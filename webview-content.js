'use strict';

/**
 * webview-content.js - injected into every page (via session.setPreloads,
 * alongside the ghostery cosmetic-filter preload).
 *
 * The ghostery preload handles general cosmetic ad-hiding from the filter
 * lists. This script adds the one thing network + cosmetic filters can't do
 * reliably: skipping YouTube's *first-party* video ads (the pre-roll/mid-roll
 * that streams from the same origin as the video). It fast-forwards the ad
 * video to its end and clicks any skip button, and hides YouTube's sponsored
 * shelves/cards.
 *
 * This is gated on the user's "Block ads and trackers" setting (queried from
 * main via ipcRenderer, like the ghostery preload). When the blocker is OFF,
 * the skipper stands down and YouTube ads play normally - matching the network
 * + cosmetic blocking, which main already gates on the same setting.
 */

// Drop a local file (PDF, image, text, html) anywhere on the window and it opens
// in a new tab via Chromium's built-in viewers. Runs on every page (chrome + all
// guests). Bubble phase + a defaultPrevented check means web apps that accept
// their own dropped files keep working — we only claim drops nothing else wanted.
(() => {
  let ipc = null, webUtils = null;
  try { const e = require('electron'); ipc = e.ipcRenderer; webUtils = e.webUtils; } catch (_) {}
  if (!ipc) return;
  const hasFiles = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  };
  const pathOf = (f) => {
    try { return (webUtils && webUtils.getPathForFile(f)) || f.path || ''; } catch (_) { return f.path || ''; }
  };
  window.addEventListener('dragover', (e) => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    const files = e.dataTransfer.files, paths = [];
    for (let i = 0; i < files.length; i++) { const p = pathOf(files[i]); if (p) paths.push(p); }
    if (!paths.length) return;
    e.preventDefault();
    try { ipc.send('ephemera:open-files', paths); } catch (_) {}
  });
})();

// Ctrl + mouse wheel = page zoom. The wheel fires inside the guest (the page), so
// we catch it here, stop Chromium's own zoom, and hand the direction to the chrome,
// which owns the per-tab zoom factor (keeping wheel zoom in sync with Ctrl +/-/0).
// Capture + { passive: false } so preventDefault actually cancels the native zoom.
(() => {
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (_) {}
  if (!ipc) return;
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || e.deltaY === 0) return; // plain scroll is left untouched
    e.preventDefault();
    try { ipc.sendToHost('ephemera:zoom', e.deltaY < 0 ? 1 : -1); } catch (_) {}
  }, { passive: false, capture: true });
})();

(() => {
  const host = location.hostname;
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/.test(host);
  if (!isYouTube) return;

  // Live mirror of the adblock setting. Default to on; corrected within a tick
  // by the invoke below, and kept fresh by main's broadcast on settings change.
  let adblockOn = true;
  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.invoke('ephemera:adblock').then((v) => { adblockOn = !!v; }).catch(() => {});
    ipcRenderer.on('ephemera:adblock', (_e, v) => { adblockOn = !!v; });
  } catch (_) { /* no ipc available - behave as if blocking is on */ }

  // Hide sponsored shelves, display ads, masthead ads, and the "skip ads or
  // get Premium" nag dialogs.
  const HIDE = [
    'ytd-promoted-video-renderer', 'ytd-display-ad-renderer', 'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer', 'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer',
    'ytd-companion-slot-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-text-search-renderer',
    '#player-ads', '#masthead-ad', '.ytp-ad-overlay-container', '.ytp-ad-message-container',
    'ytmusic-mealbar-promo-renderer', 'ad-slot-renderer', 'ytd-mealbar-promo-renderer'
  ].join(',') + '{display:none !important;}';

  function injectStyle() {
    if (document.getElementById('__ephemera_yt')) return;
    const s = document.createElement('style');
    s.id = '__ephemera_yt';
    s.textContent = HIDE;
    (document.head || document.documentElement).appendChild(s);
  }

  function removeStyle() {
    const s = document.getElementById('__ephemera_yt');
    if (s) s.remove();
  }

  // Hoisted once so the per-tick overlay-close scan below doesn't allocate a new
  // closure 4x/sec for the life of every YouTube page.
  const clickEach = (b) => b.click();

  function skipVideoAd() {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) {
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video && isFinite(video.duration) && video.duration > 0) {
        // Seek the ad to its end so it completes instantly. We do NOT touch
        // playbackRate: YouTube reuses one <video> element for ad + content, and
        // a left-over fast rate made the first real video buffer/churn.
        try { video.currentTime = video.duration; } catch (_) {}
      }
      const skip = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button'
      );
      if (skip) skip.click();
    }
    document.querySelectorAll('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container').forEach(clickEach);
  }

  function tick() {
    if (!adblockOn) { removeStyle(); return; } // blocker off -> let ads play
    // No point scanning a backgrounded tab 4x/sec: nothing is being watched, and
    // YouTube pauses hidden playback anyway. This stops every open YouTube tab
    // from being a permanent DOM-scan in the background.
    if (document.hidden) return;
    injectStyle();
    skipVideoAd();
  }

  const start = () => {
    tick();
    setInterval(tick, 250);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
