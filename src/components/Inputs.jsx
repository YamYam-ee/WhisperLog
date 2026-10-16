import { useEffect, useState } from 'react';
import { IconFile, IconUpload, IconX, IconMonitor, IconRoom } from './Icons';
import { fmtDate } from '../lib/format';

const api = window.api;

export function ModePicker({ value, onChange, disabled }) {
  return (
    <div className="mode-picker">
      <button type="button" disabled={disabled} className={value === 'digital' ? 'on' : ''} onClick={() => onChange('digital')}>
        <IconMonitor size={22} />
        <b>Digitalt möte</b>
        <span>Teams, Zoom, Meet m.fl. Spelar in din mikrofon + datorns ljud.</span>
      </button>
      <button type="button" disabled={disabled} className={value === 'physical' ? 'on' : ''} onClick={() => onChange('physical')}>
        <IconRoom size={22} />
        <b>Fysiskt möte</b>
        <span>Alla i samma rum. Spelar in via mikrofonen, Gemini skiljer på rösterna.</span>
      </button>
    </div>
  );
}

// Lista med filer som ännu inte sparats (innan mötet skapats).
export function LocalFiles({ files, onChange, label = 'Bifoga fil' }) {
  const add = async () => {
    const picked = await api.openFiles();
    onChange([...files, ...picked]);
  };
  return (
    <div className="files">
      {files.map((f, i) => (
        <div className="file-chip" key={f.path + i}>
          <IconFile size={15} /> <span>{f.name}</span>
          <button className="icon-btn" onClick={() => onChange(files.filter((_, j) => j !== i))}>
            <IconX size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" onClick={add}>
        <IconUpload size={15} /> {label}
      </button>
    </div>
  );
}

// Filer som redan är kopplade till ett sparat möte.
export function MeetingFiles({ meeting, kind, onMeeting, label = 'Bifoga fil' }) {
  const files = meeting.attachments.filter((a) => a.kind === kind);
  const add = async () => {
    const picked = await api.openFiles();
    if (picked.length) onMeeting(await api.addFiles(meeting.id, picked, kind));
  };
  return (
    <div className="files">
      {files.map((a) => (
        <div className="file-chip" key={a.id}>
          <IconFile size={15} />
          <button className="link" onClick={() => api.openFile(meeting.id, a.file)} title="Öppna">
            {a.name}
          </button>
          <button className="icon-btn" title="Ta bort" onClick={async () => onMeeting(await api.removeAttachment(meeting.id, a.id))}>
            <IconX size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" onClick={add}>
        <IconUpload size={15} /> {label}
      </button>
    </div>
  );
}

// Välj tidigare protokoll i arkivet som mall för Gemini.
export function TemplatePicker({ value, onChange, excludeId }) {
  const [meetings, setMeetings] = useState([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.listMeetings().then((l) => setMeetings(l.filter((m) => m.hasProtocol && m.id !== excludeId)));
  }, [excludeId]);
  if (!meetings.length) return <p className="muted small">Inga tidigare protokoll finns i arkivet ännu.</p>;
  const shown = meetings.filter((m) => !q || m.title.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="template-picker">
      {meetings.length > 6 && <input className="input sm" placeholder="Sök protokoll…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="template-list">
        {shown.map((m) => (
          <label key={m.id} className={'template-item' + (value.includes(m.id) ? ' on' : '')}>
            <input type="checkbox" checked={value.includes(m.id)} onChange={() => toggle(m.id)} />
            <span className="t-title">{m.title}</span>
            <span className="t-date">{fmtDate(m.startedAt || m.createdAt, { dateStyle: 'medium' })}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
