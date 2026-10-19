import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { useRec } from '../lib/recStore';
import { fmtDate, fmtDuration, fmtTime, safeFileName, speakerColor, STATUS } from '../lib/format';
import { mdToDocx, mdToHtml, mdToPrintHtml } from '../lib/markdown';
import { LivePanel } from '../components/Recording';
import { MeetingFiles, ModePicker, TemplatePicker } from '../components/Inputs';
import { IconCopy, IconDownload, IconEdit, IconFolder, IconMic, IconRefresh, IconSpark, IconTrash, IconCheck, IconUsers } from '../components/Icons';
import { LiveConversation, SpeakerChip, SpeakerPanel, displayName, nameVoice } from '../components/Speakers';

const api = window.api;

export default function MeetingView({ id }) {
  const { toast, go, startRecording } = useApp();
  const rec = useRec();
  const [m, setM] = useState(null);
  const [tab, setTab] = useState(null);
  const audioRef = useRef(null);

  const load = useCallback(() => api.getMeeting(id).then(setM), [id]);
  useEffect(() => {
    load();
    let t;
    const off = api.onMeetingUpdated((mid) => {
      if (mid !== id) return;
      clearTimeout(t);
      t = setTimeout(load, 150);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [id, load]);

  useEffect(() => {
    if (m && !tab) setTab(m.hasProtocol ? 'protocol' : m.hasNotes ? 'notes' : m.segments.some((s) => s.transcript?.length) ? 'transcript' : m.status === 'recorded' ? 'transcript' : 'details');
  }, [m, tab]);

  if (!m) return <div className="page muted">Laddar…</div>;

  const isLive = rec.meetingId === id && rec.status !== 'idle';
  const status = isLive ? (rec.status === 'paused' ? 'paused' : 'recording') : m.status;
  const st = STATUS[status] || STATUS.draft;
  const seek = (t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    a.play();
  };

  const update = async (patch) => setM(await api.updateMeeting(id, patch));
  const remove = async () => {
    if (isLive) return toast('Avsluta inspelningen först.', 'err');
    if (!confirm(`Flytta "${m.title}" till papperskorgen? Ljud, transkription, protokoll och bilagor flyttas.`)) return;
    await api.deleteMeeting(id);
    toast('Mötet flyttades till papperskorgen.', 'ok');
    go('archive');
  };

  const segStats = {
    total: m.segments.length,
    done: m.segments.filter((s) => s.status === 'done').length,
    working: m.segments.filter((s) => s.status === 'transcribing').length,
    failed: m.segments.filter((s) => s.status === 'error').length,
  };

  return (
    <div className="page meeting">
      <header className="meeting-head">
        <div className="meeting-title-row">
          <EditableTitle value={m.title} onSave={(title) => update({ title })} />
          <span className={'badge ' + st.tone}>{st.label}</span>
        </div>
        <div className="meeting-meta">
          <span>{fmtDate(m.startedAt || m.createdAt)}</span>
          {m.durationSec > 0 && <span>{fmtDuration(m.durationSec)}</span>}
          <span>{m.mode === 'physical' ? 'Fysiskt möte' : 'Digitalt möte'}</span>
          {m.source === 'import' && <span>Importerad ljudfil</span>}
          {m.pauses.length > 0 && <span>{m.pauses.length} paus(er)</span>}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => api.openFolder(id)}>
            <IconFolder size={15} /> Öppna mapp
          </button>
          <button className="btn ghost sm danger-text" onClick={remove}>
            <IconTrash size={15} /> Ta bort
          </button>
        </div>
      </header>

      {isLive && <LivePanel onStopped={() => toast('Mötet är sparat.', 'ok')} />}
      {isLive && m.liveEnabled && <LiveConversation meeting={m} setM={setM} />}

      {!isLive && m.status === 'recorded' && (
        <div className="card start-card">
          <div>
            <b>Mötet är inspelat.</b>
            <p className="muted small">Ingen text finns än. Komplettera gärna deltagare och agenda under "Underlag" först – det ger bättre namn och protokoll.</p>
          </div>
          <TranscribeButton onRun={(engine) => api.transcribe(id, engine)} />
        </div>
      )}

      {m.status === 'draft' && !isLive && (
        <div className="card start-card">
          <div>
            <b>Mötet har inte spelats in än.</b>
            <p className="muted small">Förbered agenda och mall under "Underlag" och starta när mötet börjar.</p>
          </div>
          <button className="btn primary lg" disabled={rec.status !== 'idle'} onClick={() => startRecording(m)}>
            <IconMic /> Starta inspelning
          </button>
        </div>
      )}

      {m.status === 'processing' && !isLive && (
        <div className="alert info">
          <span className="spinner" /> Bearbetar mötet… {segStats.total > 0 && `Transkriberat ${segStats.done} av ${segStats.total} delar.`}
          {m.generatingProtocol && ' Skriver protokoll…'}
        </div>
      )}
      {m.generatingProtocol && m.status !== 'processing' && (
        <div className="alert info">
          <span className="spinner" /> Gemini skriver {m.generatingKind === 'notes' ? 'minnesanteckningarna' : 'mötesprotokollet'}…
        </div>
      )}
      {m.error && !isLive && m.status !== 'processing' && (
        <div className="alert err">
          <span>{m.error}</span>
          {m.status === 'interrupted' && (
            <button className="btn sm" onClick={() => api.finalize(id)}>
              Slutför bearbetning
            </button>
          )}
          {segStats.failed > 0 && m.status !== 'interrupted' && (
            <button className="btn sm" onClick={() => api.transcribe(id)}>
              <IconRefresh size={15} /> Försök igen
            </button>
          )}
        </div>
      )}

      {m.audioFile && (
        <audio ref={audioRef} className="player" controls preload="metadata" src={`wlmedia://m/${id}/${m.audioFile}?v=${encodeURIComponent(m.endedAt || '')}`} />
      )}

      <div className="tabs">
        <button className={tab === 'protocol' ? 'on' : ''} onClick={() => setTab('protocol')}>
          Protokoll
        </button>
        <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
          Minnesanteckningar
        </button>
        <button className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>
          Transkription
          {segStats.total > 0 && segStats.done < segStats.total && <span className="tab-note">{segStats.done}/{segStats.total}</span>}
        </button>
        <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
          Underlag & filer
        </button>
      </div>

      {(tab === 'protocol' || tab === 'notes') && <DocTab m={m} setM={setM} kind={tab} />}
      {tab === 'transcript' && <TranscriptTab m={m} setM={setM} seek={seek} isLive={isLive} />}
      {tab === 'details' && <DetailsTab m={m} setM={setM} update={update} isLive={isLive} />}
    </div>
  );
}

function EditableTitle({ value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="title-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
    />
  );
}

// ------------------------------------------------------------------ Transkription
function TranscriptTab({ m, setM, seek, isLive }) {
  const { toast } = useApp();
  const entries = useMemo(() => {
    const out = [];
    for (const s of m.segments) (s.transcript || []).forEach((e, i) => out.push({ ...e, seg: s.index, idx: i }));
    return out.sort((a, b) => a.t - b.t);
  }, [m]);
  const speakers = useMemo(() => {
    const num = (s) => (/^Talare (\d+)$/.test(s) ? parseInt(s.slice(7)) : 1000);
    return [...new Set(entries.map((e) => e.speaker))].sort((a, b) => num(a) - num(b));
  }, [entries]);
  const counts = useMemo(() => entries.reduce((c, e) => ((c[e.speaker] = (c[e.speaker] || 0) + 1), c), {}), [entries]);
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [identBusy, setIdentBusy] = useState(false);

  const name = (s) => displayName(m, s);
  const hasVoices = speakers.some((s) => /^Talare \d+$/.test(s));
  const identifying = m.identifyingVoices != null || identBusy;
  const identify = async () => {
    if (hasVoices && !confirm('Identifiera rösterna på nytt? Repliker som du ändrat för hand kan få en ny röst. Namn du satt på rösterna behålls.')) return;
    setIdentBusy(true);
    try {
      setM(await api.identifyVoices(m.id));
      toast('Klart! Välj nu vem varje röst är.', 'ok');
    } catch (e) {
      toast(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
    } finally {
      setIdentBusy(false);
    }
  };
  const pickFor = (e) => async (person, { single }) => {
    if (single) setM(await api.editEntry(m.id, e.seg, e.idx, { speaker: person || e.speaker }));
    else setM(await nameVoice(m, e.speaker, person));
  };
  const pending = m.segments.filter((s) => s.status !== 'done');
  const shown = q ? entries.filter((e) => e.text.toLowerCase().includes(q.toLowerCase()) || name(e.speaker).toLowerCase().includes(q.toLowerCase())) : entries;
  const order = speakers.map(name);

  return (
    <div className="transcript-wrap">
      {entries.length > 0 && !isLive && (
        <div className={'card identify-card' + (hasVoices ? ' subtle' : '')}>
          <div>
            <b>{hasVoices ? 'Rösterna är identifierade' : 'Vem sa vad?'}</b>
            <p className="muted small">
              {identifying
                ? `Lyssnar igenom mötet och känner igen rösterna… ${m.identifyingVoices ?? 0} %`
                : hasVoices
                  ? 'Stämmer det inte? Identifiera rösterna på nytt – namnen du satt finns kvar.'
                  : 'WhisperLog lyssnar igenom ljudet och delar upp texten per röst (Talare 1, 2, 3 …) – lokalt på datorn. Sedan väljer du vem varje röst är.'}
            </p>
          </div>
          <button className={'btn ' + (hasVoices ? 'sm' : 'primary')} disabled={identifying || m.status === 'processing'} onClick={identify}>
            {identifying ? <span className="spinner" /> : <IconUsers size={16} />} {hasVoices ? 'Identifiera igen' : 'Identifiera röster'}
          </button>
        </div>
      )}

      {speakers.length > 0 && <SpeakerPanel meeting={m} setM={setM} labels={speakers} counts={counts} />}

      {entries.length > 8 && <input className="input" placeholder="Sök i transkriptionen…" value={q} onChange={(e) => setQ(e.target.value)} />}

      <div className="transcript">
        {shown.map((e) => {
          const key = `${e.seg}-${e.idx}`;
          return (
            <div key={key} className="entry">
              <button className="ts" onClick={() => seek(e.t)} title="Spela upp härifrån">
                {fmtTime(e.t)}
              </button>
              <div className="entry-body">
                <SpeakerChip meeting={m} label={e.speaker} order={order} allowSingle onPick={pickFor(e)} />
                {editing === key ? (
                  <textarea
                    className="input"
                    autoFocus
                    defaultValue={e.text}
                    rows={3}
                    onBlur={async (ev) => {
                      setEditing(null);
                      if (ev.target.value !== e.text) setM(await api.editEntry(m.id, e.seg, e.idx, ev.target.value));
                    }}
                  />
                ) : (
                  <p onDoubleClick={() => setEditing(key)} title="Dubbelklicka för att redigera">
                    {e.text}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {pending.length > 0 && m.status !== 'recorded' && (
          <div className="pending-segs">
            {pending.map((s) => (
              <div key={s.index} className={'seg-status ' + s.status}>
                {s.status === 'recording' && '● Spelar in del ' + (s.index + 1) + ' – transkriberas när delen är klar'}
                {s.status === 'pending' && 'Del ' + (s.index + 1) + ' väntar på transkribering'}
                {s.status === 'transcribing' && (
                  <>
                    <span className="spinner" /> Transkriberar del {s.index + 1} ({fmtTime(s.startOffset)}–{fmtTime(s.startOffset + s.durationSec)})
                  </>
                )}
                {s.status === 'error' && `Del ${s.index + 1} misslyckades: ${s.error}`}
              </div>
            ))}
          </div>
        )}
        {!entries.length && !pending.length && <p className="muted empty">Ingen transkription ännu.</p>}
        {!entries.length && m.status === 'recorded' && <p className="muted empty">Klicka på <b>Transkribera</b> ovan för att skicka ljudet till Gemini.</p>}
      </div>
      {!isLive && m.segments.length > 0 && m.status !== 'processing' && (
        <div className="actions">
          <button
            className="btn ghost sm"
            onClick={() => confirm('Transkribera om hela mötet med Gemini? Nuvarande transkription och manuella ändringar ersätts.') && api.retranscribe(m.id, false, 'gemini')}
          >
            <IconRefresh size={15} /> Transkribera om med Gemini
          </button>
          <button
            className="btn ghost sm"
            onClick={() => confirm('Transkribera om hela mötet lokalt på datorn? Nuvarande transkription och manuella ändringar ersätts.') && api.retranscribe(m.id, false, 'local')}
          >
            <IconRefresh size={15} /> Transkribera om lokalt
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Protokoll / minnesanteckningar
const DOC_KINDS = {
  protocol: { title: 'Protokoll', one: 'protokollet', none: 'Inget protokoll ännu', make: 'Skapa protokoll', file: 'Protokoll' },
  notes: { title: 'Minnesanteckningar', one: 'minnesanteckningarna', none: 'Inga minnesanteckningar ännu', make: 'Skapa minnesanteckningar', file: 'Minnesanteckningar' },
};

function DocTab({ m, setM, kind }) {
  const { toast } = useApp();
  const K = DOC_KINDS[kind];
  const content = m[kind] || '';
  const has = kind === 'notes' ? m.hasNotes : m.hasProtocol;
  const generatedAt = kind === 'notes' ? m.notesGeneratedAt : m.protocolGeneratedAt;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);
  useEffect(() => setEditing(false), [kind]);
  const hasTranscript = m.segments.some((s) => s.transcript?.length);
  const working = busy || (m.generatingProtocol && m.generatingKind === kind);
  const otherWorking = m.generatingProtocol && m.generatingKind !== kind;
  const name = safeFileName(`${K.file} ${m.title}`);
  const unnamed = new Set(m.segments.flatMap((s) => (s.transcript || []).map((e) => e.speaker)).filter((sp) => /^Talare \d+$/.test(sp) && !m.speakerMap?.[sp])).size;
  const hasTemplates = kind === 'protocol' && (m.templateMeetingIds?.length || m.attachments.some((a) => a.kind === 'template'));

  const generate = async () => {
    if (has && !confirm(`Skapa ${K.one} på nytt? Den nuvarande versionen ersätts (inklusive dina ändringar).`)) return;
    if (unnamed && !confirm(`${unnamed} röst${unnamed > 1 ? 'er' : ''} saknar namn. Vill du skapa ${K.one} ändå? (Namnge rösterna under Transkription för bäst resultat.)`)) return;
    setBusy(true);
    try {
      await api.generateProtocol(m.id, kind);
      setM(await api.getMeeting(m.id));
      toast(`${K.title} är klart.`, 'ok');
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setM(await api.saveProtocol(m.id, draft, kind));
    setEditing(false);
    toast('Sparat.', 'ok');
  };
  const exportWord = async (useTemplate) => {
    try {
      const buf = await mdToDocx(content, { plainLists: useTemplate });
      const saved = useTemplate ? await api.exportWordTemplate(m.id, name + '.docx', buf) : await api.exportSave(name + '.docx', buf, [{ name: 'Word', extensions: ['docx'] }]);
      if (saved) toast(useTemplate ? 'Word-filen är sparad i mallens utseende.' : 'Word-filen är sparad.', 'ok');
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
    }
  };

  if (!has && !editing) {
    return (
      <div className="card empty-protocol">
        <IconSpark size={28} />
        <h3>{K.none}</h3>
        <p className="muted">
          {!hasTranscript
            ? `${K.title} kan skapas när mötet har transkriberats.`
            : kind === 'notes'
              ? 'Gemini skriver egna, lättlästa minnesanteckningar: sammanfattning, vad ni pratade om, beslut och att göra.'
              : 'Gemini skriver protokollet utifrån transkriptionen' + (m.agendaText || m.attachments.some((a) => a.kind === 'agenda') ? ', agendan' : '') + (hasTemplates ? ' och följer din mall' : '') + '.'}
        </p>
        {hasTranscript && unnamed > 0 && <p className="small warn-text">Tips: {unnamed} röst{unnamed > 1 ? 'er' : ''} saknar namn – namnge dem under Transkription först, så blir personer och roller rätt.</p>}
        <div className="actions center">
          <button className="btn primary" disabled={!hasTranscript || working || otherWorking} onClick={generate}>
            {working ? <span className="spinner" /> : <IconSpark />} {K.make}
          </button>
          <button className="btn ghost" onClick={() => setEditing(true)}>
            Skriv själv
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="protocol">
      <div className="toolbar">
        {editing ? (
          <>
            <button className="btn primary sm" onClick={save}>
              <IconCheck size={15} /> Spara
            </button>
            <button className="btn ghost sm" onClick={() => (setEditing(false), setDraft(content))}>
              Avbryt
            </button>
            <span className="muted small">Markdown: # Rubrik, **fet**, - punktlista, | tabell |</span>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => setEditing(true)}>
              <IconEdit size={15} /> Redigera
            </button>
            <button className="btn sm" disabled={working || otherWorking || !hasTranscript} onClick={generate}>
              {working ? <span className="spinner" /> : <IconRefresh size={15} />} Skapa nytt
            </button>
            <span className="spacer" />
            {kind === 'protocol' && m.wordTemplate && (
              <button className="btn sm primary" onClick={() => exportWord(true)} title={'Använder ' + m.wordTemplate + ' – sidhuvud, sidfot och loggor följer med'}>
                <IconDownload size={15} /> Word enligt mall
              </button>
            )}
            <button className="btn sm" onClick={() => exportWord(false)}>
              <IconDownload size={15} /> Word
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                if (await api.exportPdf(name + '.pdf', mdToPrintHtml(content, m.title))) toast('PDF:en är sparad.', 'ok');
              }}
            >
              <IconDownload size={15} /> PDF
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const html = mdToHtml(content);
                await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([content], { type: 'text/plain' }) })]);
                toast('Kopierat – klistra in i Word eller e-post.', 'ok');
              }}
            >
              <IconCopy size={15} /> Kopiera
            </button>
          </>
        )}
      </div>
      {kind === 'protocol' && hasTemplates && !m.wordTemplate && !editing && (
        <p className="muted small">Vill du ha mallens loggor, sidhuvud och sidfot i Word? Bifoga det tidigare protokollet som Word-fil (.docx) under "Underlag & filer" – då dyker knappen "Word enligt mall" upp.</p>
      )}
      {editing ? (
        <div className="editor-split">
          <textarea className="input editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck />
          <div className="doc" dangerouslySetInnerHTML={{ __html: mdToHtml(draft) }} />
        </div>
      ) : (
        <div className="doc" dangerouslySetInnerHTML={{ __html: mdToHtml(content) }} />
      )}
      {generatedAt && !editing && <p className="muted small">Skapat av Gemini {fmtDate(generatedAt)}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Underlag
function DetailsTab({ m, setM, update, isLive }) {
  const { toast } = useApp();
  const [f, setF] = useState({ participants: m.participants, organization: m.organization || '', agendaText: m.agendaText, instructions: m.instructions, templateMeetingIds: m.templateMeetingIds || [], mode: m.mode });
  const dirty = ['participants', 'organization', 'agendaText', 'instructions', 'mode'].some((k) => f[k] !== m[k]) || JSON.stringify(f.templateMeetingIds) !== JSON.stringify(m.templateMeetingIds || []);
  const save = async () => {
    await update(f);
    toast('Underlaget är sparat.', 'ok');
  };
  const other = m.attachments.filter((a) => a.kind === 'other');

  return (
    <div className="details">
      {m.status === 'draft' && (
        <section className="card">
          <h3>Typ av möte</h3>
          <ModePicker value={f.mode} onChange={(mode) => setF({ ...f, mode })} />
        </section>
      )}
      <section className="card">
        <label className="field">
          <span>Deltagare</span>
          <input className="input" value={f.participants} onChange={(e) => setF({ ...f, participants: e.target.value })} placeholder="Namn (roll), separerade med komma – t.ex. Jonas Denzler (ordförande), Anna Berg (sekreterare)" />
        </label>
        <label className="field">
          <span>Bolag / organisation</span>
          <input className="input" value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} placeholder="t.ex. Exempelbolaget AB" />
        </label>
      </section>
      <section className="card">
        <h3>Agenda</h3>
        <textarea className="input" rows={6} value={f.agendaText} onChange={(e) => setF({ ...f, agendaText: e.target.value })} placeholder="Agendapunkter…" />
        <MeetingFiles meeting={m} kind="agenda" onMeeting={setM} label="Bifoga agenda" />
      </section>
      <section className="card">
        <h3>Mall från tidigare protokoll</h3>
        <TemplatePicker value={f.templateMeetingIds} onChange={(templateMeetingIds) => setF({ ...f, templateMeetingIds })} excludeId={m.id} />
        <MeetingFiles meeting={m} kind="template" onMeeting={setM} label="Bifoga protokoll som fil" />
        <label className="field">
          <span>Egna instruktioner till Gemini</span>
          <input className="input" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
        </label>
      </section>
      <section className="card">
        <h3>Övriga filer</h3>
        <p className="muted small">Presentationer, underlag m.m. som hör till mötet (ingår inte i protokollunderlaget).</p>
        <MeetingFiles meeting={m} kind="other" onMeeting={setM} label="Bifoga fil" />
        {other.length === 0 && null}
      </section>
      <div className="actions sticky">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          <IconCheck /> Spara underlag
        </button>
        {dirty && <span className="muted small">Osparade ändringar</span>}
        {isLive && <span className="muted small">Du kan ändra underlaget medan mötet pågår.</span>}
      </div>
    </div>
  );
}

// Transkribera med vald motor (standard enligt inställningarna, går att byta per möte).
function TranscribeButton({ onRun }) {
  const { settings } = useApp();
  const [engine, setEngine] = useState(settings?.transcriptionEngine || 'gemini');
  return (
    <div className="transcribe-btn">
      <select className="input sm" value={engine} onChange={(e) => setEngine(e.target.value)} title="Transkriberingsmotor">
        <option value="gemini">Gemini (molnet)</option>
        <option value="local">Lokalt (Whisper)</option>
      </select>
      <button className="btn primary lg" onClick={() => onRun(engine)}>
        <IconSpark /> Transkribera
      </button>
    </div>
  );
}
