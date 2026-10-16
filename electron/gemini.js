// All kommunikation med Google Gemini: transkribering med talaridentifiering
// och generering av mötesprotokoll.
const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Type, createUserContent, createPartFromUri, createPartFromBase64 } = require('@google/genai');

// Filer upp till denna storlek skickas direkt i anropet (snabbare och ett nätverkssteg färre).
const INLINE_LIMIT = 7 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(apiKey) {
  if (!apiKey) throw new Error('Ingen Google API-nyckel angiven. Lägg till den under Inställningar.');
  return new GoogleGenAI({ apiKey });
}

function isRetryable(err) {
  const s = String(err?.status || err?.code || '') + ' ' + String(err?.message || '');
  return /\b(429|500|502|503|504)\b|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|terminated|network/i.test(s + ' ' + String(err?.cause?.code || err?.cause?.message || ''));
}

async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryable(e) || i === tries - 1) break;
      await sleep(4000 * 2 ** i);
    }
  }
  throw friendlyError(last);
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return new Error('Google API-nyckeln är ogiltig.');
  if (/limit: 0\b/.test(msg)) return new Error('Din API-nyckel har ingen kvot för den här modellen (gratisnivån). Välj en Flash-modell eller aktivera betalning i Google AI Studio.');
  if (/RESOURCE_EXHAUSTED|429/.test(msg)) return new Error('Gemini-kvoten är slut eller för många anrop. Försök igen om en stund.');
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg)) return new Error('Gemini är tillfälligt överbelastat hos Google. Försök igen om en stund.');
  if (/not found|NOT_FOUND/i.test(msg) && /model/i.test(msg)) return new Error('Modellen hittades inte. Välj en annan modell under Inställningar. (' + msg.slice(0, 200) + ')');
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|terminated|socket/i.test(msg)) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    return new Error('Kunde inte nå Googles servrar (nätverksfel' + (cause ? ': ' + cause : '') + '). Kontrollera internetanslutningen och försök igen.');
  }
  return e instanceof Error ? e : new Error(msg);
}

// ---------------------------------------------------------------- Snabb modellväxling
// Modeller som visat sig sakna kvot eller inte finnas hoppas över resten av sessionen.
const deadModels = new Set();

const isNetwork = (e) => /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|terminated/i.test(String(e?.message) + ' ' + String(e?.cause?.code || ''));
// Fel där nästa modell ska provas direkt i stället för att vänta (överbelastning, kvot, timeout …).
const shouldFallback = (e) =>
  /\b(429|500|502|503|504|404)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|NOT_FOUND|no longer available|timed? ?out|aborted|not supported/i.test(String(e?.message) + ' ' + String(e?.status || ''));

/**
 * Anropar Gemini med första fungerande modellen i `models`. Varje försök har en tidsgräns,
 * och vid överbelastning/kvot/timeout går vi direkt vidare till nästa modell.
 */
// "Tänkande" stängs av/minimeras där det går – det kostar sekunder och behövs inte för transkribering.
function fastConfig(model) {
  if (/flash-lite/.test(model)) return {};
  return { thinkingConfig: { thinkingLevel: 'LOW' } };
}

/**
 * Anropar modellerna i `models` med "hedging": den första startas direkt; svarar den inte inom
 * `hedgeMs` startas nästa parallellt, och det första lyckade svaret vinner (övriga avbryts).
 * Ett fel (överbelastning, kvot, timeout) startar nästa modell omedelbart.
 */
