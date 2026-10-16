// Lokal transkribering med whisper.cpp. Program och modeller laddas ner vid behov
// till appens datamapp, så att ljudet aldrig behöver lämna datorn.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip';
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';

const MODELS = {
  'kb-small': {
    label: 'KB-Whisper Small – endast svenska, engelska översätts (175 MB)',
    url: 'https://huggingface.co/KBLab/kb-whisper-small/resolve/main/ggml-model-q5_0.bin',
    size: 175209680,
  },
  'kb-medium': {
    label: 'KB-Whisper Medium – endast svenska, engelska översätts (540 MB)',
    url: 'https://huggingface.co/KBLab/kb-whisper-medium/resolve/main/ggml-model-q5_0.bin',
    size: 539212484,
  },
  turbo: {
    label: 'Whisper Large-v3 Turbo – svenska + engelska, rekommenderas (575 MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    size: 574041195,
  },
};

let root = null;
const installing = new Map(); // modelId -> Promise

function init(dir) {
  root = dir;
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
}

const binDir = () => path.join(root, 'bin');
const cliPath = () => path.join(binDir(), 'Release', 'whisper-cli.exe');
const vadPath = () => path.join(root, 'models', 'vad-silero.bin');
const modelPath = (id) => path.join(root, 'models', `${id}.bin`);

function status() {
  const models = {};
  for (const [id, m] of Object.entries(MODELS)) {
    models[id] = { label: m.label, size: m.size, installed: fs.existsSync(modelPath(id)), installing: installing.has(id) };
  }
  return { binInstalled: fs.existsSync(cliPath()) && fs.existsSync(vadPath()), models };
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Nedladdningen misslyckades (${res.status}) – ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const part = dest + '.part';
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      onProgress?.(done, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
  fs.renameSync(part, dest);
}

function unzip(zip, dir) {
  // tar.exe (bsdtar) finns i Windows 10/11 och packar upp zip-filer.
  // Ange sökvägen explicit – annars kan t.ex. Git:s tar hittas först, och den förstår inte "C:".
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const run = (cmd, args) =>
    new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
  fs.mkdirSync(dir, { recursive: true });
  return run(tar, ['-xf', zip, '-C', dir]).catch(() =>
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}'`]).catch((e) => {
      throw new Error('Kunde inte packa upp whisper.cpp: ' + e.message);
    })
  );
}

// Installerar program + VAD (om det saknas) och vald modell. onProgress(text, fraction).
function install(id, onProgress) {
  if (!MODELS[id]) throw new Error('Okänd modell: ' + id);
  if (installing.has(id)) return installing.get(id);
  const p = (async () => {
    if (!fs.existsSync(cliPath())) {
      const zip = path.join(root, 'whisper-bin.zip');
      await download(BIN_URL, zip, (d, t) => onProgress?.('Laddar ner whisper.cpp…', t ? d / t : 0));
      await unzip(zip, binDir());
      fs.rmSync(zip, { force: true });
      if (!fs.existsSync(cliPath())) throw new Error('whisper-cli.exe saknas i nedladdningen');
    }
    if (!fs.existsSync(vadPath())) await download(VAD_URL, vadPath());
    if (!fs.existsSync(modelPath(id))) {
      await download(MODELS[id].url, modelPath(id), (d, t) => onProgress?.(`Laddar ner ${MODELS[id].label}…`, d / (t || MODELS[id].size)));
    }
    onProgress?.('Klar', 1);
  })().finally(() => installing.delete(id));
  installing.set(id, p);
  return p;
}

function removeModel(id) {
  fs.rmSync(modelPath(id), { force: true });
}

// Fraser som Whisper ofta "hittar på" vid tystnad/brus (från undertextade filmer i träningsdatan).
const HALLUCINATIONS = /^(tack\.?|tack så mycket\.?|tack för att (du|ni) (tittade|tittat|lyssnade|lyssnat).*|.*undertext.*|.*textning.*|.*prenumerera.*|thank you\.?|thanks for watching.*|you)$/i;
function isHallucination(text) {
  return text.length < 70 && HALLUCINATIONS.test(text.trim());
}

/**
 * Transkriberar en 16 kHz mono WAV-fil. Returnerar [{t, end, text}] i sekunder.
 */
function transcribeWav(wav, { modelId, language = 'sv' }) {
  if (!fs.existsSync(cliPath()) || !fs.existsSync(modelPath(modelId))) {
    throw new Error('Den lokala modellen är inte nedladdad. Ladda ner den under Inställningar → Transkribering.');
  }
  const outBase = path.join(os.tmpdir(), `whisperlog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
  const args = ['-m', modelPath(modelId), '-f', wav, '-l', language, '-t', String(threads), '-np', '-oj', '-of', outBase, '--vad', '-vm', vadPath(), '-sns'];
  return new Promise((resolve, reject) => {
    const p = spawn(cliPath(), args, { windowsHide: true, cwd: path.dirname(cliPath()) });
    // Låg prioritet så att datorn (och mötet) inte blir segt.
    try {
      os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* inte kritiskt */
    }
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    p.on('error', reject);
    p.on('close', (code) => {
      const json = outBase + '.json';
      try {
        if (code !== 0) throw new Error('whisper.cpp avslutades med kod ' + code + ': ' + err.slice(-400));
        const data = JSON.parse(fs.readFileSync(json, 'utf8'));
        resolve(
          (data.transcription || [])
            .map((s) => ({ t: (s.offsets?.from || 0) / 1000, end: (s.offsets?.to || 0) / 1000, text: String(s.text || '').trim() }))
            .filter((s) => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text) && !isHallucination(s.text))
        );
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(json, { force: true });
      }
    });
  });
}

module.exports = { MODELS, init, status, install, removeModel, transcribeWav };
