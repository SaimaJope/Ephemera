'use strict';

/**
 * offline.js - Ephemera's "no internet connection" screen.
 *
 * When a main-frame navigation fails because the machine is offline, the chrome
 * (renderer.js) raises this overlay over the content area instead of letting the
 * guest <webview> show Chromium's default error page. The omnibox keeps the
 * address you tried to reach; Retry just navigates there again.
 *
 * Tucked inside is a small, calm Space Invaders scene drawn on a low-resolution
 * canvas scaled up with nearest-neighbour sampling, so every shape stays a crisp
 * 8-bit block. It is wired to the same design tokens as the rest of the app
 * (the cannon and shots follow the live --accent), framed by a quiet terminal
 * prompt for the Kali flavour. Playable with the arrow keys and space; left
 * alone, an attract-mode cannon keeps the field alive.
 *
 * Exposes a tiny controller on window.__ephemeraOffline that the chrome calls.
 */

(() => {
  const root = document.getElementById('offline-screen');
  if (!root) return;

  const canvas  = document.getElementById('offline-canvas');
  const ctx     = canvas.getContext('2d');
  const elTitle = document.getElementById('offline-title');
  const elSub   = document.getElementById('offline-sub');
  const elHint  = document.getElementById('offline-hint');
  const elRetry = document.getElementById('offline-retry');
  const elCmd   = document.getElementById('offline-cmd');
  const elCode  = document.getElementById('offline-code');
  const elScore = document.getElementById('offline-score');

  const W = canvas.width;   // internal pixel grid (logical, then scaled by CSS)
  const H = canvas.height;
  ctx.imageSmoothingEnabled = false;

  // Read the reduced-motion preference live (it can change at runtime) and treat
  // the app's High performance mode the same way: in either "calm" state the
  // scene never auto-plays and holds still while idle (see update()/frame()).
  const reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const prefersReduce = () => !!reduceMq.matches;
  const isCalm = () => prefersReduce() || document.body.classList.contains('high-perf');
  const now = () => (window.performance && performance.now ? performance.now() : 0);

  // ── Palette (read live from the chrome's CSS custom properties) ─────────────
  let pal = {};
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return [176, 124, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function readPalette(accent) {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    pal = {
      accent: (accent && accent.trim()) || get('--accent', '#b07cff'),
      text:   get('--text', '#d6dadf'),
      muted:  get('--muted', '#8b93a1'),
      border: get('--border', '#353b45'),
      danger: get('--danger', '#fa4b4b'),
      field:  '#0d1015'   // a hair darker than --bg so the scene reads as a screen
    };
    pal.accentRgb = hexToRgb(pal.accent);
  }

  // ── Sprites (each 'X' is one logical pixel) ────────────────────────────────
  const CRAB_A = [
    '..X.....X..',
    '...X...X...',
    '..XXXXXXX..',
    '.XX.XXX.XX.',
    'XXXXXXXXXXX',
    'X.XXXXXXX.X',
    'X.X.....X.X',
    '...XX.XX...'
  ];
  const CRAB_B = [
    '..X.....X..',
    'X..X...X..X',
    'X.XXXXXXX.X',
    'XXX.XXX.XXX',
    'XXXXXXXXXXX',
    '.XXXXXXXXX.',
    '..X.....X..',
    '.X.......X.'
  ];
  const PLAYER = [
    '......X......',
    '......X......',
    '.....XXX.....',
    '.XXXXXXXXXXX.',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX'
  ];
  const IW = CRAB_A[0].length, IH = CRAB_A.length;   // 11 x 8
  const PW = PLAYER[0].length, PH = PLAYER.length;    // 13 x 8
  const PLAYER_Y = H - PH - 6;
  const GROUND_Y = PLAYER_Y + PH + 1;

  function drawSprite(grid, x, y, color) {
    ctx.fillStyle = color;
    x |= 0; y |= 0;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      for (let c = 0; c < row.length; c++) {
        if (row.charCodeAt(c) === 88 /* 'X' */) ctx.fillRect(x + c, y + r, 1, 1);
      }
    }
  }

  // ── Game state ──────────────────────────────────────────────────────────────
  const COLS = 7, ROWS = 3;
  const PITCH_X = 20, PITCH_Y = 16;
  const BLOCK_W = (COLS - 1) * PITCH_X + IW;
  const GX = Math.round((W - BLOCK_W) / 2);
  const GY = 22;

  const PLAYER_SPD = 0.085;   // px per ms
  const BULLET_SPD = 0.24;
  const BOMB_SPD   = 0.06;

  const g = {
    started: false,
    inv: [], total: COLS * ROWS,
    dir: 1, marchT: 0, frame: 0,
    px: (W - PW) / 2,
    bullets: [], bombs: [], sparks: [],
    bombT: 1400,
    score: 0, wave: 0,
    over: false, overT: 0,
    ai: false, aiFireT: 0,
    lastInput: 0
  };
  const keys = { left: false, right: false };

  function buildInvaders() {
    g.inv.length = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        g.inv.push({ x: GX + c * PITCH_X, y: GY + r * PITCH_Y, row: r, alive: true });
      }
    }
    g.dir = 1; g.marchT = 0;
  }
  function newWave() {
    g.wave++;
    buildInvaders();
    g.bullets.length = 0; g.bombs.length = 0;
    g.bombT = 1200;
  }
  function reset() {
    g.score = 0; g.wave = 0;
    g.px = (W - PW) / 2;
    g.bullets.length = 0; g.bombs.length = 0; g.sparks.length = 0;
    g.over = false; g.overT = 0;
    buildInvaders();
    g.bombT = 1400;
  }

  const aliveList = () => g.inv.filter((i) => i.alive);

  function fire() {
    if (g.over) return;
    if (g.bullets.length === 0) g.bullets.push({ x: g.px + ((PW - 1) >> 1), y: PLAYER_Y - 3 });
  }
  function spark(x, y) {
    for (let i = 0; i < 6; i++) {
      g.sparks.push({ x, y, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, life: 260 });
    }
  }
  function gameOver() {
    if (g.over) return;
    g.over = true; g.overT = 1500;
    spark(g.px + (PW >> 1), PLAYER_Y + 2);
    spark(g.px + (PW >> 1), PLAYER_Y + 4);
  }

  function stepMarch() {
    const alive = aliveList();
    if (!alive.length) return;
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of alive) {
      if (i.x < minX) minX = i.x;
      if (i.x + IW > maxX) maxX = i.x + IW;
      if (i.y + IH > maxY) maxY = i.y + IH;
    }
    const dx = g.dir * 2;
    if (maxX + dx > W - 3 || minX + dx < 3) {
      g.dir *= -1;
      for (const i of alive) i.y += 8;
      if (maxY + 8 >= PLAYER_Y) gameOver();
    } else {
      for (const i of alive) i.x += dx;
    }
    g.frame ^= 1;
  }

  function steerAI(dt) {
    // Attract mode: track the lowest invader and pop shots off when lined up.
    const alive = aliveList();
    if (!alive.length) return;
    let target = alive[0];
    for (const i of alive) {
      if (i.y > target.y || (i.y === target.y && Math.abs(i.x - g.px) < Math.abs(target.x - g.px))) target = i;
    }
    const want = target.x + (IW >> 1) - (PW >> 1);
    const d = want - g.px;
    if (Math.abs(d) > 1) g.px += Math.sign(d) * Math.min(Math.abs(d), PLAYER_SPD * dt * 0.85);
    g.aiFireT -= dt;
    if (Math.abs(d) < 4 && g.aiFireT <= 0) { fire(); g.aiFireT = 520 + Math.random() * 360; }
  }

  function update(dt) {
    if (g.over) {
      g.overT -= dt;
      tickSparks(dt);
      if (g.overT <= 0) reset();
      return;
    }

    const calm = isCalm();

    // Player. Attract mode (self-play) only runs in the lively default; in calm
    // mode the cannon moves solely under the player's own keys.
    g.ai = !calm && (now() - g.lastInput > 5000);
    if (g.ai) {
      steerAI(dt);
    } else {
      if (keys.left)  g.px -= PLAYER_SPD * dt;
      if (keys.right) g.px += PLAYER_SPD * dt;
    }
    g.px = Math.max(2, Math.min(W - PW - 2, g.px));

    // In calm mode, hold the swarm still while the field is idle (no keys held,
    // nothing in flight); only advance it once the player actually engages. The
    // loop parks itself afterwards (frame()), so nothing animates on its own.
    const stepWorld = !calm || isActive();

    const alive = aliveList();
    if (!alive.length) { tickSparks(dt); newWave(); return; }

    // March (speeds up as the swarm thins and waves climb).
    if (stepWorld) {
      const cleared = g.total - alive.length;
      let interval = Math.max(26, 110 - cleared * 5);
      interval *= prefersReduce() ? 1.7 : 1;
      interval /= (1 + g.wave * 0.12);
      g.marchT += dt;
      if (g.marchT >= interval) { g.marchT -= interval; stepMarch(); }
    }

    // Player bullet.
    for (let b = g.bullets.length - 1; b >= 0; b--) {
      const bl = g.bullets[b];
      bl.y -= BULLET_SPD * dt;
      if (bl.y < -4) { g.bullets.splice(b, 1); continue; }
      let hit = false;
      for (const i of g.inv) {
        if (!i.alive) continue;
        if (bl.x >= i.x && bl.x <= i.x + IW && bl.y >= i.y && bl.y <= i.y + IH) {
          i.alive = false;
          g.score += i.row === 0 ? 30 : 10;
          spark(i.x + (IW >> 1), i.y + (IH >> 1));
          hit = true; break;
        }
      }
      if (hit) g.bullets.splice(b, 1);
    }

    // Enemy bombs (only dropped while the world is stepping).
    if (stepWorld) {
      g.bombT -= dt;
      if (g.bombT <= 0 && alive.length && g.bombs.length < 2) {
        const src = alive[(Math.random() * alive.length) | 0];
        g.bombs.push({ x: src.x + (IW >> 1), y: src.y + IH, t: 0 });
        g.bombT = 700 + Math.random() * 1500;
      }
    }
    for (let b = g.bombs.length - 1; b >= 0; b--) {
      const bm = g.bombs[b];
      bm.y += BOMB_SPD * dt; bm.t += dt;
      if (bm.y > H) { g.bombs.splice(b, 1); continue; }
      if (bm.x >= g.px && bm.x <= g.px + PW && bm.y >= PLAYER_Y && bm.y <= PLAYER_Y + PH) {
        g.bombs.splice(b, 1); gameOver(); break;
      }
    }

    tickSparks(dt);
  }

  function tickSparks(dt) {
    for (let s = g.sparks.length - 1; s >= 0; s--) {
      const sp = g.sparks[s];
      sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.life -= dt;
      if (sp.life <= 0) g.sparks.splice(s, 1);
    }
  }

  function render() {
    const calm = isCalm();
    ctx.save();
    if (g.over && !calm) {
      ctx.translate((Math.random() - 0.5) * 2 | 0, (Math.random() - 0.5) * 2 | 0);
    }

    // Field + ground line.
    ctx.fillStyle = pal.field;
    ctx.fillRect(-2, -2, W + 4, H + 4);
    ctx.fillStyle = pal.border;
    ctx.fillRect(0, GROUND_Y, W, 1);

    // Invaders (top row brighter, the rest muted - no stray colours).
    for (const i of g.inv) {
      if (!i.alive) continue;
      drawSprite(g.frame ? CRAB_B : CRAB_A, i.x, i.y, i.row === 0 ? pal.text : pal.muted);
    }

    // Sparks.
    for (const sp of g.sparks) {
      ctx.globalAlpha = Math.max(0, Math.min(1, sp.life / 260));
      ctx.fillStyle = pal.accent;
      ctx.fillRect(sp.x | 0, sp.y | 0, 1, 1);
    }
    ctx.globalAlpha = 1;

    // Bombs.
    ctx.fillStyle = pal.muted;
    for (const bm of g.bombs) {
      const wig = (bm.t % 220 < 110) ? -1 : 0;
      ctx.fillRect((bm.x + wig) | 0, bm.y | 0, 1, 3);
    }

    // Player (blinks while exploding) + shots.
    const showShip = !g.over || (Math.floor(g.overT / 120) % 2 === 0);
    if (showShip) drawSprite(PLAYER, g.px, PLAYER_Y, g.over ? pal.danger : pal.accent);
    ctx.fillStyle = pal.accent;
    for (const bl of g.bullets) ctx.fillRect(bl.x | 0, bl.y | 0, 1, 4);

    // Loss flash (a brief red fade; suppressed for reduced-motion / high-perf).
    if (g.over && !calm) {
      ctx.globalAlpha = Math.max(0, Math.min(0.18, g.overT / 1500 * 0.18));
      ctx.fillStyle = pal.danger;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Score: written only when it changes, and kept hidden until the player
    // actually scores so the idle screen stays message-first (not a game HUD).
    if (elScore && g.score !== lastScore) {
      elScore.textContent = String(g.score).padStart(4, '0');
      elScore.style.opacity = g.score > 0 ? '1' : '0';
      lastScore = g.score;
    }
  }

  // ── Loop ────────────────────────────────────────────────────────────────────
  let raf = 0, last = 0, visible = false, onRetry = null, lastScore = -1;
  // The field is "active" while the player is steering or anything is in flight.
  // In calm mode the loop parks once this goes false, so an idle reduced-motion /
  // high-perf screen settles to a still frame and stops burning the CPU.
  function isActive() {
    return keys.left || keys.right || g.over ||
           g.bullets.length > 0 || g.bombs.length > 0 || g.sparks.length > 0;
  }
  function frame(ts) {
    if (!visible) return;
    const dt = last ? Math.min(50, ts - last) : 16;
    last = ts;
    update(dt);
    render();
    if (isCalm() && !isActive()) { raf = 0; return; } // park: hold the still frame
    raf = requestAnimationFrame(frame);
  }
  function wake() {
    if (visible && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  }

  // ── Input (window-level, gated so it never disturbs the omnibox) ───────────
  function isTyping() {
    const a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  }
  function markInput() { g.lastInput = now(); g.ai = false; }
  function doRetry() { if (typeof onRetry === 'function') onRetry(); }

  window.addEventListener('keydown', (e) => {
    if (!visible || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowLeft':  keys.left = true;  markInput(); wake(); e.preventDefault(); break;
      case 'ArrowRight': keys.right = true; markInput(); wake(); e.preventDefault(); break;
      case ' ': case 'Spacebar': fire(); markInput(); wake(); e.preventDefault(); break;
      case 'Enter': doRetry(); markInput(); e.preventDefault(); break;
      case 'r': case 'R': doRetry(); markInput(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft')  keys.left = false;
    else if (e.key === 'ArrowRight') keys.right = false;
  });

  // Click the field to fire; click anywhere on the screen keeps key focus here
  // (so input keeps flowing even after the failed webview had it).
  canvas.addEventListener('mousedown', (e) => { e.preventDefault(); fire(); markInput(); wake(); });
  root.addEventListener('mousedown', () => { if (visible && document.activeElement !== elRetry) { try { root.focus(); } catch (_) {} } });
  if (elRetry) elRetry.addEventListener('click', doRetry);

  // ── Public controller (called by renderer.js) ──────────────────────────────
  function show(opts) {
    opts = opts || {};
    readPalette(opts.accent);
    const s = opts.strings || {};
    if (s.title != null) elTitle.textContent = s.title;
    if (s.sub   != null) elSub.textContent   = s.sub;
    if (s.hint  != null) elHint.textContent  = s.hint;
    if (s.retry != null) elRetry.textContent = s.retry;
    elCmd.textContent = 'ping ' + (opts.host || 'anywhere.net');
    if (opts.code) { elCode.textContent = opts.code; elCode.hidden = false; }
    else { elCode.textContent = ''; elCode.hidden = true; }
    onRetry = opts.onRetry || null;

    if (!visible) {
      visible = true;
      root.classList.add('show');
      root.setAttribute('aria-hidden', 'false');
      if (!g.started) { reset(); g.started = true; }
      g.lastInput = now();       // a moment of attract-mode grace, then it self-plays
      last = 0;
      raf = requestAnimationFrame(frame);
      try { root.focus({ preventScroll: true }); } catch (_) { try { root.focus(); } catch (__) {} }
    } else {
      // Already up (re-shown on a settings change or a failed retry): make sure a
      // parked calm-mode loop resumes so e.g. turning High performance mode off
      // re-enlivens the scene, and render once with any new accent.
      wake();
    }
  }
  function hide() {
    if (!visible) return;
    visible = false;
    root.classList.remove('show');
    root.setAttribute('aria-hidden', 'true');
    cancelAnimationFrame(raf); raf = 0;
    keys.left = keys.right = false;
  }
  function setAccent(hex) { if (visible) readPalette(hex); }
  function isVisible() { return visible; }

  window.__ephemeraOffline = { show, hide, setAccent, isVisible };
})();
