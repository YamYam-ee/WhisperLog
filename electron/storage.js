// Lagring av möten på disk. Varje möte är en mapp med meeting.json,
// segmentfiler (ljud), audio.mp3, protocol.md, transcript.txt och bilagor.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const events = new EventEmitter();
const cache = new Map();
let baseDir = null;

function setBaseDir(dir) {
  baseDir = dir;
  fs.mkdirSync(baseDir, { recursive: true });
  cache.clear();
}

function getBaseDir() {
  return baseDir;
}

function meetingDir(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Ogiltigt mötes-id');
  return path.join(baseDir, id);
}

function resolveInMeeting(id, rel) {
  const dir = meetingDir(id);
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('Ogiltig sökväg');
  return full;
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function newId(date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}_${rand}`;
}

function load(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(meetingDir(id), 'meeting.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(id, m);
  return m;
}

function save(m) {
  m.updatedAt = new Date().toISOString();
  cache.set(m.id, m);
  writeJsonAtomic(path.join(meetingDir(m.id), 'meeting.json'), m);
  writeTranscriptText(m);
  events.emit('updated', m.id);
  return m;
}

function create(data) {
  const now = new Date();
  const id = newId(now);
  fs.mkdirSync(path.join(meetingDir(id), 'segments'), { recursive: true });
  fs.mkdirSync(path.join(meetingDir(id), 'attachments'), { recursive: true });
  const m = {
    id,
    title: data.title?.trim() || 'Möte ' + now.toLocaleString('sv-SE'),
    mode: data.mode === 'physical' ? 'physical' : 'digital',
    source: data.source || 'recording',
    participants: data.participants || '',
    agendaText: data.agendaText || '',
    instructions: data.instructions || '',
    templateMeetingIds: data.templateMeetingIds || [],
    attachments: [],
    createdAt: now.toISOString(),
    startedAt: null,
    endedAt: null,
    durationSec: 0,
    status: 'draft',
    pauses: [],
    segments: [],
    speakerMap: {},
    audioFile: null,
    hasProtocol: false,
    protocolGeneratedAt: null,
    error: null,
  };
  cache.set(id, m);
  save(m);
  for (const a of data.attachments || []) addAttachment(id, a.path, a.kind);
  return load(id);
}

function update(id, fn) {
  const m = load(id);
  if (!m) throw new Error('Mötet finns inte: ' + id);
  if (typeof fn === 'function') fn(m);
  else Object.assign(m, fn);
  return save(m);
}

function list() {
  if (!baseDir || !fs.existsSync(baseDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(baseDir)) {
    try {
      const m = load(name);
      if (m) out.push(summary(m));
    } catch {
      /* ignorera trasiga mappar */
    }
  }
  return out.sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
}

function summary(m) {
  const speakers = new Set();
  for (const s of m.segments) for (const e of s.transcript || []) speakers.add(m.speakerMap[e.speaker] || e.speaker);
  return {
    id: m.id,
    title: m.title,
    mode: m.mode,
    source: m.source,
    status: m.status,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    durationSec: m.durationSec,
    hasProtocol: m.hasProtocol,
    attachmentCount: m.attachments.length,
    speakers: [...speakers],
    participants: m.participants,
  };
}

function remove(id) {
  cache.delete(id);
  return meetingDir(id);
}

function addAttachment(id, srcPath, kind = 'other') {
  const dir = path.join(meetingDir(id), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(srcPath);
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)} (${i++})${ext}`;
  }
  fs.copyFileSync(srcPath, path.join(dir, name));
  return update(id, (m) => {
    m.attachments.push({
      id: Math.random().toString(36).slice(2, 10),
      name,
      file: 'attachments/' + name,
      kind,
      addedAt: new Date().toISOString(),
    });
  });
}

function removeAttachment(id, attId) {
  return update(id, (m) => {
    const a = m.attachments.find((x) => x.id === attId);
    if (a) {
      try {
        fs.unlinkSync(resolveInMeeting(id, a.file));
      } catch {
        /* redan borta */
      }
    }
    m.attachments = m.attachments.filter((x) => x.id !== attId);
  });
}

function fullTranscript(m) {
  const all = [];
  for (const s of m.segments) for (const e of s.transcript || []) all.push(e);
  return all.sort((a, b) => a.t - b.t);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const mm = pad(Math.floor((sec % 3600) / 60));
  const ss = pad(sec % 60);
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function transcriptAsText(m) {
  return fullTranscript(m)
    .map((e) => `[${fmtTime(e.t)}] ${m.speakerMap[e.speaker] || e.speaker}: ${e.text}`)
    .join('\n');
}

function writeTranscriptText(m) {
  const text = transcriptAsText(m);
  if (!text) return;
  try {
    fs.writeFileSync(path.join(meetingDir(m.id), 'transcript.txt'), text, 'utf8');
  } catch {
    /* inte kritiskt */
  }
}

function readProtocol(id) {
  const f = path.join(meetingDir(id), 'protocol.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

function writeProtocol(id, md, generated = false) {
  fs.writeFileSync(path.join(meetingDir(id), 'protocol.md'), md, 'utf8');
  return update(id, (m) => {
    m.hasProtocol = !!md.trim();
    if (generated) m.protocolGeneratedAt = new Date().toISOString();
    if (m.status === 'transcribed' && m.hasProtocol) m.status = 'done';
  });
}

module.exports = {
  events,
  setBaseDir,
  getBaseDir,
  meetingDir,
  resolveInMeeting,
  create,
  load,
  update,
  list,
  summary,
  remove,
  addAttachment,
  removeAttachment,
  fullTranscript,
  transcriptAsText,
  readProtocol,
  writeProtocol,
  fmtTime,
};
