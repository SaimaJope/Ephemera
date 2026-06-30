'use strict';

/**
 * newtab.js home page logic. Runs inside the page webview; it navigates itself
 * (the chrome observes via did-navigate) and exposes one global the chrome calls
 * to push appearance settings (background, branding, accent, engine, language).
 */

(() => {
  // ── Fake fast-load screen ──────────────────────────────────────────────────
  // About one new tab in ten, flash a very short, very smooth progress sweep
  // before revealing the page. Purely cosmetic theatre: it makes the (instant,
  // local) new tab feel like it loaded something. Runs first and synchronously
  // so the loader is already on screen at the first paint, never after it.
  (function fakeLoad() {
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (Math.random() >= 0.25) return;               // 25% spawn rate
      const fill = document.querySelector('#nt-loader .nt-bar-fill');
      if (!fill) return;
      const dur = Math.round(300 + Math.random() * 200); // 0.3s - 0.5s, random
      const fillMs = Math.round(dur * 0.82);             // bar completes, then rests a beat
      document.body.classList.add('nt-loading');
      // One frame to commit the empty bar, then slide the fill across the track.
      requestAnimationFrame(() => {
        fill.style.transition = 'transform ' + fillMs + 'ms cubic-bezier(0.22, 0.61, 0.36, 1)';
        fill.style.transform = 'translateX(0)';
      });
      setTimeout(() => document.body.classList.remove('nt-loading'), dur);
    } catch (_) { document.body.classList.remove('nt-loading'); }
  })();

  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  let engineUrl = 'https://duckduckgo.com/?q=';

  // The logo, search box and funfact are all hidden until the chrome pushes
  // settings (see .logo-wrap / .search in the CSS), so the page never flashes
  // its English default placeholder or default-colour logo. The chrome flips
  // this within a frame or two of load; the timeout is a safety net if settings
  // never arrive (e.g. the page opened on its own), in which case we fall back
  // to the English funfact.
  const reveal = () => {
    document.documentElement.classList.add('accent-ready', 'nt-ready');
  };
  setTimeout(() => {
    reveal();
    // Only fall back to the English funfact if settings never pushed a language.
    if (factLang === null) showFact(document.documentElement.lang || 'en');
  }, 450);

  function resolve(raw) {
    const s = raw.trim();
    if (!s) return null;
    if (/^(https?|file|about|data):/i.test(s)) return s;
    const hostLike = /^(localhost(:\d+)?|[^\s/?#]+\.[^\s/?#]{2,})(:\d+)?([/?#].*)?$/i;
    if (!/\s/.test(s) && hostLike.test(s)) return 'https://' + s;
    return engineUrl + encodeURIComponent(s);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = resolve(input.value);
    if (url) window.location.href = url;
  });

  // Applied by the chrome (renderer.js) via executeJavaScript.
  window.__ephemeraApplySettings = (cfg) => {
    cfg = cfg || {};
    const body = document.body;
    body.classList.remove('bg-blue', 'bg-grey');
    if (cfg.bg === 'blue') body.classList.add('bg-blue');
    else if (cfg.bg === 'grey') body.classList.add('bg-grey');
    // Semi-hidden Normal/Dark/Light theme, pushed from the chrome. 'normal' = the
    // signature dark home; the two classes below swap the home to a deeper dark or
    // a clean light backdrop so the new tab matches the rest of the window.
    body.classList.toggle('nt-theme-dark', cfg.theme === 'dark');
    body.classList.toggle('nt-theme-light', cfg.theme === 'light');
    body.classList.toggle('no-branding', cfg.branding === false);
    body.classList.toggle('high-perf', !!cfg.highPerf);
    if (cfg.searchText) input.placeholder = cfg.searchText;
    if (cfg.lang) { document.documentElement.lang = cfg.lang; showFact(cfg.lang); }
    if (cfg.accent) {
      document.documentElement.style.setProperty('--accent', cfg.accent);
      const m = /^#?([0-9a-f]{6})$/i.exec(cfg.accent);
      if (m) {
        const n = parseInt(m[1], 16);
        const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
        document.documentElement.style.setProperty('--accent-rgb', rgb);
        document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb}, 0.14)`);
      }
    }
    if (cfg.engine) engineUrl = cfg.engine;
    // Beautiful mode: extra motion + the mouse-reactive dust field. Held off in
    // high-performance mode and for anyone who prefers reduced motion.
    body.classList.toggle('beautiful', !!cfg.beautiful);
    const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (cfg.beautiful && !cfg.highPerf && !reduceMotion) dust.start();
    else dust.stop();
    reveal(); // settings are in: show the logo (correct accent) and search box
  };

  // ── Fun fact: a quiet grey-italic line under the search. The label follows
  //    the UI language (with a couple of 1% easter eggs); the fact text falls
  //    back to English if that language's set is not loaded yet. ─────────────
  function labelFor(lang) {
    if (lang === 'fi') return { text: 'Tiesitkö?' };
    if (lang === 'ru') return { text: 'Интересный факт' };
    if (lang === 'es') {
      return Math.random() < 0.01
        ? { text: 'Fato interessante', href: 'https://es.wikipedia.org/wiki/Idioma_portugu%C3%A9s' }
        : { text: 'Dato curioso' };
    }
    return Math.random() < 0.01 ? { text: 'Did you 👃🏻' } : { text: 'Did you know?' };
  }
  let factLang = null;
  function showFact(lang) {
    const facts = window.__EPHEMERA_FACTS || {};
    const factKey = facts[lang] && facts[lang].length ? lang : 'en';
    if (lang === factLang) return; // keep the same fact while unrelated settings change
    factLang = lang;
    const list = facts[factKey] || [];
    const wrap = document.getElementById('funfact');
    const labelEl = document.getElementById('funfact-label');
    const textEl = document.getElementById('funfact-text');
    if (!wrap || !textEl || !list.length) { if (wrap) wrap.classList.remove('show'); return; }
    const lbl = labelFor(lang);
    labelEl.textContent = lbl.text;
    if (lbl.href) {
      labelEl.style.cursor = 'pointer';
      labelEl.onclick = () => { window.location.href = lbl.href; };
    } else {
      labelEl.style.cursor = '';
      labelEl.onclick = null;
    }
    textEl.textContent = list[Math.floor(Math.random() * list.length)];
    wrap.classList.add('show');
  }
  // Note: the first showFact() is deferred until the chrome pushes the language
  // (in __ephemeraApplySettings), or the safety-net timeout above, so the English
  // funfact label/text never flashes before the localised one.

  // ── Easter egg: tap the logo five times and it drops out of the layout into a
  //    little physics toy — gravity, bouncy walls, and you can grab it and fling
  //    it around the page. Self-contained; resets on a fresh new tab. ──────────
  (() => {
    const logo = document.querySelector('.logo');
    if (!logo) return;

    let taps = 0, tapTimer = null, active = false;
    logo.addEventListener('click', () => {
      if (active) return;
      taps += 1;
      // Stay fully hidden for the first 5 taps (no feedback at all); only after
      // the halfway point does it start wobbling, then it drops on the 10th tap.
      if (taps > 5) {
        logo.classList.remove('egg-wobble'); void logo.offsetWidth; logo.classList.add('egg-wobble');
      }
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 1600);
      if (taps >= 10) { clearTimeout(tapTimer); start(); }
    });

    // Physics state (position is the disc centre; r is its radius).
    let x = 0, y = 0, vx = 0, vy = 0, r = 58, angle = 0, angVel = 0;
    let W = 0, H = 0, last = 0, dragging = false, gx = 0, gy = 0;
    const trail = [];
    const G = 2600, REST = 0.7, WALL = 0.72, FRICTION = 0.84, MAXV = 4200;
    // Honour the OS "reduce motion" setting: the ball still bounces, but without
    // the beautiful-mode blur/stretch smear (which CSS can't strip, being inline).
    const noMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;

    const measure = () => { W = window.innerWidth; H = window.innerHeight; };
    const draw = () => {
      // Beautiful mode: smear the ball along its travel direction and add a
      // speed-scaled blur, so a fast bounce reads with motion blur. The
      // rotate(local)/scale/rotate(-local) sandwich stretches along the WORLD
      // velocity vector even as the disc spins (local = velocityAngle - spin).
      let extra = '';
      if (document.body.classList.contains('beautiful') && !(noMotion && noMotion.matches)) {
        const s = Math.min(Math.hypot(vx, vy) / 3600, 1);
        if (s > 0.06) {
          const local = Math.atan2(vy, vx) - angle;
          extra = ` rotate(${local}rad) scale(${1 + s * 0.1}, ${1 - s * 0.05}) rotate(${-local}rad)`;
          logo.style.filter = `blur(${(s * 0.7).toFixed(2)}px)`;
        } else if (logo.style.filter) { logo.style.filter = ''; }
      } else if (logo.style.filter) { logo.style.filter = ''; }
      logo.style.transform = `translate3d(${x - r}px, ${y - r}px, 0) rotate(${angle}rad)${extra}`;
    };

    function start() {
      active = true;
      const rect = logo.getBoundingClientRect();
      r = rect.width / 2;
      x = rect.left + r; y = rect.top + r;
      vx = (Math.random() * 2 - 1) * 140; vy = 0;
      angVel = (Math.random() * 2 - 1) * 2;
      measure();
      logo.classList.remove('egg-wobble');
      logo.classList.add('physics');
      document.body.classList.add('physics-on');
      draw();
      logo.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('resize', measure);
      last = performance.now();
      requestAnimationFrame(tick);
    }

    function tick(now) {
      let dt = (now - last) / 1000; last = now;
      if (dt > 1 / 30) dt = 1 / 30; else if (dt < 0) dt = 0;
      if (!dragging) {
        vy += G * dt;
        x += vx * dt; y += vy * dt;
        angle += angVel * dt; angVel *= 0.992;
        if (x < r) { x = r; vx = -vx * WALL; }
        else if (x > W - r) { x = W - r; vx = -vx * WALL; }
        if (y < r) { y = r; if (vy < 0) vy = -vy * WALL; }
        else if (y > H - r) {
          y = H - r;
          if (vy > 0) vy = -vy * REST;
          vx *= FRICTION;
          angVel = vx / r;               // roll along the floor
          if (Math.abs(vy) < 55) vy = 0; // settle instead of jittering forever
        }
      }
      draw();
      requestAnimationFrame(tick);
    }

    function onDown(e) {
      dragging = true;
      logo.classList.add('grabbing');
      try { logo.setPointerCapture(e.pointerId); } catch (_) {}
      gx = e.clientX - x; gy = e.clientY - y;
      vx = vy = 0;
      trail.length = 0; trail.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      x = Math.max(r, Math.min(W - r, e.clientX - gx));
      y = Math.max(r, Math.min(H - r, e.clientY - gy));
      trail.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (trail.length > 6) trail.shift();
      draw();
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      logo.classList.remove('grabbing');
      try { logo.releasePointerCapture(e.pointerId); } catch (_) {}
      const n = trail.length;
      if (n >= 2) {
        const a = trail[0], b = trail[n - 1];
        const dt = Math.max((b.t - a.t) / 1000, 0.016);
        vx = Math.max(-MAXV, Math.min(MAXV, (b.x - a.x) / dt));
        vy = Math.max(-MAXV, Math.min(MAXV, (b.y - a.y) / dt));
        angVel = vx * 0.012; // spin in the direction of the throw
      }
    }
  })();

  // ── Beautiful mode: a faint, mouse-reactive dust field ──────────────────────
  // Accent-tinted motes drift slowly upward; the cursor parts and brightens the
  // ones nearby, like clearing dust in a sunbeam. Started/stopped by the chrome
  // pushing beautiful mode (see __ephemeraApplySettings). Pauses when hidden.
  const dust = (() => {
    const canvas = document.getElementById('nt-dust');
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return { start() {}, stop() {} };

    let W = 0, H = 0, dpr = 1, raf = 0, running = false, last = 0;
    let particles = [];
    const pointer = { x: -9999, y: -9999, active: false };
    const R = 168; // cursor influence radius (px)

    const accentRGB = () =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '176, 124, 255';

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }
    function seed() {
      const n = Math.max(40, Math.min(120, Math.round((W * H) / 16000)));
      particles = [];
      for (let i = 0; i < n; i++) {
        particles.push({
          x: Math.random() * W, y: Math.random() * H,
          r: 0.7 + Math.random() * 2.0,
          a: 0.06 + Math.random() * 0.20,
          vx: (Math.random() - 0.5) * 8,
          vy: -(5 + Math.random() * 12),         // gentle upward drift
          sway: Math.random() * Math.PI * 2,
          spd: 0.2 + Math.random() * 0.5,
          tw: Math.random() * Math.PI * 2,       // twinkle phase
          tws: 0.8 + Math.random() * 1.6
        });
      }
    }
    const LINK = 118, LINK2 = LINK * LINK;       // motes within this distance get a thread
    function frame(now) {
      if (!running) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016; last = now;
      ctx.clearRect(0, 0, W, H);
      const rgb = accentRGB();
      // 1) move + draw the motes (with twinkle and cursor repel/brighten)
      for (const p of particles) {
        p.sway += p.spd * dt;
        p.tw += p.tws * dt;
        p.x += (p.vx + Math.cos(p.sway) * 6) * dt;
        p.y += p.vy * dt;
        let a = p.a * (0.65 + 0.35 * Math.sin(p.tw));   // twinkle
        if (pointer.active) {
          const dx = p.x - pointer.x, dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) || 1, f = 1 - d / R;
            p.x += (dx / d) * f * 1.8;            // part around the cursor
            p.y += (dy / d) * f * 1.8;
            a = Math.min(0.8, a + f * 0.6);       // and flare
          }
        }
        if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; } // recycle off the top
        if (p.x < -6) p.x = W + 6; else if (p.x > W + 6) p.x = -6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fillStyle = 'rgba(' + rgb + ', ' + a + ')';
        ctx.fill();
      }
      // 2) constellation: faint accent threads between motes that drift close
      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
          if (d2 < LINK2) {
            const o = (1 - Math.sqrt(d2) / LINK) * 0.16;
            ctx.strokeStyle = 'rgba(' + rgb + ', ' + o.toFixed(3) + ')';
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
      }
      // 3) a soft accent glow that follows the cursor (additive)
      if (pointer.active) {
        const g = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, R);
        g.addColorStop(0, 'rgba(' + rgb + ', 0.02)');
        g.addColorStop(1, 'rgba(' + rgb + ', 0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.fillRect(pointer.x - R, pointer.y - R, R * 2, R * 2);
        ctx.globalCompositeOperation = 'source-over';
      }
      raf = requestAnimationFrame(frame);
    }
    function loop() { last = 0; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); }
    const onMove = (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true; };
    const onLeave = () => { pointer.active = false; };
    const onResize = () => resize();
    const onVis = () => { if (document.hidden) cancelAnimationFrame(raf); else if (running) loop(); };

    function start() {
      if (running) return;
      running = true;
      resize();
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerleave', onLeave, { passive: true });
      window.addEventListener('blur', onLeave);
      window.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVis);
      loop();
    }
    function stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf); raf = 0;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      ctx.clearRect(0, 0, W, H);
    }
    return { start, stop };
  })();

  // ── Idle "molt" ─────────────────────────────────────────────────────────────
  // Leave a new tab completely untouched for a long while and the fun fact quietly
  // becomes one dimmer, self-referential line. One-shot per tab; the faintest
  // interaction before then cancels it, so it is only ever found by sitting still.
  (() => {
    const IDLE_MS = 150000; // 2.5 minutes of stillness
    let timer = null, molted = false;
    const moltLine = (lang) => ({
      fi: 'Mitään ei jää. Ei edes tätä.',
      ru: 'Ничего не остаётся. Даже это.',
      es: 'Nada se guarda. Ni siquiera esto.'
    })[lang] || 'Nothing kept. Not even this.';

    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    function teardown() {
      if (timer) { clearTimeout(timer); timer = null; }
      events.forEach((ev) => window.removeEventListener(ev, arm));
    }
    function molt() {
      if (molted) return;
      const wrap = document.getElementById('funfact');
      const textEl = document.getElementById('funfact-text');
      if (!wrap || !textEl || !wrap.classList.contains('show')) return; // nothing to molt
      molted = true;
      teardown();
      wrap.classList.remove('show'); // fade the current fact out...
      setTimeout(() => {
        textEl.textContent = moltLine(document.documentElement.lang || 'en');
        wrap.classList.add('molted');
        wrap.classList.add('show');  // ...then fade the dimmer line in
      }, 480);
    }
    function arm() {
      if (molted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(molt, IDLE_MS);
    }
    events.forEach((ev) => window.addEventListener(ev, arm, { passive: true }));
    arm();
  })();
})();
