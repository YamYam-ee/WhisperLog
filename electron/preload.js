const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  pickDir: invoke('settings:pickDir'),
  listModels: invoke('gemini:models'),
  testKey: invoke('gemini:test'),
  openFiles: invoke('dialog:openFiles'),

  listMeetings: invoke('meetings:list'),
  getMeeting: invoke('meetings:get'),
  createMeeting: invoke('meetings:create'),
  updateMeeting: invoke('meetings:update'),
  editEntry: invoke('meetings:editEntry'),
  deleteMeeting: invoke('meetings:delete'),
  addFiles: invoke('meetings:addFiles'),
  removeAttachment: invoke('meetings:removeAttachment'),
  openFolder: invoke('meetings:openFolder'),
  openFile: invoke('meetings:openFile'),
  finalize: invoke('meetings:finalize'),
  transcribe: invoke('meetings:transcribe'),
  retranscribe: invoke('meetings:retranscribe'),
  identifyVoices: invoke('meetings:identifyVoices'),
  openStorageRoot: invoke('storage:openRoot'),
  openLog: invoke('app:openLog'),
  appVersion: invoke('app:version'),
  importAudio: invoke('import:audio'),

  generateProtocol: invoke('protocol:generate'),
  saveProtocol: invoke('protocol:save'),
  exportSave: invoke('export:save'),
  exportPdf: invoke('export:pdf'),
  exportWordTemplate: invoke('export:wordTemplate'),

  rec: {
    begin: invoke('rec:begin'),
    segmentStart: invoke('rec:segmentStart'),
    chunk: invoke('rec:chunk'),
    segmentEnd: invoke('rec:segmentEnd'),
    pause: invoke('rec:pause'),
    resume: invoke('rec:resume'),
    finish: invoke('rec:finish'),
    state: invoke('rec:state'),
    liveAudio: (id, track, data, offset) => ipcRenderer.send('live:audio', id, track, data, offset),
  },

  onMeetingUpdated: on('meeting:updated'),
  onRecCommand: on('rec:command'),
  onNavMeeting: on('nav:meeting'),
  onDetected: on('detector:detected'),
  onDetectorEnded: on('detector:ended'),
  onDetectorApps: on('detector:apps'),
  onSettingsChanged: on('settings:changed'),
  whisperStatus: invoke('whisper:status'),
  whisperInstall: invoke('whisper:install'),
  whisperRemove: invoke('whisper:remove'),
  onWhisperProgress: on('whisper:progress'),
});
