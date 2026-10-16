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

export function safeFileName(s) {
  return String(s || 'protokoll').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80);
}
