'use strict';

/**
 * error.js - Ephemera's per-site load-error screen.
 *
 * Sibling of offline.js. Where the offline egg covers a whole-network outage,
 * THIS screen is raised (by renderer.js) over the content area when ONE site's
 * main-frame navigation fails: DNS not found, connection refused, timed out,
 * reset, a bad TLS certificate, too many redirects, an empty response, etc. It
 * stands in for Chromium's bare default error page.
 *
 * The diagnostic eyebrow/title/host name WHAT failed; the centrepiece is a
 * playable, self-contained retro Tetris drawn on a low-resolution canvas scaled
 * up with nearest-neighbour sampling so every block stays a crisp 8-bit brick.
 * Like Chrome's dino game it sits still until you press Space - no attract mode,
 * which also keeps reduced-motion / High-performance happy (nothing animates
 * unless you're playing). Arrow keys move/soft-drop, Up rotates, Space hard-drops
 * (and starts/restarts), P pauses; Enter retries the navigation, Backspace goes
 * back. The board chrome follows the live --accent; the seven tetrominoes carry a
 * fixed, lightly-muted classic palette so the field reads unmistakably as Tetris.
 *
 * Exposes window.__ephemeraError = { show, hide, setAccent, isVisible }, the
 * same controller shape as offline.js, which the chrome calls.
 */

