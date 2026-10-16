import { useEffect, useRef } from 'react';
import { recStore, useRec } from '../lib/recStore';
import { fmtTime } from '../lib/format';
import { IconPause, IconPlay, IconStop } from './Icons';

// Nivåmätare som läser direkt från inspelarens analysatorer (utan React-rendering per frame).
export function LevelMeter({ which, label, bars = 24 }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf;
    const loop = () => {
      const lv = recStore.levels()[which];
      const el = ref.current;
      if (el) {
        const n = lv == null ? 0 : Math.round(lv * bars);
        el.dataset.off = lv == null ? '1' : '';
        [...el.children].forEach((c, i) => c.classList.toggle('on', i < n));
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [which, bars]);
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-bars" ref={ref}>
        {Array.from({ length: bars }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </div>
  );
}

export function RecControls({ onStopped, big }) {
  const rec = useRec();
  const busy = rec.status === 'starting' || rec.status === 'stopping';
  const stop = async () => {
    const id = await recStore.stop();
    if (id) onStopped?.(id);
  };
  return (
    <div className={'rec-controls' + (big ? ' big' : '')}>
      {rec.status === 'paused' ? (
        <button className="btn primary" disabled={busy} onClick={() => recStore.resume()}>
          <IconPlay /> Återuppta
        </button>
      ) : (
        <button className="btn" disabled={busy || rec.status !== 'recording'} onClick={() => recStore.pause()}>
          <IconPause /> Pausa
        </button>
      )}
      <button className="btn danger" disabled={busy} onClick={stop}>
        <IconStop /> {rec.status === 'stopping' ? 'Avslutar…' : 'Avsluta möte'}
      </button>
    </div>
  );
}

// Kompakt widget i sidomenyn som syns oavsett vy.
export function RecordingWidget({ onOpen, onStopped }) {
  const rec = useRec();
  if (rec.status === 'idle') return null;
  return (
    <div className={'rec-widget ' + rec.status}>
      <button className="rec-widget-head" onClick={() => onOpen(rec.meetingId)} title="Visa mötet">
        <span className="rec-dot" />
        <span className="rec-widget-title">{rec.title}</span>
      </button>
      <div className="rec-widget-time">
        {fmtTime(rec.elapsed)}
        <span>{rec.status === 'paused' ? 'Pausad' : rec.status === 'recording' ? 'Spelar in' : '…'}</span>
      </div>
      <LevelMeter which="mic" label="Mic" bars={16} />
      {rec.mode === 'digital' && <LevelMeter which="system" label="Dator" bars={16} />}
      <RecControls onStopped={onStopped} />
    </div>
  );
}

export function LivePanel({ onStopped }) {
  const rec = useRec();
  return (
    <div className={'live-panel ' + rec.status}>
      <div className="live-left">
        <div className="live-status">
          <span className="rec-dot" />
          {rec.status === 'paused' ? 'Pausad – inget spelas in' : rec.status === 'starting' ? 'Startar…' : rec.status === 'stopping' ? 'Sparar…' : 'Spelar in'}
        </div>
        <div className="live-time">{fmtTime(rec.elapsed)}</div>
        <div className="live-hint">
          {rec.mode === 'digital' ? 'Mikrofon + datorns ljud (alla plattformar: Teams, Zoom, Meet …)' : 'Fysiskt möte – rumsmikrofon'}
          {' · '}Du kan stänga fönstret, inspelningen fortsätter i bakgrunden.
        </div>
        {rec.warning && <div className="alert warn">{rec.warning}</div>}
      </div>
      <div className="live-right">
        <LevelMeter which="mic" label="Mikrofon" />
        {rec.mode === 'digital' && <LevelMeter which="system" label="Datorljud" />}
        <RecControls onStopped={onStopped} big />
      </div>
    </div>
  );
}
