const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  Tray,
  Menu,
  Notification,
  dialog,
  shell,
  safeStorage,
  nativeImage,
  globalShortcut,
  powerSaveBlocker,
  protocol,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const storage = require('./storage');
const audio = require('./audio');
const gemini = require('./gemini');
const { MeetingDetector } = require('./detector');
const localWhisper = require('./localWhisper');
const { LiveMeeting } = require('./liveTranscriber');
const voices = require('./voices');
const { fillTemplate } = require('./wordTemplate');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const ASSETS = path.join(__dirname, '..', 'assets');

if (process.env.WHISPERLOG_USERDATA) app.setPath('userData', process.env.WHISPERLOG_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('app.whisperlog');
protocol.registerSchemesAsPrivileged([
  { scheme: 'wlmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

let win = null;
let tray = null;
let quitting = false;
let detector = null;
let recState = { status: 'idle', meetingId: null, title: '', elapsed: 0 };
let powerBlockId = null;

// ---------------------------------------------------------------- Loggfil
function setupLogging() {
  const file = path.join(app.getPath('userData'), 'whisperlog.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
  } catch {
    /* ignorera */
  }
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = args
        .map((a) => (a instanceof Error ? a.stack + (a.cause ? '\n  orsak: ' + (a.cause.stack || a.cause) : '') : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      try {
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${level.toUpperCase()} ${text}\n`);
      } catch {
        /* ignorera */
      }
    };
  }
}

// ---------------------------------------------------------------- Inställningar
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  userName: '',
  transcribeModel: '', // väljs automatiskt utifrån vad API-nyckeln har tillgång till
  protocolModel: '',
  micDeviceId: 'default',
  segmentMinutes: 2,
  storageDir: '',
  detectMeetings: true,
  autoStartOnDetect: false,
  autoTranscribe: true, // transkribera i bakgrunden under mötet
  transcriptionEngine: 'live',
  localModel: 'turbo',
  // transcriptionEngine: 'live' = Gemini Live under mötet (standard), 'gemini' = efteråt med talaridentifiering, 'local' = Whisper // KB-modellerna översätter engelska till svenska – turbo behåller språket
  autoProtocol: false,
  openAtLogin: false,
  shortcutPause: 'CommandOrControl+Alt+P',
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if ((settings.settingsVersion || 1) < 2) {
    // v2: automatisk sändning till Gemini är avstängd som standard
    settings.autoTranscribe = false;
    settings.autoProtocol = false;
    settings.settingsVersion = 2;
  }
  if (settings.settingsVersion < 3) {
    // v3: transkribering i bakgrunden under mötet (protokollet skapas med knapp)
    settings.autoTranscribe = true;
    settings.segmentMinutes = 5;
    settings.settingsVersion = 3;
  }
  if (settings.settingsVersion < 4) {
    // v4: automatiskt modellval med växling (Flash Lite först för transkribering)
    settings.transcribeModel = '';
    settings.protocolModel = '';
    settings.settingsVersion = 4;
  }
  if (settings.settingsVersion < 5) {
    // v5: kortare bakgrundsdelar – högst 2 min kvar att bearbeta när mötet slutar
    if (settings.segmentMinutes >= 5) settings.segmentMinutes = 2;
    settings.settingsVersion = 5;
  }
  if (settings.settingsVersion < 6) {
    if (String(settings.localModel).startsWith('kb-')) settings.localModel = 'turbo';
    settings.settingsVersion = 6;
  }
  if (settings.settingsVersion < 7) {
    // v7: Gemini Live (obegränsad, klar direkt när mötet slutar) som standard
    if (settings.transcriptionEngine === 'gemini') settings.transcriptionEngine = 'live';
    settings.settingsVersion = 7;
    if (fs.existsSync(settingsFile())) saveSettings();
  }
  if (!settings.storageDir) settings.storageDir = path.join(app.getPath('documents'), 'WhisperLog');
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function getApiKey() {
  if (!app.isPackaged && process.env.WHISPERLOG_APIKEY) return process.env.WHISPERLOG_APIKEY; // endast utveckling/test
  if (!settings.apiKeyEnc) return '';
  try {
    const buf = Buffer.from(settings.apiKeyEnc, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}

function setApiKey(key) {
  key = (key || '').trim();
  if (!key) {
    delete settings.apiKeyEnc;
    return;
  }
  settings.apiKeyEnc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key).toString('base64')
    : Buffer.from(key, 'utf8').toString('base64');
}

function publicSettings() {
  const { apiKeyEnc, ...rest } = settings;
  const key = getApiKey();
  return { ...rest, hasApiKey: !!key, apiKeyHint: key ? '••••' + key.slice(-4) : '' };
}

function applyLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, path: exe, args: ['--hidden'] });
}

function applyShortcut() {
  globalShortcut.unregisterAll();
  if (settings.shortcutPause) {
    try {
      globalShortcut.register(settings.shortcutPause, () => send('rec:command', 'toggle-pause'));
    } catch {
      /* ogiltig kombination */
    }
  }
}

function applyDetector() {
  if (!detector) {
    detector = new MeetingDetector();
    detector.on('meeting-start', onMeetingDetected);
    detector.on('meeting-end', onMeetingEnded);
    detector.on('change', (apps) => send('detector:apps', apps));
  }
  if (settings.detectMeetings) detector.start();
  else detector.stop();
}

// ---------------------------------------------------------------- Fönster & tray
function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'WhisperLog',
    backgroundColor: '#F4F7FB',
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // inspelningen ska fortsätta när fönstret är dolt
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (!settings.closeHintShown) {
        settings.closeHintShown = true;
        saveSettings();
        notify('WhisperLog körs i bakgrunden', 'Appen finns kvar i aktivitetsfältet (nere till höger) och lyssnar efter möten.');
      }
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function trayImage(recording) {
  // .ico med flera storlekar – Windows väljer rätt storlek för skärmens skalning.
  return nativeImage.createFromPath(path.join(ASSETS, recording ? 'tray-rec.ico' : 'tray.ico'));
}

function fmtElapsed(sec) {
  return storage.fmtTime(sec);
}

function updateTray() {
  if (!tray) return;
  const s = recState.status;
  const active = s === 'recording' || s === 'paused';
  tray.setImage(trayImage(s === 'recording'));
  tray.setToolTip(
    s === 'recording'
      ? `WhisperLog – spelar in: ${recState.title}`
      : s === 'paused'
        ? `WhisperLog – pausad: ${recState.title}`
        : 'WhisperLog'
  );
  const items = [{ label: 'Öppna WhisperLog', click: showWindow }, { type: 'separator' }];
  if (active) {
    items.push(
      { label: `${s === 'recording' ? '● Spelar in' : '❚❚ Pausad'} – ${recState.title}`, enabled: false },
      s === 'recording'
        ? { label: 'Pausa (t.ex. lunch/fika)', click: () => send('rec:command', 'pause') }
        : { label: 'Återuppta inspelning', click: () => send('rec:command', 'resume') },
      { label: 'Avsluta mötet', click: () => send('rec:command', 'stop') }
    );
  } else {
    items.push(
      { label: 'Starta digitalt möte', click: () => quickStart('digital') },
      { label: 'Starta fysiskt möte', click: () => quickStart('physical') }
    );
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Upptäck möten automatiskt',
      type: 'checkbox',
      checked: !!settings.detectMeetings,
      click: (mi) => {
        settings.detectMeetings = mi.checked;
        saveSettings();
        applyDetector();
        send('settings:changed', publicSettings());
      },
    },
    { type: 'separator' },
    { label: 'Avsluta WhisperLog', click: () => requestQuit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.on('click', showWindow);
  updateTray();
}

function quickStart(mode, title) {
  showWindow();
  send('rec:command', 'quick-start', { mode, title });
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png') });
  n.on('click', () => (onClick ? onClick() : showWindow()));
  n.show();
}

async function requestQuit() {
  if (recState.status === 'recording' || recState.status === 'paused') {
    showWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Avsluta mötet och stäng', 'Avbryt'],
      defaultId: 1,
      cancelId: 1,
      title: 'Inspelning pågår',
      message: 'En inspelning pågår. Vill du avsluta mötet och stänga WhisperLog?',
      detail: 'Det inspelade ljudet sparas. Transkribering som inte hunnit klart kan slutföras från arkivet nästa gång.',
    });
    if (response !== 0) return;
    send('rec:command', 'stop');
    const until = Date.now() + 8000;
    while (recState.status !== 'idle' && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- Mötesdetektering
function onMeetingDetected(apps) {
  if (recState.status !== 'idle') return;
  const appName = apps[0];
  const title = `Möte (${appName.replace(/ \(.*\)$/, '')}) ${new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}`;
  if (settings.autoStartOnDetect) {
    send('rec:command', 'quick-start', { mode: 'digital', title, auto: true });
    notify('Inspelning startad', `Ett möte upptäcktes i ${appName}. WhisperLog spelar nu in.`);
  } else {
    notify('Möte upptäckt', `${appName} använder mikrofonen. Klicka här för att spela in mötet.`, () => quickStart('digital', title));
    send('detector:detected', { apps, title });
  }
}

function onMeetingEnded(apps) {
  if (recState.status !== 'recording') return;
  notify('Mötet verkar ha avslutats', `${apps[0]} använder inte längre mikrofonen. Klicka för att avsluta inspelningen.`, () => {
    showWindow();
    send('detector:ended', { apps });
  });
}

// ---------------------------------------------------------------- Modeller
// Modellistan hämtas en gång per session; varje anrop får en kedja av modeller att växla mellan.
let modelCache = null;
async function modelChain(kind) {
  if (!modelCache) modelCache = await gemini.listModels(getApiKey());
  const chain = kind === 'flash' ? gemini.chainFor(modelCache, 'transcribe', settings.transcribeModel) : gemini.chainFor(modelCache, 'protocol', settings.protocolModel);
  if (!chain.length) throw new Error('Hittade ingen Gemini-modell för din API-nyckel.');
  return chain;
}

async function withModel(kind, fn) {
  return fn(await modelChain(kind));
}

// ---------------------------------------------------------------- Gemini Live (under mötet)
const lives = new Map(); // meetingId -> LiveMeeting

// Röstgruppering per möte: avtryck i minnet (sparas även i voices.json i mötesmappen).
const voiceStates = new Map();

function voiceStateFor(id) {
  if (!voiceStates.has(id)) {
    const file = path.join(storage.meetingDir(id), 'voices.json');
    let saved = { items: [] };
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* nytt möte */
    }
    const m = storage.load(id);
    voiceStates.set(id, {
      file,
      items: saved.items || [],
      seq: Math.max(0, ...(m.liveEntries || []).map((e) => e.id || 0)),
      saveTimer: null,
    });
  }
  return voiceStates.get(id);
}

function saveVoicesSoon(st) {
  clearTimeout(st.saveTimer);
  st.saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(st.file, JSON.stringify({ items: st.items.map((it) => ({ ...it, emb: it.emb.map((x) => +x.toFixed(4)) })) }));
    } catch (e) {
      console.warn('Kunde inte spara röstavtryck', e.message);
    }
  }, 5000);
}

// Räknar ut röstavtryck för en ny replik (i 6-sekundersbitar, så att talarbyten inom en lång
// replik fångas) och grupperar om alla röster i mötet.
function identifyVoice(id, entry, track) {
  if (!voices.ready()) return;
  try {
    const st = voiceStateFor(id);
    const to = entry.end - 0.3;
    const from = Math.max(entry.t, to - 118); // ljudhistoriken räcker ~2 min bakåt
    // Eko: hörs datorljudet starkare än mikrofonen är mikrofonens ljud ett eko från högtalarna.
    const other = entry.track === 'mic' ? lives.get(id)?.tracks.system : null;
    const level = (pcm) => {
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
    };
    let k = 0;
    for (let s = from; s < to - 1; s += 6, k++) {
      const e = Math.min(s + 6, to);
      const pcm = track.audio(s, e);
      if (other && level(other.audio(s, e)) > level(pcm) * 0.6) continue;
      const emb = voices.embed(pcm);
      if (emb) st.items.push({ id: entry.id + ':' + k, entry: entry.id, from: s, to: e, emb, track: entry.track });
    }
    if (!st.items.some((it) => it.entry === entry.id)) return;
    const { labels } = voices.cluster(st.items, reservedLabels(id));
    for (const it of st.items) it.voice = labels.get(it.id);
    // Per replik: röst per tidsbit + den röst som hörs mest.
    const parts = new Map();
    for (const it of st.items) {
      if (!parts.has(it.entry)) parts.set(it.entry, []);
      parts.get(it.entry).push({ from: Math.round(it.from * 10) / 10, to: Math.round(it.to * 10) / 10, voice: it.voice });
    }
    storage.update(id, (m) => {
      for (const le of m.liveEntries || []) {
        const p = parts.get(le.id);
        if (!p) continue;
        le.voiceParts = p;
        const dur = {};
        for (const x of p) dur[x.voice] = (dur[x.voice] || 0) + (x.to - x.from);
        le.voice = Object.entries(dur).sort((a, b) => b[1] - a[1])[0][0];
      }
    });
    saveVoicesSoon(st);
  } catch (e) {
    console.warn('Röstigenkänning misslyckades:', e.message);
  }
}

// Etiketter som användaren gett namn – återanvänds aldrig för en annan röst.
function reservedLabels(id) {
  const m = storage.load(id);
  return new Set(Object.keys(m.speakerMap || {}).filter((k) => /^Talare \d+$/.test(k) && m.speakerMap[k]));
}

function readPcm(file) {
  const b = fs.readFileSync(file).subarray(44);
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)));
}

function rms(pcm, from, to) {
  if (!pcm) return 0;
  let e = 0;
  const a = Math.max(0, Math.round(from * 16000));
  const b = Math.min(pcm.length, Math.round(to * 16000));
  for (let i = a; i < b; i++) e += pcm[i] * pcm[i];
  return b > a ? Math.sqrt(e / (b - a)) : 0;
}

/**
 * Röstidentifiering i efterhand för ett redan transkriberat möte (eller vissa segment).
 * Räknar röstavtryck i 6-sekundersbitar ur ljudfilerna, grupperar dem tillsammans med eventuella
 * Live-avtryck och delar texten per mening och röst → Talare 1, 2, 3 … i hela mötet.
 */
const identifying = new Set();
async function identifyVoicesPostHoc(id, { only = null } = {}) {
  if (identifying.has(id)) throw new Error('Röstidentifiering pågår redan för mötet');
  identifying.add(id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisperlog-voices-'));
  try {
    await voices.ensureModel();
    const m = storage.load(id);
    const st = voiceStateFor(id);
    const segs = m.segments.filter((s) => s.transcript?.length && (!only || only.includes(s.index)));
    const totalSec = segs.reduce((n, s) => n + (s.durationSec || 0), 0) || 1;
    let doneSec = 0;
    storage.update(id, { identifyingVoices: 0 });
    const newItems = [];
    for (const s of segs) {
      const read = async (key) => {
        const rel = s.files?.[key];
        if (!rel) return null;
        const src = storage.resolveInMeeting(id, rel);
        if (!fs.existsSync(src) || fs.statSync(src).size < 2000) return null;
        const wav = path.join(tmp, s.index + '-' + key + '.wav');
        await audio.toWav16k(src, wav);
        return readPcm(wav);
      };
      const mic = await read('mic');
      const sys = await read('system');
      const mix = (await read('mix')) || mic || sys;
      if (!mix) continue;
      const rows = s.transcript.slice().sort((a, b) => a.t - b.t);
      const segEnd = s.startOffset + (s.durationSec || mix.length / 16000);
      for (let i = 0; i < rows.length; i++) {
        const from = rows[i].t - s.startOffset;
        const to = Math.min((rows[i + 1]?.t ?? segEnd) - s.startOffset, from + 120, mix.length / 16000);
        for (let a = Math.max(0, from), k = 0; a < to - 1; a += 6, k++) {
          const b = Math.min(a + 6, to);
          const emb = voices.embed(mix.subarray(Math.round(a * 16000), Math.round(b * 16000)));
          if (emb) {
            const track = mic && sys ? (rms(mic, a, b) >= rms(sys, a, b) ? 'mic' : 'system') : mic ? 'mic' : 'system';
            newItems.push({ id: 'p' + s.index + ':' + i + ':' + k, entry: 'p' + s.index + ':' + i, from: s.startOffset + a, to: s.startOffset + b, emb, track });
          }
          await new Promise((r) => setImmediate(r)); // håll appen responsiv
        }
        doneSec = Math.min(totalSec, doneSec + (to - from));
        storage.update(id, { identifyingVoices: Math.round((100 * doneSec) / totalSec) });
      }
    }
    // Ersätt tidigare efterhandsavtryck för dessa segment och gruppera allt tillsammans.
    const segPrefixes = segs.map((s) => 'p' + s.index + ':');
    // Behåll etiketterna (och därmed namnen) från en tidigare identifiering: nya bitar ärver
    // rösten från den gamla biten på samma tidpunkt, så att grupperingen matchar dem.
    const old = st.items.filter((it) => segPrefixes.some((p) => String(it.id).startsWith(p)));
    for (const it of newItems) {
      const prev = old.find((o) => Math.abs(o.from - it.from) < 3 && o.voice);
      if (prev) it.voice = prev.voice;
    }
    st.items = st.items.filter((it) => !segPrefixes.some((p) => String(it.id).startsWith(p))).concat(newItems);
    const { labels } = voices.cluster(st.items, reservedLabels(id));
    for (const it of st.items) it.voice = labels.get(it.id);
    saveVoicesSoon(st);

    storage.update(id, (mm) => {
      for (const s of mm.segments) {
        if (!segs.some((x) => x.index === s.index)) continue;
        const rows = s.transcript.slice().sort((a, b) => a.t - b.t);
        const segEnd = s.startOffset + (s.durationSec || 0);
        s.transcript = rows.flatMap((e, i) => {
          const parts = st.items.filter((it) => it.entry === 'p' + s.index + ':' + i).map((it) => ({ from: it.from, to: it.to, voice: it.voice }));
          if (!parts.length) return [e];
          const dur = {};
          for (const p of parts) dur[p.voice] = (dur[p.voice] || 0) + (p.to - p.from);
          const voice = Object.entries(dur).sort((a, b) => b[1] - a[1])[0][0];
          return splitByVoice({ t: e.t, end: rows[i + 1]?.t ?? segEnd, text: e.text, voice, voiceParts: parts }).map((p) => ({ t: p.t, speaker: p.voice, text: p.text }));
        });
        s.voicesIdentified = true;
      }
      // Live-repliker får också de omräknade etiketterna.
      for (const le of mm.liveEntries || []) {
        const p = st.items.filter((it) => it.entry === le.id);
        if (!p.length) continue;
        le.voiceParts = p.map((it) => ({ from: it.from, to: it.to, voice: it.voice }));
        const dur = {};
        for (const x of le.voiceParts) dur[x.voice] = (dur[x.voice] || 0) + (x.to - x.from);
        le.voice = Object.entries(dur).sort((a, b) => b[1] - a[1])[0][0];
      }
      // Digitalt möte: rösten som mest hörs i mikrofonen är du.
      if (mm.mode !== 'physical' && settings.userName) {
        const micDur = {};
        for (const it of st.items) if (it.track === 'mic' && it.voice) micDur[it.voice] = (micDur[it.voice] || 0) + (it.to - it.from);
        const top = Object.entries(micDur).sort((a, b) => b[1] - a[1])[0];
        mm.speakerMap = mm.speakerMap || {};
        if (top && !mm.speakerMap[top[0]]) mm.speakerMap[top[0]] = settings.userName;
      }
      mm.identifyingVoices = null;
    });
    applyLiveEntries(id, { onlyLive: true });
    return meetingFull(id);
  } catch (e) {
    storage.update(id, { identifyingVoices: null });
    throw e;
  } finally {
    identifying.delete(id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function liveFor(id) {
  if (!lives.has(id)) {
    lives.set(
      id,
      new LiveMeeting({
        apiKey: getApiKey(),
        onEntry: (e, track) => {
          const st = voiceStateFor(id);
          e.id = ++st.seq;
          storage.update(id, (m) => (m.liveEntries = m.liveEntries || []).push(e));
          setImmediate(() => identifyVoice(id, e, track));
        },
        onGap: (track, at) => storage.update(id, (m) => (m.liveGaps = m.liveGaps || []).push({ track, at })),
      })
    );
  }
  return lives.get(id);
}

// Delar en Live-replik i meningar och ger varje mening rösten som hördes vid den tidpunkten
// (texten fördelas jämnt över replikens tid). Sammanhängande meningar med samma röst slås ihop.
function splitByVoice(e) {
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

// Fördelar Live-texten på segmenten. Segment där anslutningen bröts markeras för
// vanlig transkribering i efterhand.
function applyLiveEntries(id, { onlyLive = false } = {}) {
  storage.update(id, (m) => {
    if (onlyLive && !(m.liveEntries || []).length) return;
    const entries = (m.liveEntries || []).slice().sort((a, b) => a.t - b.t);
    const gaps = m.liveGaps || [];
    const label = m.mode === 'physical' ? { mic: 'Deltagare' } : { mic: settings.userName || 'Jag', system: 'Övriga deltagare' };
    // Digitala möten: rösten som främst hörs i mikrofonen är du – få ditt namn om den inte namngetts.
    if (m.mode !== 'physical' && settings.userName) {
      const micCount = {};
      for (const e of entries) if (e.voice && e.track === 'mic') micCount[e.voice] = (micCount[e.voice] || 0) + 1;
      const top = Object.entries(micCount).sort((a, b) => b[1] - a[1])[0];
      m.speakerMap = m.speakerMap || {};
      if (top && !m.speakerMap[top[0]]) m.speakerMap[top[0]] = settings.userName;
    }
    m.segments.forEach((s, i) => {
      const start = s.startOffset;
      const end = start + (s.durationSec || 0);
      const isLast = i === m.segments.length - 1;
      if (onlyLive && (s.engine !== 'live' || s.voicesIdentified)) return;
      if (gaps.some((g) => g.at >= start - 1 && g.at < end + 1)) {
        s.status = 'pending';
        return;
      }
      const mine = entries
        .filter((e) => e.t >= start - 0.5 && (e.t < end || isLast) && label[e.track])
        .flatMap((e) =>
          splitByVoice(e).map((p) => ({ t: Math.max(start, p.t), end: p.t + p.text.split(/\s+/).length / 2.5, speaker: p.voice || label[e.track], text: p.text, track: e.track }))
        );
      s.transcript = cleanupEntries(mine);
      s.status = 'done';
      s.engine = 'live';
    });
  });
}

// ---------------------------------------------------------------- Transkribering
const queues = new Map(); // meetingId -> Promise-kedja

async function runPool(items, concurrency, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

function enqueue(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => console.error(e));
  queues.set(id, next);
  return next;
}

const TRACK_INFO = {
  mic: (m) => ({
    label: 'MIKROFON',
    description:
      m.mode === 'physical'
        ? 'Rumsmikrofon i ett fysiskt möte. Innehåller alla deltagare i rummet.'
        : `Användarens egen mikrofon (${settings.userName || 'användaren'}).`,
  }),
  system: () => ({ label: 'SYSTEMLJUD', description: 'Datorns ljudutgång – övriga deltagare i det digitala mötet.' }),
};

// Ord-överlapp mellan två texter (0–1), för att hitta eko av högtalarljud i mikrofonen.
function similarity(a, b) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

// Lokal transkribering: varje spår för sig med whisper.cpp. Talare kommer från spåret
// (mikrofon = du, systemljud = övriga), eftersom Whisper inte kan skilja på röster.
async function transcribeLocal(m, seg, tmpDir) {
  const labels = m.mode === 'physical' ? { mic: 'Deltagare' } : { mic: settings.userName || 'Jag', system: 'Övriga deltagare' };
  const all = [];
  for (const key of ['mic', 'system']) {
    const rel = seg.files?.[key];
    if (!rel || !labels[key]) continue;
    const src = storage.resolveInMeeting(m.id, rel);
    if (!fs.existsSync(src) || fs.statSync(src).size < 2000) continue;
    const wav = path.join(tmpDir, key + '.wav');
    await audio.toWav16k(src, wav);
    for (const s of await localWhisper.transcribeWav(wav, { modelId: settings.localModel })) all.push({ ...s, speaker: labels[key], track: key });
  }
  return cleanupEntries(all);
}

// Tar bort mikrofonrepliker som bara är eko av systemljudet (högtalare i stället för headset)
// och slår ihop korta meningar från samma talare till stycken.
function cleanupEntries(all) {
  const sys = all.filter((e) => e.track === 'system');
  const kept = all.filter((e) => e.track !== 'mic' || !sys.some((s) => s.t < e.end + 2 && e.t < s.end + 2 && similarity(e.text, s.text) > 0.6));
  kept.sort((a, b) => a.t - b.t);
  // Slå ihop korta meningar från samma talare till stycken.
  const out = [];
  for (const e of kept) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === e.speaker && e.t - prev.end < 2 && prev.text.length < 450) {
      prev.text += ' ' + e.text;
      prev.end = e.end;
    } else out.push({ ...e });
  }
  return out.map(({ t, speaker, text }) => ({ t, speaker, text }));
}

async function transcribeSegment(id, index, engine = settings.transcriptionEngine) {
  let m = storage.load(id);
  const seg = m.segments.find((s) => s.index === index);
  if (!seg || seg.status === 'done') return; // kan ha köats två gånger
  storage.update(id, (mm) => {
    const s = mm.segments.find((x) => x.index === index);
    s.status = 'transcribing';
    s.error = null;
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisperlog-'));
  try {
    if (engine === 'local') {
      const entries = (seg.durationSec || 0) < 1 ? [] : await transcribeLocal(m, seg, tmpDir);
      storage.update(id, (mm) => {
        const s = mm.segments.find((x) => x.index === index);
        s.status = 'done';
        s.engine = 'local';
        s.transcript = entries.map((e) => ({ ...e, t: Math.round((s.startOffset + e.t) * 10) / 10 }));
      });
      return;
    }
    const tracks = [];
    for (const key of ['mic', 'system']) {
      const rel = seg.files?.[key];
      if (!rel) continue;
      const src = storage.resolveInMeeting(id, rel);
      if (!fs.existsSync(src) || fs.statSync(src).size < 2000) continue;
      let mp3 = src;
      if (!src.toLowerCase().endsWith('.mp3')) {
        mp3 = path.join(tmpDir, `${key}.mp3`);
        await audio.toSpeechMp3(src, mp3);
      }
      tracks.push({ path: mp3, ...TRACK_INFO[key](m) });
    }
    if (!tracks.length || (seg.durationSec || 0) < 1) {
      storage.update(id, (mm) => {
        const s = mm.segments.find((x) => x.index === index);
        s.status = 'done';
        s.transcript = [];
      });
      return;
    }
    m = storage.load(id);
    const earlier = storage.fullTranscript(m).filter((e) => e.t < seg.startOffset);
    const knownSpeakers = [...new Set(earlier.map((e) => e.speaker))];
    const previousTail = earlier
      .slice(-8)
      .map((e) => `${e.speaker}: ${e.text}`)
      .join('\n');
    const run = () => withModel('flash', (models) => gemini.transcribe({
      apiKey: getApiKey(),
      models,
      tracks,
      userName: settings.userName,
      participants: m.participants,
      mode: m.mode,
      knownSpeakers,
      previousTail,
      durationSec: seg.durationSec,
    }));
    let entries;
    try {
      entries = await run();
    } catch (e) {
      // Tillfälligt nätverks-/serverfel: ett nytt försök efter en stund innan vi ger upp.
      if (!/nätverksfel|överbelastat|kvoten är slut/i.test(e.message)) throw e;
      // Finns en lokal modell används den direkt i stället för att vänta på Google.
      const ls = localWhisper.status();
      if (ls.binInstalled && ls.models[settings.localModel]?.installed) {
        console.warn('Gemini otillgängligt (' + e.message + ') – transkriberar segment ' + index + ' lokalt');
        const local = await transcribeLocal(m, seg, tmpDir);
        storage.update(id, (mm) => {
          const s = mm.segments.find((x) => x.index === index);
          s.status = 'done';
          s.engine = 'local';
          s.transcript = local.map((x) => ({ ...x, t: Math.round((s.startOffset + x.t) * 10) / 10 }));
        });
        return;
      }
      console.error('Segment ' + index + ' misslyckades, försöker igen om 45 s:', e.message);
      await new Promise((r) => setTimeout(r, 45000));
      entries = await run();
    }
    storage.update(id, (mm) => {
      const s = mm.segments.find((x) => x.index === index);
      s.status = 'done';
      s.engine = 'gemini';
      s.transcript = entries.map((e) => ({ ...e, t: Math.round((s.startOffset + e.t) * 10) / 10 }));
    });
  } catch (e) {
    console.error('Transkribering misslyckades (segment ' + index + ')', e);
    storage.update(id, (mm) => {
      const s = mm.segments.find((x) => x.index === index);
      s.status = 'error';
      s.error = String(e.message || e);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function buildArchiveAudio(id) {
  const m = storage.load(id);
  const files = m.segments
    .map((s) => s.files?.mix || s.files?.mic)
    .filter(Boolean)
    .map((rel) => storage.resolveInMeeting(id, rel));
  if (!files.length) return;
  const out = path.join(storage.meetingDir(id), 'audio.mp3');
  await audio.concatToMp3(files, out);
  storage.update(id, { audioFile: 'audio.mp3' });
}

// transcribe=false: spara bara ljudet; transkribering startas sedan med en knapp.
async function finalizeMeeting(id, { transcribe = true, engine = settings.transcriptionEngine } = {}) {
  const live = lives.get(id);
  if (live) {
    await live.finish().catch((e) => console.error(e));
    lives.delete(id);
  }
  if (storage.load(id).liveEnabled && engine === 'live') {
    applyLiveEntries(id);
    engine = 'gemini'; // eventuella luckor transkriberas i efterhand (med lokal reserv)
  } else if (engine === 'live') engine = 'gemini';
  storage.update(id, (m) => {
    m.status = 'processing';
    m.error = null;
    if (!m.endedAt) m.endedAt = new Date().toISOString();
    m.durationSec = Math.max(m.durationSec || 0, ...m.segments.map((s) => s.startOffset + (s.durationSec || 0)));
  });
  // Segment som inte hann transkriberas (t.ex. efter krasch) köas.
  const toRun = [];
  for (const s of storage.load(id).segments) {
    if (s.status !== 'done' && s.status !== 'transcribing') {
      if (s.status === 'recording') {
        const dur = await audio.duration(storage.resolveInMeeting(id, s.files.mix || s.files.mic)).catch(() => 0);
        storage.update(id, (mm) => {
          const x = mm.segments.find((y) => y.index === s.index);
          x.durationSec = dur;
          x.status = 'pending';
        });
      }
      toRun.push(s.index);
    }
  }
  // Flera delar samtidigt mot Gemini; lokalt en i taget (processorn är redan fullt utnyttjad).
  if (transcribe && toRun.length) enqueue(id, () => runPool(toRun, engine === 'local' ? 1 : 3, (i) => transcribeSegment(id, i, engine)));
  // Ljudfilen för arkivet byggs parallellt – texten ska inte behöva vänta på den.
  const audioDone = buildArchiveAudio(id).catch((e) => {
    console.error(e);
    storage.update(id, { error: 'Kunde inte skapa ljudfil: ' + e.message });
  });
  if (!transcribe) {
    await audioDone;
    const mm = storage.load(id);
    const allDone = mm.segments.length && mm.segments.every((s) => s.status === 'done');
    storage.update(id, { status: allDone ? (mm.hasProtocol ? 'done' : 'transcribed') : 'recorded' });
    notify('Mötet är sparat', mm.title + ' – öppna mötet och klicka på Transkribera när du vill.', () => openMeeting(id));
    return;
  }
  await (queues.get(id) || Promise.resolve());
  audioDone.then(() => send('meeting:updated', id));
  {
    const mm = storage.load(id);
    const redone = mm.liveEnabled ? mm.segments.filter((s) => s.status === 'done' && s.engine && s.engine !== 'live' && !s.voicesIdentified).map((s) => s.index) : [];
    if (redone.length && voices.ready()) await identifyVoicesPostHoc(id, { only: redone }).catch((e) => console.warn('Röstidentifiering i efterhand misslyckades:', e.message));
  }
  const m = storage.load(id);
  const failed = m.segments.filter((s) => s.status === 'error');
  if (failed.length) {
    storage.update(id, { status: 'error', error: `Transkriberingen misslyckades för ${failed.length} del(ar): ${failed[0].error}` });
    notify('Transkriberingen misslyckades', m.title + ': ' + failed[0].error, () => openMeeting(id));
    return;
  }
  storage.update(id, { status: m.hasProtocol ? 'done' : 'transcribed' });
  if (settings.autoProtocol && !m.hasProtocol && getApiKey()) {
    try {
      await generateProtocol(id);
      notify('Mötesprotokollet är klart', m.title, () => openMeeting(id));
    } catch (e) {
      storage.update(id, { error: 'Protokoll: ' + e.message });
      notify('Protokollet kunde inte skapas', e.message, () => openMeeting(id));
    }
  } else {
    notify('Transkriberingen är klar', m.title, () => openMeeting(id));
  }
}

function openMeeting(id) {
  showWindow();
  send('nav:meeting', id);
}

const generating = new Set();
async function generateProtocol(id, kind = 'protocol') {
  if (generating.has(id)) throw new Error('Ett dokument skapas redan för mötet');
  generating.add(id);
  storage.update(id, { generatingProtocol: true, generatingKind: kind, error: null });
  try {
    const m = storage.load(id);
    const attachments = (kind) =>
      m.attachments.filter((a) => a.kind === kind).map((a) => ({ name: a.name, path: storage.resolveInMeeting(id, a.file) }));
    const templateTexts = [];
    for (const tid of m.templateMeetingIds || []) {
      try {
        const tm = storage.load(tid);
        const text = storage.readProtocol(tid);
        if (tm && text) templateTexts.push({ name: `Protokoll: ${tm.title}`, text });
      } catch {
        /* borttaget möte */
      }
    }
    const md = await withModel('pro', (models) => gemini.generateProtocol({
      apiKey: getApiKey(),
      models,
      meeting: m,
      transcriptText: storage.transcriptAsText(m),
      agendaFiles: attachments('agenda'),
      templateFiles: attachments('template'),
      templateTexts,
      userName: settings.userName,
      kind,
    }));
    storage.writeDoc(id, kind, md, true);
    return md;
  } finally {
    generating.delete(id);
    storage.update(id, { generatingProtocol: false, generatingKind: null });
  }
}

// ---------------------------------------------------------------- Mediaprotokoll (uppspelning med spolning)
const MIME = { '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

function registerMediaProtocol() {
  protocol.handle('wlmedia', async (request) => {
    try {
      const url = new URL(request.url);
      const [id, ...rest] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
      const file = storage.resolveInMeeting(id, rest.join('/'));
      const size = fs.statSync(file).size;
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = request.headers.get('range');
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        const stream = fs.createReadStream(file, { start, end });
        return new Response(require('stream').Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return new Response(require('stream').Readable.toWeb(fs.createReadStream(file)), {
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- IPC
function meetingFull(id) {
  const m = storage.load(id);
  if (!m) return null;
  return {
    ...m,
    protocol: storage.readDoc(id, 'protocol'),
    notes: storage.readDoc(id, 'notes'),
    wordTemplate: (m.attachments || []).find((a) => a.kind === 'template' && /\.docx$/i.test(a.name))?.name || null,
    dir: storage.meetingDir(id),
  };
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  h('settings:get', () => publicSettings());
  h('settings:set', (patch) => {
    if ('apiKey' in patch) {
      setApiKey(patch.apiKey);
      modelCache = null;
      delete patch.apiKey;
    }
    const oldDir = settings.storageDir;
    Object.assign(settings, patch);
    saveSettings();
    if (settings.storageDir !== oldDir) storage.setBaseDir(settings.storageDir);
    applyLoginItem();
    applyShortcut();
    applyDetector();
    updateTray();
    return publicSettings();
  });
  h('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.storageDir });
    return r.canceled ? null : r.filePaths[0];
  });

  h('gemini:models', () => gemini.listModels(getApiKey()));
  h('gemini:test', async (apiKey) => {
    const r = await gemini.testKey(apiKey || getApiKey());
    // Tomt = automatiskt val med modellväxling (snabbast). Kan låsas manuellt i fälten.
    settings.transcribeModel = '';
    settings.protocolModel = '';
    modelCache = r.models;
    saveSettings();
    return { transcribeModel: r.transcribeModel, protocolModel: r.protocolModel, note: r.note };
  });

  h('dialog:openFiles', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: opts.filters || [
        { name: 'Dokument', extensions: ['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg'] },
        { name: 'Alla filer', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
  });

  h('meetings:list', () => storage.list());
  h('meetings:get', (id) => meetingFull(id));
  h('meetings:create', (data) => meetingFull(storage.create(data).id));
  h('meetings:update', (id, patch) => {
    const allowed = ['title', 'participants', 'organization', 'agendaText', 'instructions', 'templateMeetingIds', 'speakerMap', 'mode'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    storage.update(id, clean);
    return meetingFull(id);
  });
  // change = ny text (sträng) eller { text?, speaker? } – speaker ändrar bara denna replik.
  h('meetings:editEntry', (id, segIndex, entryIndex, change) => {
    const patch = typeof change === 'string' ? { text: change } : change || {};
    storage.update(id, (m) => {
      const s = m.segments.find((x) => x.index === segIndex);
      const e = s?.transcript?.[entryIndex];
      if (!e) return;
      if (typeof patch.text === 'string') e.text = patch.text;
      if (patch.speaker) e.speaker = patch.speaker;
    });
    return meetingFull(id);
  });
  h('meetings:identifyVoices', (id) => identifyVoicesPostHoc(id));
  h('meetings:delete', async (id) => {
    const dir = storage.remove(id);
    await shell.trashItem(dir); // till papperskorgen, inte permanent radering
    return true;
  });
  h('meetings:addFiles', (id, files, kind) => {
    for (const f of files) storage.addAttachment(id, f.path, kind);
    return meetingFull(id);
  });
  h('meetings:removeAttachment', (id, attId) => {
    storage.removeAttachment(id, attId);
    return meetingFull(id);
  });
  h('meetings:openFolder', (id) => shell.openPath(storage.meetingDir(id)));
  h('meetings:openFile', (id, rel) => shell.openPath(storage.resolveInMeeting(id, rel)));
  h('meetings:transcribe', (id, engine) => {
    storage.update(id, (m) => {
      for (const s of m.segments) if (s.status === 'error') s.status = 'pending';
    });
    finalizeMeeting(id, { transcribe: true, engine: engine || settings.transcriptionEngine });
    return true;
  });
  h('meetings:finalize', (id) => {
    finalizeMeeting(id, { transcribe: !!settings.autoTranscribe });
    return true;
  });
  h('meetings:retranscribe', async (id, onlyFailed, engine) => {
    storage.update(id, (m) => {
      m.status = 'processing';
      m.error = null;
      for (const s of m.segments) if (!onlyFailed || s.status === 'error') s.status = 'pending';
    });
    finalizeMeeting(id, { transcribe: true, engine: engine || settings.transcriptionEngine });
    return true;
  });
  h('storage:openRoot', () => shell.openPath(storage.getBaseDir()));

  // --- Lokal Whisper
  h('whisper:status', () => localWhisper.status());
  h('whisper:install', async (modelId) => {
    await localWhisper.install(modelId, (text, fraction) => send('whisper:progress', { modelId, text, fraction }));
    return localWhisper.status();
  });
  h('whisper:remove', (modelId) => {
    localWhisper.removeModel(modelId);
    return localWhisper.status();
  });

  h('protocol:generate', (id, kind) => generateProtocol(id, kind || 'protocol'));
  h('protocol:save', (id, md, kind) => {
    storage.writeDoc(id, kind || 'protocol', md);
    return meetingFull(id);
  });
  // Word enligt mallen: fyller mötets Word-mall (sidhuvud, sidfot, loggor) med det nya innehållet.
  h('export:wordTemplate', async (id, defaultName, generated) => {
    const m = storage.load(id);
    const tpl = m.attachments.find((a) => a.kind === 'template' && /\.docx$/i.test(a.name));
    if (!tpl) throw new Error('Mötet har ingen Word-mall bifogad');
    const buf = await fillTemplate(storage.resolveInMeeting(id, tpl.file), generated);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: 'Word', extensions: ['docx'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, buf);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  // --- Inspelning (renderer skickar ljudbitar löpande så att inget går förlorat vid krasch)
  ipcMain.on('live:audio', (_e, id, track, data, offset) => {
    try {
      liveFor(id).push(track, Buffer.from(data), offset);
    } catch (e) {
      console.error('live:audio', e);
    }
  });
  h('rec:begin', (id) => {
    storage.update(id, (m) => {
      if (settings.transcriptionEngine === 'live' && getApiKey()) m.liveEnabled = true;
      m.status = 'recording';
      if (!m.startedAt) m.startedAt = new Date().toISOString();
    });
    return meetingFull(id);
  });
  h('rec:segmentStart', (id, index, startOffset, tracks) => {
    storage.update(id, (m) => {
      const files = {};
      for (const t of tracks) {
        files[t] = `segments/seg-${String(index).padStart(3, '0')}-${t}.webm`;
        fs.writeFileSync(storage.resolveInMeeting(id, files[t]), Buffer.alloc(0));
      }
      m.segments.push({ index, startOffset, durationSec: 0, files, status: 'recording', transcript: [] });
      m.status = 'recording';
    });
  });
  h('rec:chunk', (id, index, track, data) => {
    fs.appendFileSync(storage.resolveInMeeting(id, `segments/seg-${String(index).padStart(3, '0')}-${track}.webm`), Buffer.from(data));
  });
  h('rec:segmentEnd', (id, index, durationSec) => {
    storage.update(id, (m) => {
      const s = m.segments.find((x) => x.index === index);
      s.durationSec = durationSec;
      s.status = 'pending';
      m.durationSec = s.startOffset + durationSec;
    });
    if (settings.autoTranscribe && !storage.load(id).liveEnabled) enqueue(id, () => transcribeSegment(id, index));
  });
  h('rec:pause', (id, atSec, from) => {
    lives.get(id)?.pause();
    storage.update(id, (m) => {
      m.status = 'paused';
      m.pauses.push({ at: atSec, from: from || new Date().toISOString(), to: null });
    });
  });
  h('rec:resume', (id) => {
    storage.update(id, (m) => {
      m.status = 'recording';
      const p = m.pauses[m.pauses.length - 1];
      if (p && !p.to) p.to = new Date().toISOString();
    });
  });
  h('rec:finish', (id, durationSec) => {
    storage.update(id, (m) => {
      m.durationSec = durationSec;
      m.endedAt = new Date().toISOString();
      const p = m.pauses[m.pauses.length - 1];
      if (p && !p.to) p.to = m.endedAt;
    });
    const m = storage.load(id);
    finalizeMeeting(id, { transcribe: !!settings.autoTranscribe || !!m.liveEnabled, engine: m.liveEnabled ? 'live' : settings.transcriptionEngine });
    return true;
  });
  h('rec:state', (state) => {
    recState = { ...recState, ...state };
    const active = recState.status === 'recording' || recState.status === 'paused';
    if (active && powerBlockId === null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && powerBlockId !== null) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = null;
    }
    updateTray();
  });

  h('import:audio', async (data) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Ljud/video', extensions: ['mp3', 'wav', 'm4a', 'webm', 'ogg', 'mp4', 'aac', 'flac', 'mkv', 'mov'] }],
    });
    if (r.canceled) return null;
    const src = r.filePaths[0];
    const m = storage.create({ ...data, title: data.title || path.basename(src, path.extname(src)), source: 'import', mode: data.mode || 'physical' });
    const dir = storage.meetingDir(m.id);
    storage.update(m.id, { status: 'processing', startedAt: fs.statSync(src).mtime.toISOString() });
    (async () => {
      try {
        const seconds = (settings.segmentMinutes || 10) * 60;
        await audio.split(src, path.join(dir, 'segments', 'seg-%03d-mic.mp3'), seconds);
        const parts = fs.readdirSync(path.join(dir, 'segments')).filter((f) => /^seg-\d{3}-mic\.mp3$/.test(f)).sort();
        let offset = 0;
        const segs = [];
        for (const [i, f] of parts.entries()) {
          const d = await audio.duration(path.join(dir, 'segments', f));
          segs.push({ index: i, startOffset: offset, durationSec: d, files: { mic: 'segments/' + f }, status: 'pending', transcript: [] });
          offset += d;
        }
        storage.update(m.id, { segments: segs, durationSec: offset, endedAt: new Date().toISOString() });
        await finalizeMeeting(m.id, { transcribe: !!settings.autoTranscribe });
      } catch (e) {
        storage.update(m.id, { status: 'error', error: 'Import misslyckades: ' + e.message });
      }
    })();
    return meetingFull(m.id);
  });

  // --- Export
  h('export:save', async (defaultName, data, filters) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defaultName), filters });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, Buffer.from(data));
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  h('export:pdf', async (defaultName, html) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled) return null;
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    const tmp = path.join(os.tmpdir(), `whisperlog-print-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    await pdfWin.loadURL(pathToFileURL(tmp).href);
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    pdfWin.destroy();
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(r.filePath, pdf);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  h('app:show', () => showWindow());
}

// ---------------------------------------------------------------- Uppstart
function recoverInterrupted() {
  for (const s of storage.list()) {
    if (['recording', 'paused', 'processing'].includes(s.status)) {
      storage.update(s.id, (m) => {
        m.status = 'interrupted';
        m.error = 'Appen stängdes innan mötet var färdigbehandlat. Klicka på "Slutför bearbetning".';
        for (const seg of m.segments) if (seg.status === 'transcribing') seg.status = 'pending';
      });
    }
  }
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  setupLogging();
  loadSettings();
  localWhisper.init(path.join(app.getPath('userData'), 'whisper'));
  voices.init(path.join(app.getPath('userData'), 'voices'));
  voices.ensureModel().catch((e) => console.warn('Röstmodellen kunde inte laddas ner:', e.message));
  storage.setBaseDir(settings.storageDir);
  recoverInterrupted();
  storage.events.on('updated', (id) => send('meeting:updated', id));

  // Fånga systemljud (loopback) när renderern anropar getDisplayMedia – utan dialog.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write'].includes(permission)));

  registerMediaProtocol();
  registerIpc();
  createWindow();
  createTray();
  applyShortcut();
  applyDetector();
  applyLoginItem();

  // Utvecklartest: simulera ett långt möte från en ljudfil (körs aldrig i den paketerade appen).
  if (!app.isPackaged && process.env.WHISPERLOG_SIMULATE) {
    const { simulate } = require('./simulate');
    setTimeout(async () => {
      try {
        const id = await simulate({ file: process.env.WHISPERLOG_SIMULATE, speed: Number(process.env.WHISPERLOG_SPEED || 4), storage, settings, liveFor, finalizeMeeting, log: (s) => console.log(s) });
        const t = Date.now();
        await generateProtocol(id);
        console.log(`SIM protokoll klart efter ${((Date.now() - t) / 1000).toFixed(1)} s, ${storage.readProtocol(id).length} tecken`);
      } catch (e) {
        console.error('SIM misslyckades', e);
      }
    }, 3000);
  }
});

app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault();
    requestQuit();
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  /* ligg kvar i tray */
});