(() => {
  const root = document.getElementById('error-screen');
  if (!root) return;

  const elCmd    = document.getElementById('err-cmd');
  const elGlyph  = document.getElementById('err-glyph');
  const elTitle  = document.getElementById('err-title');
  const elSub    = document.getElementById('err-sub');
  const elHost   = document.getElementById('err-host');
  const elCode   = document.getElementById('err-code');
  const elHint   = document.getElementById('err-hint');
  const elRetry  = document.getElementById('err-retry');
  const elBack   = document.getElementById('err-back');
  const board    = document.getElementById('err-board');
  const next     = document.getElementById('err-next');
  const elScore  = document.getElementById('err-score');
  const elLines  = document.getElementById('err-lines');
  const elLevel  = document.getElementById('err-level');
  const elPrompt = document.getElementById('err-prompt');
  const elPTitle = document.getElementById('err-prompt-title');
  const elBegin  = document.getElementById('err-begin');
  const stageEl  = document.getElementById('err-stage');
  if (!board || !next) return;

  const bctx = board.getContext('2d');
  const nctx = next.getContext('2d');
  bctx.imageSmoothingEnabled = false;
  nctx.imageSmoothingEnabled = false;

  // High performance mode is treated the same as reduced-motion: in either "calm"
  // state line clears resolve instantly (no flash) and the field never shakes.
  const reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const isCalm = () => !!reduceMq.matches || document.body.classList.contains('high-perf');
  const now = () => (window.performance && performance.now ? performance.now() : 0);

  // ── Per-failure-class glyphs (24px, 1.7 stroke, currentColor) ───────────────
  const GLYPHS = {
    dns: '<svg viewBox="0 0 24 24" class="err-glyph-fill"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.96973 5.03039L18.9697 20.0304L20.0304 18.9697L5.03039 3.96973L3.96973 5.03039ZM2.92454 9.67478C3.71079 8.88852 4.57369 8.2256 5.48917 7.68602L6.58987 8.78672C5.86769 9.17925 5.17917 9.65606 4.53875 10.2172L11.9999 17.5283L13.6826 15.8795L14.7433 16.9402L11.9999 19.6284L2.38879 10.2105L2.92454 9.67478ZM19.4611 10.2172L15.8255 13.7797L16.8862 14.8404L21.611 10.2105L21.0753 9.67478C17.6588 6.25827 12.7953 5.17059 8.45752 6.41173L9.69662 7.65083C13.0757 6.95288 16.7117 7.80832 19.4611 10.2172Z"/></svg>',
    refused: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 18.4 18.4"/></svg>',
    timeout: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>',
    reset: '<svg viewBox="0 0 24 24"><path d="M10.5 13.2a4 4 0 0 0 5.7 0l1.8-1.8a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M13.5 10.8a4 4 0 0 0-5.7 0L6 12.6a4 4 0 0 0 5.7 5.7l1-1"/><path d="M3.5 3.5 20.5 20.5"/></svg>',
    cert: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3.1 7.8 7 9 1.7-.5 3.2-1.5 4.4-2.8"/><path d="M19 13.2V6l-7-3"/><path d="M4.5 4.5 19.5 19.5"/></svg>',
    redirect: '<svg viewBox="0 0 24 24"><path d="M17 2.5 21 6.5l-4 4"/><path d="M3 11.5v-1a4 4 0 0 1 4-4h14"/><path d="M7 21.5 3 17.5l4-4"/><path d="M21 12.5v1a4 4 0 0 1-4 4H3"/></svg>',
    empty: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
    generic: '<svg viewBox="0 0 24 24"><path d="M10.3 4 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/></svg>',
  };

  // ── Board geometry (logical canvas pixels; CSS scales it up, pixelated) ─────
  const COLS = 10, ROWS = 20, CELL = 10;   // board canvas = 100 x 200
  const PCELL = 8;                          // preview cell (next canvas = 40 x 40)

  // Seven tetrominoes: spawn matrix + a 1-based piece id (so grid 0 = "empty").
  // The field is MONOCHROME, Game-Boy style: every piece is the same hue as the
  // live accent (the Kali phosphor green/blue), differing only in brightness. Each
  // id maps to one of three accent tones below so neighbouring pieces still read
  // apart without ever introducing a second colour.
  const PIECE_TONE = [0, 2, 1, 2, 1, 0, 1, 0];   // index by piece id 1..7 → tone 0..2
  const PIECES = {
    I: { c: 1, m: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },
    O: { c: 2, m: [[1,1],[1,1]] },
    T: { c: 3, m: [[0,1,0],[1,1,1],[0,0,0]] },
    S: { c: 4, m: [[0,1,1],[1,1,0],[0,0,0]] },
    Z: { c: 5, m: [[1,1,0],[0,1,1],[0,0,0]] },
    J: { c: 6, m: [[1,0,0],[1,1,1],[0,0,0]] },
    L: { c: 7, m: [[0,0,1],[1,1,1],[0,0,0]] },
  };
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const SCORE_TABLE = [0, 100, 300, 500, 800];   // 0,1,2,3,4 lines
  const LOCK_DELAY = 420, MAX_RESETS = 15;

  function rotateCW(m) {
    const n = m.length, r = [];
    for (let y = 0; y < n; y++) { r.push(new Array(n).fill(0)); }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) r[x][n - 1 - y] = m[y][x];
    return r;
  }
  function widthOf(m) {
    let w = 0;
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) if (m[y][x]) w = Math.max(w, x + 1);
    return w;
  }

  // ── Colour helpers (monochrome accent ramp) ─────────────────────────────────
  const FIELD_RGB = [13, 16, 21];
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    const s = /^#?([0-9a-f]{3})$/i.exec((hex || '').trim());
    if (s) { const n = parseInt(s[1], 16); return [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17]; }
    return [124, 222, 150];
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';

  // ── Game state ──────────────────────────────────────────────────────────────
  let pal = { accent: '#b07cff', grid: 'rgba(255,255,255,0.04)', field: '#0d1015', tones: [], aRgb: [124, 222, 150] };
  const g = {
    grid: [],            // ROWS x COLS of colour index (0 = empty)
    piece: null,         // { type, color, m, x, y }
    nextType: null,
    bag: [],
    score: 0, lines: 0, level: 1,
    dropT: 0, lockT: 0, resets: 0,
    clearRows: null, clearT: 0,
    mode: 'ready',       // 'ready' | 'play' | 'clearing' | 'over'
  };
  const keys = { left: false, right: false, down: false };
  let raf = 0, last = 0, visible = false, onRetry = null, onBack = null;

  function readPalette(accent) {
    const cs = getComputedStyle(document.documentElement);
    const get = (n, f) => (cs.getPropertyValue(n).trim() || f);
    pal.accent = (accent && accent.trim()) || get('--accent', '#b07cff');
    pal.muted = get('--muted', '#8b93a1');
    // Three brightness tiers of the accent over the field — the whole monochrome
    // Game-Boy ramp. Each tier carries its own dark frame + light corner speck so
    // the bricks read as dot-matrix LCD cells, never a flat colour.
    const A = pal.aRgb = hexToRgb(pal.accent);
    const F = FIELD_RGB, WHITE = [255, 255, 255];
    const bases = [mix(A, F, 0.58), mix(A, F, 0.30), mix(A, F, 0.06)];   // dim · mid · bright
    pal.tones = bases.map((base) => ({
      base: rgb(base), dark: rgb(mix(base, F, 0.55)), light: rgb(mix(base, WHITE, 0.42)),
    }));
    pal.field = rgb(mix(F, A, 0.05));       // a breath of phosphor tint in the screen
    pal.grid = rgba(A, 0.07);               // faint accent-tinted dot-matrix grid
    pal.ghost = rgba(A, 0.20);              // landing outline
    pal.flash = rgb(mix(A, WHITE, 0.40));   // line-clear flash stays in-hue (no white)
  }

  function emptyGrid() { g.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0)); }
  function refillBag() {
    const b = TYPES.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = b[i]; b[i] = b[j]; b[j] = t; }
    g.bag = b;
  }
  function pullType() { if (!g.bag.length) refillBag(); return g.bag.pop(); }

  function makePiece(type) {
    const def = PIECES[type];
    const m = def.m.map((r) => r.slice());
    return { type, color: def.c, m, x: ((COLS - widthOf(m)) >> 1), y: 0 };
  }
  function collides(p, m, px, py) {
    m = m || p.m; px = (px == null) ? p.x : px; py = (py == null) ? p.y : py;
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      const bx = px + x, by = py + y;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && g.grid[by][bx]) return true;
    }
    return false;
  }
  function spawn() {
    const type = g.nextType || pullType();
    g.nextType = pullType();
    const p = makePiece(type);
    g.piece = p;
    g.lockT = 0; g.resets = 0;
    drawNext();
    if (collides(p)) { g.piece = null; gameOver(); return false; }
    return true;
  }
  function lockPiece() {
    const p = g.piece;
    for (let y = 0; y < p.m.length; y++) for (let x = 0; x < p.m[y].length; x++) {
      if (p.m[y][x] && p.y + y >= 0) g.grid[p.y + y][p.x + x] = p.color;
    }
    g.piece = null;
    // Find full rows.
    const full = [];
    for (let r = 0; r < ROWS; r++) { if (g.grid[r].every((v) => v)) full.push(r); }
    if (full.length) {
      addClearScore(full.length);
      if (isCalm()) { applyClears(full); spawn(); }
      else { g.clearRows = full; g.clearT = 180; g.mode = 'clearing'; }
    } else {
      spawn();
    }
  }
  function applyClears(rows) {
    const set = new Set(rows);
    const kept = [];
    for (let r = 0; r < ROWS; r++) if (!set.has(r)) kept.push(g.grid[r]);
    while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(0));
    g.grid = kept;
    g.clearRows = null;
  }
  function addClearScore(n) {
    g.lines += n;
    g.score += (SCORE_TABLE[n] || 0) * g.level;
    g.level = 1 + Math.floor(g.lines / 10);
    syncHud();
  }

  function move(dx) {
    const p = g.piece; if (!p) return false;
    if (!collides(p, p.m, p.x + dx, p.y)) { p.x += dx; touchLock(); return true; }
    return false;
  }
  function rotate() {
    const p = g.piece; if (!p) return;
    const rm = rotateCW(p.m);
    for (const k of [0, -1, 1, -2, 2]) {       // basic wall kick
      if (!collides(p, rm, p.x + k, p.y)) { p.m = rm; p.x += k; touchLock(); return; }
    }
  }
  function touchLock() {
    // Resting move/rotate refreshes the lock delay, up to a cap (anti-stall).
    if (g.piece && collides(g.piece, g.piece.m, g.piece.x, g.piece.y + 1) && g.resets < MAX_RESETS) {
      g.lockT = 0; g.resets++;
    }
  }
  function softStep() {
    const p = g.piece; if (!p) return false;
    if (!collides(p, p.m, p.x, p.y + 1)) { p.y += 1; g.lockT = 0; g.resets = 0; return true; }
    return false;
  }
  function hardDrop() {
    const p = g.piece; if (!p) return;
    let d = 0;
    while (!collides(p, p.m, p.x, p.y + 1)) { p.y += 1; d++; }
    g.score += d * 2; syncHud();
    lockPiece();
  }
  function ghostY() {
    const p = g.piece; if (!p) return 0;
    let y = p.y;
    while (!collides(p, p.m, p.x, y + 1)) y++;
    return y;
  }

  function gravityInterval() { return Math.max(70, 800 - (g.level - 1) * 65); }

  // The secret: pressing Space on the sealed error page unseals the game. The
  // vault expands (CSS), then a Begin button takes it from there - nothing ever
  // tells the user this is here.
  function openVault() {
    if (g.mode !== 'hidden') return;
    if (stageEl) stageEl.classList.add('open');
    g.mode = 'ready';
    showPrompt('');
    render();
  }
  function start() {
    if (stageEl) stageEl.classList.add('open');
    emptyGrid();
    g.score = 0; g.lines = 0; g.level = 1;
    g.dropT = 0; g.lockT = 0; g.resets = 0; g.clearRows = null;
    g.bag = []; g.nextType = null;
    syncHud();
    g.mode = 'play';
    spawn();
    hidePrompt();
    wake();
  }
  function gameOver() {
    g.mode = 'over';
    showPrompt('Game Over');
    render();
  }
  function togglePause() {
    if (g.mode === 'play') { g.mode = 'paused'; showPrompt('Paused'); render(); }
    else if (g.mode === 'paused') { g.mode = 'play'; hidePrompt(); wake(); }
  }

  // ── Per-frame update ────────────────────────────────────────────────────────
  function update(dt) {
    if (g.mode === 'clearing') {
      g.clearT -= dt;
      if (g.clearT <= 0) { applyClears(g.clearRows); spawn(); g.mode = g.piece ? 'play' : 'over'; }
      return;
    }
    if (g.mode !== 'play' || !g.piece) return;

    const softing = keys.down;
    g.dropT += dt;
    const interval = softing ? Math.min(45, gravityInterval()) : gravityInterval();
    while (g.dropT >= interval) {
      g.dropT -= interval;
      if (softStep()) { if (softing) { g.score += 1; syncHud(); } }
      else {
        g.lockT += interval;
        if (g.lockT >= LOCK_DELAY) { lockPiece(); break; }
      }
    }
    // Lock-delay accrual when fully rested between gravity ticks too.
    if (g.piece && collides(g.piece, g.piece.m, g.piece.x, g.piece.y + 1)) {
      g.lockT += dt;
      if (g.lockT >= LOCK_DELAY) lockPiece();
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  // A dot-matrix LCD cell: mid base, a full 1px darker frame so cells separate,
  // and a small light speck in the upper-left - the classic Game-Boy brick.
  function brick(ctx, cx, cy, tone, cell, alpha) {
    const x = cx * cell, y = cy * cell;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = tone.base;
    ctx.fillRect(x, y, cell, cell);
    ctx.fillStyle = tone.dark;
    ctx.fillRect(x, y, cell, 1); ctx.fillRect(x, y, 1, cell);
    ctx.fillRect(x, y + cell - 1, cell, 1); ctx.fillRect(x + cell - 1, y, 1, cell);
    ctx.fillStyle = tone.light;
    ctx.fillRect(x + 2, y + 2, 2, 2);
    ctx.globalAlpha = 1;
  }
  function ghostCell(ctx, cx, cy, cell) {
    const x = cx * cell, y = cy * cell;
    ctx.fillStyle = pal.ghost;
    ctx.fillRect(x, y, cell, 1); ctx.fillRect(x, y, 1, cell);
    ctx.fillRect(x, y + cell - 1, cell, 1); ctx.fillRect(x + cell - 1, y, 1, cell);
  }
  const toneOf = (id) => pal.tones[PIECE_TONE[id]] || pal.tones[1];
  function render() {
    // Field.
    bctx.fillStyle = pal.field;
    bctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
    // Faint grid.
    bctx.fillStyle = pal.grid;
    for (let x = 1; x < COLS; x++) bctx.fillRect(x * CELL, 0, 1, ROWS * CELL);
    for (let y = 1; y < ROWS; y++) bctx.fillRect(0, y * CELL, COLS * CELL, 1);
    // Settled stack.
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (g.grid[r][c]) brick(bctx, c, r, toneOf(g.grid[r][c]), CELL);
    }
    // Clearing rows flash (stays in-hue - bright accent, never white).
    if (g.mode === 'clearing' && g.clearRows) {
      const on = Math.floor(g.clearT / 45) % 2 === 0;
      bctx.fillStyle = on ? pal.flash : pal.tones[1].base;
      for (const r of g.clearRows) bctx.fillRect(0, r * CELL, COLS * CELL, CELL);
    }
    // Active piece + ghost.
    const p = g.piece;
    if (p && (g.mode === 'play' || g.mode === 'paused')) {
      const gy = ghostY();
      if (gy !== p.y) for (let y = 0; y < p.m.length; y++) for (let x = 0; x < p.m[y].length; x++) {
        if (p.m[y][x]) ghostCell(bctx, p.x + x, gy + y, CELL);
      }
      const tone = toneOf(p.color);
      for (let y = 0; y < p.m.length; y++) for (let x = 0; x < p.m[y].length; x++) {
        if (p.m[y][x] && p.y + y >= 0) brick(bctx, p.x + x, p.y + y, tone, CELL);
      }
    }
  }
  function drawNext() {
    nctx.clearRect(0, 0, next.width, next.height);
    const t = g.nextType; if (!t) return;
    const def = PIECES[t], m = def.m;
    const w = widthOf(m);
    let minY = m.length, maxY = 0;
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) if (m[y][x]) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const h = (maxY - minY + 1) || 1;
    const ox = Math.round((next.width - w * PCELL) / 2);
    const oy = Math.round((next.height - h * PCELL) / 2) - minY * PCELL;
    const tone = toneOf(def.c);
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (m[y][x]) brick(nctx, (ox / PCELL) + x, (oy / PCELL) + y, tone, PCELL);
    }
  }

  function syncHud() {
    if (elScore) elScore.textContent = String(g.score);
    if (elLines) elLines.textContent = String(g.lines);
    if (elLevel) elLevel.textContent = String(g.level);
  }
  function showPrompt(title) {
    if (!elPrompt) return;
    elPrompt.classList.add('show');
    if (elPTitle) elPTitle.textContent = title || '';
  }
  function hidePrompt() { if (elPrompt) elPrompt.classList.remove('show'); }

  // ── Loop ────────────────────────────────────────────────────────────────────
  function frame(ts) {
    if (!visible) { raf = 0; return; }
    const dt = last ? Math.min(50, ts - last) : 16;
    last = ts;
    if (g.mode === 'play' || g.mode === 'clearing') { update(dt); render(); raf = requestAnimationFrame(frame); }
    else { render(); raf = 0; }   // ready / paused / over: paint once and park
  }
  function wake() { if (visible && !raf) { last = 0; raf = requestAnimationFrame(frame); } }

  // ── Input (window-level, gated so it never disturbs the omnibox) ────────────
  function isTyping() {
    const a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  }
  const doRetry = () => { if (typeof onRetry === 'function') onRetry(); };
  const doBack  = () => { if (!elBack.hidden && typeof onBack === 'function') onBack(); };

  window.addEventListener('keydown', (e) => {
    if (!visible || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowLeft':  if (g.mode === 'play') { keys.left = true; move(-1); } e.preventDefault(); break;
      case 'ArrowRight': if (g.mode === 'play') { keys.right = true; move(1); } e.preventDefault(); break;
      case 'ArrowDown':  keys.down = true; if (g.mode === 'play') softStep(); e.preventDefault(); break;
      case 'ArrowUp': case 'x': case 'X': if (g.mode === 'play') { rotate(); render(); } e.preventDefault(); break;
      case ' ': case 'Spacebar':
        if (g.mode === 'hidden') openVault();
        else if (g.mode === 'ready' || g.mode === 'over') start();
        else if (g.mode === 'play') hardDrop();
        e.preventDefault(); break;
      case 'p': case 'P': togglePause(); e.preventDefault(); break;
      case 'Enter': doRetry(); e.preventDefault(); break;
      case 'Backspace': doBack(); e.preventDefault(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft') keys.left = false;
    else if (e.key === 'ArrowRight') keys.right = false;
    else if (e.key === 'ArrowDown') keys.down = false;
  });

  // Click the board to start/focus; click anywhere keeps key focus on the screen
  // (so input keeps flowing even after the failed webview had it).
  board.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (g.mode === 'ready' || g.mode === 'over') start();
    try { root.focus(); } catch (_) {}
  });
  root.addEventListener('mousedown', (e) => {
    if (visible && e.target !== elRetry && e.target !== elBack && e.target !== elBegin) { try { root.focus(); } catch (_) {} }
  });
  if (elBegin) elBegin.addEventListener('click', () => { if (g.mode === 'hidden') openVault(); else start(); });
  if (elRetry) elRetry.addEventListener('click', doRetry);
  if (elBack)  elBack.addEventListener('click', doBack);

  // ── Public controller (called by renderer.js) ──────────────────────────────
  function show(opts) {
    opts = opts || {};
    readPalette(opts.accent);
    const s = opts.strings || {};

    root.classList.toggle('is-cert', opts.klass === 'cert');
    if (elGlyph) elGlyph.innerHTML = GLYPHS[opts.glyph] || GLYPHS.generic;
    if (elCmd) elCmd.textContent = (opts.verb || 'connect') + ' ' + (opts.host || '');
    if (s.title != null) elTitle.textContent = s.title;
    if (s.sub   != null) elSub.textContent   = s.sub;
    if (s.hint  != null && elHint) elHint.textContent = s.hint;
    if (s.retry != null) elRetry.textContent = s.retry;
    if (s.back  != null) elBack.textContent  = s.back;
    if (elHost) { elHost.textContent = opts.url || opts.host || ''; elHost.title = opts.url || opts.host || ''; }
    if (elCode) {
      const big = opts.code ? String(opts.code) : '';
      const errno = (typeof opts.errno === 'number' && opts.errno) ? ' (' + opts.errno + ')' : '';
      elCode.textContent = big ? big + errno : '';
      elCode.hidden = !big;
    }
    elBack.hidden = !opts.canBack;
    onRetry = opts.onRetry || null;
    onBack  = opts.onBack  || null;

    // Sealed by default: the page reads as a plain error and nothing reveals the
    // game. Space (or a click on the board) secretly unseals it; see openVault().
    emptyGrid(); g.piece = null; g.nextType = null; g.bag = [];
    g.score = 0; g.lines = 0; g.level = 1; g.mode = 'hidden';
    syncHud(); drawNext();
    hidePrompt();
    if (stageEl) stageEl.classList.remove('open');

    visible = true;
    root.classList.add('show');
    root.setAttribute('aria-hidden', 'false');
    render();
    try { root.focus({ preventScroll: true }); } catch (_) { try { root.focus(); } catch (__) {} }
  }
  function hide() {
    if (!visible) return;
    visible = false;
    root.classList.remove('show');
    root.setAttribute('aria-hidden', 'true');
    cancelAnimationFrame(raf); raf = 0;
    keys.left = keys.right = keys.down = false;
  }
  function setAccent(hex) { if (visible) { readPalette(hex); render(); drawNext(); } }
  function isVisible() { return visible; }

  window.__ephemeraError = { show, hide, setAccent, isVisible };
})();
