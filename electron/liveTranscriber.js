// Realtidstranskribering med Gemini Live (gemini-3.5-transcribe-live). Varje ljudspår
// (mikrofon / systemljud) strömmas till en egen session medan mötet pågår, så att
// transkriptionen är klar i samma ögonblick som mötet avslutas.
const { GoogleGenAI, Modality } = require('@google/genai');

const MODEL = 'gemini-3.5-transcribe-live';
const BYTES_PER_SEC = 32000; // 16 kHz, 16 bit, mono
const ROTATE_AFTER_MS = 8 * 60 * 1000; // byt session i en tystnad efter 8 min …
const FORCE_ROTATE_MS = 9.5 * 60 * 1000; // … eller tvingat efter 9,5 min

// Enstaka gemener utan skiljetecken ("ice", "informé") är brus, inte tal.
const isJunk = (text) => text.length < 12 && /^\p{Ll}[\p{L}'’-]*$/u.test(text.trim());

class LiveTrack {
  constructor({ apiKey, track, onEntry, onGap }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.track = track;
    this.onEntry = onEntry;
    this.onGap = onGap;
    this.session = null;
    this.connecting = null;
    this.queue = [];
    this.lastMsgAt = 0;
    this.closed = false;
  }

  // Öppnar en ny session. `base` = mötestiden (s) då sessionens första ljudbyte skickas.
  async open(base) {
    const st = { base, sentBytes: 0, startedAt: Date.now(), pendingStart: null, wantRotate: false, ended: false };
    st.session = await this.ai.live.connect({
      model: MODEL,
      config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: ['sv-SE', 'en-US'] } },
      callbacks: {
        onmessage: (m) => this.onMessage(st, m),
        onerror: (e) => this.onBroken(st, e?.message || 'fel'),
        onclose: (e) => {
          if (!st.ended) this.onBroken(st, 'stängd ' + (e?.code || '') + ' ' + (e?.reason || ''));
        },
      },
    });
    return st;
  }

  onMessage(st, m) {
    this.lastMsgAt = Date.now();
    const off = m.voiceActivity?.audioOffset;
    if (m.voiceActivity?.type === 'ACTIVITY_START' && off) st.pendingStart = st.base + parseFloat(off);
    if (m.voiceActivity?.type === 'ACTIVITY_END' && st.wantRotate) this.rotate();
    const tr = m.serverContent?.inputTranscription;
    if (tr?.text && tr.text.trim() && !isJunk(tr.text)) {
      const t = st.pendingStart ?? Math.max(st.base, st.base + st.sentBytes / BYTES_PER_SEC - 10);
      // Live-texten saknar ibland mellanslag efter punkt ("helskärm.Man") – lägg till det.
      const text = tr.text.trim().replace(/([.!?])(?=\p{Lu})/gu, '$1 ');
      this.onEntry({ t: Math.round(t * 10) / 10, track: this.track, text, lang: tr.languageCode || '' });
      st.pendingStart = null;
    }
  }

  onBroken(st, why) {
    if (st.ended || this.current !== st) return;
    st.ended = true;
    console.warn(`Live-transkribering (${this.track}) avbröts: ${why} – återansluter`);
    this.onGap(st.base + st.sentBytes / BYTES_PER_SEC);
    this.current = null;
  }

  // Skickar en ljudbit. `offset` = mötestiden (s) för bitens början.
  push(buf, offset) {
    if (this.closed) return;
    const st = this.current;
    if (st && !st.ended) {
      const age = Date.now() - st.startedAt;
      if (age > FORCE_ROTATE_MS) this.rotate();
      else if (age > ROTATE_AFTER_MS) st.wantRotate = true;
    }
    if (this.current && !this.current.ended) {
      this.send(this.current, buf);
      return;
    }
    this.queue.push({ buf, offset });
    if (!this.connecting) {
      const base = this.queue[0].offset;
      this.connecting = this.open(base)
        .then((s) => {
          this.current = s;
          for (const q of this.queue.splice(0)) this.send(s, q.buf);
        })
        .catch((e) => {
          console.warn(`Kunde inte ansluta till Gemini Live (${this.track}): ${e.message}`);
          this.onGap(base);
          this.queue = []; // ljudet finns kvar på disk och transkriberas i efterhand
        })
        .finally(() => (this.connecting = null));
    }
  }

  send(st, buf) {
    st.sentBytes += buf.length;
    try {
      st.session.sendRealtimeInput({ audio: { data: Buffer.from(buf).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (e) {
      this.onBroken(st, e.message);
    }
  }

  // Avslutar aktuell session (resterande text levereras) – nästa ljudbit öppnar en ny.
  rotate() {
    const old = this.current;
    if (!old || old.ended) return;
    old.ended = true;
    this.current = null;
    try {
      old.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      /* redan stängd */
    }
    setTimeout(() => {
      try {
        old.session.close();
      } catch {
        /* ignorera */
      }
    }, 10000);
  }

  // Vid paus/stopp: be om sista texten och vänta tills det blir tyst (max ~8 s).
  async finish() {
    if (this.connecting) await this.connecting.catch(() => {});
    const st = this.current;
    if (!st || st.ended) return;
    st.ended = true;
    this.current = null;
    try {
      st.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      /* ignorera */
    }
    const started = Date.now();
    this.lastMsgAt = Math.max(this.lastMsgAt, started);
    while (Date.now() - this.lastMsgAt < 1500 && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 200));
    try {
      st.session.close();
    } catch {
      /* ignorera */
    }
  }
}

// Ett möte = upp till två spår.
class LiveMeeting {
  constructor({ apiKey, onEntry, onGap }) {
    this.apiKey = apiKey;
    this.onEntry = onEntry;
    this.onGap = onGap;
    this.tracks = {};
  }

  push(track, buf, offset) {
    if (!this.tracks[track]) {
      this.tracks[track] = new LiveTrack({ apiKey: this.apiKey, track, onEntry: this.onEntry, onGap: (at) => this.onGap(track, at) });
    }
    this.tracks[track].push(buf, offset);
  }

  async pause() {
    await Promise.all(Object.values(this.tracks).map((t) => t.finish()));
  }

  async finish() {
    await this.pause();
    for (const t of Object.values(this.tracks)) t.closed = true;
  }
}

module.exports = { LiveMeeting, MODEL };
