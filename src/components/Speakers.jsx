import { useEffect, useMemo, useRef, useState } from 'react';
import { speakerColor, splitByVoice, fmtTime, similarity } from '../lib/format';
import { IconUsers, IconCheck, IconX } from './Icons';

const api = window.api;

// "Jonas Denzler (ordförande), Anna Berg" → ["Jonas Denzler", "Anna Berg"]
export function parseParticipants(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map((s) => s.replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

export const displayName = (m, label) => m.speakerMap?.[label] || label;

// Sätter namn på en röst (alla repliker med samma etikett).
export async function nameVoice(m, label, name) {
  const speakerMap = { ...(m.speakerMap || {}) };
  if (name) speakerMap[label] = name;
  else delete speakerMap[label];
  return api.updateMeeting(m.id, { speakerMap });
}

/**
 * Liten meny för att välja person. `allowSingle` visar valet "bara den här repliken".
 * onPick(name, { single }) – name = '' betyder ta bort namnet.
 */
export function PersonPicker({ meeting, label, allowSingle, onPick, onClose }) {
  const ref = useRef(null);
  const [other, setOther] = useState('');
  const [single, setSingle] = useState(false);
  const people = useMemo(() => {
    const fromList = parseParticipants(meeting.participants);
    const used = Object.values(meeting.speakerMap || {});
    return [...new Set([...fromList, ...used])].filter(Boolean);
  }, [meeting]);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  const pick = (name) => {
    onPick(name, { single });
    onClose();
  };
  return (
    <div className="picker" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="picker-head">
        Vem är <b>{label}</b>?
      </div>
      {people.length === 0 && <p className="muted small picker-hint">Fyll i deltagare under "Underlag" så kan du välja dem här.</p>}
      <div className="picker-list">
        {people.map((p) => (
          <button key={p} className="picker-item" onClick={() => pick(p)}>
            <IconUsers size={14} /> {p}
          </button>
        ))}
      </div>
      <form
        className="picker-other"
        onSubmit={(e) => {
          e.preventDefault();
          if (other.trim()) pick(other.trim());
        }}
      >
        <input className="input sm" placeholder="Annat namn…" value={other} onChange={(e) => setOther(e.target.value)} />
        <button className="btn sm" type="submit" disabled={!other.trim()}>
          <IconCheck size={14} />
        </button>
      </form>
      {allowSingle && (
        <label className="toggle small picker-single">
          <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} /> Bara den här repliken
        </label>
      )}
      {!single && meeting.speakerMap?.[label] && (
        <button className="btn ghost sm picker-clear" onClick={() => pick('')}>
          <IconX size={14} /> Ta bort namnet
        </button>
      )}
    </div>
  );
}

// Klickbart talarnamn som öppnar PersonPicker.
export function SpeakerChip({ meeting, label, order, allowSingle, onPick }) {
  const [open, setOpen] = useState(false);
  const name = displayName(meeting, label);
  return (
    <span className="chip-wrap">
      <button className="who chip" style={{ color: speakerColor(name, order) }} onClick={() => setOpen(true)} title="Klicka för att välja vem det är">
        {name}
      </button>
      {open && <PersonPicker meeting={meeting} label={label} allowSingle={allowSingle} onPick={onPick} onClose={() => setOpen(false)} />}
    </span>
  );
}

// Översikt över alla röster med namnval – samma namn på två röster slår ihop dem.
export function SpeakerPanel({ meeting, setM, labels, counts }) {
  const order = labels.map((l) => displayName(meeting, l));
  const unnamed = labels.filter((l) => /^Talare \d+$/.test(l) && !meeting.speakerMap?.[l]).length;
  return (
    <section className="card speakers">
      <div className="row-between">
        <h3>Röster i mötet</h3>
        <span className="muted small">{unnamed ? `${unnamed} röst${unnamed > 1 ? 'er' : ''} saknar namn` : 'Alla röster har namn'}</span>
      </div>
      <p className="muted small">Klicka på en röst och välj vem det är – alla repliker med den rösten får namnet, även i protokollet. Två röster kan få samma namn.</p>
      <div className="voice-grid">
        {labels.map((l) => (
          <div key={l} className="voice-row">
            <span className="swatch" style={{ background: speakerColor(displayName(meeting, l), order) }} />
            <span className="orig">{l}</span>
            <SpeakerChip meeting={meeting} label={l} order={order} onPick={async (name) => setM(await nameVoice(meeting, l, name))} />
            <span className="muted small">{counts[l] || 0} repl.</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// Under mötet: senaste replikerna med röst, så att du kan peka ut vem som pratar i realtid.
export function LiveConversation({ meeting, setM }) {
  const rows = useMemo(() => {
    const entries = meeting.liveEntries || [];
    const sys = entries.filter((e) => e.track === 'system');
    // Dölj mikrofonrepliker som bara är eko av datorljudet (högtalare i stället för headset).
    const isEcho = (e) => e.track === 'mic' && sys.some((s) => Math.abs(s.t - e.t) < 15 && similarity(e.text, s.text) > 0.5);
    const out = [];
    for (const e of entries) if (!isEcho(e)) for (const p of splitByVoice(e)) out.push({ ...p, track: e.track, key: e.id + ':' + p.t });
    return out.sort((a, b) => a.t - b.t).slice(-8);
  }, [meeting.liveEntries]);
  const labels = [...new Set((meeting.liveEntries || []).map((e) => e.voice).filter(Boolean))].sort((a, b) => parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, '')));
  const order = labels.map((l) => displayName(meeting, l));
  const fallback = (r) => (meeting.mode === 'physical' ? 'Deltagare' : r.track === 'mic' ? 'Du' : 'Övriga deltagare');
  return (
    <section className="card live-conv">
      <div className="row-between">
        <h3>Vem pratar?</h3>
        <span className="muted small">Klicka på en röst och välj person – gäller alla repliker med den rösten.</span>
      </div>
      {labels.length > 0 && (
        <div className="voice-chips">
          {labels.map((l) => (
            <SpeakerChip key={l} meeting={meeting} label={l} order={order} onPick={async (name) => setM(await nameVoice(meeting, l, name))} />
          ))}
        </div>
      )}
      <div className="live-rows">
        {rows.length === 0 && <p className="muted small">Texten dyker upp här när någon har pratat en stund.</p>}
        {rows.map((r) => (
          <div key={r.key} className="live-row">
            <span className="ts">{fmtTime(r.t)}</span>
            {r.voice ? (
              <SpeakerChip meeting={meeting} label={r.voice} order={order} onPick={async (name) => setM(await nameVoice(meeting, r.voice, name))} />
            ) : (
              <span className="who muted">{fallback(r)}</span>
            )}
            <p>{r.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
