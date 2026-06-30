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
  language: 'en',            // 'en' | 'es' | 'ru' | 'fi'
  highPerf: false,           // fewer animations, no cosmetic mutation observer
  beautifulMode: false,      // extra motion: mouse-reactive new-tab dust, animated tab close
  startMaximized: true,      // open filling the screen (toggleable in Settings)
  notepadDeleteOnClear: true, // Clean Slate also deletes the exported notepad .txt
  notepadPath: ''            // last path the notepad was exported to (for delete-on-clear)
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

function registerDownloads(ses) {
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

// --- privacy hardening on the ephemeral session ----------------------------
function hardenSession(ses) {
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
    callback({ requestHeaders: headers });
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
function registerCosmeticIpc() {
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    try {
      if (!adblockBlocker || !settings.adblock) return;
      // The sender frame may already be gone by the time this async IPC runs
      // (fast navigation/teardown). Touching it would throw "Render frame was
      // disposedâ¦"; bail quietly instead.
      if (!event.sender || event.sender.isDestroyed()) return;
      // Don't run cosmetics against our own chrome / new-tab files.
      if (typeof event.sender.getURL === 'function' && event.sender.getURL().startsWith('file:')) return;
      return adblockBlocker.onInjectCosmeticFilters(event, url, msg);
    } catch (_) { /* never let a page break the main process */ }
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => {
    try {
      if (settings.highPerf) return false; // skip per-mutation cosmetic work in high-perf mode
      return adblockBlocker ? adblockBlocker.onIsMutationObserverEnabled(event) : false;
    } catch (_) { return false; }
  });
}

async function enableAdblock(ses) {
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

    // Network blocking (with live counting), gated on the adblock setting. We
    // drive onBeforeRequest ourselves rather than enableBlockingInSession() so
    // we can (a) count every block and (b) avoid the Electron-35-only path.
    const guessType = blocker.config.guessRequestTypeFromUrl === true;
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!settings.adblock) { callback({}); return; }
      // Main-frame navigations are never blocked, so detect them straight from
      // resourceType and skip building a Request (which parses the URL via tldts
      // twice and allocates hash arrays) for every top-level load. The
      // isMainFrame() check below still guards any non-standard resourceType, so
      // the set of blocked requests is byte-for-byte identical.
      if (details.resourceType === 'mainFrame') { callback({}); return; }
      const request = fromElectronDetails(details);
      if (guessType && request.type === 'other') {
        request.guessTypeOfRequest();
      }
      if (request.isMainFrame()) { callback({}); return; }
      const { redirect, match } = blocker.match(request);
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

    console.log('[ephemera] full ad/tracker blocking enabled (network + cosmetics)');
  } catch (err) {
    // A failed filter-list fetch must never take the browser down.
    console.error('[ephemera] adblock init failed, continuing without it:', err.message);
  }
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

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', 'normal'));
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

  // Notepad: export the current text to a .txt the user picks. We remember the
  // path so Clean Slate can (optionally) delete it later.
  handleChrome('notepad:save', async (_event, text) => {
    try {
      const { dialog } = require('electron');
      const home = (() => { try { return app.getPath('documents'); } catch (_) { return app.getPath('home'); } })();
      const def = settings.notepadPath || path.join(home, 'ephemera-notes.txt');
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save notepad',
        defaultPath: def,
        filters: [{ name: 'Text file', extensions: ['txt'] }]
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      fs.writeFileSync(res.filePath, String(text == null ? '' : text), 'utf8');
      settings.notepadPath = res.filePath;
      saveSettings();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', settings);
      return { ok: true, path: res.filePath };
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
    if (r.item) { try { r.item.cancel(); } catch (_) {} }
    try { fs.rmSync(r.meta.savePath, { force: true }); } catch (_) {}
    downloads.delete(id);
    pushDownloads();
    // mainWindow.webContents is on the same ephemeral partition, so re-issuing
    // the request flows back through our will-download handler into the folder.
    if (/^https?:\/\//i.test(url) && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.downloadURL(url); } catch (_) {}
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
    if (/^https?:\/\//i.test(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('new-tab', url);
    } else if (/^mailto:|^tel:/i.test(url)) {
      shell.openExternal(url);
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
  const ses = session.fromPartition(PARTITION);
  hardenSession(ses);
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
});

app.on('window-all-closed', () => {
  // Quit on all platforms - there is no persisted state to keep an app alive for.
  app.quit();
});
