import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { useRec } from '../lib/recStore';
import { fmtDate, fmtDuration, STATUS } from '../lib/format';
import { IconFolder, IconMonitor, IconRoom, IconSearch, IconUpload } from '../components/Icons';

const api = window.api;
const FILTERS = [
  ['all', 'Alla'],
  ['protocol', 'Med protokoll'],
  ['todo', 'Saknar protokoll'],
  ['draft', 'Planerade'],
];

export default function Archive() {
  const { openMeeting } = useApp();
  const rec = useRec();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const load = () => api.listMeetings().then(setList);
    load();
    let t;
    const off = api.onMeetingUpdated(() => {
      clearTimeout(t);
      t = setTimeout(load, 300);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  const groups = useMemo(() => {
    if (!list) return [];
    const needle = q.toLowerCase();
    const filtered = list.filter((m) => {
      if (filter === 'protocol' && !m.hasProtocol) return false;
      if (filter === 'todo' && (m.hasProtocol || m.status === 'draft')) return false;
      if (filter === 'draft' && m.status !== 'draft') return false;
      if (!needle) return true;
      return [m.title, m.participants, ...m.speakers].join(' ').toLowerCase().includes(needle);
    });
    const byMonth = new Map();
    for (const m of filtered) {
      const key = new Date(m.startedAt || m.createdAt).toLocaleDateString('sv-SE', { year: 'numeric', month: 'long' });
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(m);
    }
    return [...byMonth.entries()];
  }, [list, q, filter]);

  return (
    <div className="page">
      <header className="page-head row-between">
        <div>
          <h1>Arkiv</h1>
          <p className="muted">{list ? `${list.length} möten` : 'Laddar…'} – ljud, transkription, protokoll och bilagor.</p>
        </div>
        <button className="btn ghost" onClick={() => api.openStorageRoot()}>
          <IconFolder /> Öppna arkivmappen
        </button>
      </header>

      <div className="archive-tools">
        <div className="search">
          <IconSearch size={16} />
          <input placeholder="Sök på rubrik, deltagare eller talare…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg-control">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {list && !list.length && (
        <div className="card empty">
          <p>Arkivet är tomt. Starta ditt första möte under "Nytt möte".</p>
        </div>
      )}

      {groups.map(([month, items]) => (
        <section key={month} className="archive-group">
          <h4>{month}</h4>
          <div className="archive-list">
            {items.map((m) => {
              const live = rec.meetingId === m.id && rec.status !== 'idle';
              const st = STATUS[live ? (rec.status === 'paused' ? 'paused' : 'recording') : m.status] || STATUS.draft;
              return (
                <button key={m.id} className="archive-item" onClick={() => openMeeting(m.id)}>
                  <div className="ai-icon">{m.source === 'import' ? <IconUpload /> : m.mode === 'physical' ? <IconRoom /> : <IconMonitor />}</div>
                  <div className="ai-main">
                    <div className="ai-title">{m.title}</div>
                    <div className="ai-sub">
                      {fmtDate(m.startedAt || m.createdAt)}
                      {m.durationSec > 0 && ` · ${fmtDuration(m.durationSec)}`}
                      {m.speakers.length > 0 && ` · ${m.speakers.slice(0, 5).join(', ')}${m.speakers.length > 5 ? ' …' : ''}`}
                    </div>
                  </div>
                  <div className="ai-badges">
                    {m.attachmentCount > 0 && <span className="badge neutral">{m.attachmentCount} filer</span>}
                    {m.hasProtocol && <span className="badge ok">Protokoll</span>}
                    {(!m.hasProtocol || m.status !== 'done') && <span className={'badge ' + st.tone}>{st.label}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
