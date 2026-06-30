'use strict';

/**
 * Ephemera - main process.
 *
 * Owns the single source of truth for the privacy model:
 *   - one shared NON-PERSISTENT session partition ("ephemera"). Because the
 *     partition name has no "persist:" prefix, Electron keeps all of its
 *     storage (cookies, cache, localStorage, IndexedDB, service workers, â¦)
 *     in memory and discards it on quit. Nothing the user browses touches disk.
 *   - network-layer ad/tracker blocking via @ghostery/adblocker-electron, with
 *     a live blocked-request counter streamed to the renderer.
 *   - DNT + Sec-GPC injected on every request, all permission prompts denied,
 *     no NTLM credential persistence.
 *   - "Clean Slate": wipe everything mid-session and reset the counter.
 *
 * Renderer page content is hosted in <webview> tags. We chose <webview> over
 * WebContentsView deliberately: it keeps the renderer a single self-contained
 * document with no per-tag view geometry bookkeeping in the main process, which
 * is the pragmatic choice for a focused portfolio app. The tradeoff is that
 * <webview> is a heavier, somewhat legacy abstraction and Electron nudges new
 * apps toward WebContentsView for production multi-process isolation; if this
 * grew into a real product, migrating the tab host to WebContentsView would be
 * the path to take.
 */

const { app, BrowserWindow, session, ipcMain, shell, webContents, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

// cross-fetch is required by the spec for feeding filter lists to the blocker.
// Its CJS build exposes the fetch function as either the module itself or .default.
const crossFetch = require('cross-fetch');
const fetchFn = crossFetch.default || crossFetch;

const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
// Battle-tested content script that performs cosmetic filtering (element hiding
// + scriptlets) inside each page. We inject it via session.setPreloads (works on
// Electron 31, unlike registerPreloadScript) alongside our own YouTube skipper.
const ADBLOCK_PRELOAD = require.resolve('@ghostery/adblocker-electron-preload');
const WEBVIEW_CONTENT = path.join(__dirname, 'webview-content.js');

// Internal codename used for every durable identifier so the product can be
// renamed by swapping display strings only.
const PARTITION = 'ephemera';
const BG = '#1b1e24';

// Onion routing (Tor). Anonymous tabs live in their OWN non-persistent partition
// so they get a separate cookie/cache jar AND a separate proxy from normal tabs:
// normal browsing stays direct and fast, only Tor tabs route through Tor. We
// "bring your own" Tor - we don't bundle the daemon, we point at a Tor that the
// user is already running (the standalone tor service on 9050, or Tor Browser on
// 9150) and auto-detect which. socks5:// makes Chromium resolve hostnames AT the
// proxy (remote DNS), which is what makes .onion addresses work and stops DNS
// leaks. Everything the normal session hardens (UA, DNT, permission denial,
// ad/tracker blocking, WebRTC IP-leak guard) applies to the Tor session too.
const TOR_PARTITION = 'ephemera-tor';
const TOR_SOCKS_PORTS = [9050, 9150];   // tor daemon, then Tor Browser's bundled tor
const TOR_CONTROL_PORTS = [9051, 9151]; // matching control ports (best-effort NEWNYM)
// Ports for OUR bundled tor (when the user has no Tor of their own). Deliberately
// off the standard 9050/9150 so we never collide with a Tor the user is running.
const BUNDLED_TOR_SOCKS = 9052;
const BUNDLED_TOR_CONTROL = 9053;

// A generic Chrome User-Agent matching the bundled Chromium MAJOR version. The
// default Electron UA tacks on "Ephemera/1.0.0" and "Electron/31.x" tokens, which
// (a) uniquely fingerprint this browser to every site and tracker and (b)
// advertise an Electron target. We replace it with a clean Chrome string. Real
// Chrome freezes its UA string's minor/build/patch to 0.0.0 ("User-Agent
// Reduction"), so we mirror that exactly: emitting the true build number (e.g.
// 126.0.6478.x) would itself flag a non-Chrome client. Applied globally via
// app.userAgentFallback (covers request headers AND navigator.userAgent) plus the
// ephemeral session. The matching Sec-CH-UA client hints are fixed up in
// hardenSession() (we splice the "Google Chrome" brand into the list Chromium
// itself produced) so the low-entropy hints don't betray the disguise.
const CHROME_MAJOR = String(process.versions.chrome || '').split('.')[0] || '126';
const UA_PLATFORM =
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
  : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : 'X11; Linux x86_64';
const GENERIC_UA =
  `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

let mainWindow = null;
let adblockBlocker = null;
let adblockGuessType = false; // mirror of blocker.config.guessRequestTypeFromUrl

// Onion routing state. The Tor session is created lazily (only when the user
// first opens a Tor tab), so users who never touch Tor pay nothing for it.
let torSession = null;       // session.fromPartition(TOR_PARTITION), once created
let torDetectedPort = null;  // SOCKS port of the USER'S OWN Tor (9050/9150), null = none
let torAppliedPort = null;   // SOCKS port currently wired into the Tor session's proxy
// Bundled tor (one-click): spawned only when the user has no Tor of their own.
let bundledTorProc = null;       // the child `tor` process, or null
let bundledTorPort = null;       // its SOCKS port once spawned
let bundledTorBootstrap = 0;     // 0..100, parsed from tor's "Bootstrapped N%" log
let bundledTorDataDir = null;    // EPHEMERAL data dir (temp, wiped on quit + Clean Slate)

// A compact public-suffix set covering the common multi-label TLDs, so we can
// derive a site's registrable domain (eTLD+1) for the cross-site cookie check
// below without pulling in a full public-suffix-list dependency. Erring toward
// treating two hosts as the SAME site (and so NOT blocking) is the safe failure
// mode here - it never blocks a first-party cookie; at worst a rare exotic TLD
// lets one extra third-party cookie through, which Clean Slate wipes anyway.
const MULTI_TLD = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.tr', 'com.ar', 'com.sg', 'com.hk', 'com.tw', 'com.ua',
  'co.kr', 'or.kr', 'co.id', 'co.th', 'in.th', 'com.my', 'com.ph', 'com.vn',
  'co.il', 'org.il', 'com.pl', 'com.ru', 'org.ru', 'net.ru'
]);

// Registrable domain (eTLD+1) of a hostname. IPs and single-label hosts (e.g.
// "localhost") are returned verbatim. Used only to decide first- vs third-party.
function registrableDomain(host) {
  if (!host) return '';
  host = host.toLowerCase();
  // Bare IPv4 / IPv6 / single label: no registrable concept, compare as-is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') !== -1) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_TLD.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

// True when a request's URL belongs to a different registrable domain than the
// top-level document that triggered it - i.e. a cross-site (third-party) request.
function isThirdPartyRequest(details) {
  let docUrl = '';
  try {
    if (details.frame && details.frame.top && typeof details.frame.top.url === 'string') {
      docUrl = details.frame.top.url;
    }
  } catch (_) { /* frame disposed mid-flight */ }
  if (!docUrl) {
    try { if (details.webContents) docUrl = details.webContents.getURL(); } catch (_) {}
  }
  if (!docUrl) return false; // unknown initiator: treat as first-party (don't strip)
  try {
    const docHost = new URL(docUrl).hostname;
    const reqHost = new URL(details.url).hostname;
    if (!docHost || !reqHost) return false;
    return registrableDomain(docHost) !== registrableDomain(reqHost);
  } catch (_) { return false; }
}

// Never surface a raw error dialog to the user. Electron pops a modal on any
// uncaught main-process exception by default (e.g. the benign "Render frame was
// disposed before WebFrameMain could be accessed" that fires during fast
// navigation/tab teardown). Installing these handlers suppresses the dialog;
// we just log and carry on. The user never has to know.
process.on('uncaughtException', (err) => {
  console.error('[ephemera] uncaught:', (err && err.message) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ephemera] unhandled rejection:', (reason && reason.message) || reason);
});

// Same spirit as above, for a noisier cousin: Electron logs "Error occurred in
// handler for 'GUEST_VIEW_MANAGER_CALL'" to the main console every time a
// <webview> IPC method (executeJavaScript, findInPage, getURL, ...) loses its
// target frame mid-flight - a benign teardown/navigation race (e.g. the new-tab
// page navigating itself to a search result while a fire-and-forget settings
// push is still in flight). EVERY such call in this app is non-critical and
// already wrapped in try/catch + .catch() in the renderer, so the failure is
// harmless; we just filter the duplicate, alarming log lines. Any OTHER
// console.error (including real errors) passes through untouched.
const __ephemeraConsoleError = console.error.bind(console);
console.error = (...args) => {
  const head = args.length ? args[0] : '';
  if (typeof head === 'string' && head.indexOf("GUEST_VIEW_MANAGER_CALL") !== -1) return;
  __ephemeraConsoleError(...args);
};

// --- user preferences (NOT browsing data - safe to persist to disk) ---------
const DEFAULT_SETTINGS = {
  windowControls: 'traffic', // 'traffic' (coloured circles) | 'mono' (flat grey)
  accent: '#b07cff',         // signature purple
  searchEngine: 'google',
  theme: 'normal',           // 'normal' (signature charcoal, default) | 'dark' (deeper black) | 'light' (semi-hidden, cycled from the wordmark)
  newtabMode: 'page',        // 'page' (Ephemera new-tab page) | 'engine' (search engine home, e.g. google.fi)
  newtabBg: 'blue',          // 'navy' (dark) | 'blue' (accent-tinted) | 'grey'
  showBranding: true,
  showCounter: true,
  cleanSlate: 'subtle',      // 'subtle' (muted icon) | 'button' (red label)
  adblock: true,
  sendDnt: true,
  blockThirdPartyCookies: true, // strip cross-site (third-party) cookies during the session, Firefox-ETP-Strict style
  language: 'en',            // 'en' | 'es' | 'ru' | 'fi'
  highPerf: false,           // fewer animations, no cosmetic mutation observer
  beautifulMode: false,      // extra motion: mouse-reactive new-tab dust, animated tab close
  startMaximized: true,      // open filling the screen (toggleable in Settings)
  notepadDeleteOnClear: true, // Clean Slate also deletes the exported notepad .txt
  notepadPath: '',           // last path the notepad was exported to (for delete-on-clear)
  torEnabled: true,          // offer anonymous Tor tabs (the onion "+" button + Ctrl+Shift+N)
  torPort: 0,                // 0 = auto-detect the SOCKS port (9050/9150); else a fixed port
  torUseBundled: true,       // if the user has no Tor of their own, start our bundled tor (one-click)
  // Security levels (Tor-Browser-style), gating JavaScript / active content per
  // traffic type. 'standard' (all on) | 'safer' (no JS on insecure sites) |
  // 'safest' (no JS at all). Three INDEPENDENT scopes - normal browsing, clearnet
  // over Tor, and .onion services - so each can be tuned on its own. Enforced via
  // an injected response CSP (see securityCsp); does NOT touch ad/tracker/cookie
  // blocking, which are separate features.
  securityLevel: 'standard',     // normal (direct) browsing
  torSecurityLevel: 'safer',     // clearnet sites opened over Tor
  onionSecurityLevel: 'safer'    // .onion services opened over Tor
};
let settings = { ...DEFAULT_SETTINGS };
let SETTINGS_FILE = null;

function loadSettings() {
  SETTINGS_FILE = path.join(app.getPath('userData'), 'ephemera-settings.json');
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  // Mutual exclusivity invariant (in case an older/edited file has both set).
  if (settings.beautifulMode && settings.highPerf) settings.beautifulMode = false;
}
function saveSettings() {
  // notepadPath stays in memory only: writing it would leave a durable on-disk
  // record that a private note was taken and exactly where - a trace this
  // browser exists to avoid. It is still live in `settings` for the session
  // (so delete-on-Clean-Slate works), just never serialised to disk.
  try {
    const { notepadPath, ...persist } = settings;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(persist, null, 2));
  } catch (_) {}
}

// --- live blocked-request counter -----------------------------------------
let blockedCount = 0;
let counterDirty = false;

function flushCounter() {
  if (counterDirty && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('blocked-count', blockedCount);
    counterDirty = false;
  }
}

// --- ephemeral downloads ---------------------------------------------------
// A download, by definition, has to land on disk. So every download goes into
// ONE dedicated folder that is wiped on launch, on Clean Slate, and on quit.
// This is the only on-disk browsing artefact Ephemera produces, and it never
// outlives a session: the leave-no-trace promise is kept by deleting the whole
// folder, not by trusting the OS to forget it.
let DOWNLOADS_DIR = null;
const downloads = new Map(); // id -> { item: Electron.DownloadItem|null, meta }
let dlSeq = 0;
let downloadsDirty = false;

function initDownloadsDir() {
  DOWNLOADS_DIR = path.join(app.getPath('temp'), 'ephemera-downloads');
  // Remove anything a previous run (or a crash) left behind, then recreate it
  // empty. Nothing from before this launch survives.
  try { fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (_) {}
}

// Reduce an untrusted remote filename to a safe basename living strictly inside
// DOWNLOADS_DIR (no path separators, no traversal, no control characters).
function sanitizeFilename(name) {
  let base = path.basename(String(name == null ? '' : name).trim());
  base = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'download';
  if (base.length > 180) {
    const ext = path.extname(base).slice(0, 24);
    base = base.slice(0, 180 - ext.length) + ext;
  }
  return base;
}

// Never overwrite: report.pdf -> "report (1).pdf" -> "report (2).pdf" ...
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem} (${i++})${ext}`);
  return candidate;
}

