import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { IconCheck, IconFolder, IconRefresh, IconDownload, IconTrash } from '../components/Icons';

const api = window.api;
const errMsg = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function Settings() {
  const { settings, setSettings, toast } = useApp();
  const [s, setS] = useState(settings);
  const [key, setKey] = useState('');
  const [models, setModels] = useState([]);
  const [mics, setMics] = useState([]);
  const [testing, setTesting] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => {
    api.appVersion().then(setVersion);
  }, []);

  useEffect(() => setS(settings), [settings]);

  useEffect(() => {
    (async () => {
      // Be om mikrofonbehörighet en gång så att enheternas namn syns.
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
        st.getTracks().forEach((t) => t.stop());
      } catch {
        /* ingen mikrofon */
      }
      const devs = await navigator.mediaDevices.enumerateDevices();
      setMics(devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'));
    })();
  }, []);

  const loadModels = async () => {
    try {
      setModels(await api.listModels());
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  useEffect(() => {
    if (settings?.hasApiKey) loadModels();
  }, [settings?.hasApiKey]);

  if (!s) return null;

  const save = async (patch) => {
    const next = await api.setSettings(patch);
    setSettings(next);
    return next;
  };
  const field = (k) => ({ value: s[k] ?? '', onChange: (e) => setS({ ...s, [k]: e.target.value }), onBlur: () => s[k] !== settings[k] && save({ [k]: s[k] }) });
  const check = (k) => ({ checked: !!s[k], onChange: (e) => save({ [k]: e.target.checked }) });

  const saveKey = async () => {
    setTesting(true);
    try {
      const r = await api.testKey(key.trim());
      await save({ apiKey: key.trim() });
      setKey('');
      toast(`API-nyckeln fungerar och är sparad (krypterat). Modeller: ${r.transcribeModel} / ${r.protocolModel}`, 'ok');
      if (r.note) toast(r.note, 'info');
    } catch (e) {
      toast('Nyckeln kunde inte verifieras: ' + errMsg(e), 'err');
    } finally {
      setTesting(false);
    }
  };

  const modelSelect = (k) => {
    const names = models.map((m) => m.name);
    return (
      <>
        <input className="input" list={'models-' + k} placeholder="Väljs automatiskt (nyaste)" {...field(k)} />
        <datalist id={'models-' + k}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </>
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Inställningar</h1>
      </header>

      <section className="card">
        <h3>Google Gemini</h3>
        <p className="muted small">
          Skapa en nyckel på aistudio.google.com → "Get API key". Nyckeln sparas krypterat på den här datorn. {settings.hasApiKey && <b>Sparad nyckel: {settings.apiKeyHint}</b>}
        </p>
        <div className="row">
          <input className="input" type="password" placeholder={settings.hasApiKey ? 'Klistra in ny nyckel för att byta' : 'Klistra in din API-nyckel (AIza…)'} value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn primary" disabled={!key.trim() || testing} onClick={saveKey}>
            {testing ? <span className="spinner" /> : <IconCheck />} Testa & spara
          </button>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Modell för transkribering</span>
            {modelSelect('transcribeModel')}
            <small className="muted">En Flash-modell är snabb och billig och räcker oftast.</small>
          </label>
          <label className="field">
            <span>Modell för protokoll</span>
            {modelSelect('protocolModel')}
            <small className="muted">En Pro-modell ger bäst sammanfattningar.</small>
          </label>
        </div>
        {settings.hasApiKey && (
          <button className="btn ghost sm" onClick={loadModels}>
            <IconRefresh size={15} /> Hämta modellista ({models.length})
          </button>
        )}
      </section>

      <section className="card">
        <h3>Du</h3>
        <label className="field">
          <span>Ditt namn</span>
          <input className="input" placeholder="Används som talarnamn för din mikrofon i digitala möten" {...field('userName')} />
        </label>
      </section>

      <section className="card">
        <h3>Inspelning</h3>
        <div className="grid2">
          <label className="field">
            <span>Mikrofon</span>
            <select className="input" value={s.micDeviceId} onChange={(e) => save({ micDeviceId: e.target.value })}>
              <option value="default">Systemets standardmikrofon</option>
              {mics
                .filter((d) => d.deviceId !== 'default')
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Mikrofon ' + d.deviceId.slice(0, 6)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Transkribera i bakgrunden var</span>
            <select className="input" value={s.segmentMinutes} onChange={(e) => save({ segmentMinutes: Number(e.target.value) })}>
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} minut
                  {n > 1 ? 'er' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Kortkommando för paus/återuppta</span>
          <input className="input" {...field('shortcutPause')} placeholder="CommandOrControl+Alt+P" />
        </label>
      </section>

      <TranscriptionSettings s={s} save={save} check={check} toast={toast} />

      <section className="card">
        <h3>Mötesdetektering</h3>
        <p className="muted small">WhisperLog ser när Teams, Zoom, webbläsaren (Meet) m.fl. börjar använda mikrofonen.</p>
        <label className="toggle">
          <input type="checkbox" {...check('detectMeetings')} /> Upptäck möten och visa en notis
        </label>
        <label className="toggle">
          <input type="checkbox" disabled={!s.detectMeetings} {...check('autoStartOnDetect')} /> Starta inspelning automatiskt när ett möte upptäcks
        </label>
        <label className="toggle">
          <input type="checkbox" {...check('openAtLogin')} /> Starta WhisperLog dolt när Windows startar
        </label>
      </section>

      <section className="card">
        <h3>Arkiv</h3>
        <div className="row">
          <input className="input" value={s.storageDir} readOnly />
          <button
            className="btn"
            onClick={async () => {
              const dir = await api.pickDir();
              if (dir) {
                await save({ storageDir: dir });
                toast('Arkivmappen är ändrad. Befintliga möten flyttas inte automatiskt.', 'info');
              }
            }}
          >
            <IconFolder /> Välj mapp
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Felsökning</h3>
        <p className="muted small">
          WhisperLog {version} · Om något går fel sparas orsaken i en loggfil. Skicka den gärna vidare om du behöver hjälp.
        </p>
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.openLog()}>
          <IconFolder size={15} /> Visa loggfilen
        </button>
      </section>
    </div>
  );
}

function TranscriptionSettings({ s, save, check, toast }) {
  const [st, setSt] = useState(null);
  const [progress, setProgress] = useState({});
  useEffect(() => {
    api.whisperStatus().then(setSt);
    return api.onWhisperProgress((p) => setProgress((x) => ({ ...x, [p.modelId]: p })));
  }, []);
  const install = async (id) => {
    try {
      setSt(await api.whisperInstall(id));
      toast('Modellen är nedladdad och klar att använda.', 'ok');
      if (s.transcriptionEngine === 'local' || !st?.models[s.localModel]?.installed) await save({ localModel: id });
    } catch (e) {
      toast(errMsg(e), 'err');
      setSt(await api.whisperStatus());
    } finally {
      setProgress((x) => ({ ...x, [id]: null }));
    }
  };
  const remove = async (id) => {
    if (confirm('Ta bort modellen från datorn? Den kan laddas ner igen senare.')) setSt(await api.whisperRemove(id));
  };
  const localReady = st?.binInstalled && st?.models[s.localModel]?.installed;

  return (
    <section className="card">
      <h3>Transkribering</h3>
      <div className="mode-picker three">
        <button type="button" className={s.transcriptionEngine === 'live' ? 'on' : ''} onClick={() => save({ transcriptionEngine: 'live' })}>
          <b>Gemini Live – direkt (rekommenderas)</b>
          <span>Transkriberar medan ni pratar – klart i samma sekund som mötet slutar. Obegränsat antal anrop. Talare: du / övriga.</span>
        </button>
        <button type="button" className={s.transcriptionEngine === 'gemini' ? 'on' : ''} onClick={() => save({ transcriptionEngine: 'gemini' })}>
          <b>Gemini – med talaridentifiering</b>
          <span>Skiljer på alla röster och sätter namn, även i fysiska möten. Ljudet skickas i delar; tar några sekunder extra och räknas mot kvoten.</span>
        </button>
        <button type="button" className={s.transcriptionEngine === 'local' ? 'on' : ''} onClick={() => save({ transcriptionEngine: 'local' })}>
          <b>Lokalt på datorn (Whisper)</b>
          <span>Ljudet lämnar aldrig datorn – bara texten skickas till Gemini för protokollet. Talare: du / övriga (digitalt), ej namn i fysiska möten.</span>
        </button>
      </div>
      {s.transcriptionEngine === 'local' && !localReady && <div className="alert warn">Ladda ner en lokal modell nedan innan du använder lokal transkribering.</div>}

      <div className="field">
        <span>Lokala modeller</span>
        <div className="model-list">
          {st &&
            Object.entries(st.models).map(([id, m]) => {
              const p = progress[id];
              return (
                <div key={id} className={'model-row' + (s.localModel === id && m.installed ? ' on' : '')}>
                  <label className="model-pick">
                    <input type="radio" name="localModel" disabled={!m.installed} checked={s.localModel === id} onChange={() => save({ localModel: id })} />
                    <span>{m.label}</span>
                  </label>
                  {p ? (
                    <div className="dl">
                      <div className="dl-bar">
                        <i style={{ width: Math.round((p.fraction || 0) * 100) + '%' }} />
                      </div>
                      <small className="muted">{p.text} {Math.round((p.fraction || 0) * 100)} %</small>
                    </div>
                  ) : m.installed ? (
                    <button className="btn ghost sm" onClick={() => remove(id)} title="Ta bort från datorn">
                      <IconTrash size={15} />
                    </button>
                  ) : (
                    <button className="btn sm" disabled={m.installing} onClick={() => install(id)}>
                      <IconDownload size={15} /> Ladda ner
                    </button>
                  )}
                </div>
              );
            })}
        </div>
        <small className="muted">Lokalt är långsammare än Gemini på den här datorn (Turbo ≈ 2× realtid). KB-Whisper översätter engelska inslag till svenska – välj Turbo för blandade möten. Om Gemini är överbelastat eller nätet ligger nere används den lokala modellen automatiskt som reserv.</small>
      </div>

      <label className="toggle">
        <input type="checkbox" {...check('autoTranscribe')} /> Transkribera i bakgrunden under mötet (texten är klar när mötet slutar)
      </label>
      <label className="toggle">
        <input type="checkbox" checked={s.autoRefine !== false} onChange={(e) => save({ autoRefine: e.target.checked })} /> Förfina talare automatiskt efter mötet (Gemini delar per tur, röstigenkänningen avgör vem)
      </label>
      <label className="toggle">
        <input type="checkbox" {...check('autoProtocol')} /> Skapa protokoll automatiskt när transkriberingen är klar
      </label>
    </section>
  );
}
