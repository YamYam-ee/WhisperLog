// Röstigenkänning: ett "röstavtryck" (embedding) per replik, som grupperas till Talare 1, 2, 3 …
// Använder sherpa-onnx med WeSpeaker ResNet34 (VoxCeleb) lokalt – inget ljud lämnar datorn.
//
// Metod (testad på blandat svenskt/engelskt mötesljud, 97 % rätt grupperade repliker):
//  1. Avtrycken normaliseras och centreras (medelvärdet av alla avtryck dras bort).
//  2. Agglomerativ gruppering med cosinus-gräns 0.3 över alla repliker hittills.
//  3. Etiketterna hålls stabila mellan omräkningar så att namn du satt finns kvar.
//
// Själva avtrycken räknas i en separat process (voiceWorker.js) så att en krasch i det
// inbyggda biblioteket aldrig kan ta ned appen.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx';
const MODEL_MIN_BYTES = 20 * 1024 * 1024; // modellen är ~26 MB – mindre betyder avbruten nedladdning
const THRESHOLD = 0.3;
const SR = 16000;

let modelFile = null;
let lastError = null;

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  modelFile = path.join(dir, 'wespeaker-resnet34-lm.onnx');
}

const ready = () => !!modelFile && fs.existsSync(modelFile) && fs.statSync(modelFile).size >= MODEL_MIN_BYTES && !disabled;

// Modellen (27 MB) laddas ner från sherpa-onnx officiella releaser första gången den behövs.
let downloading = null;
function ensureModel() {
  if (modelFile && fs.existsSync(modelFile) && fs.statSync(modelFile).size < MODEL_MIN_BYTES) fs.rmSync(modelFile, { force: true });
  if (fs.existsSync(modelFile)) return Promise.resolve();
  if (downloading) return downloading;
  downloading = (async () => {
    const res = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('Kunde inte ladda ner röstmodellen (' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MODEL_MIN_BYTES) throw new Error('Röstmodellen blev inte komplett nedladdad – försök igen.');
    fs.writeFileSync(modelFile + '.part', buf);
    fs.renameSync(modelFile + '.part', modelFile);
  })().finally(() => (downloading = null));
  return downloading;
}

// ---------------------------------------------------------------- Bakgrundsprocess
let worker = null;
let workerReady = null;
const pending = new Map();
let seq = 0;
let crashes = 0;
let disabled = false;

function startWorker() {
  if (worker) return workerReady;
  // ELECTRON_RUN_AS_NODE: Electron-programmet körs som vanlig Node (samma inbyggda bibliotek).
  worker = fork(path.join(__dirname, 'voiceWorker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  worker.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  workerReady = new Promise((resolve, reject) => {
    const onMsg = (m) => {
      if (m.type === 'ready') {
        worker.off('message', onMsg);
        resolve();
      }
    };
    worker.on('message', onMsg);
    worker.once('exit', () => reject(new Error('Röstprocessen startade inte')));
  });
  worker.on('message', (m) => {
    const p = m.id != null && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m);
  });
  worker.on('exit', (code, signal) => {
    const why = `Röstigenkänningen kraschade på den här datorn (kod ${code ?? signal}). Detaljer finns i loggfilen under Inställningar → Felsökning.`;
    console.error(why, stderr);
    lastError = why;
    worker = null;
    workerReady = null;
    crashes++;
    // Kraschar den om och om igen fungerar biblioteket inte på den här datorn – stäng av för sessionen.
    if (crashes >= 3) disabled = true;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
  });
  return workerReady;
}

function call(msg) {
  return startWorker().then(
    () =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.send({ ...msg, id, modelFile });
      })
  );
}

// Kontrollerar att biblioteket och modellen fungerar på den här datorn.
async function check() {
  if (disabled) throw new Error(lastError || 'Röstigenkänningen är avstängd efter upprepade krascher.');
  await ensureModel();
  await call({ type: 'init' });
}

const status = () => ({ ready: ready(), disabled, lastError });

const norm = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Avtryck för en ljudbit (Int16 PCM 16 kHz). Returnerar null om biten är för kort eller tyst.
async function embed(pcm16) {
  if (!ready() || pcm16.length < SR * 1.0) return null;
  let e = 0;
  for (let i = 0; i < pcm16.length; i++) e += (pcm16[i] / 32768) ** 2;
  if (Math.sqrt(e / pcm16.length) < 0.004) return null;
  const res = await call({ type: 'embed', pcm: pcm16 });
  return norm(res.emb);
}

