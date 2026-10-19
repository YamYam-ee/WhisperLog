export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function fmtDuration(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtDate(iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', opts);
}

export const STATUS = {
  draft: { label: 'Planerat', tone: 'neutral' },
  recorded: { label: 'Inspelat', tone: 'neutral' },
  recording: { label: 'Spelar in', tone: 'rec' },
  paused: { label: 'Pausat', tone: 'warn' },
  processing: { label: 'Bearbetas', tone: 'info' },
  transcribed: { label: 'Transkriberat', tone: 'info' },
  done: { label: 'Klart', tone: 'ok' },
  error: { label: 'Fel', tone: 'err' },
  interrupted: { label: 'Avbrutet', tone: 'warn' },
};

// Talarfärger som är läsbara på vit bakgrund (först profilens teal och marin).
const PALETTE = ['#0d9488', '#2b3a42', '#2563eb', '#c2410c', '#7c3aed', '#059669', '#db2777', '#0369a1', '#b45309', '#4f46e5'];
export function speakerColor(name, order) {
  const i = order ? order.indexOf(name) : -1;
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Delar en Live-replik i meningar och ger varje mening rösten som hördes vid den tidpunkten
// (texten fördelas jämnt över replikens tid). Sammanhängande meningar med samma röst slås ihop.
export function splitByVoice(e) {
  const parts = e.voiceParts || [];
  if (new Set(parts.map((p) => p.voice)).size < 2) return [{ t: e.t, voice: e.voice, text: e.text }];
  const sentences = e.text.match(/[^.!?]+[.!?]*\s*/g) || [e.text];
  const total = e.text.length || 1;
  const dur = Math.max(1, (e.end || e.t + 1) - e.t);
  const mid = (p) => (p.from + p.to) / 2;
  const out = [];
  let pos = 0;
  for (const s of sentences) {
    const startT = e.t + (pos / total) * dur;
    const at = e.t + ((pos + s.length / 2) / total) * dur;
    pos += s.length;
    const p = parts.find((x) => at >= x.from && at < x.to) || parts.reduce((a, b) => (Math.abs(mid(a) - at) <= Math.abs(mid(b) - at) ? a : b));
    const last = out[out.length - 1];
    if (last && last.voice === p.voice) last.text += s;
    else out.push({ t: startT, voice: p.voice, text: s });
  }
  return out.map((o) => ({ ...o, t: Math.round(o.t * 10) / 10, text: o.text.trim() })).filter((o) => o.text);
}

// Ord-överlapp mellan två texter (0–1) – för att känna igen eko av högtalarljud i mikrofonen.
export function similarity(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export function safeFileName(s) {
  return String(s || 'protokoll').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80);
}
