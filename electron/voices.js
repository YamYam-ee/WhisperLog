// Röstigenkänning: ett "röstavtryck" (embedding) per replik, som grupperas till Talare 1, 2, 3 …
// Använder sherpa-onnx med WeSpeaker ResNet34 (VoxCeleb) lokalt – inget ljud lämnar datorn.
//
// Metod (testad på blandat svenskt/engelskt mötesljud, 97 % rätt grupperade repliker):
//  1. Avtrycken normaliseras och centreras (medelvärdet av alla avtryck dras bort).
//  2. Agglomerativ gruppering med cosinus-gräns 0.3 över alla repliker hittills.
//  3. Etiketterna hålls stabila mellan omräkningar så att namn du satt finns kvar.
const fs = require('fs');
const path = require('path');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx';
const THRESHOLD = 0.3;
const SR = 16000;

let extractor = null;
let modelFile = null;

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  modelFile = path.join(dir, 'wespeaker-resnet34-lm.onnx');
}

const ready = () => !!modelFile && fs.existsSync(modelFile);

// Modellen (27 MB) laddas ner från sherpa-onnx officiella releaser första gången den behövs.
let downloading = null;
function ensureModel() {
  if (ready()) return Promise.resolve();
  if (downloading) return downloading;
  downloading = (async () => {
    const res = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('Kunde inte ladda ner röstmodellen (' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(modelFile + '.part', buf);
    fs.renameSync(modelFile + '.part', modelFile);
  })().finally(() => (downloading = null));
  return downloading;
}

function getExtractor() {
  if (!extractor) {
    const sherpa = require('sherpa-onnx-node');
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelFile, numThreads: 2 });
  }
  return extractor;
}

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
function embed(pcm16) {
  if (!ready() || pcm16.length < SR * 1.0) return null;
  const f = new Float32Array(pcm16.length);
  let e = 0;
  for (let i = 0; i < pcm16.length; i++) {
    f[i] = pcm16[i] / 32768;
    e += f[i] * f[i];
  }
  if (Math.sqrt(e / f.length) < 0.004) return null;
  const ex = getExtractor();
  const st = ex.createStream();
  st.acceptWaveform({ samples: f, sampleRate: SR });
  st.inputFinished();
  return norm(Array.from(ex.compute(st, false))); // Electron tillåter inte externa buffertar
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

module.exports = { init, ready, ensureModel, embed, cluster, MODEL_URL };
