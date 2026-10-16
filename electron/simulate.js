// Utvecklarverktyg: simulerar ett långt möte från en WAV-fil (16 kHz mono) genom exakt samma
// kedja som en riktig inspelning – segment på disk, Gemini Live-strömning, sessionsbyten,
// avslutning och fördelning av texten. Startas med WHISPERLOG_SIMULATE=<wav> (bara i dev).
const fs = require('fs');
const path = require('path');

function wavHeader(bytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(bytes, 40);
  return h;
}

async function simulate({ file, speed, storage, settings, liveFor, finalizeMeeting, log }) {
  const pcm = fs.readFileSync(file).subarray(44);
  const total = pcm.length / 32000;
  const m = storage.create({ title: `Simulerat möte ${Math.round(total / 60)} min (test)`, mode: 'digital' });
  const id = m.id;
  storage.update(id, { status: 'recording', startedAt: new Date().toISOString(), liveEnabled: true });
  log(`SIM start: ${id}, ${Math.round(total / 60)} min ljud, ${speed}× hastighet`);
  const segBytes = (settings.segmentMinutes || 2) * 60 * 32000;
  const chunk = 8192; // ~256 ms, samma storlek som inspelaren skickar
  const t0 = Date.now();
  let index = 0;
  for (let i = 0; i < pcm.length; index++) {
    const end = Math.min(pcm.length, i + segBytes);
    const rel = `segments/seg-${String(index).padStart(3, '0')}-system.wav`;
    const slice = pcm.subarray(i, end);
    fs.writeFileSync(storage.resolveInMeeting(id, rel), Buffer.concat([wavHeader(slice.length), slice]));
    storage.update(id, (mm) => mm.segments.push({ index, startOffset: i / 32000, durationSec: 0, files: { system: rel, mix: rel }, status: 'recording', transcript: [] }));
    const segStart = Date.now();
    for (let j = i; j < end; j += chunk) {
      liveFor(id).push('system', pcm.subarray(j, Math.min(end, j + chunk)), j / 32000);
      // vänta så att strömmen går i `speed`× realtid
      const target = segStart + ((j + chunk - i) / 32000 / speed) * 1000;
      const wait = target - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    storage.update(id, (mm) => {
      const s = mm.segments.find((x) => x.index === index);
      s.durationSec = (end - i) / 32000;
      s.status = 'pending';
      mm.durationSec = end / 32000;
    });
    const mm = storage.load(id);
    log(`SIM segment ${index} klart (${Math.round(end / 32000 / 60)} min), live-repliker hittills: ${(mm.liveEntries || []).length}, luckor: ${(mm.liveGaps || []).length}`);
    i = end;
  }
  log(`SIM allt ljud skickat efter ${((Date.now() - t0) / 60000).toFixed(1)} min – avslutar mötet`);
  storage.update(id, { endedAt: new Date().toISOString() });
  const tStop = Date.now();
  await finalizeMeeting(id, { transcribe: true, engine: 'live' });
  const done = storage.load(id);
  const entries = storage.fullTranscript(done);
  log(
    `SIM KLART: status=${done.status}, klart ${((Date.now() - tStop) / 1000).toFixed(1)} s efter stopp, ` +
      `${entries.length} repliker, ${(done.liveEntries || []).length} live-bitar, luckor=${JSON.stringify(done.liveGaps || [])}, ` +
      `segment: ${done.segments.map((s) => s.engine || s.status).join(',')}, ljudfil=${done.audioFile}, fel=${done.error}`
  );
  // Täckning: hur stor del av varje 10-minutersperiod har text?
  const buckets = [];
  for (const e of entries) buckets[Math.floor(e.t / 600)] = (buckets[Math.floor(e.t / 600)] || 0) + e.text.length;
  log(`SIM tecken per 10 min: ${Array.from({ length: Math.ceil(total / 600) }, (_, k) => buckets[k] || 0).join(' ')}`);
  return id;
}

module.exports = { simulate, wavHeader };