function generateFast(ai, models, request, { timeoutMs = 90000, hedgeMs = 15000, fast = false } = {}) {
  const list = models.filter((m) => !deadModels.has(m));
  if (!list.length) return Promise.reject(new Error('Ingen Gemini-modell tillgänglig för din API-nyckel.'));

  const call = async (model, signal) => {
    const extra = fast ? fastConfig(model) : {};
    const run = (cfg) => ai.models.generateContent({ ...request, model, config: { ...request.config, ...cfg, abortSignal: signal, httpOptions: { timeout: timeoutMs } } });
    try {
      return await run(extra);
    } catch (e) {
      // Modellen stödjer inte tänkandeinställningen – försök igen utan.
      if (Object.keys(extra).length && /thinking/i.test(String(e?.message)) && /\b400\b|INVALID_ARGUMENT/.test(String(e?.message))) return run({});
      throw e;
    }
  };

  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let round = 0;
    let done = false;
    let last = null;
    let hedgeTimer = null;
    const controllers = [];
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      controllers.forEach((c) => c.abort());
      fn(v);
    };
    const launch = () => {
      if (done) return;
      clearTimeout(hedgeTimer);
      if (next >= list.length) {
        if (running > 0) return; // vänta på de som redan kör
        if (round === 0) {
          // Alla modeller nekade: ett varv till efter en kort paus.
          round = 1;
          next = 0;
          hedgeTimer = setTimeout(launch, 2000);
          return;
        }
        return finish(reject, friendlyError(last));
      }
      const model = list[next++];
      if (deadModels.has(model)) return launch();
      running++;
      const ctrl = new AbortController();
      controllers.push(ctrl);
      hedgeTimer = setTimeout(launch, hedgeMs);
      const started = Date.now();
      call(model, ctrl.signal).then(
        (res) => {
          res.modelUsed = model;
          console.log(`Gemini ${model} svarade efter ${((Date.now() - started) / 1000).toFixed(1)} s`);
          finish(resolve, res);
        },
        (e) => {
          running--;
          if (done) return;
          last = e;
          if (/limit: 0\b|NOT_FOUND|no longer available/i.test(String(e?.message))) deadModels.add(model);
          if (!shouldFallback(e) && !isNetwork(e)) return finish(reject, friendlyError(e));
          console.warn(`Gemini ${model}: ${String(e?.message).slice(0, 120)} – provar nästa modell`);
          launch();
        }
      );
    };
    launch();
  });
}

/**
 * Ordnad lista med modeller att prova. Transkribering: Flash Lite först (tänker inte,
 * snabbast och minst överbelastad). Protokoll: Pro → Flash → Lite.
 */
function chainFor(models, kind, preferred) {
  const names = models.map((m) => m.name);
  const ver = (n) => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)-/)?.[1] || '0');
  const pick = (re) => names.filter((n) => re.test(n)).sort((a, b) => ver(b) - ver(a));
  const alias = (n) => (names.includes(n) ? [n] : []);
  const lite = pick(/^gemini-\d+(\.\d+)?-flash-lite$/);
  const flash = pick(/^gemini-\d+(\.\d+)?-flash$/);
  const pro = [...pick(/^gemini-\d+(\.\d+)?-pro$/), ...pick(/^gemini-\d+(\.\d+)?-pro-preview$/)];
  const chain =
    kind === 'transcribe'
      ? [...lite.slice(0, 2), ...alias('gemini-flash-lite-latest'), ...flash.slice(0, 2), ...alias('gemini-flash-latest')]
      : [...pro.slice(0, 1), ...flash.slice(0, 2), ...alias('gemini-flash-latest'), ...lite.slice(0, 1)];
  return [...new Set([preferred, ...chain].filter(Boolean))].filter((m) => !deadModels.has(m));
}

async function uploadAndWait(ai, filePath, mimeType) {
  let f = await withRetry(() => ai.files.upload({ file: filePath, config: { mimeType, displayName: path.basename(filePath) } }));
  const started = Date.now();
  while (String(f.state) === 'PROCESSING') {
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('Google bearbetade filen för länge: ' + path.basename(filePath));
    await sleep(2500);
    f = await ai.files.get({ name: f.name });
  }
  if (String(f.state) === 'FAILED') throw new Error('Google kunde inte bearbeta filen ' + path.basename(filePath));
  return f;
}

function cleanJson(text) {
  return String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

function parseTimestamp(v) {
  if (typeof v === 'number') return v;
  const parts = String(v || '0').trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const transcriptSchema = {
  type: Type.OBJECT,
  properties: {
    entries: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start: { type: Type.STRING, description: 'Starttid relativt ljudets början, format MM:SS' },
          speaker: { type: Type.STRING, description: 'Talarens namn eller etikett' },
          text: { type: Type.STRING, description: 'Det som sades, ordagrant' },
        },
        required: ['start', 'speaker', 'text'],
      },
    },
  },
  required: ['entries'],
};

/**
 * Transkriberar ett segment. `tracks` är [{path, label, description}] – alla filer
 * startar samtidigt. Returnerar [{t, speaker, text}] med t i sekunder relativt segmentet.
 */