const downloadsList = () => [...downloads.values()].map((r) => r.meta);

function flushDownloads() {
  if (downloadsDirty && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downloads:update', downloadsList());
    downloadsDirty = false;
  }
}
// Immediate send, for one-shot changes (remove / clear / Clean Slate) that
// should not wait for the throttle interval.
function pushDownloads() {
  downloadsDirty = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downloads:update', downloadsList());
  }
}

// Cancel everything in flight, forget the list, delete the folder outright and
// recreate it empty. After this, zero downloaded bytes remain on disk.
function wipeDownloads() {
  for (const r of downloads.values()) {
    if (r.item) { try { r.item.cancel(); } catch (_) {} }
  }
  downloads.clear();
  try { fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (_) {}
}

function registerDownloads(ses, isTor) {
  ses.on('will-download', (_event, item) => {
    const id = 'dl-' + (++dlSeq);
    const filename = sanitizeFilename(item.getFilename());
    const savePath = uniquePath(DOWNLOADS_DIR, filename);
    // Setting the save path up front skips the native "Save As" dialog and
    // forces every download into our ephemeral folder. That is the whole point:
    // the user never chooses a location, so nothing escapes the wipe.
    item.setSavePath(savePath);

    const meta = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      mime: (typeof item.getMimeType === 'function' && item.getMimeType()) || '',
      state: 'progressing', // progressing | paused | completed | cancelled | interrupted
      paused: false,
      // Which partition the file came down through. A Tor download must NEVER be
      // re-issued through the direct session on retry (that would deanonymise it),
      // so we remember its origin here and the retry handler honours it.
      tor: !!isTor,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startTime: Date.now()
    };
    downloads.set(id, { item, meta });
    downloadsDirty = true;

    item.on('updated', (_e, state) => {
      meta.receivedBytes = item.getReceivedBytes();
      meta.totalBytes = item.getTotalBytes();
      meta.paused = item.isPaused();
      meta.state = meta.paused ? 'paused' : (state === 'interrupted' ? 'interrupted' : 'progressing');
      downloadsDirty = true;
    });
    item.on('done', (_e, state) => {
      meta.receivedBytes = item.getReceivedBytes();
      meta.state = state; // 'completed' | 'cancelled' | 'interrupted'
      meta.paused = false;
      const rec = downloads.get(id);
      if (rec) rec.item = null; // the DownloadItem is dead now; keep the row in the list
      downloadsDirty = true;
    });
  });
}

