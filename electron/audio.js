// Ljudbearbetning med ffmpeg (följer med appen via ffmpeg-static).
const { spawn } = require('child_process');
const fs = require('fs');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-10000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error('ffmpeg: ' + err.slice(-600)))));
  });
}

// Komprimerad mono-mp3 som skickas till Gemini för transkribering.
function toSpeechMp3(input, output) {
  return run(['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', output]);
}

// 16 kHz mono WAV – det format whisper.cpp vill ha.
function toWav16k(input, output) {
  return run(['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
}

// Slår ihop segmentens ljud till en sammanhängande fil för arkivet.
async function concatToMp3(inputs, output) {
  const existing = inputs.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
  if (!existing.length) throw new Error('Inga ljudfiler att slå ihop');
  const args = ['-loglevel', 'error'];
  for (const f of existing) args.push('-i', f);
  const filter = existing.map((_, i) => `[${i}:a]`).join('') + `concat=n=${existing.length}:v=0:a=1[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', output);
  await run(args);
}

// Delar en importerad ljudfil i bitar om `seconds` sekunder.
function split(input, outPattern, seconds) {
  return run(['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', outPattern]);
}

async function duration(file) {
  // ffmpeg -i utan utfil avslutas med fel men skriver Duration till stderr.
  const out = await run(['-i', file, '-f', 'null', '-']).catch((e) => e.message);
  const times = [...String(out).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const m = times.length ? times[times.length - 1] : String(out).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = { toSpeechMp3, toWav16k, concatToMp3, split, duration, ffmpegPath };