async function transcribe({ apiKey, models, tracks, userName, participants, mode, knownSpeakers, previousTail, durationSec }) {
  const ai = client(apiKey);
  const uploaded = [];
  try {
    const inline = [];
    for (const t of tracks) {
      if (fs.statSync(t.path).size <= INLINE_LIMIT / tracks.length) inline.push({ ...t, part: createPartFromBase64(fs.readFileSync(t.path).toString('base64'), 'audio/mpeg') });
      else {
        const file = await uploadAndWait(ai, t.path, 'audio/mpeg');
        uploaded.push({ ...t, file });
        inline.push({ ...t, part: createPartFromUri(file.uri, file.mimeType) });
      }
    }

    const me = userName?.trim() || 'Jag';
    const lines = [
      'Du är en noggrann professionell mötestranskriberare.',
      'Transkribera allt tal i ljudet ordagrant. Rätta inte grammatik, men utelämna rena utfyllnadsljud ("öh", "eh", "um").',
      '',
      'Språk (mycket viktigt):',
      '- Mötet hålls främst på svenska men kan blanda svenska och engelska – mellan talare, mellan meningar och mitt i en mening.',
      '- Skriv varje del på EXAKT det språk som faktiskt talas. Översätt ALDRIG. Svenska skrivs som korrekt svenska med å, ä och ö; engelska skrivs som engelska.',
      '- Engelska fackuttryck och lånord i svenskt tal (t.ex. "deadline", "meeting", "feedback", "pitch") behålls som de sades.',
      '- Använd svensk stavning av svenska namn, orter, företag och begrepp. Siffror, belopp och datum skrivs som de uttalas i sitt språk.',
      '',
      'Ljudkällor:',
      ...inline.map((u) => `- "${u.label}": ${u.description}`),
      inline.length > 1
        ? 'Alla ljudfiler startar exakt samtidigt och ska vävas ihop till EN kronologisk transkription. Om röster från systemljudet även hörs svagt i mikrofonen (eko från högtalare) ska de bara tas med en gång.'
        : '',
      mode === 'physical'
        ? 'Detta är ett fysiskt möte där flera personer sitter i samma rum runt en mikrofon. Skilj noga på rösterna.'
        : `Rösten som hörs tydligast i mikrofonen är användaren, som ska kallas "${me}".`,
      '',
      'Talaridentifiering:',
      '- Skilj på olika röster och ge varje unik person en konsekvent etikett genom hela ljudet.',
      '- Använd ALDRIG ljudkällornas namn ("MIKROFON", "SYSTEMLJUD") som talare – de beskriver bara varifrån ljudet kommer.',
      '- Använd personens riktiga namn när det tydligt framgår (t.ex. när någon tilltalas, presenterar sig eller utifrån deltagarlistan). Annars "Talare 1", "Talare 2" osv.',
      participants?.trim() ? `- Kända deltagare: ${participants.trim()}` : '',
      `- Användaren heter "${me}". Stava alltid namn exakt som i användarnamnet och deltagarlistan – även om uttalet låter som en annan stavning.`,
      knownSpeakers?.length ? `- Etiketter som redan använts tidigare i samma möte (återanvänd dem för samma röster): ${knownSpeakers.join(', ')}` : '',
      previousTail ? `\nDe sista replikerna från föregående del av mötet (för sammanhang):\n${previousTail}` : '',
      '',
      'Format:',
      '- Ett nytt inlägg varje gång talaren byts, eller ungefär var 30:e sekund vid långa monologer.',
      `- "start" anges som MM:SS relativt ljudfilens början${durationSec ? ` (ljudet är cirka ${Math.round(durationSec)} sekunder långt)` : ''}.`,
      '- Hoppa över tystnad, musik och bakgrundsljud. Om inget tal finns, returnera en tom lista.',
    ].filter((l) => l !== '');

    const parts = [lines.join('\n')];
    for (const u of inline) {
      parts.push(`Ljudfil "${u.label}":`);
      parts.push(u.part);
    }

    const res = await generateFast(
      ai,
      models,
      { contents: createUserContent(parts), config: { responseMimeType: 'application/json', responseSchema: transcriptSchema, temperature: 0.2, maxOutputTokens: 65536 } },
      { timeoutMs: 60000 + (durationSec || 60) * 400, hedgeMs: 10000 + (durationSec || 60) * 60, fast: true }
    );
    const data = JSON.parse(cleanJson(res.text));
    return (data.entries || [])
      .map((e) => ({
        t: Math.max(0, Math.min(parseTimestamp(e.start), durationSec || Infinity)),
        speaker: String(e.speaker || 'Okänd').trim(),
        text: String(e.text || '').trim(),
      }))
      .filter((e) => e.text);
  } finally {
    for (const u of uploaded) ai.files.delete({ name: u.file.name }).catch(() => {});
  }
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.rtf']);
const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Gör om en fil till något Gemini kan läsa: text (docx/txt) eller uppladdad fil (pdf/bild).
async function fileToParts(ai, file, uploadedList) {
  const ext = path.extname(file.path).toLowerCase();
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ path: file.path });
    return [`--- ${file.name} ---\n${value}`];
  }
  if (TEXT_EXT.has(ext)) return [`--- ${file.name} ---\n${fs.readFileSync(file.path, 'utf8')}`];
  if (MIME[ext]) {
    const up = await uploadAndWait(ai, file.path, MIME[ext]);
    uploadedList.push(up);
    return [`--- ${file.name} (bifogad fil) ---`, createPartFromUri(up.uri, up.mimeType)];
  }
  return [`--- ${file.name} --- (filformatet kan inte läsas och har hoppats över)`];
}