// --- security levels --------------------------------------------------------
// Tor-Browser-style levels, gating JavaScript / active content per traffic type.
// Enforced by ADDING a restrictive Content-Security-Policy to document responses
// (the browser enforces it alongside any CSP the site sent - the strictest wins),
// so it needs no per-tab webview re-attach and updates live with the setting.

const VALID_LEVELS = new Set(['standard', 'safer', 'safest']);
const isOnionUrl = (url) => { try { return /\.onion\.?$/i.test(new URL(url).hostname); } catch (_) { return false; } };

// Which level governs this request: .onion / clearnet-over-Tor / normal.
function securityLevelFor(isTor, url) {
  const lvl = isTor ? (isOnionUrl(url) ? settings.onionSecurityLevel : settings.torSecurityLevel) : settings.securityLevel;
  return VALID_LEVELS.has(lvl) ? lvl : 'standard';
}

// The CSP directive to ADD for a document response, or null for "no restriction".
// Never touches our own chrome / pages: only http(s) documents are gated, so
// file:// (index.html, newtab.html) and about:/data: are always left fully alive.
function securityCsp(isTor, url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const level = securityLevelFor(isTor, url);
  if (level === 'safest') return "script-src 'none'; object-src 'none'"; // no JS, no plugins, anywhere
  if (level === 'safer') {
    if (isOnionUrl(url)) return "script-src 'self'";          // .onion: first-party scripts only
    if (/^http:\/\//i.test(url)) return "script-src 'none'";  // insecure clearnet (http): no JS
    return null;                                              // https clearnet: JS stays on
  }
  return null; // standard: nothing added
}

// --- notepad export (optionally AES-256 encrypted .zip) --------------------
// @zip.js/zip.js is pulled in lazily the first time a note is exported as a zip,
// so users who never export pay nothing for it at startup. useWebWorkers:false
// keeps it on the main thread (no Worker plumbing needed in the Electron main
// process). encryptionStrength 3 = AES-256.
let zipLib = null;
function getZipLib() {
  if (!zipLib) { zipLib = require('@zip.js/zip.js'); zipLib.configure({ useWebWorkers: false }); }
  return zipLib;
}

// A note title -> a safe, unique ".txt" entry name inside the archive. Strips path
// separators / control chars, caps the length, and de-duplicates ("note (2).txt").
function noteEntryName(title, i, used) {
  let base = String(title == null ? '' : title).trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 60).trim();
  if (!base) base = 'note-' + (i + 1);
  let name = base + '.txt', n = 1;
  while (used.has(name.toLowerCase())) name = base + ' (' + (n++) + ').txt';
  used.add(name.toLowerCase());
  return name;
}

// Bundle the notes into a zip (Buffer), one .txt per note. A non-empty password
// makes it a real AES-256 zip; otherwise it's a plain zip. Always emits at least
// one entry so the archive is never empty.
async function buildNotesZip(notes, password) {
  const zip = getZipLib();
  const opts = password ? { password: String(password), encryptionStrength: 3 } : {};
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), opts);
  const used = new Set();
  const list = Array.isArray(notes) && notes.length ? notes : [{ title: '', body: '' }];
  for (let i = 0; i < list.length; i++) {
    const note = list[i] || {};
    await writer.add(noteEntryName(note.title, i, used), new zip.TextReader(String(note.body == null ? '' : note.body)));
  }
  return Buffer.from(await writer.close());
}

// --- privacy hardening on the ephemeral session ----------------------------
function hardenSession(ses, isTor) {
  // Inject Do-Not-Track and Global Privacy Control on every outgoing request
  // (toggleable in settings).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (settings.sendDnt) {
      headers['DNT'] = '1';
      headers['Sec-GPC'] = '1';
    } else {
      delete headers['DNT'];
      delete headers['Sec-GPC'];
    }
    // Keep the UA client hints consistent with the spoofed Chrome UA string.
    // Electron's brand list carries "Chromium" but omits the "Google Chrome"
    // brand real Chrome includes, so a tracker reading Sec-CH-UA could still tell
    // this isn't Chrome - undermining the UA spoof. We take whatever brand list
    // Chromium already produced (correct GREASE brand + exact version) and splice
    // the matching "Google Chrome" entry in, touching nothing else. Only headers
    // Chromium already chose to send are rewritten, so the SET of hints stays
    // identical to default Chrome; we only correct their brand values.
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk !== 'sec-ch-ua' && lk !== 'sec-ch-ua-full-version-list') continue;
      const v = headers[k];
      if (typeof v !== 'string' || v.indexOf('"Google Chrome"') !== -1) continue;
      const m = v.match(/"Chromium";v="([^"]+)"/);
      if (m) headers[k] = `${v}, "Google Chrome";v="${m[1]}"`;
    }
    // Cross-site cookie isolation: strip the outgoing Cookie header on any
    // third-party request so trackers embedded across sites can't READ a cookie
    // they previously set. Set-Cookie on third-party responses is dropped in
    // onHeadersReceived below, closing the write side too. Main-frame navigations
    // are first-party by definition and never touched. (Firefox ETP "Strict".)
    if (settings.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdPartyRequest(details)) {
      for (const k of Object.keys(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'cookie' || lk === 'cookie2') delete headers[k];
      }
    }
    callback({ requestHeaders: headers });
  });

  // Response-header rewriting: (1) write side of cross-site cookie isolation -
  // drop Set-Cookie from third-party responses so an embedded tracker can't plant
  // a cookie; (2) security level - add a restrictive CSP to document responses to
  // disable JavaScript / active content per the level for THIS traffic (normal /
  // Tor / .onion). Both run off the one handler so we rewrite the headers once.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (!headers) { callback({}); return; }
    let changed = false;

    if (settings.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdPartyRequest(details)) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'set-cookie') { delete headers[k]; changed = true; }
      }
    }

    // CSP only matters on documents (where script runs), so scope it to the main
    // frame + subframes; subresource responses don't execute script.
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      const csp = securityCsp(isTor, details.url);
      if (csp) {
        // Add as an EXTRA CSP header so it ANDs with any policy the site already
        // sent (multiple CSP headers => the intersection is enforced).
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy');
        if (key) {
          const cur = headers[key];
          headers[key] = (Array.isArray(cur) ? cur : [cur]).concat(csp);
        } else {
          headers['Content-Security-Policy'] = [csp];
        }
        changed = true;
      }
    }

    callback(changed ? { responseHeaders: headers } : {});
  });

  // Deny every permission prompt by default (geo, camera, mic, notificationsâ¦).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false);
  }

  // No NTLM / negotiate auto-authentication, and never persist HTTP-auth creds.
  ses.allowNTLMCredentialsForDomains('');

  // Present a generic Chrome identity instead of the Electron/Ephemera default
  // (anti-fingerprinting; see GENERIC_UA above). Belt-and-braces with the global
  // app.userAgentFallback set at startup.
  try { ses.setUserAgent(GENERIC_UA); } catch (_) {}
}

