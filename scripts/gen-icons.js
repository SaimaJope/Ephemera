/**
 * gen-icons.js — rasterize the Ephemera logo into the packaging icon.
 *
 * The shipped logo (assets/logo.svg) is a transparent beetle mark in Kali
 * blue + white. For an app icon we composite it onto the Kali "dragon
 * wallpaper" gradient inside a squircle, then rasterize to a 1024px PNG.
 * electron-builder derives the platform formats (.ico for Windows, .icns
 * for macOS, sized PNGs for Linux) from this single build/icon.png.
 *
 * Pure JS, prebuilt native renderer (@resvg/resvg-js) — no system deps,
 * works offline.
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'assets', 'logo.svg');
const BUILD = path.join(ROOT, 'build');
const SRC_OUT = path.join(BUILD, 'icon-source.svg');
const PNG_OUT = path.join(BUILD, 'icon.png');

const SIZE = 2048; // matches the logo viewBox; rendered down to 1024

function extractInner(svg) {
  // Grab everything between the opening <svg ...> tag and </svg>.
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  const close = svg.lastIndexOf('</svg>');
  if (open === -1 || close === -1) {
    throw new Error('Could not parse assets/logo.svg');
  }
  return svg.slice(open + 1, close).trim();
}

function buildComposite(inner) {
  // Beetle centred at ~76% scale so it breathes inside the squircle.
  const scale = 0.76;
  const offset = (SIZE - SIZE * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1018"/>
      <stop offset="1" stop-color="#16243a"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.70" cy="0.40" r="0.62">
      <stop offset="0" stop-color="#1c5a8f"/>
      <stop offset="1" stop-color="#1c5a8f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.20" cy="0.80" r="0.55">
      <stop offset="0" stop-color="#0e2a47"/>
      <stop offset="1" stop-color="#0e2a47" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="squircle">
      <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="420" ry="420"/>
    </clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <rect width="${SIZE}" height="${SIZE}" fill="url(#base)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#glow1)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#glow2)"/>
    <rect x="8" y="8" width="${SIZE - 16}" height="${SIZE - 16}" rx="414" ry="414"
          fill="none" stroke="#5ca7fb" stroke-opacity="0.22" stroke-width="10"/>
    <g transform="translate(${offset} ${offset}) scale(${scale})">
      ${inner}
    </g>
  </g>
</svg>`;
}

function main() {
  if (!fs.existsSync(LOGO)) {
    throw new Error(`Missing logo at ${LOGO}`);
  }
  fs.mkdirSync(BUILD, { recursive: true });

  const inner = extractInner(fs.readFileSync(LOGO, 'utf8'));
  const composite = buildComposite(inner);
  fs.writeFileSync(SRC_OUT, composite);

  const resvg = new Resvg(composite, { fitTo: { mode: 'width', value: 1024 } });
  const png = resvg.render().asPng();
  fs.writeFileSync(PNG_OUT, png);

  console.log(`[gen-icons] wrote ${path.relative(ROOT, PNG_OUT)} (${png.length} bytes)`);
}

main();
