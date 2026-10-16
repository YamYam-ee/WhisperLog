// Upptäcker möten genom att se vilka program som använder mikrofonen just nu.
// Windows loggar detta i registret (CapabilityAccessManager): ett program som har
// LastUsedTimeStart men LastUsedTimeStop = 0 använder mikrofonen i detta ögonblick.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

const FRIENDLY = [
  [/teams/i, 'Microsoft Teams'],
  [/zoom/i, 'Zoom'],
  [/webex|ciscocollab|atmgr/i, 'Webex'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/skype/i, 'Skype'],
  [/gotomeeting|g2m/i, 'GoTo Meeting'],
  [/chrome/i, 'Google Chrome (t.ex. Google Meet)'],
  [/msedge/i, 'Microsoft Edge (t.ex. Google Meet)'],
  [/firefox/i, 'Firefox (t.ex. Google Meet)'],
  [/whatsapp/i, 'WhatsApp'],
];

function friendlyName(key) {
  const raw = key.split('\\').pop();
  const exe = raw.includes('#') ? raw.split('#').pop() : raw.split('_')[0];
  for (const [re, name] of FRIENDLY) if (re.test(raw)) return name;
  return exe.replace(/\.exe$/i, '');
}

function queryRegistry() {
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const active = [];
      let current = null;
      let start = 0;
      let stop = 0;
      const flush = () => {
        if (current && start !== 0 && stop === 0) active.push(current);
      };
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('HKEY_')) {
          flush();
          current = line.trim();
          start = 0;
          stop = 0;
        } else {
          const m = line.match(/^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i);
          if (m) {
            const v = parseInt(m[2], 16);
            if (m[1] === 'LastUsedTimeStart') start = v;
            else stop = v;
          }
        }
      }
      flush();
      resolve(active);
    });
  });
}

class MeetingDetector extends EventEmitter {
  constructor({ intervalMs = 4000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.activeApps = [];
    this.pending = null;
    this.pendingCount = 0;
    const self = path.basename(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).toLowerCase();
    this.selfNames = new Set([self, 'whisperlog.exe', 'electron.exe']);
  }

  isSelf(key) {
    const raw = key.split('\\').pop().toLowerCase();
    const exe = raw.split('#').pop();
    return this.selfNames.has(exe) || raw.includes('whisperlog');
  }

  async poll() {
    if (process.platform !== 'win32') return;
    const keys = (await queryRegistry()).filter((k) => !this.isSelf(k));
    const names = [...new Set(keys.map(friendlyName))].sort();
    const sig = names.join('|');
    // Kräv två likadana avläsningar i rad så att korta mikrofontester inte triggar.
    if (sig === this.pending) this.pendingCount++;
    else {
      this.pending = sig;
      this.pendingCount = 1;
    }
    if (this.pendingCount < 2 || sig === this.activeApps.join('|')) return;
    const before = this.activeApps;
    this.activeApps = names;
    if (!before.length && names.length) this.emit('meeting-start', names);
    else if (before.length && !names.length) this.emit('meeting-end', before);
    this.emit('change', names);
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.activeApps = [];
    this.pending = null;
  }
}

module.exports = { MeetingDetector };