// Cosmetic-filter IPC. The injected adblocker preload asks main for the rules
// to hide/inject for each page; the blocker applies them via the sender. We
// register these immediately (referencing adblockBlocker, which is null until
// the lists finish loading) so early page loads don't error on a missing handler.
//
// YouTube serves its first-party video ads from the SAME player/endpoint as the
// content, and uBO's youtube.com cosmetic rules are ~32 document_start scriptlets
// (set-constant / json-edit-xhr-request / replace-node-text) that rewrite the
// player's own JS and XHR responses. The adblocker-electron preload can only
// inject those LATE over async IPC (after the player already read those values),
// so on YouTube they don't block the ad - they desync the player so the video
// never starts, and the per-mutation cosmetic observer storms IPC on YouTube's
// hyperactive DOM (slow + the executeJavaScript spam). So we skip generic
// cosmetics on YouTube and let webview-content.js's purpose-built skipper handle
// YT ads; network blocking still kills the off-player ad pings. Other sites keep
// full cosmetic filtering.
function isYouTubePage(u) {
  try { return /(^|\.)youtube(-nocookie)?\.com$/.test(new URL(u).hostname); }
  catch (_) { return false; }
}
function registerCosmeticIpc() {
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    try {
      if (!adblockBlocker || !settings.adblock) return;
      // The sender frame may already be gone by the time this async IPC runs
      // (fast navigation/teardown). Touching it would throw "Render frame was
      // disposedâ¦"; bail quietly instead.
      if (!event.sender || event.sender.isDestroyed()) return;
      // Don't run cosmetics against our own chrome / new-tab files.
      const senderUrl = (typeof event.sender.getURL === 'function') ? event.sender.getURL() : '';
      if (senderUrl.startsWith('file:')) return;
      // YouTube is handled by the dedicated skipper, never the generic scriptlets.
      if (isYouTubePage(url) || isYouTubePage(senderUrl)) return;
      return adblockBlocker.onInjectCosmeticFilters(event, url, msg);
    } catch (_) { /* never let a page break the main process */ }
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => {
    try {
      if (settings.highPerf) return false; // skip per-mutation cosmetic work in high-perf mode
      const u = (event.sender && typeof event.sender.getURL === 'function') ? event.sender.getURL() : '';
      if (isYouTubePage(u)) return false;   // no cosmetic-observer IPC storm on YouTube
      return adblockBlocker ? adblockBlocker.onIsMutationObserverEnabled(event) : false;
    } catch (_) { return false; }
  });
}

// Network blocking (with live counting), gated on the adblock setting. We drive
// onBeforeRequest ourselves rather than enableBlockingInSession() so we can
// (a) count every block and (b) avoid the Electron-35-only path. Registered per
// session: once for the normal jar, and again for the Tor jar when it is created,
// both sharing the single loaded engine. Safe to register before the engine has
// finished loading - it just passes everything through until adblockBlocker is set.
function applyNetworkBlocking(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!settings.adblock || !adblockBlocker) { callback({}); return; }
    // Main-frame navigations are never blocked, so detect them straight from
    // resourceType and skip building a Request (which parses the URL via tldts
    // twice and allocates hash arrays) for every top-level load. The
    // isMainFrame() check below still guards any non-standard resourceType, so
    // the set of blocked requests is byte-for-byte identical.
    if (details.resourceType === 'mainFrame') { callback({}); return; }
    const request = fromElectronDetails(details);
    if (adblockGuessType && request.type === 'other') {
      request.guessTypeOfRequest();
    }
    if (request.isMainFrame()) { callback({}); return; }
    const { redirect, match } = adblockBlocker.match(request);
    if (redirect) {
      blockedCount += 1; counterDirty = true;
      callback({ redirectURL: redirect.dataUrl });
    } else if (match) {
      blockedCount += 1; counterDirty = true;
      callback({ cancel: true });
    } else {
      callback({});
    }
  });
}

