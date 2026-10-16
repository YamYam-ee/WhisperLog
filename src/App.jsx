import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { recStore, useRec } from './lib/recStore';
import { RecordingWidget } from './components/Recording';
import { IconArchive, IconPlus, IconSettings, IconX } from './components/Icons';
import NewMeeting from './views/NewMeeting';
import Archive from './views/Archive';
import MeetingView from './views/MeetingView';
import Settings from './views/Settings';
import markOnDark from '../assets/brand/mark-on-dark.svg';

const api = window.api;
const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export default function App() {
  const [route, setRoute] = useState({ name: 'new' });
  const [settings, setSettings] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [banner, setBanner] = useState(null);
  const [micApps, setMicApps] = useState([]);
  const rec = useRec();
  const recRef = useRef(rec);
  recRef.current = rec;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const toast = useCallback((text, tone = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 9000 : 4500);
  }, []);

  const go = useCallback((name, id) => setRoute({ name, id }), []);
  const openMeeting = useCallback((id) => setRoute({ name: 'meeting', id }), []);

  // Skapar (om det behövs) och startar inspelning av ett möte.
  const startRecording = useCallback(
    async (meeting) => {
      try {
        await recStore.start(meeting);
        setBanner(null);
        openMeeting(meeting.id);
      } catch (e) {
        toast(e.message, 'err');
        openMeeting(meeting.id);
      }
    },
    [openMeeting, toast]
  );

  const quickStart = useCallback(
    async ({ mode = 'digital', title } = {}) => {
      if (recRef.current.status !== 'idle') return openMeeting(recRef.current.meetingId);
      const m = await api.createMeeting({ mode, title });
      await startRecording(m);
    },
    [openMeeting, startRecording]
  );

  const stopRecording = useCallback(async () => {
    const id = await recStore.stop();
    if (id) {
      openMeeting(id);
      toast(settingsRef.current?.autoTranscribe ? 'Mötet är avslutat och transkriberas nu i bakgrunden.' : 'Mötet är sparat. Klicka på Transkribera när du vill skicka det till Gemini.', 'ok');
    }
  }, [openMeeting, toast]);

  // Engångsladdning av inställningar vid start (separat från prenumerationerna nedan).
  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      if (!s.hasApiKey) setRoute({ name: 'settings' });
    });
  }, []);

  useEffect(() => {
    const offs = [
      api.onSettingsChanged(setSettings),
      api.onNavMeeting(openMeeting),
      api.onDetectorApps(setMicApps),
      api.onDetected((d) => recRef.current.status === 'idle' && setBanner({ type: 'detected', ...d })),
      api.onDetectorEnded((d) => setBanner({ type: 'ended', ...d })),
      api.onRecCommand(async (cmd, data) => {
        try {
          if (cmd === 'quick-start') await quickStart(data);
          else if (cmd === 'pause') await recStore.pause();
          else if (cmd === 'resume') await recStore.resume();
          else if (cmd === 'toggle-pause') {
            if (recRef.current.status === 'recording' || recRef.current.status === 'paused') {
              await recStore.togglePause();
              toast(recStore.get().status === 'paused' ? 'Inspelningen är pausad' : 'Inspelningen återupptogs', 'info');
            }
          } else if (cmd === 'stop') await stopRecording();
        } catch (e) {
          toast(e.message, 'err');
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [openMeeting, quickStart, stopRecording, toast]);

  const ctx = { settings, setSettings, toast, go, openMeeting, startRecording, stopRecording };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">
              <img src={markOnDark} alt="" />
              <div className="wordmark">
                <span>Whisper</span>
                <b>Log</b>
              </div>
            </div>
            <div className="brand-sub">Mötesprotokoll med Gemini</div>
          </div>
          <nav>
            <button className={route.name === 'new' ? 'active' : ''} onClick={() => go('new')}>
              <IconPlus /> Nytt möte
            </button>
            <button className={route.name === 'archive' || route.name === 'meeting' ? 'active' : ''} onClick={() => go('archive')}>
              <IconArchive /> Arkiv
            </button>
            <button className={route.name === 'settings' ? 'active' : ''} onClick={() => go('settings')}>
              <IconSettings /> Inställningar
            </button>
          </nav>
          <div className="sidebar-fill" />
          <RecordingWidget onOpen={openMeeting} onStopped={(id) => openMeeting(id)} />
          {settings?.detectMeetings && (
            <div className="detector-status" title="WhisperLog känner av när ett program använder mikrofonen">
              <span className={'dot' + (micApps.length ? ' live' : '')} />
              {micApps.length ? `Mikrofon används av ${micApps.join(', ')}` : 'Lyssnar efter möten'}
            </div>
          )}
        </aside>

        <main className="main">
          {banner && (
            <div className="banner">
              {banner.type === 'detected' ? (
                <>
                  <span>
                    <b>Möte upptäckt:</b> {banner.apps.join(', ')} använder mikrofonen.
                  </span>
                  <button className="btn primary sm" onClick={() => quickStart({ mode: 'digital', title: banner.title })}>
                    Spela in mötet
                  </button>
                </>
              ) : (
                <>
                  <span>
                    <b>Mötet verkar ha avslutats</b> – {banner.apps.join(', ')} använder inte längre mikrofonen.
                  </span>
                  {rec.status !== 'idle' && (
                    <button className="btn danger sm" onClick={() => (setBanner(null), stopRecording())}>
                      Avsluta inspelningen
                    </button>
                  )}
                </>
              )}
              <button className="icon-btn" onClick={() => setBanner(null)} title="Stäng">
                <IconX />
              </button>
            </div>
          )}
          {route.name === 'new' && <NewMeeting />}
          {route.name === 'archive' && <Archive />}
          {route.name === 'meeting' && <MeetingView key={route.id} id={route.id} />}
          {route.name === 'settings' && <Settings />}
        </main>

        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={'toast ' + t.tone}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </AppCtx.Provider>
  );
}
