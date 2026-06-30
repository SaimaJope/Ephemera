'use strict';

/**
 * preload.js - the only bridge between the sandboxed renderer and the main
 * process. The renderer never touches Node or ipcRenderer directly; it sees
 * exactly the small, audited surface exposed here as `window.ephemera`.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ephemera', {
  // Frameless-window controls.
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),

  // The panic button: wipe the ephemeral session and reset the counter.
  // Resolves once main has finished clearing everything. opts.keepNotepad spares
  // the exported notepad .txt for this one wipe.
  cleanSlate: (opts) => ipcRenderer.invoke('clean-slate', opts),

  // Notepad: export to a user-chosen file (Save dialog). payload is either
  //   { format: 'txt', text }                         - the active note as .txt
  //   { format: 'zip', notes: [{title, body}], password } - all notes, AES-256
  //     encrypted when a password is given, else a plain .zip.
  notepadSave: (payload) => ipcRenderer.invoke('notepad:save', payload),

  // Live count of blocked ad/tracker requests.
  onBlockedCount: (cb) => {
    const handler = (_event, count) => cb(count);
    ipcRenderer.on('blocked-count', handler);
    return () => ipcRenderer.removeListener('blocked-count', handler);
  },

  // A popup / target=_blank navigation that should open as a new tab. `tor` is
  // true when the opener was a Tor tab, so the new tab stays on Tor (no leak).
  onNewTab: (cb) => {
    const handler = (_event, url, tor) => cb(url, tor);
    ipcRenderer.on('new-tab', handler);
    return () => ipcRenderer.removeListener('new-tab', handler);
  },

  // Maximized / normal transitions, for the maximize-button glyph.
  onWindowState: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on('win:state', handler);
    return () => ipcRenderer.removeListener('win:state', handler);
  },

  // Browser-wide keyboard shortcuts, intercepted in main (work even while a
  // <webview> holds focus). Action is one of: new-tab, close-tab,
  // focus-address, reload, clean-slate, next-tab, prev-tab.
  onShortcut: (cb) => {
    const handler = (_event, action) => cb(action);
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },

  // User preferences (persisted by main).
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => {
    const handler = (_event, s) => cb(s);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },

  // Right-click in a page: main forwards the context params here so the renderer
  // can show its own styled menu.
  onContextMenu: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('context-menu', handler);
    return () => ipcRenderer.removeListener('context-menu', handler);
  },

  // Clipboard, for context-menu copy/paste of links and addresses.
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

  // Open dropped local files (PDFs/images/text) in new tabs.
  openFiles: (paths) => ipcRenderer.send('ephemera:open-files', paths),

  // Onion routing (Tor). The chrome prepares the Tor session before opening a Tor
  // tab, polls check() to drive the live "Tor detected / start Tor" banner, and
  // can request a fresh identity. status/check/prepare/newIdentity all resolve to
  // { enabled, running, port, ready }.
  tor: {
    status:      () => ipcRenderer.invoke('tor:status'),
    check:       () => ipcRenderer.invoke('tor:check'),
    prepare:     () => ipcRenderer.invoke('tor:prepare'),
    newIdentity: () => ipcRenderer.invoke('tor:new-identity'),
    restart:     () => ipcRenderer.invoke('tor:restart'),
    onStatus: (cb) => {
      const handler = (_event, status) => cb(status);
      ipcRenderer.on('tor:status', handler);
      return () => ipcRenderer.removeListener('tor:status', handler);
    }
  },

  // Downloads. Everything lands in one ephemeral folder that Clean Slate (and
  // quit) deletes outright; the renderer drives the Firefox-style panel from
  // the live list pushed over 'downloads:update'.
  downloads: {
    getAll: () => ipcRenderer.invoke('downloads:get'),
    // Save a media URL (e.g. context-menu "Save image"); wcId is the guest
    // webContents the URL came from, so the fetch keeps the page's session.
    start:  (url, wcId) => ipcRenderer.invoke('downloads:start', url, wcId),
    open:   (id) => ipcRenderer.invoke('downloads:open', id),
    reveal: (id) => ipcRenderer.invoke('downloads:reveal', id),
    pause:  (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    retry:  (id) => ipcRenderer.invoke('downloads:retry', id),
    clear:  () => ipcRenderer.invoke('downloads:clear'),
    onUpdate: (cb) => {
      const handler = (_event, list) => cb(list);
      ipcRenderer.on('downloads:update', handler);
      return () => ipcRenderer.removeListener('downloads:update', handler);
    }
  }
});