async function enableAdblock(ses) {
  // Register the request hook immediately so early loads are covered the instant
  // the engine lands (it no-ops until then); then load the engine once.
  applyNetworkBlocking(ses);
  try {
    // Full prebuilt set: EasyList + EasyPrivacy + uBO filters + resources +
    // cosmetic rules - far broader than ads-and-tracking alone. CACHED to disk
    // so it downloads ONCE: later launches load the serialized engine from
    // userData instantly (no multi-MB fetch competing with the first page load,
    // which is what made the first YouTube video slow) and it works offline.
    // This cache is filter data, not browsing data, so it does not break the
    // leave-no-trace promise.
    const blocker = await ElectronBlocker.fromPrebuiltFull(fetchFn, {
      path: path.join(app.getPath('userData'), 'ephemera-adblock.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile
    });
    adblockBlocker = blocker;
    adblockGuessType = blocker.config.guessRequestTypeFromUrl === true;
    console.log('[ephemera] full ad/tracker blocking enabled (network + cosmetics)');
  } catch (err) {
    // A failed filter-list fetch must never take the browser down.
    console.error('[ephemera] adblock init failed, continuing without it:', err.message);
  }
}

// ── Onion routing (Tor) ─────────────────────────────────────────────────────
// All Tor plumbing lives here: a lazily-created hardened+proxied session, TCP
// detection of a locally-running Tor, and a best-effort "new identity".

// Point the Tor session's proxy at a SOCKS port. socks5:// (not socks4) makes
// Chromium hand the hostname to Tor for resolution, so .onion resolves and DNS
// never leaks to the local resolver.
function applyTorProxy(port) {
  if (!torSession || !port) return Promise.resolve();
  return torSession.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` })
    .then(() => { torAppliedPort = port; })
    .catch(() => {});
}

// Create (once) the anonymous session: same hardening, downloads, content
// preloads and ad/tracker blocking as the normal jar, plus the Tor proxy. Called
// from the renderer (via 'tor:prepare') just before it attaches the first Tor
// <webview>, so the session is fully configured before any guest can load.
function setupTorSession() {
  if (torSession) return torSession;
  const ses = session.fromPartition(TOR_PARTITION);
  hardenSession(ses, true); // isTor: security level uses torSecurityLevel / onionSecurityLevel
  registerDownloads(ses, true);
  try { ses.setPreloads([ADBLOCK_PRELOAD, WEBVIEW_CONTENT]); }
  catch (e) { console.error('[ephemera] tor setPreloads failed:', e.message); }
  applyNetworkBlocking(ses);
  torSession = ses;
  // NB: we deliberately do NOT apply the proxy here. refreshTorStatus() applies it
  // (AWAITED) immediately after, from tor:prepare. Doing it here too would be a
  // fire-and-forget apply that could race and set torAppliedPort even if the awaited
  // one later fails - and torStatus().ready keys off torAppliedPort precisely so a
  // silent setProxy failure leaves ready=false (fail CLOSED), never masked.
  return ses;
}

// One quick TCP connect: is something listening on 127.0.0.1:port? On the Tor
// SOCKS ports, that "something" is overwhelmingly Tor. Good enough to drive the
// friendly "Tor detected / start Tor" UX without a full SOCKS handshake.
function probePort(port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeout || 600);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch (_) { finish(false); }
  });
}

// Find the SOCKS port Tor is listening on (the configured one, or 9050 then 9150).
async function detectTor() {
  const ports = settings.torPort > 0 ? [settings.torPort] : TOR_SOCKS_PORTS;
  for (const p of ports) { if (await probePort(p)) return p; }
  return null;
}

// ── Bundled tor (one-click) ─────────────────────────────────────────────────
// We ship the official tor binary under tor/<platform>/ (placed by scripts/
// fetch-tor.js at build time, included via electron-builder extraResources). When
// the user has no Tor of their own, we spawn it ourselves so onion browsing is
// truly one-click. If the binary is absent (e.g. a dev checkout that never ran
// fetch-tor), every call below no-ops and we fall back to the "start Tor" UX.
function torBinaryPath() {
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const base = app.isPackaged ? path.join(process.resourcesPath, 'tor') : path.join(__dirname, 'tor');
  return path.join(base, plat, exe);
}
function torGeoipPaths(bin) {
  const dir = path.dirname(bin);
  const g = path.join(dir, 'geoip'), g6 = path.join(dir, 'geoip6');
  return { geoip: fs.existsSync(g) ? g : null, geoip6: fs.existsSync(g6) ? g6 : null };
}
// The bundled tor's control-port cookie (32 raw bytes -> hex) for authenticated
// NEWNYM. Only our bundled tor uses cookie auth at a path we know.
function controlAuthCookieHex() {
  try {
    if (!bundledTorDataDir) return null;
    const p = path.join(bundledTorDataDir, 'control_auth_cookie');
    return fs.existsSync(p) ? fs.readFileSync(p).toString('hex') : null;
  } catch (_) { return null; }
}

function pushTorStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tor:status', status || torStatus());
}

// Fixed path of the bundled tor's EPHEMERAL data dir. Stable (doesn't depend on
// bundledTorDataDir being assigned) so we can wipe it at launch even after a prior
// crash that never reached startBundledTor.
function torDataDirPath() { return path.join(app.getPath('temp'), 'ephemera-tor-data'); }
function wipeTorDataDir() { try { fs.rmSync(torDataDirPath(), { recursive: true, force: true }); } catch (_) {} }

// Spawn the bundled tor (idempotent). Returns its SOCKS port immediately after
// spawn (NOT after bootstrap) so the caller can open the tab and show progress;
// bootstrap % streams to the UI via pushTorStatus. Returns null if unavailable.
function startBundledTor() {
  if (bundledTorProc) return bundledTorPort || BUNDLED_TOR_SOCKS;
  const bin = torBinaryPath();
  if (!fs.existsSync(bin)) return null; // not bundled in this build -> caller falls back
  try {
    // EPHEMERAL data dir: a persistent Tor dir on disk would itself reveal that the
    // user runs Tor - unacceptable for the threat model. Wiped at launch, on quit,
    // and on Clean Slate. We re-bootstrap each session (amnesiac, Tails-style).
    bundledTorDataDir = torDataDirPath();
    try { fs.rmSync(bundledTorDataDir, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(bundledTorDataDir, { recursive: true });
    const geo = torGeoipPaths(bin);
    const args = [
      'SOCKSPort', '127.0.0.1:' + BUNDLED_TOR_SOCKS,
      'ControlPort', '127.0.0.1:' + BUNDLED_TOR_CONTROL,
      'CookieAuthentication', '1',
      'DataDirectory', bundledTorDataDir,
      'AvoidDiskWrites', '1',
      // Tor watches OUR pid and exits if we vanish - so a hard-killed Electron (no
      // will-quit) can't orphan tor.exe on the SOCKS port. Belt-and-braces with the
      // launch-time wipe above.
      '__OwningControllerProcess', String(process.pid),
      'Log', 'notice stdout'
    ];
    if (geo.geoip) { args.push('GeoIPFile', geo.geoip); }
    if (geo.geoip6) { args.push('GeoIPv6File', geo.geoip6); }
    const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    bundledTorProc = proc;
    bundledTorPort = BUNDLED_TOR_SOCKS;
    bundledTorBootstrap = 0;
    const onLog = (buf) => {
      const m = buf.toString().match(/Bootstrapped (\d+)%/);
      if (m) { bundledTorBootstrap = Math.max(bundledTorBootstrap, parseInt(m[1], 10)); pushTorStatus(); }
    };
    proc.stdout.on('data', onLog);
    proc.stderr.on('data', onLog);
    proc.on('exit', () => { bundledTorProc = null; bundledTorPort = null; bundledTorBootstrap = 0; pushTorStatus(); });
    proc.on('error', (e) => { console.error('[ephemera] bundled tor error:', e.message); bundledTorProc = null; bundledTorPort = null; bundledTorBootstrap = 0; });
    console.log('[ephemera] bundled Tor starting on 127.0.0.1:' + BUNDLED_TOR_SOCKS);
    return BUNDLED_TOR_SOCKS;
  } catch (e) {
    console.error('[ephemera] bundled tor spawn failed:', e.message);
    bundledTorProc = null; bundledTorPort = null;
    return null;
  }
}

// Kill the bundled tor and delete its ephemeral data dir (leave-no-trace). Wipes
// the fixed path unconditionally, so a stale dir is cleared even if this process
// never spawned tor itself (e.g. left by a prior crashed session).
function stopBundledTor() {
  if (bundledTorProc) { try { bundledTorProc.kill(); } catch (_) {} bundledTorProc = null; }
  bundledTorPort = null; bundledTorBootstrap = 0; bundledTorDataDir = null;
  wipeTorDataDir();
}

function torStatus() {
  const sys = torDetectedPort;                          // the user's own Tor (if any)
  const bundled = !sys && !!bundledTorProc;             // else our bundled tor
  const running = sys ? true : (bundled && bundledTorBootstrap >= 100);
  return {
    enabled: !!settings.torEnabled,
    running: !!running,
    starting: bundled && bundledTorBootstrap < 100,     // bootstrapping the bundled tor
    bootstrap: bundled ? bundledTorBootstrap : 100,
    bundled,
    port: sys || (bundled ? bundledTorPort : null),
    // ready ONLY when a socks5 proxy is CONFIRMED applied (torAppliedPort set by a
    // resolved setProxy). A bare session with no proxy would egress DIRECT, so
    // createTorTab must refuse to open a Tor tab until this is true (fail closed).
    ready: !!torSession && torAppliedPort !== null
  };
}

// Re-probe and keep the Tor session's proxy pointed at the active Tor: the user's
// OWN Tor if they run one (instant, no spawn), otherwise our BUNDLED tor (spawned
// on demand). Always leaves a socks5 proxy applied so it fails CLOSED. Awaited, so
// tor:prepare doesn't resolve (and the renderer doesn't attach a Tor webview)
// until the proxy is in place. Pushes status so the banner/new-tab page track live.
async function refreshTorStatus() {
  const sys = await detectTor();          // the user's own Tor (9050/9150)
  torDetectedPort = sys;
  let port = sys;
  if (!sys && settings.torUseBundled !== false && torSession) {
    port = startBundledTor();             // spawn ours (idempotent); null if not bundled
  }
  // Fail-closed default: even with no Tor at all, point at a dead Tor port so a
  // request can never silently fall back to a direct connection.
  if (!port) port = (settings.torPort > 0 ? settings.torPort : TOR_SOCKS_PORTS[0]);
  if (torSession && torAppliedPort !== port) await applyTorProxy(port);
  const status = torStatus();
  pushTorStatus(status);
  return status;
}

// Real circuit rotation via Tor's control port. For OUR bundled tor we have the
// control cookie, so NEWNYM genuinely works (a real new circuit). For a user's own
// Tor we try empty auth (only some setups allow it); if that fails we still wipe
// the session in torNewIdentity(), which always resets the browser-side identity.
function trySignalNewnym() {
  return new Promise((resolve) => {
    const attempts = [];
    const cookie = controlAuthCookieHex();
    if (bundledTorProc && cookie) attempts.push({ port: BUNDLED_TOR_CONTROL, auth: cookie });
    for (const p of TOR_CONTROL_PORTS) attempts.push({ port: p, auth: '' });
    const tryNext = () => {
      const a = attempts.shift();
      if (!a) { resolve(false); return; }
      const sock = new net.Socket();
      let settled = false;
      let saw250 = false;
      const done = (ok) => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} ok ? resolve(true) : tryNext(); };
      sock.setTimeout(900);
      sock.once('timeout', () => done(saw250));
      sock.once('error', () => done(false));
      sock.connect(a.port, '127.0.0.1', () => {
        try { sock.write(`AUTHENTICATE ${a.auth}\r\nSIGNAL NEWNYM\r\n`); } catch (_) { return done(false); }
      });
      sock.on('data', (buf) => {
        const s = buf.toString();
        if (s.indexOf('250') !== -1) saw250 = true;     // an OK to AUTHENTICATE and/or NEWNYM
        if (s.indexOf('515') !== -1 || s.indexOf('514') !== -1) return done(false); // auth required/bad
        if (saw250) { try { sock.write('QUIT\r\n'); } catch (_) {} done(true); }
      });
    };
    tryNext();
  });
}

// "New identity": ask Tor for a fresh circuit (best-effort) AND wipe the Tor
// session's cookies/cache/storage so the browser-side identity resets too. The
// wipe is the guarantee; the NEWNYM is a bonus on setups that allow it.
async function torNewIdentity() {
  await trySignalNewnym();
  if (torSession) {
    try {
      await torSession.clearStorageData({
        storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
      });
      await torSession.clearCache();
      if (typeof torSession.clearHostResolverCache === 'function') await torSession.clearHostResolverCache();
      if (typeof torSession.clearAuthCache === 'function') await torSession.clearAuthCache();
    } catch (_) {}
  }
}

// Find a live webContents on the Tor partition (used so a Tor download retry is
// re-issued through Tor, never the direct session).
function firstTorWebContents() {
  if (!torSession) return null;
  try {
    return webContents.getAllWebContents().find((wc) => {
      try { return wc.session === torSession && !wc.isDestroyed(); } catch (_) { return false; }
    }) || null;
  } catch (_) { return null; }
}

// Push the maximize state — and, while maximized, the exact amount the window
// overflows the visible screen — to the chrome. A frameless window on Windows is
// maximized by hanging its (invisible) resize border off every edge of the work
// area: the window rect ends up at roughly (-8,-8) with 8px past each side. That
// shaves the top off the titlebar, so the traffic-light controls get pushed up
// against the screen edge and look off-centre / clipped. We measure the real
// per-edge overflow here (workArea minus the window bounds) and the renderer
// insets the chrome by it, landing every edge exactly on the visible screen. In a
// normal window the inset is all zeros, so windowed layout is unchanged.
function sendWinState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  if (maximized) {
    try {
      const b = mainWindow.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      inset.top = Math.max(0, wa.y - b.y);
      inset.left = Math.max(0, wa.x - b.x);
      inset.right = Math.max(0, (b.x + b.width) - (wa.x + wa.width));
      inset.bottom = Math.max(0, (b.y + b.height) - (wa.y + wa.height));
    } catch (_) { /* on any failure fall back to a zero inset, never a broken layout */ }
  }
  try { mainWindow.webContents.send('win:state', { maximized, inset }); } catch (_) {}
}

// --- window ----------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: BG, // paint dark immediately - no white flash on load
    show: false,
    title: 'Ephemera',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
      devTools: true
    }
  });

  // Lock down guest <webview> contents: no Node, isolated, sandboxed, no popups.
  // Every flag below is pinned explicitly rather than trusting the framework
  // default, so a future Electron change (or an attribute set on the <webview>
  // tag) can't silently weaken a guest's isolation.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;             // session preloads only; no per-tag injection
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;          // keep same-origin policy enforced
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.webviewTag = false;          // a guest can't embed its own <webview>
    params.allowpopups = false;
  });

  mainWindow.once('ready-to-show', () => {
    if (settings.startMaximized) mainWindow.maximize(); // fill the screen on launch
    mainWindow.show();
  });

  mainWindow.on('maximize', sendWinState);
  mainWindow.on('unmaximize', sendWinState);
  // Initial sync once the chrome has loaded and is listening — covers launching
  // already-maximized, where the 'maximize' above can fire before the renderer
  // attaches its win:state handler (otherwise the window opens with the controls
  // clipped until the first manual maximize toggle).
  mainWindow.webContents.on('did-finish-load', sendWinState);
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- IPC sender validation -------------------------------------------------
// Guest pages get our adblock + content-script preloads injected, and those run
// in a world that can address main over ipcRenderer. The privileged channels
// (window controls, settings, Clean Slate, clipboard, notepad export, downloads)
// are meant for ONE caller: the trusted chrome document, which alone holds the
// window.ephemera bridge. We validate the sender on every privileged channel
// (Electron's recommended "validate the sender of all IPC messages" practice) so
// a compromised or hostile guest can't drive them. The chrome is the only
// legitimate caller, so this is completely invisible to the user.
//
// Channels left open to guests on purpose: the @ghostery/* cosmetic-filter IPC,
// ephemera:adblock (a boolean query), and ephemera:open-files (drop-a-file-on-a
// -page opens it in a tab) - the last is bounded with its own input validation.
function fromChrome(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}
function handleChrome(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => (fromChrome(event) ? fn(event, ...args) : undefined));
}
function onChrome(channel, fn) {
  ipcMain.on(channel, (event, ...args) => { if (fromChrome(event)) fn(event, ...args); });
}

// --- IPC -------------------------------------------------------------------
function registerIpc() {
  onChrome('win:minimize', () => mainWindow && mainWindow.minimize());
  onChrome('win:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  onChrome('win:close', () => mainWindow && mainWindow.close());

  // Settings: read + write the persisted preference file.
  handleChrome('settings:get', () => settings);
  handleChrome('settings:set', (_event, patch) => {
    patch = { ...(patch || {}) };
    // Beautiful mode and High-performance mode are mutually exclusive: one adds
    // motion, the other strips it. Whichever the user just switched ON forces the
    // other OFF, so the persisted state (and both toggles) can never show both.
    if (patch.beautifulMode === true) patch.highPerf = false;
    if (patch.highPerf === true) patch.beautifulMode = false;
    // Toggling "Open maximised" applies immediately, not just next launch.
    if (typeof patch.startMaximized === 'boolean' && mainWindow && !mainWindow.isDestroyed()) {
      if (patch.startMaximized) { if (!mainWindow.isMaximized()) mainWindow.maximize(); }
      else if (mainWindow.isMaximized()) mainWindow.unmaximize();
    }
    settings = { ...settings, ...patch };
    saveSettings();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', settings);
    // Push the adblock state to every guest page so the in-page YouTube
    // ad-skipper turns off live when the user disables "Block ads and trackers".
    try {
      webContents.getAllWebContents().forEach((wc) => {
        try { wc.send('ephemera:adblock', settings.adblock); } catch (_) {}
      });
    } catch (_) {}
    return settings;
  });

  // The injected webview-content preload asks for the current adblock state to
  // decide whether to skip YouTube's first-party ads.
  ipcMain.handle('ephemera:adblock', () => settings.adblock);

  // --- onion routing (Tor) -------------------------------------------------
  // Chrome-only: the trusted renderer drives the Tor lifecycle. A guest page can
  // never reach these (fromChrome guard), so a hostile site can't flip the proxy.
  handleChrome('tor:status', () => torStatus());
  // Re-probe for a running Tor right now (drives the live banner / onboarding poll).
  handleChrome('tor:check', () => refreshTorStatus());
  // Build the Tor session if needed, then report status. The renderer calls this
  // and awaits it BEFORE attaching a Tor <webview>, so the proxy + hardening are
  // already in place when the guest loads.
  handleChrome('tor:prepare', async () => {
    setupTorSession();
    return await refreshTorStatus();
  });
  // Fresh circuit + wiped Tor session.
  handleChrome('tor:new-identity', async () => {
    await torNewIdentity();
    return torStatus();
  });
  // Restart the bundled tor from scratch (used by the "Retry" escape when a
  // bootstrap stalls - e.g. a network that throttles Tor). Re-spawns + re-probes.
  handleChrome('tor:restart', async () => {
    stopBundledTor();
    return await refreshTorStatus();
  });

  // Open dropped local files (PDFs, images, text, html) in new tabs. Chromium's
  // built-in viewers render them; nothing is copied, we just navigate to file://.
  // Reachable from guest pages too (you can drop a file straight onto a web page),
  // so it can't be chrome-locked - bound it instead: only existing regular files,
  // capped, restricted to viewer-safe extensions (so a drag never navigates the
  // app to, say, a local .html that could probe other file:// paths), each turned
  // into a local file:// URL and nothing else.
  const OPENABLE_EXT = new Set([
    '.pdf', '.txt', '.md', '.log', '.json', '.csv', '.xml',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'
  ]);
  ipcMain.on('ephemera:open-files', (_event, paths) => {
    if (!mainWindow || mainWindow.isDestroyed() || !Array.isArray(paths)) return;
    let opened = 0;
    for (const p of paths) {
      if (opened >= 16) break;
      if (typeof p !== 'string' || !p) continue;
      if (!OPENABLE_EXT.has(path.extname(p).toLowerCase())) continue;
      try {
        if (!fs.statSync(p).isFile()) continue; // skip dirs / missing / special paths
        mainWindow.webContents.send('new-tab', require('url').pathToFileURL(p).href);
        opened++;
      } catch (_) {}
    }
  });

  // Clipboard access for the custom context menu (copy link/image, paste).
  handleChrome('clipboard:write', (_event, text) => clipboard.writeText(String(text == null ? '' : text)));
  handleChrome('clipboard:read', () => clipboard.readText());

  // The headline feature: wipe the ephemeral session to a fresh state.
  handleChrome('clean-slate', async (_event, opts) => {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'shadercache',
        'websql',
        'serviceworkers',
        'cachestorage'
      ]
    });
    await ses.clearCache();
    if (typeof ses.clearHostResolverCache === 'function') await ses.clearHostResolverCache();
    if (typeof ses.clearAuthCache === 'function') await ses.clearAuthCache();

    // The anonymous Tor jar is just as ephemeral - wipe it on Clean Slate too, so
    // nothing browsed over Tor outlives the session either. (Only if it was ever
    // created; users who never opened a Tor tab have no Tor session to clear.)
    if (torSession) {
      await torSession.clearStorageData({
        storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
      });
      await torSession.clearCache();
      if (typeof torSession.clearHostResolverCache === 'function') await torSession.clearHostResolverCache();
      if (typeof torSession.clearAuthCache === 'function') await torSession.clearAuthCache();
      // Fresh Tor circuit too, so the post-wipe session also looks like a new user
      // on the network (best-effort; the storage wipe above is the guarantee). For a
      // user's OWN Tor this rotates its circuit; the bundled tor is killed outright
      // next.
      try { await trySignalNewnym(); } catch (_) {}
    }
    // The bundled tor's on-disk data dir (control cookie, guard state - evidence Tor
    // was used) is part of "everything": Clean Slate kills it and deletes the dir.
    // The next onion tab re-spawns and re-bootstraps. (No-op if we never started it.)
    stopBundledTor();

    // Delete every downloaded file too - this is what makes the wipe total.
    wipeDownloads();

    // Optionally delete the exported notepad .txt (default yes; the confirm
    // dialog lets the user spare it for this one wipe via "Keep it").
    const keepNote = !!(opts && opts.keepNotepad);
    if (settings.notepadPath && settings.notepadDeleteOnClear && !keepNote) {
      try { fs.rmSync(settings.notepadPath, { force: true }); } catch (_) {}
      settings.notepadPath = '';
      saveSettings();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', settings);
    }

    blockedCount = 0;
    counterDirty = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('blocked-count', 0);
      mainWindow.webContents.send('downloads:update', downloadsList());
    }
    return true;
  });

  // Notepad: export to a file the user picks. Two formats:
  //   - 'txt': the active note's text as a plain .txt (the simple quick-save).
  //   - 'zip': ALL notes bundled, one .txt per note, OPTIONALLY encrypted. A
  //     password produces a real AES-256 zip (the WinZip-AES standard that 7-Zip /
  //     WinRAR / PeaZip open with the password); no password produces a plain zip.
  // We remember the path so Clean Slate can (optionally) delete it later. The
  // notes themselves never touch disk except through this deliberate export.
  handleChrome('notepad:save', async (_event, payload) => {
    try {
      const { dialog } = require('electron');
      payload = payload || {};
      const isZip = payload.format === 'zip';
      const ext = isZip ? 'zip' : 'txt';
      const home = (() => { try { return app.getPath('documents'); } catch (_) { return app.getPath('home'); } })();
      // Reuse the previous path only when its extension matches this format, so a
      // prior .txt export doesn't pre-fill a .zip save (and vice versa).
      const prior = settings.notepadPath &&
        path.extname(settings.notepadPath).toLowerCase() === '.' + ext ? settings.notepadPath : '';
      const def = prior || path.join(home, 'ephemera-notes.' + ext);
      const res = await dialog.showSaveDialog(mainWindow, {
        title: isZip ? 'Export notes' : 'Save note',
        defaultPath: def,
        filters: [isZip ? { name: 'Zip archive', extensions: ['zip'] } : { name: 'Text file', extensions: ['txt'] }]
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      if (isZip) {
        const buf = await buildNotesZip(payload.notes, payload.password);
        fs.writeFileSync(res.filePath, buf);
      } else {
        fs.writeFileSync(res.filePath, String(payload.text == null ? '' : payload.text), 'utf8');
      }
      settings.notepadPath = res.filePath;
      saveSettings();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', settings);
      return { ok: true, path: res.filePath, format: ext, encrypted: !!(isZip && payload.password) };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });

  // --- downloads -----------------------------------------------------------
  handleChrome('downloads:get', () => downloadsList());
  handleChrome('downloads:open', (_e, id) => {
    const r = downloads.get(id);
    if (r && r.meta.state === 'completed') shell.openPath(r.meta.savePath).catch(() => {});
    return true;
  });
  handleChrome('downloads:reveal', (_e, id) => {
    const r = downloads.get(id);
    if (r) { try { shell.showItemInFolder(r.meta.savePath); } catch (_) {} }
    return true;
  });
  handleChrome('downloads:pause', (_e, id) => {
    const r = downloads.get(id);
    if (r && r.item) { try { r.item.pause(); } catch (_) {} }
    return true;
  });
  handleChrome('downloads:resume', (_e, id) => {
    const r = downloads.get(id);
    if (r && r.item && r.item.canResume()) { try { r.item.resume(); } catch (_) {} }
    return true;
  });
  handleChrome('downloads:cancel', (_e, id) => {
    const r = downloads.get(id);
    if (r && r.item) { try { r.item.cancel(); } catch (_) {} }
    return true;
  });
  handleChrome('downloads:remove', (_e, id) => {
    const r = downloads.get(id);
    if (!r) return true;
    if (r.item) { try { r.item.cancel(); } catch (_) {} }
    try { fs.rmSync(r.meta.savePath, { force: true }); } catch (_) {}
    downloads.delete(id);
    pushDownloads();
    return true;
  });
  handleChrome('downloads:retry', (_e, id) => {
    const r = downloads.get(id);
    if (!r) return true;
    const url = r.meta.url;
    const wasTor = !!r.meta.tor;
    if (r.item) { try { r.item.cancel(); } catch (_) {} }
    try { fs.rmSync(r.meta.savePath, { force: true }); } catch (_) {}
    downloads.delete(id);
    pushDownloads();
    // Re-issue the request so it flows back through will-download into the folder -
    // but through a webContents on the SAME partition it came from. A Tor download
    // must go back out over Tor: we route it through a live Tor guest, and if none
    // exists we decline rather than leak it through the direct session.
    if (/^https?:\/\//i.test(url)) {
      let wc = null;
      if (wasTor) wc = firstTorWebContents();
      else if (mainWindow && !mainWindow.isDestroyed()) wc = mainWindow.webContents;
      if (wc && !wc.isDestroyed()) { try { wc.downloadURL(url); } catch (_) {} }
    }
    return true;
  });
  handleChrome('downloads:clear', () => {
    wipeDownloads();
    pushDownloads();
    return true;
  });
  // Save a media URL on demand (context-menu "Save image"). Issuing it through
  // the originating GUEST webContents routes the request back through our
  // will-download handler (file lands in DOWNLOADS_DIR, wiped with everything)
  // and keeps the page's own session/referrer. Locked down: only http(s) (no
  // data: blobs written via us), and it must come from a live guest - we never
  // download through the privileged chrome webContents.
  handleChrome('downloads:start', (_e, url, wcId) => {
    if (!/^https?:/i.test(url || '') || !wcId) return false;
    try {
      const wc = webContents.fromId(wcId);
      if (wc && !wc.isDestroyed() && wc !== mainWindow.webContents) wc.downloadURL(url);
    } catch (_) {}
    return true;
  });
}

// Browser-wide keyboard shortcuts. We intercept at the main-process level via
// before-input-event because a focused <webview> swallows keydown in the chrome
// renderer - so shortcuts would otherwise die the moment you start browsing.
// This fires no matter which webContents (chrome or guest) holds focus; we map
// the chord and let the renderer carry out the action.
function registerShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (!mod) return;
    const key = (input.key || '').toLowerCase();
    let action = null;
    if (key === 't' && !input.shift) action = 'new-tab';
    else if (key === 't' && input.shift) action = 'reopen-tab';
    else if (key === 'n' && input.shift) action = 'new-tor-tab'; // Ctrl/Cmd+Shift+N: anonymous Tor tab
    else if (key === 'w' && !input.shift) action = 'close-tab';
    else if (key === 'l') action = 'focus-address';
    else if (key === 'r' && !input.shift) action = 'reload';
    else if (key === 'f' && !input.shift) action = 'find';
    else if (key === '=' || key === '+') action = 'zoom-in';
    else if (key === '-') action = 'zoom-out';
    else if (key === '0') action = 'zoom-reset';
    else if (key === 'k' && input.shift) action = 'clean-slate';
    else if (key === ',') action = 'settings';
    else if (key === 'tab') action = input.shift ? 'prev-tab' : 'next-tab';
    if (action) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shortcut', action);
    }
  });
}

// Forward popup / target=_blank navigations to the renderer as new tabs, keep
// external protocols out of the in-app webviews, and wire up shortcuts.
app.on('web-contents-created', (_event, contents) => {
  registerShortcuts(contents);

  // Stop WebRTC from leaking the machine's real IP. A page can open one
  // RTCPeerConnection with no permission prompt and read the host's addresses
  // from ICE candidates - the classic deanonymisation / VPN-bypass vector, and
  // for a leave-no-trace browser the *public* server-reflexive IP is the value
  // that matters most. 'default_public_interface_only' only hides the extra LAN
  // interfaces; it still leaks the public IP. 'disable_non_proxied_udp' forces
  // all WebRTC traffic through a proxy (or TCP/TURN), so a direct-connection
  // page can never learn the real IP. Trade-off: peer-to-peer UDP media (some
  // video calls without TURN) may not connect - acceptable for an anonymity tool.
  try {
    if (typeof contents.setWebRTCIPHandlingPolicy === 'function') {
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    }
  } catch (_) {}

  contents.setWindowOpenHandler(({ url }) => {
    // Carry the OPENER's partition so a popup / target=_blank / middle-click from a
    // Tor page opens as a Tor tab and never escapes to the direct session.
    const fromTor = !!torSession && contents.session === torSession;
    if (/^https?:\/\//i.test(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('new-tab', url, fromTor);
    } else if (/^mailto:|^tel:/i.test(url)) {
      // Never hand a Tor-page-derived address to a clearnet OS app (state escape).
      if (!fromTor) shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // The chrome document must never navigate away from its own renderer files.
  contents.on('will-navigate', (event, url) => {
    if (mainWindow && contents === mainWindow.webContents && !url.startsWith('file:')) {
      event.preventDefault();
    }
  });

  // Right-click inside a guest page: forward the params to the chrome, which
  // renders our own styled context menu. (The chrome's own inputs get a menu
  // built entirely in the renderer.)
  contents.on('context-menu', (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (contents === mainWindow.webContents) return;
    // params.x/y from a <webview> guest don't line up with the chrome's own
    // coordinate space (they sit under the toolbar). Use the real cursor point
    // mapped into the window's content area (both in DIP / CSS px) instead.
    const cur = screen.getCursorScreenPoint();
    const cb = mainWindow.getContentBounds();
    mainWindow.webContents.send('context-menu', {
      x: cur.x - cb.x,
      y: cur.y - cb.y,
      linkURL: params.linkURL || '',
      srcURL: params.srcURL || '',
      mediaType: params.mediaType || 'none',
      selectionText: (params.selectionText || '').trim(),
      isEditable: !!params.isEditable,
      editFlags: params.editFlags || {}
    });
  });
});

app.whenReady().then(() => {
  // Set the global default UA before any webContents is created so navigator.userAgent
  // and every request header carry the generic Chrome identity (anti-fingerprinting).
  app.userAgentFallback = GENERIC_UA;
  loadSettings();
  initDownloadsDir();
  wipeTorDataDir(); // clear any bundled-tor data dir a prior (crashed) session left behind
  const ses = session.fromPartition(PARTITION);
  hardenSession(ses, false); // normal browsing: security level uses securityLevel
  registerDownloads(ses);
  // Arm content preloads (cosmetic filter + YouTube skipper) BEFORE any webview
  // can attach, so the very first page load is already covered. (Independent of
  // the async filter-list load below.)
  try { ses.setPreloads([ADBLOCK_PRELOAD, WEBVIEW_CONTENT]); }
  catch (e) { console.error('[ephemera] setPreloads failed:', e.message); }
  registerCosmeticIpc();
  registerIpc();
  createWindow();
  enableAdblock(ses); // async - UI is already up; counter starts once lists load
  setInterval(flushCounter, 200);
  setInterval(flushDownloads, 130);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Tear the ephemeral folder down on the way out so a quit leaves nothing behind,
// the same guarantee Clean Slate gives mid-session. Cancel first (releases any
// file locks), then delete.
app.on('before-quit', () => {
  for (const r of downloads.values()) { if (r.item) { try { r.item.cancel(); } catch (_) {} } }
});
app.on('will-quit', () => {
  if (DOWNLOADS_DIR) { try { fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true }); } catch (_) {} }
  // Kill the bundled tor and wipe its ephemeral data dir - nothing about this
  // session, including the fact that Tor ran, survives on disk.
  stopBundledTor();
});

app.on('window-all-closed', () => {
  // Quit on all platforms - there is no persisted state to keep an app alive for.
  app.quit();
});
