// WhisperLogs grafiska profil: logga (ljudvåg + fjäder) och alla ikoner genereras härifrån.
//   node scripts/brand.js   → assets/brand/*.svg, assets/icon.png, assets/icon.ico, assets/tray*.png
const fs = require('fs');
const path = require('path');

const C = {
  navy: '#2B3A42',
  navyDeep: '#1C272D',
  green: '#10B981',
  teal: '#0D9488',
  mint: '#5EEAD4',
  light: '#E8F0FE',
  rec: '#EF4444',
};

// Ljudvågens staplar (höjd i viewBox-enheter), centrerade kring y = 40.
const BARS_FULL = [8, 16, 28, 44, 24, 54, 34, 20, 10];
const BARS_SIMPLE = [24, 50, 34, 16]; // tjockare och färre för 16–32 px

/**
 * Själva märket i en 128×72-ruta. `cut` = färgen bakom (används för fjäderns skåror).
 * `simple` = förenklad variant för små ikoner.
 */
function mark({ cut = '#ffffff', simple = false, id = 'm' } = {}) {
  const bars = simple ? BARS_SIMPLE : BARS_FULL;
  const w = simple ? 10 : 4.6;
  const gap = simple ? 4.5 : 2.1;
  const x0 = simple ? 6 : 4;
  const rects = bars
    .map((h, i) => {
      const x = x0 + i * (w + gap);
      return `<rect x="${x.toFixed(1)}" y="${(40 - h / 2).toFixed(1)}" width="${w}" height="${h}" rx="${w / 2}"/>`;
    })
    .join('');
  // Fjäder: blad från basen (62,60) upp till spetsen (120,6), med skaft och två skåror.
  const blade = 'M62 60 C64 40 84 16 120 6 C116 28 104 50 70 58 Z';
  const notches = simple
    ? ''
    : `<path d="M92 33 L104 31 M84 43 L97 42" stroke="${cut}" stroke-width="2.6" stroke-linecap="round"/>`;
  return `
    <defs>
      <linearGradient id="${id}-wave" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${C.teal}"/><stop offset="1" stop-color="${C.green}"/>
      </linearGradient>
      <linearGradient id="${id}-feather" x1="0.15" y1="1" x2="0.95" y2="0">
        <stop offset="0" stop-color="${simple ? C.teal : C.navy}"/><stop offset="0.45" stop-color="${simple ? '#12A08A' : C.teal}"/><stop offset="1" stop-color="${C.green}"/>
      </linearGradient>
    </defs>
    <g fill="url(#${id}-wave)">${rects}</g>
    <path d="${blade}" fill="url(#${id}-feather)"/>
    ${notches}
    <path d="M56 66 C70 50 88 32 112 13" fill="none" stroke="${cut}" stroke-opacity="0.55" stroke-width="${simple ? 2.4 : 1.8}" stroke-linecap="round"/>`;
}

const markSvg = (opts) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 72">${mark(opts)}</svg>`;

// Appikon: mörk rundad ruta med märket. `dot` = röd inspelningsprick.
function iconSvg({ simple = false, dot = false } = {}) {
  const s = 256;
  const scale = simple ? 1.9 : 1.62;
  const tx = (s - 128 * scale) / 2;
  const ty = (s - 72 * scale) / 2 + (simple ? 4 : 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.navy}"/><stop offset="1" stop-color="${C.navyDeep}"/></linearGradient></defs>
    <rect x="${simple ? 0 : 8}" y="${simple ? 0 : 8}" width="${simple ? 256 : 240}" height="${simple ? 256 : 240}" rx="${simple ? 52 : 56}" fill="url(#bg)"/>
    <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${scale})">${mark({ cut: C.navyDeep, simple, id: 'i' })}</g>
    ${dot ? `<circle cx="206" cy="50" r="44" fill="${C.rec}" stroke="#ffffff" stroke-width="12"/>` : ''}
  </svg>`;
}

// Liggande logga: märke + ordbild (Whisper normal, Log fet).
function logoSvg({ dark = false } = {}) {
  const ink = dark ? '#ffffff' : C.navy;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 112">
    <g transform="translate(0 20)">${mark({ cut: dark ? C.navyDeep : '#ffffff', id: 'l' })}</g>
    <text x="146" y="78" font-family="Inter, 'Segoe UI', sans-serif" font-size="62" fill="${ink}" letter-spacing="-1.5"><tspan font-weight="400">Whisper</tspan><tspan font-weight="700">Log</tspan></text>
  </svg>`;
}

// ICO-fil med inbäddade PNG:er (stöds av Windows Vista och senare).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

function main() {
  const { Resvg } = require('@resvg/resvg-js');
  const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  const root = path.join(__dirname, '..', 'assets');
  const brand = path.join(root, 'brand');
  fs.mkdirSync(brand, { recursive: true });

  const files = {
    'mark.svg': markSvg({ cut: '#ffffff' }),
    'mark-on-dark.svg': markSvg({ cut: C.navyDeep, id: 'd' }),
    'logo.svg': logoSvg(),
    'logo-on-dark.svg': logoSvg({ dark: true }),
    'icon.svg': iconSvg(),
  };
  for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(brand, name), svg.replace(/\n\s*/g, ''));

  // Små storlekar använder den förenklade varianten så att ikonen förblir tydlig.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = sizes.map((size) => ({ size, data: render(iconSvg({ simple: size <= 40 }), size) }));
  fs.writeFileSync(path.join(root, 'icon.ico'), buildIco(pngs));
  fs.writeFileSync(path.join(root, 'icon.png'), render(iconSvg(), 512));
  // Systemfältet: egna .ico med de storlekar Windows använder vid olika skalning (100–200 %).
  const traySizes = [16, 20, 24, 32, 40, 48];
  fs.writeFileSync(path.join(root, 'tray.ico'), buildIco(traySizes.map((size) => ({ size, data: render(iconSvg({ simple: true }), size) }))));
  fs.writeFileSync(path.join(root, 'tray-rec.ico'), buildIco(traySizes.map((size) => ({ size, data: render(iconSvg({ simple: true, dot: true }), size) }))));
  fs.writeFileSync(path.join(brand, 'logo-preview.png'), render(logoSvg(), 1040));
  console.log('Grafisk profil genererad i', root);
}

if (require.main === module) main();
module.exports = { C, mark, markSvg, iconSvg, logoSvg };
