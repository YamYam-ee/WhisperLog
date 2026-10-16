// Global inspelningsstatus – lever oberoende av vilken vy som visas.
import { useSyncExternalStore } from 'react';
import { MeetingRecorder } from './recorder';

const api = window.api;
const listeners = new Set();
let state = { status: 'idle', meetingId: null, title: '', mode: null, elapsed: 0, warning: null };
let rec = null;
let ticker = null;
let busy = false;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function syncMain() {
  api.rec.state({ status: state.status, meetingId: state.meetingId, title: state.title });
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

export const recStore = {
  subscribe(l) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
  levels: () => rec?.levels() || { mic: null, system: null },

  start: (meeting) =>
    guard(async () => {
      if (state.status !== 'idle') throw new Error('En inspelning pågår redan.');
      const settings = await api.getSettings();
      set({ status: 'starting', meetingId: meeting.id, title: meeting.title, mode: meeting.mode, elapsed: 0, warning: null });
      rec = new MeetingRecorder({
        meetingId: meeting.id,
        mode: meeting.mode,
        micDeviceId: settings.micDeviceId,
        segmentMinutes: settings.segmentMinutes,
        live: settings.transcriptionEngine === 'live' && settings.hasApiKey,
      });
      rec.onWarning = (w) => set({ warning: w });
      try {
        await rec.init();
        await api.rec.begin(meeting.id);
        await rec.startSegment();
      } catch (e) {
        rec = null;
        set({ status: 'idle', meetingId: null });
        throw e;
      }
      set({ status: 'recording' });
      syncMain();
      ticker = setInterval(() => rec && set({ elapsed: rec.elapsed() }), 500);
    }),

  pause: () =>
    guard(async () => {
      if (state.status !== 'recording') return;
      const from = new Date().toISOString();
      set({ status: 'paused' });
      syncMain();
      await rec.pause();
      await api.rec.pause(state.meetingId, rec.elapsed(), from);
    }),

  resume: () =>
    guard(async () => {
      if (state.status !== 'paused') return;
      await rec.resume();
      await api.rec.resume(state.meetingId);
      set({ status: 'recording' });
      syncMain();
    }),

  togglePause() {
    return state.status === 'recording' ? this.pause() : this.resume();
  },

  stop: () =>
    guard(async () => {
      if (state.status !== 'recording' && state.status !== 'paused') return;
      set({ status: 'stopping' });
      clearInterval(ticker);
      const id = state.meetingId;
      const duration = await rec.stop();
      rec = null;
      await api.rec.finish(id, duration);
      set({ status: 'idle', meetingId: null, title: '', elapsed: 0, warning: null });
      syncMain();
      return id;
    }),
};

export function useRec() {
  return useSyncExternalStore(recStore.subscribe, recStore.get);
}
