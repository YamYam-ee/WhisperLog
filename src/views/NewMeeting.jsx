import { useState } from 'react';
import { useApp } from '../App';
import { useRec } from '../lib/recStore';
import { LocalFiles, ModePicker, TemplatePicker } from '../components/Inputs';
import { IconMic, IconUpload } from '../components/Icons';

const api = window.api;

export default function NewMeeting() {
  const { startRecording, openMeeting, toast, settings } = useApp();
  const rec = useRec();
  const [f, setF] = useState({
    title: '',
    mode: 'digital',
    participants: '',
    organization: '',
    agendaText: '',
    instructions: '',
    templateMeetingIds: [],
  });
  const [agendaFiles, setAgendaFiles] = useState([]);
  const [templateFiles, setTemplateFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });

  const payload = () => ({
    ...f,
    attachments: [...agendaFiles.map((a) => ({ ...a, kind: 'agenda' })), ...templateFiles.map((a) => ({ ...a, kind: 'template' }))],
  });

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => startRecording(await api.createMeeting(payload())));
  const plan = () =>
    run(async () => {
      const m = await api.createMeeting(payload());
      toast('Mötet är sparat i arkivet. Starta inspelningen därifrån när mötet börjar.', 'ok');
      openMeeting(m.id);
    });
  const importAudio = () =>
    run(async () => {
      const m = await api.importAudio(payload());
      if (m) {
        toast('Ljudfilen importeras. Klicka på Transkribera i mötet när den är klar.', 'ok');
        openMeeting(m.id);
      }
    });

  const recording = rec.status !== 'idle';

  return (
    <div className="page">
      <header className="page-head">
        <h1>Nytt möte</h1>
        <p className="muted">Fyll i det du vill – allt utom typ av möte är valfritt och kan kompletteras i efterhand.</p>
      </header>

      {!settings?.hasApiKey && (
        <div className="alert warn">Ingen Google API-nyckel är angiven. Inspelning fungerar, men för transkribering och protokoll behöver du lägga in nyckeln under Inställningar.</div>
      )}

      {settings?.hasApiKey && !settings?.userName && (
        <div className="alert warn">Ange ditt namn under Inställningar – annars vet Gemini inte vem du är i transkriptionen och protokollet.</div>
      )}

      <section className="card">
        <label className="field">
          <span>Rubrik</span>
          <input className="input lg" placeholder="t.ex. Styrelsemöte oktober" value={f.title} onChange={set('title')} autoFocus />
        </label>
        <ModePicker value={f.mode} onChange={set('mode')} />
        <label className="field">
          <span>Deltagare</span>
          <input className="input" placeholder="Namn (roll), t.ex. Jonas Denzler (ordförande), Anna Berg (sekreterare)" value={f.participants} onChange={set('participants')} />
          <small className="muted">Under mötet kan du välja bland deltagarna när du pekar ut vem som pratar.</small>
        </label>
        <label className="field">
          <span>Bolag / organisation</span>
          <input className="input" placeholder="Används i protokollet" value={f.organization} onChange={set('organization')} />
        </label>
      </section>

      <section className="card">
        <h3>Agenda</h3>
        <p className="muted small">Om du anger en agenda skrivs protokollet efter dess punkter.</p>
        <textarea className="input" rows={5} placeholder={'1. Mötets öppnande\n2. Föregående protokoll\n3. …'} value={f.agendaText} onChange={set('agendaText')} />
        <LocalFiles files={agendaFiles} onChange={setAgendaFiles} label="Bifoga agenda (PDF, Word, text)" />
      </section>

      <section className="card">
        <h3>Mall från tidigare protokoll</h3>
        <p className="muted small">Gemini efterliknar formen och stilen i de protokoll du väljer här.</p>
        <TemplatePicker value={f.templateMeetingIds} onChange={set('templateMeetingIds')} />
        <LocalFiles files={templateFiles} onChange={setTemplateFiles} label="Bifoga protokoll som fil" />
        <label className="field">
          <span>Egna instruktioner till Gemini</span>
          <input className="input" placeholder="t.ex. Skriv kortfattat, numrera paragraferna från §45" value={f.instructions} onChange={set('instructions')} />
        </label>
      </section>

      <div className="actions sticky">
        <button className="btn primary lg" disabled={busy || recording} onClick={start}>
          <IconMic /> Starta inspelning
        </button>
        <button className="btn" disabled={busy} onClick={plan}>
          Spara som planerat möte
        </button>
        <button className="btn ghost" disabled={busy} onClick={importAudio}>
          <IconUpload /> Importera ljudfil istället
        </button>
        {recording && <span className="muted small">En inspelning pågår redan.</span>}
      </div>
    </div>
  );
}
