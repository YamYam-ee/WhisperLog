// Spelar in mikrofon och (för digitala möten) datorns systemljud.
// Ljudet delas i segment (t.ex. 10 min) som transkriberas löpande medan mötet pågår.
// Varje spår skickas i små bitar till huvudprocessen och skrivs direkt till disk.
const MIME = 'audio/webm;codecs=opus';
const api = window.api;

export class MeetingRecorder {
  constructor({ meetingId, mode, micDeviceId, segmentMinutes, live }) {
    this.live = !!live; // strömma ljudet till Gemini Live under mötet
    this.meetingId = meetingId;
    this.mode = mode;
    this.micDeviceId = micDeviceId;
    this.segmentMs = Math.max(1, Number(segmentMinutes) || 10) * 60 * 1000;
    this.segIndex = 0;
    this.accumulated = 0; // inspelade sekunder exkl. pauser
    this.current = null;
    this.pending = Promise.resolve();
    this.onWarning = null;
    this.active = true;
  }

  async init() {
    const micConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (this.micDeviceId && this.micDeviceId !== 'default') micConstraints.deviceId = { exact: this.micDeviceId };
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
    } catch (e) {
      if (micConstraints.deviceId) {
        delete micConstraints.deviceId; // vald mikrofon saknas – använd standard
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
      } else throw new Error('Kunde inte komma åt mikrofonen: ' + e.message);
    }

    if (this.mode === 'digital') {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        display.getVideoTracks().forEach((t) => t.stop());
        const audioTracks = display.getAudioTracks();
        if (!audioTracks.length) throw new Error('inget ljudspår');
        this.sysStream = new MediaStream(audioTracks);
      } catch (e) {
        this.sysStream = null;
        this.onWarning?.('Kunde inte fånga datorns ljud (' + e.message + '). Endast mikrofonen spelas in.');
      }
    }

    this.ctx = new AudioContext();
    await this.ctx.resume();
    this.dest = this.ctx.createMediaStreamDestination();
    const micSrc = this.ctx.createMediaStreamSource(this.micStream);
    this.micAnalyser = this.makeAnalyser(micSrc);
    micSrc.connect(this.dest);
    if (this.sysStream) {
      const sysSrc = this.ctx.createMediaStreamSource(this.sysStream);
      this.sysAnalyser = this.makeAnalyser(sysSrc);
      sysSrc.connect(this.dest);
    }

    // mic + system transkriberas separat (ger bättre talaridentifiering), mix arkiveras.
    this.tracks = { mic: this.micStream };
    if (this.sysStream) {
      this.tracks.system = this.sysStream;
      this.tracks.mix = this.dest.stream;
    }
    if (this.live) this.startPcm();
  }

  // 16 kHz PCM till Gemini Live, ett flöde per spår. Skickas bara medan ett segment spelas in
  // (inte under paus). Offset = mötestiden för bitens början, för tidsstämplarna.
  startPcm() {
    this.pcmCtx = new AudioContext({ sampleRate: 16000 });
    const mute = this.pcmCtx.createGain();
    mute.gain.value = 0;
    mute.connect(this.pcmCtx.destination);
    const streams = { mic: this.micStream, system: this.sysStream };
    for (const [name, stream] of Object.entries(streams)) {
      if (!stream) continue;
      const src = this.pcmCtx.createMediaStreamSource(stream);
      const proc = this.pcmCtx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => {
        if (!this.current) return;
        const f = ev.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
        api.rec.liveAudio(this.meetingId, name, pcm.buffer, Math.max(0, this.elapsed() - f.length / 16000));
      };
      src.connect(proc);
      proc.connect(mute);
    }
    this.pcmCtx.resume();
  }

  makeAnalyser(src) {
    const a = this.ctx.createAnalyser();
    a.fftSize = 1024;
    src.connect(a);
    return a;
  }

  level(analyser) {
    if (!analyser) return null;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, Math.sqrt(rms) * 1.6);
  }

  levels() {
    return { mic: this.level(this.micAnalyser), system: this.level(this.sysAnalyser) };
  }

  elapsed() {
    return this.accumulated + (this.current ? (performance.now() - this.current.startedAt) / 1000 : 0);
  }

  async startSegment() {
    const index = this.segIndex++;
    const startOffset = this.accumulated;
    await api.rec.segmentStart(this.meetingId, index, startOffset, Object.keys(this.tracks));
    if (!this.active) {
      // pausades/stoppades medan segmentet registrerades
      await api.rec.segmentEnd(this.meetingId, index, 0);
      return;
    }
    const recs = [];
    for (const [name, stream] of Object.entries(this.tracks)) {
      const r = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: name === 'mix' ? 64000 : 32000 });
      const entry = { name, r, queue: Promise.resolve() };
      r.ondataavailable = (e) => {
        if (!e.data.size) return;
        const blob = e.data;
        entry.queue = entry.queue.then(async () => api.rec.chunk(this.meetingId, index, name, await blob.arrayBuffer()));
      };
      entry.stopped = new Promise((res) => (r.onstop = res));
      recs.push(entry);
    }
    recs.forEach((e) => e.r.start(4000));
    this.current = { index, startedAt: performance.now(), recs };
    this.segTimer = setTimeout(() => this.rotate(), this.segmentMs);
  }

  // Avslutar aktuellt segment. Inspelarna stoppas direkt (synkront) så att ett nytt
  // segment kan starta utan glapp; själva skrivningen till disk sker i bakgrunden.
  closeSegment() {
    const cur = this.current;
    if (!cur) return Promise.resolve();
    clearTimeout(this.segTimer);
    this.current = null;
    const dur = (performance.now() - cur.startedAt) / 1000;
    this.accumulated += dur;
    cur.recs.forEach((e) => e.r.state !== 'inactive' && e.r.stop());
    const done = (async () => {
      await Promise.all(cur.recs.map((e) => e.stopped));
      await Promise.all(cur.recs.map((e) => e.queue));
      await api.rec.segmentEnd(this.meetingId, cur.index, dur);
    })();
    this.pending = this.pending.then(() => done);
    return done;
  }

  async rotate() {
    const closing = this.closeSegment();
    await this.startSegment();
    await closing;
  }

  async pause() {
    this.active = false;
    await this.closeSegment();
  }

  async resume() {
    this.active = true;
    await this.startSegment();
  }

  async stop() {
    this.active = false;
    await this.closeSegment();
    await this.pending;
    for (const s of [this.micStream, this.sysStream]) s?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    await this.pcmCtx?.close().catch(() => {});
    return this.accumulated;
  }
}