/**
 * Skapar ett mötesprotokoll i Markdown.
 * agendaFiles / templateFiles: [{name, path}], templateTexts: [{name, text}]
 */
async function generateProtocol({ apiKey, models, meeting, transcriptText, agendaFiles, templateFiles, templateTexts, userName }) {
  const ai = client(apiKey);
  const uploaded = [];
  try {
    const date = new Date(meeting.startedAt || meeting.createdAt);
    const hasAgenda = !!(meeting.agendaText?.trim() || agendaFiles.length);
    const hasTemplates = !!(templateFiles.length || templateTexts.length);

    const parts = [
      [
        'Du är en erfaren mötessekreterare. Skriv ett professionellt mötesprotokoll på svenska utifrån transkriptionen nedan.',
        '',
        'Krav:',
        '- Svara ENDAST med protokollet i Markdown (inga förklaringar före eller efter, inga kodblock runt).',
        '- Skriv protokollet på korrekt, professionell svenska – även när delar av mötet hölls på engelska. Sammanfatta engelska inlägg på svenska; etablerade engelska fackuttryck och namn får stå kvar.',
        '- Stava deltagarnas namn exakt som i deltagarlistan och användarnamnet.',
        '- Var saklig och koncis. Sammanfatta diskussioner, återge inte ordagrant.',
        '- Ta tydligt med beslut, åtgärdspunkter (vad, ansvarig, ev. deadline) och öppna frågor.',
        '- Hitta inte på uppgifter som inte finns i underlaget. Om något är oklart, skriv det.',
        '- Talaretiketter som "Talare 1" ska inte användas som namn i protokollet om personens namn inte är känt – beskriv då rollen eller skriv "en deltagare".',
        '- Etiketterna "Övriga deltagare" och "Deltagare" betyder att talaren inte är identifierad (flera personer kan dölja sig bakom samma etikett). Härled vem som säger vad ur sammanhanget (tilltal, presentationer, deltagarlistan) när det går, annars skriv neutralt.',
        hasAgenda
          ? '- Protokollet SKA följa agendans struktur och punktordning. Varje agendapunkt blir en egen rubrik/paragraf. Diskussioner som inte passar någon punkt läggs under "Övriga frågor".'
          : '- Ingen agenda finns: strukturera protokollet efter de ämnen som diskuterades.',
        hasTemplates
          ? '- Tidigare protokoll bifogas som MALL. Efterlikna deras layout, rubriker, numrering, ton, tabeller och detaljnivå så nära som möjligt – men använd endast innehåll från detta möte.'
          : '- Använd en klassisk protokollstruktur: rubrik, datum/tid, närvarande, punkter (§1, §2 …), beslut, åtgärdslista i tabell, nästa möte om det nämns.',
        meeting.instructions?.trim() ? `\nSärskilda instruktioner från användaren:\n${meeting.instructions.trim()}` : '',
        '',
        'Mötesinformation:',
        `- Rubrik: ${meeting.title}`,
        `- Datum: ${date.toLocaleDateString('sv-SE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        `- Starttid: ${date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`,
        `- Längd (inspelad tid): cirka ${Math.round((meeting.durationSec || 0) / 60)} minuter`,
        `- Typ: ${meeting.mode === 'physical' ? 'Fysiskt möte' : 'Digitalt möte'}`,
        `- Protokollet förs av / användaren: ${userName || 'okänd'}`,
        meeting.participants?.trim() ? `- Angivna deltagare: ${meeting.participants.trim()}` : '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    ];

    if (hasAgenda) {
      parts.push('\n=== AGENDA ===');
      if (meeting.agendaText?.trim()) parts.push(meeting.agendaText.trim());
      for (const f of agendaFiles) parts.push(...(await fileToParts(ai, f, uploaded)));
    }
    if (hasTemplates) {
      parts.push('\n=== TIDIGARE PROTOKOLL (MALL – endast för form och stil) ===');
      for (const t of templateTexts) parts.push(`--- ${t.name} ---\n${t.text}`);
      for (const f of templateFiles) parts.push(...(await fileToParts(ai, f, uploaded)));
    }
    parts.push('\n=== TRANSKRIPTION ([tid] talare: text) ===\n' + (transcriptText || '(ingen transkription)'));

    const res = await generateFast(ai, models, { contents: createUserContent(parts), config: { temperature: 0.4, maxOutputTokens: 65536 } }, { timeoutMs: Math.min(300000, 90000 + (transcriptText || '').length), hedgeMs: 40000 });
    return String(res.text || '')
      .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
      .replace(/\n```\s*$/, '')
      .trim();
  } finally {
    for (const u of uploaded) ai.files.delete({ name: u.name }).catch(() => {});
  }
}

async function listModels(apiKey) {
  const ai = client(apiKey);
  const out = [];
  const pager = await withRetry(() => ai.models.list({ config: { pageSize: 100 } }));
  for await (const m of pager) {
    const name = String(m.name || '').replace(/^models\//, '');
    const actions = m.supportedActions || [];
    if (name.startsWith('gemini') && (!actions.length || actions.includes('generateContent')) && !/embedding|image|tts|live|audio/i.test(name)) {
      out.push({ name, displayName: m.displayName || name });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
}

// Modellkandidater av en sort ("flash" eller "pro"), bäst först:
// nyaste numrerade stabila (gemini-3.8-flash), sedan preview-versioner, sist "-latest"-alias.
function modelCandidates(models, kind) {
  const names = models.map((m) => m.name);
  const version = (n) => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)-/)?.[1] || '0');
  const byVersion = (a, b) => version(b) - version(a);
  const stable = names.filter((n) => new RegExp(`^gemini-\\d+(\\.\\d+)?-${kind}$`).test(n)).sort(byVersion);
  const preview = names.filter((n) => new RegExp(`^gemini-\\d+(\\.\\d+)?-${kind}-preview$`).test(n)).sort(byVersion);
  const latest = names.filter((n) => n === `gemini-${kind}-latest`);
  return [...stable, ...preview, ...latest];
}

function pickModel(models, kind) {
  return modelCandidates(models, kind)[0] || null;
}

function isModelMissing(err) {
  return /model/i.test(String(err?.message)) && /hittades inte|not found|no longer available|NOT_FOUND|404/i.test(String(err?.message));
}

// Modellen finns men nyckeln saknar kvot för den (t.ex. Pro på gratisnivån).
function isNoQuota(err) {
  return /kvot|quota|RESOURCE_EXHAUSTED|429/i.test(String(err?.message));
}

// Verifierar nyckeln med ett snabbt anrop. Modell väljs sedan automatiskt per anrop
// (med växling vid överbelastning), så inget behöver låsas här.
async function testKey(apiKey) {
  const models = await listModels(apiKey);
  const chain = chainFor(models, 'transcribe');
  if (!chain.length) throw new Error('Nyckeln fungerar men har inte tillgång till någon Gemini Flash-modell.');
  const res = await generateFast(client(apiKey), chain, { contents: 'Svara bara med ordet OK.' }, { timeoutMs: 30000 });
  return { models, transcribeModel: res.modelUsed, protocolModel: chainFor(models, 'protocol')[0] || res.modelUsed, note: '' };
}

module.exports = { transcribe, generateProtocol, listModels, testKey, pickModel, chainFor, isModelMissing, isNoQuota };
