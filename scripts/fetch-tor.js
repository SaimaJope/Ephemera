'use strict';

/**
 * fetch-tor.js - place the official Tor "Expert Bundle" binary under tor/<platform>/
 * so main.js can spawn it for one-click onion browsing. Run at build time (the
 * `dist` scripts call it) and also runnable by hand for dev:  node scripts/fetch-tor.js
 *
 * We do NOT commit the binary (it's ~10-20 MB per platform and must track upstream
 * security releases). This fetches it reproducibly instead. If it fails (offline,
 * blocked), the app still runs - it just falls back to "bring your own Tor".
 *
 * Env overrides: TOR_VERSION=14.0.1 (skip discovery), TOR_PLATFORM=win|mac|linux,
 * TOR_ARCH=x86_64|aarch64|i686 (cross-fetch for another target).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FALLBACK_VERSION = '14.0.1'; // used only if version discovery fails; bump as needed

function platform() {
  const p = process.env.TOR_PLATFORM ||
    (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux');
  return {
    dir: p,
    os: p === 'win' ? 'windows' : p === 'mac' ? 'macos' : 'linux',
    exe: p === 'win' ? 'tor.exe' : 'tor'
  };
}
function arch() {
  if (process.env.TOR_ARCH) return process.env.TOR_ARCH;
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'i686';
  return 'x86_64';
}

// GET with redirect handling -> Buffer.
function get(url, depth) {
  if ((depth || 0) > 6) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ephemera-fetch-tor' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, (depth || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function discoverVersion() {
  if (process.env.TOR_VERSION) return process.env.TOR_VERSION;
  try {
    const j = JSON.parse((await get('https://aus1.torproject.org/torbrowser/update_3/release/downloads.json')).toString());
    if (j && j.version) return j.version;
  } catch (_) { /* fall through to fallback */ }
  return FALLBACK_VERSION;
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
  }
}

(async () => {
  const p = platform();
  const a = arch();
  const outDir = path.join(ROOT, 'tor', p.dir);
  const exePath = path.join(outDir, p.exe);
  if (fs.existsSync(exePath)) { console.log('[fetch-tor] already present:', path.relative(ROOT, exePath)); return; }

  const version = await discoverVersion();
  const file = `tor-expert-bundle-${p.os}-${a}-${version}.tar.gz`;
  const url = `https://dist.torproject.org/torbrowser/${version}/${file}`;
  console.log('[fetch-tor] downloading', url);
  const tgz = await get(url);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemera-tor-'));
  const tarPath = path.join(tmp, file);
  fs.writeFileSync(tarPath, tgz);
  console.log('[fetch-tor] extracting (' + (tgz.length / 1048576).toFixed(1) + ' MB)…');
  // Run tar WITH cwd=tmp and a RELATIVE archive name: a Windows drive-letter path
  // like "C:\..." makes GNU tar think "C:" is a remote host ("Cannot connect to
  // C: resolve failed"). A bare basename avoids the colon entirely, and works with
  // both GNU tar (Git Bash) and bsdtar (Windows/macOS).
  execFileSync('tar', ['-xzf', path.basename(tarPath)], { cwd: tmp, stdio: 'inherit' });

  // Expert-bundle layout: tor/tor(.exe) (+ libs/pluggable_transports), data/geoip(6).
  fs.mkdirSync(outDir, { recursive: true });
  const torSub = path.join(tmp, 'tor');
  if (fs.existsSync(torSub)) copyRecursive(torSub, outDir);
  for (const g of ['geoip', 'geoip6']) {
    const s = path.join(tmp, 'data', g);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(outDir, g));
  }
  if (p.exe === 'tor') { try { fs.chmodSync(exePath, 0o755); } catch (_) {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  if (!fs.existsSync(exePath)) throw new Error('extracted bundle but ' + p.exe + ' not found in tor/');
  console.log('[fetch-tor] done:', path.relative(ROOT, exePath));
})().catch((e) => { console.error('[fetch-tor] FAILED:', e.message); console.error('[fetch-tor] the app still works via bring-your-own Tor.'); process.exit(1); });