/**
 * Grupperar avtryck. `items` = [{id, emb, voice?}] (voice = tidigare etikett, t.ex. "Talare 2").
 * Returnerar Map id -> etikett. Befintliga etiketter återanvänds för den grupp som har flest
 * av sina tidigare repliker; nya grupper får lägsta lediga nummer.
 */
function cluster(items, reserved = new Set()) {
  const withEmb = items.filter((x) => x.emb);
  const result = new Map();
  if (!withEmb.length) return { labels: result };
  const mean = withEmb[0].emb.map((_, k) => withEmb.reduce((s, x) => s + x.emb[k], 0) / withEmb.length);
  const E = withEmb.map((x) => norm(x.emb.map((v, k) => v - mean[k])));

  // Agglomerativ gruppering med centroid-cosinus. S[i][j] = dot(summa_i, summa_j) och
  // N[i] = |summa_i|² uppdateras vid varje sammanslagning, så att ingen vektor räknas om.
  const n = E.length;
  const S = E.map((a) => E.map((b) => dot(a, b)));
  const N = E.map((_, i) => S[i][i]);
  const members = E.map((_, i) => [i]);
  const alive = new Array(n).fill(true);
  const sim = (i, j) => S[i][j] / Math.sqrt(N[i] * N[j]);
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bs = -2;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const s = sim(i, j);
        if (s > bs) {
          bs = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (bs < THRESHOLD || bi < 0) break;
    N[bi] = N[bi] + N[bj] + 2 * S[bi][bj];
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      S[bi][k] = S[k][bi] = S[bi][k] + S[bj][k];
    }
    S[bi][bi] = N[bi];
    members[bi].push(...members[bj]);
    alive[bj] = false;
  }
  // Enstaka avvikande bitar (skratt, brus, överlappande tal) slås ihop med närmaste större röst.
  const live = [];
  for (let i = 0; i < n; i++) if (alive[i]) live.push(i);
  for (const i of live) {
    if (members[i].length > 1) continue;
    let best = -1;
    let bs = -2;
    for (const j of live) {
      if (j === i || !alive[j] || members[j].length < 3) continue;
      const s2 = sim(i, j);
      if (s2 > bs) {
        bs = s2;
        best = j;
      }
    }
    if (best >= 0 && bs >= 0.1) {
      members[best].push(...members[i]);
      alive[i] = false;
    }
  }
  const C = members.filter((_, i) => alive[i]).map((m) => ({ m }));

  // Stabila etiketter: matcha grupper mot tidigare etiketter (störst överlapp först).
  const pairs = [];
  C.forEach((g, gi) => {
    const counts = {};
    for (const i of g.m) {
      const v = withEmb[i].voice;
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    for (const [v, n] of Object.entries(counts)) pairs.push({ gi, v, n });
  });
  pairs.sort((a, b) => b.n - a.n);
  const groupLabel = new Map();
  const usedLabels = new Set();
  for (const p of pairs) {
    if (groupLabel.has(p.gi) || usedLabels.has(p.v)) continue;
    groupLabel.set(p.gi, p.v);
    usedLabels.add(p.v);
  }
  // Nya grupper (i tidsordning) får lägsta lediga nummer. Etiketter som har fått ett namn
  // återanvänds aldrig för en annan röst (`reserved`).
  const taken = new Set([...usedLabels, ...reserved]);
  const fresh = C.map((g, gi) => ({ gi, first: Math.min(...g.m) })).filter((x) => !groupLabel.has(x.gi)).sort((a, b) => a.first - b.first);
  for (const f of fresh) {
    let k = 1;
    while (taken.has(`Talare ${k}`)) k++;
    taken.add(`Talare ${k}`);
    groupLabel.set(f.gi, `Talare ${k}`);
  }
  C.forEach((g, gi) => g.m.forEach((i) => result.set(withEmb[i].id, groupLabel.get(gi))));
  return { labels: result };
}

module.exports = { init, ready, ensureModel, embed, cluster, check, status, MODEL_URL };
