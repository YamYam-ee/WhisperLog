import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { useRec } from '../lib/recStore';
import { fmtDate, fmtDuration, fmtTime, safeFileName, speakerColor, STATUS } from '../lib/format';
import { mdToDocx, mdToHtml, mdToPrintHtml } from '../lib/markdown';
import { LivePanel } from '../components/Recording';
import { MeetingFiles, ModePicker, TemplatePicker } from '../components/Inputs';
import { IconCopy, IconDownload, IconEdit, IconFolder, IconMic, IconRefresh, IconSpark, IconTrash, IconCheck } from '../components/Icons';

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
    if (m && !tab) setTab(m.hasProtocol ? 'protocol' : m.segments.some((s) => s.transcript?.length) ? 'transcript' : m.status === 'recorded' ? 'transcript' : 'details');
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
          <span className="spinner" /> Gemini skriver mötesprotokollet…
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
        <button className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>
          Transkription
          {segStats.total > 0 && segStats.done < segStats.total && <span className="tab-note">{segStats.done}/{segStats.total}</span>}
        </button>
        <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
          Underlag & filer
        </button>
      </div>

      {tab === 'protocol' && <ProtocolTab m={m} setM={setM} />}
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
  const speakers = useMemo(() => [...new Set(entries.map((e) => e.speaker))], [entries]);
  const [map, setMap] = useState(m.speakerMap || {});
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => setMap(m.speakerMap || {}), [m.speakerMap]);

  const name = (s) => m.speakerMap?.[s] || s;
  const saveMap = async () => {
    setM(await api.updateMeeting(m.id, { speakerMap: map }));
    toast('Talarnamnen är sparade.', 'ok');
  };
  const pending = m.segments.filter((s) => s.status !== 'done');
  const shown = q ? entries.filter((e) => e.text.toLowerCase().includes(q.toLowerCase()) || name(e.speaker).toLowerCase().includes(q.toLowerCase())) : entries;
  const order = speakers.map(name);

  return (
    <div className="transcript-wrap">
      {speakers.length > 0 && (
        <section className="card speakers">
          <div className="row-between">
            <h3>Talare</h3>
            <span className="muted small">Byt "Talare 1" mot riktiga namn – det används även i protokollet.</span>
          </div>
          <div className="speaker-grid">
            {speakers.map((s) => (
              <label key={s} className="speaker-row">
                <span className="swatch" style={{ background: speakerColor(name(s), order) }} />
                <span className="orig">{s}</span>
                <input className="input sm" placeholder={s} value={map[s] ?? ''} onChange={(e) => setMap({ ...map, [s]: e.target.value })} />
              </label>
            ))}
          </div>
          <button className="btn sm" onClick={saveMap}>
            <IconCheck size={15} /> Spara namn
          </button>
        </section>
      )}

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
                <span className="who" style={{ color: speakerColor(name(e.speaker), order) }}>
                  {name(e.speaker)}
                </span>
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

// ------------------------------------------------------------------ Protokoll
function ProtocolTab({ m, setM }) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.protocol);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(m.protocol);
  }, [m.protocol, editing]);
  const hasTranscript = m.segments.some((s) => s.transcript?.length);
  const name = safeFileName(`Protokoll ${m.title}`);

  const generate = async () => {
    if (m.hasProtocol && !confirm('Skriva ett nytt protokoll? Det nuvarande ersätts (inklusive dina ändringar).')) return;
    setBusy(true);
    try {
      await api.generateProtocol(m.id);
      setM(await api.getMeeting(m.id));
      toast('Protokollet är klart.', 'ok');
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setM(await api.saveProtocol(m.id, draft));
    setEditing(false);
    toast('Protokollet är sparat.', 'ok');
  };

  if (!m.hasProtocol && !editing) {
    return (
      <div className="card empty-protocol">
        <IconSpark size={28} />
        <h3>Inget protokoll ännu</h3>
        <p className="muted">
          {hasTranscript
            ? 'Gemini skriver protokollet utifrån transkriptionen' + (m.agendaText || m.attachments.some((a) => a.kind === 'agenda') ? ', agendan' : '') + (m.templateMeetingIds?.length || m.attachments.some((a) => a.kind === 'template') ? ' och dina mallar' : '') + '.'
            : 'Protokollet kan skrivas när mötet har transkriberats.'}
        </p>
        <div className="actions center">
          <button className="btn primary" disabled={!hasTranscript || busy || m.generatingProtocol} onClick={generate}>
            {busy || m.generatingProtocol ? <span className="spinner" /> : <IconSpark />} Skapa protokoll
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
            <button className="btn ghost sm" onClick={() => (setEditing(false), setDraft(m.protocol))}>
              Avbryt
            </button>
            <span className="muted small">Markdown: # Rubrik, **fet**, - punktlista, | tabell |</span>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => setEditing(true)}>
              <IconEdit size={15} /> Redigera
            </button>
            <button className="btn sm" disabled={busy || m.generatingProtocol || !hasTranscript} onClick={generate}>
              {busy || m.generatingProtocol ? <span className="spinner" /> : <IconRefresh size={15} />} Skapa nytt
            </button>
            <span className="spacer" />
            <button
              className="btn sm"
              onClick={async () => {
                const buf = await mdToDocx(m.protocol);
                if (await api.exportSave(name + '.docx', buf, [{ name: 'Word', extensions: ['docx'] }])) toast('Word-filen är sparad.', 'ok');
              }}
            >
              <IconDownload size={15} /> Word
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                if (await api.exportPdf(name + '.pdf', mdToPrintHtml(m.protocol, m.title))) toast('PDF:en är sparad.', 'ok');
              }}
            >
              <IconDownload size={15} /> PDF
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const html = mdToHtml(m.protocol);
                await navigator.clipboard.write([
                  new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([m.protocol], { type: 'text/plain' }) }),
                ]);
                toast('Kopierat – klistra in i Word eller e-post.', 'ok');
              }}
            >
              <IconCopy size={15} /> Kopiera
            </button>
          </>
        )}
      </div>
      {editing ? (
        <div className="editor-split">
          <textarea className="input editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck />
          <div className="doc" dangerouslySetInnerHTML={{ __html: mdToHtml(draft) }} />
        </div>
      ) : (
        <div className="doc" dangerouslySetInnerHTML={{ __html: mdToHtml(m.protocol) }} />
      )}
      {m.protocolGeneratedAt && !editing && <p className="muted small">Skapat av Gemini {fmtDate(m.protocolGeneratedAt)}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Underlag
function DetailsTab({ m, setM, update, isLive }) {
  const { toast } = useApp();
  const [f, setF] = useState({ participants: m.participants, agendaText: m.agendaText, instructions: m.instructions, templateMeetingIds: m.templateMeetingIds || [], mode: m.mode });
  const dirty = ['participants', 'agendaText', 'instructions', 'mode'].some((k) => f[k] !== m[k]) || JSON.stringify(f.templateMeetingIds) !== JSON.stringify(m.templateMeetingIds || []);
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
          <input className="input" value={f.participants} onChange={(e) => setF({ ...f, participants: e.target.value })} placeholder="Namn, separerade med komma" />
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
