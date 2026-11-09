/*
 * metinalpdogan.com
 *
 * The page starts as x_T ~ N(0, I) and is sampled back to x_0 with a cosine
 * noise schedule. The portrait is denoised with the actual forward-process
 * identity x_t = sqrt(ᾱ_t)·x_0 + sqrt(1 − ᾱ_t)·ε; text "denoises" glyph by glyph;
 * sections below the fold go through a short pass when they scroll into view.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const motion = root.classList.contains('motion');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const raf = (f) => requestAnimationFrame(f);

  /* ------------------------------------------------------------ noise */

  const randn = () => {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  };
  // Lookup tables: sampling millions of fresh Gaussians per frame is wasteful.
  const GF = new Float32Array(1 << 16);
  for (let i = 0; i < GF.length; i++) GF[i] = randn();
  const gauss = () => GF[(Math.random() * 65536) | 0];
  const GB = new Uint8ClampedArray(1 << 14);
  for (let i = 0; i < GB.length; i++) GB[i] = 128 + 44 * GF[i];
  const gbyte = () => GB[(Math.random() * 16384) | 0];

  // Cosine schedule (Nichol & Dhariwal, 2021). tau in [0, 1]; tau = 1 is pure noise.
  const S = 0.008;
  const A0 = Math.cos((S / (1 + S)) * (Math.PI / 2)) ** 2;
  const alphaBar = (tau) => {
    const v = Math.cos(((tau + S) / (1 + S)) * (Math.PI / 2)) ** 2 / A0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  const T = 1000;

  /* ------------------------------------------------------------ text */

  const SETS = {
    l: 'abcdefghijklmnopqrstuvwxyz',
    u: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    d: '0123456789',
    p: '·:;+-=*/<>~^',
  };
  const LETTER = /\p{L}/u;
  const SPACE = /\s/;
  const ORIG = new WeakMap(); // text node -> original string
  const busy = new WeakSet(); // nodes currently being animated

  function glyphSet(ch) {
    if (SPACE.test(ch)) return null; // keep word shapes: the low frequencies come back first
    if (ch >= '0' && ch <= '9') return SETS.d;
    if (LETTER.test(ch)) return ch !== ch.toLowerCase() ? SETS.u : SETS.l;
    return SETS.p;
  }

  function collect(scope, keep) {
    const items = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || busy.has(n) || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest('script, style, svg, canvas, [data-noscramble]')) return NodeFilter.FILTER_REJECT;
        if (keep && !keep(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!ORIG.has(n)) ORIG.set(n, n.nodeValue);
      const chars = Array.from(ORIG.get(n));
      items.push({ node: n, chars, sets: chars.map(glyphSet), u: chars.map(Math.random) });
      busy.add(n);
    }
    return items;
  }

  // Each character has its own threshold u ~ U(0,1) and is "clean" once a >= u.
  function paint(items, a) {
    for (const it of items) {
      let s = '';
      for (let i = 0; i < it.chars.length; i++) {
        const set = it.sets[i];
        s += set === null || a >= it.u[i] ? it.chars[i] : set[(Math.random() * set.length) | 0];
      }
      if (it.node.nodeValue !== s) it.node.nodeValue = s;
    }
  }

  /* ------------------------------------------------------------ full-screen noise */

  const noise = (() => {
    const cv = $('#noise');
    if (!cv) return null;
    const ctx = cv.getContext('2d', { alpha: false });
    const SLACK = 2048;
    let w = 0, h = 0, img = null, buf = null;

    function size() {
      // 2 CSS px per sample; a hidden tab can report a 0×0 viewport
      const nw = Math.max(1, Math.ceil((innerWidth || 1280) / 2));
      const nh = Math.max(1, Math.ceil((innerHeight || 800) / 2));
      if (buf && nw === w && nh === h) return;
      w = nw; h = nh;
      cv.width = w; cv.height = h;
      img = ctx.createImageData(w, h);
      buf = new Uint8ClampedArray((w * h + SLACK) * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = gbyte(); buf[i + 1] = gbyte(); buf[i + 2] = gbyte(); buf[i + 3] = 255;
      }
    }
    function draw() {
      const off = ((Math.random() * SLACK) | 0) * 4;
      img.data.set(buf.subarray(off, off + w * h * 4));
      ctx.putImageData(img, 0, 0);
    }
    return { cv, size, draw };
  })();

  /* ------------------------------------------------------------ portrait */

  const portrait = (() => {
    const fig = $('#portrait');
    if (!fig) return null;
    const img = $('img', fig);
    const cv = $('canvas', fig);
    const frame = $('.portrait-frame', fig);
    const tag = $('#ptag');
    let ctx, out, x0, eps, n = 0, ready = false, failed = false, running = false;

    const loaded = new Promise((res) => {
      if (img.complete && img.naturalWidth) res();
      else {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      }
    });

    async function prepare() {
      await loaded;
      if (ready || failed) return ready;
      try {
        const W = Math.min(img.naturalWidth, Math.round(frame.clientWidth * Math.min(2, devicePixelRatio || 1)));
        if (!W) throw new Error('no image');
        cv.width = cv.height = W;
        n = W * W;
        ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, W, W);
        out = ctx.getImageData(0, 0, W, W); // throws on a tainted canvas (e.g. file://)
        const d = out.data;
        x0 = new Float32Array(n * 3);
        for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
          x0[k] = d[j] / 127.5 - 1;
          x0[k + 1] = d[j + 1] / 127.5 - 1;
          x0[k + 2] = d[j + 2] / 127.5 - 1;
        }
        resample();
        ready = true;
        fig.classList.add('live');
      } catch (e) {
        failed = true; // the plain <img> stays visible
      }
      return ready;
    }

    function resample() {
      if (!n) return;
      eps = new Float32Array(n * 3);
      for (let i = 0; i < eps.length; i++) eps[i] = gauss();
    }

    function label(tau) {
      if (!tag) return;
      const t = Math.round(tau * T);
      tag.textContent = t === 0 ? 'x₀ · t = 0' : `xₜ · t = ${String(t).padStart(4, '0')}`;
    }

    // x_t = sqrt(ᾱ)·x_0 + sqrt(1−ᾱ)·ε
    function render(ab, tau) {
      label(tau);
      if (!ready) return;
      const a = Math.sqrt(ab), s = Math.sqrt(1 - ab), d = out.data;
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
        d[j] = (a * x0[k] + s * eps[k] + 1) * 127.5;
        d[j + 1] = (a * x0[k + 1] + s * eps[k + 1] + 1) * 127.5;
        d[j + 2] = (a * x0[k + 2] + s * eps[k + 2] + 1) * 127.5;
      }
      ctx.putImageData(out, 0, 0);
    }

    async function replay(duration = 1600) {
      if (running || !(await prepare())) return;
      running = true;
      resample();
      const t0 = performance.now();
      await new Promise((done) => {
        const f = (now) => {
          const p = Math.min(1, (now - t0) / duration);
          render(alphaBar(1 - p), 1 - p);
          if (p < 1) raf(f); else done();
        };
        raf(f);
      });
      running = false;
    }

    frame.addEventListener('click', () => { if (state.p >= 0.998) replay(); });

    return { prepare, resample, render, replay };
  })();

  /* ------------------------------------------------------------ the reverse process, driven by scroll */

  // The page opens as x_T ~ N(0, I). The first stretch of scroll (the runway) walks t
  // from T down to 0 while the page stays pinned under the noise; past the runway the
  // page scrolls normally. Only the opening view (nav + hero) takes part.
  //
  // Once the page is clean and scrolling has settled, the runway is folded away, so the
  // top of the page is the top of the document. Going back to noise then takes about a
  // second of deliberate upward scrolling at the top (or holding a pull on touch).
  const state = { p: 1, target: 1, offset: 0, active: false, locked: false };

  function restore(items) {
    for (const it of items) {
      const o = ORIG.get(it.node);
      if (it.node.nodeValue !== o) it.node.nodeValue = o;
    }
  }

  function scrollDiffusion() {
    const page = $('#page');
    const runway = $('#runway');
    const hud = $('#hud');
    const hint = $('#renoise');
    const hintLabel = hint ? $('.renoise-label', hint) : null;
    const hudT = $('#hud-t'), hudS = $('#hud-s');
    if (!motion || !noise || !page || !runway || !hud) return;

    state.active = true;
    root.classList.add('diffusing');
    root.classList.remove('intro');

    let D = 0, lastW = 0, pageH = 0, pinned = false, looping = false, frameNo = 0, lastP = -1;
    let items = [];

    const jump = (y) => {
      root.style.scrollBehavior = 'auto';
      scrollTo(0, y);
      root.style.scrollBehavior = '';
    };
    const runwayH = () => (state.locked ? 0 : D);

    function measure() {
      if (innerWidth !== lastW || !D) { // ignore height-only changes (mobile URL bar)
        lastW = innerWidth;
        D = Math.max(420, Math.round((innerHeight || 800) * 1.1));
        noise.size();
        noise.draw();
      }
      runway.style.height = runwayH() + 'px';
      state.offset = runwayH();
      pageH = page.offsetHeight;
      if (pinned) document.body.style.minHeight = D + pageH + 'px';
    }

    // While pinned the page is out of flow; min-height keeps the document as tall as it
    // will be once the page is back in flow, so unpinning never jumps.
    function setPinned(on) {
      if (on === pinned) return;
      pinned = on;
      root.classList.toggle('pinned', on);
      document.body.style.minHeight = on ? D + pageH + 'px' : '';
    }

    function apply(p, moved) {
      const tau = 1 - p, ab = alphaBar(tau), v = 1 - ab;
      if (moved) {
        noise.cv.style.opacity = v.toFixed(3);
        noise.cv.style.visibility = v < 0.002 ? 'hidden' : '';
        page.style.filter = v > 0.004 ? `blur(${(11 * v).toFixed(2)}px)` : '';
        if (portrait) portrait.render(ab, tau);
        if (hudT) hudT.textContent = String(Math.round(tau * T)).padStart(4, '0');
        if (hudS) hudS.textContent = Math.sqrt(v).toFixed(3);
        const hv = Math.max(0, 1 - p * 2.5);
        hud.style.opacity = hv.toFixed(3);
        hud.style.visibility = hv < 0.01 ? 'hidden' : '';
      }
      // Under fully opaque noise, and once clean, the DOM keeps its real text.
      if (p <= 0.002 || p >= 0.998) restore(items);
      else paint(items, Math.pow(ab, 0.55));
    }

    function tick() {
      const d = state.target - state.p;
      state.p = Math.abs(d) < 0.0006 ? state.target : state.p + d * 0.14;
      const p = state.p;
      const moved = p !== lastP;
      const noisy = 1 - alphaBar(1 - p) > 0.002;
      const shimmer = noisy && frameNo++ % 3 === 0; // keep the static alive (~20 fps)
      if (shimmer) noise.draw();
      if (moved || shimmer) apply(p, moved);
      lastP = p;
      if (moved || noisy) raf(tick);
      else looping = false;
    }
    const kick = () => { if (!looping) { looping = true; raf(tick); } };

    /* ---- scripted scroll (HUD, brand link, "back to noise"); opposing input cancels it */
    let glideId = 0, glideDir = 0;
    const cancelGlide = () => { glideId++; glideDir = 0; };
    function glide(to, ms) {
      const id = ++glideId, from = scrollY, t0 = performance.now();
      glideDir = Math.sign(to - from);
      const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      root.style.scrollBehavior = 'auto';
      const f = (now) => {
        if (id !== glideId) { root.style.scrollBehavior = ''; return; }
        const k = Math.min(1, (now - t0) / ms);
        scrollTo(0, from + (to - from) * ease(k));
        if (k < 1) raf(f);
        else { glideDir = 0; root.style.scrollBehavior = ''; scheduleLock(); }
      };
      raf(f);
    }

    /* ---- lock: fold the runway away once the page is clean */
    let lockTimer = 0;
    function scheduleLock() {
      clearTimeout(lockTimer);
      if (!state.locked && scrollY >= D) lockTimer = setTimeout(tryLock, 200);
    }
    function tryLock() {
      if (state.locked || glideDir || scrollY < D) return;
      const y = scrollY;
      state.locked = true;
      runway.style.height = '0px';
      state.offset = 0;
      jump(y - D); // same frame as the fold, so nothing moves on screen
      arrivedAt = performance.now();
    }
    function unlock() {
      if (!state.locked) return;
      const y = Math.max(0, scrollY);
      state.locked = false;
      runway.style.height = D + 'px';
      state.offset = D;
      jump(y + D);
    }

    /* ---- the one-second hold that takes a clean page back to noise */
    const HOLD_MS = 1000;
    const hold = { start: 0, last: 0, gap: 0, touch: false, done: false, raf: 0 };
    let arrivedAt = 0, wasAtTop = false;

    function showHint(k, label) {
      if (!hint) return;
      if (label && hintLabel && hintLabel.textContent !== label) hintLabel.textContent = label;
      hint.style.setProperty('--k', k.toFixed(3));
      hint.classList.add('show');
    }
    function hideHint() { if (hint) hint.classList.remove('show'); }

    function resetHold() {
      hold.start = 0; hold.done = false; hold.touch = false;
      if (hold.raf) cancelAnimationFrame(hold.raf);
      hold.raf = 0;
      hideHint();
    }
    function finishHold() {
      resetHold();
      unlock();
      glide(0, 1400);
    }
    function holdTick(now) {
      hold.raf = 0;
      if (!hold.start) return;
      if (!state.locked || scrollY > 1 || (!hold.touch && now - hold.last > hold.gap)) { resetHold(); return; }
      const k = Math.min(1, (now - hold.start) / HOLD_MS);
      if (now - hold.start > 120) {
        showHint(k, hold.done && hold.touch ? 'release to return to noise' : 'keep scrolling ↑ to return to noise');
      }
      if (k >= 1 && !hold.done) {
        hold.done = true;
        if (!hold.touch) { finishHold(); return; } // wheel / keys: go now; touch: on release
      }
      hold.raf = raf(holdTick);
    }
    function intent(now, gap, touch) {
      if (!hold.start || (!hold.touch && now - hold.last > hold.gap)) { hold.start = now; hold.done = false; }
      hold.last = now; hold.gap = gap; hold.touch = !!touch;
      if (!hold.raf) hold.raf = raf(holdTick);
    }

    // Wheel: ignore the tail of the flick that brought you to the top, and inertial
    // scrolling (deltas that only ever shrink); count only a sustained push.
    let lastAbs = 0, decay = 0;
    addEventListener('wheel', (e) => {
      if (glideDir && e.deltaY && Math.sign(e.deltaY) !== glideDir) cancelGlide();
      if (!state.locked || scrollY > 1) return;
      if (e.deltaY >= 0) { if (e.deltaY > 0) resetHold(); return; }
      const now = performance.now();
      const a = Math.abs(e.deltaY);
      decay = a < lastAbs ? decay + 1 : 0;
      lastAbs = a;
      if (now - arrivedAt < 350) return;
      if (decay >= 8) { resetHold(); return; }
      intent(now, 220, false);
    }, { passive: true });

    // Touch: hold a downward pull at the top for a second, then let go.
    let ty0 = null;
    addEventListener('touchstart', (e) => {
      if (glideDir) cancelGlide();
      ty0 = state.locked && scrollY <= 1 && e.touches.length === 1 ? e.touches[0].clientY : null;
    }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (ty0 === null || !state.locked || scrollY > 1) return;
      if (e.touches[0].clientY - ty0 > 28) intent(performance.now(), 0, true);
    }, { passive: true });
    const touchEnd = () => {
      if (hold.touch && hold.done) finishHold();
      else if (hold.touch) resetHold();
      ty0 = null;
    };
    addEventListener('touchend', touchEnd, { passive: true });
    addEventListener('touchcancel', touchEnd, { passive: true });

    // Keys: hold ↑ / PageUp / Home at the top.
    addEventListener('keydown', (e) => {
      const up = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home';
      const down = e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'End' || e.key === ' ';
      if ((glideDir < 0 && down) || (glideDir > 0 && up)) cancelGlide();
      if (!up || !state.locked || scrollY > 1) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
      const now = performance.now();
      if (now - arrivedAt < 350) return;
      intent(now, 650, false);
    });

    function onScroll() {
      const y = scrollY;
      if (state.locked) {
        setPinned(false);
        state.target = 1;
        const atTop = y <= 1;
        if (atTop && !wasAtTop) arrivedAt = performance.now();
        wasAtTop = atTop;
        if (!atTop && hold.start) resetHold();
      } else {
        setPinned(y < D);
        state.target = Math.min(1, Math.max(0, y / D));
        wasAtTop = false;
        if (y !== lastScrollY) scheduleLock(); // "settled" means the position stopped changing
      }
      lastScrollY = y;
      kick();
    }
    let lastScrollY = -1;

    // ---- start
    measure();
    let hash = null;
    try { hash = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch (e) { hash = null; }
    if (hash && hash !== page) {
      // a deep link (#publications, ...) goes straight to x_0
      state.p = state.target = 1;
      root.style.scrollBehavior = 'auto';
      hash.scrollIntoView();
      root.style.scrollBehavior = '';
    } else {
      jump(0);
      setPinned(true);
      state.p = state.target = 0;
      // only the opening view denoises: the nav and the hero (name, kicker, bio, links)
      items = [$('.nav'), $('.hero')].filter(Boolean).flatMap((el) => collect(el));
    }
    apply(state.p, true);
    onScroll();

    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', () => { measure(); onScroll(); });
    // A same-document jump (e.g. #publications typed while still in the noise) can't
    // scroll a pinned page, so place it where that section will be once unpinned.
    addEventListener('hashchange', () => {
      let el = null;
      try { el = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) { el = null; }
      if (!el || el === page || !pinned) return;
      const off = el.getBoundingClientRect().top - page.getBoundingClientRect().top;
      jump(D + off - 72);
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => measure()).observe(page);
    if (portrait) portrait.prepare().then(() => { lastP = -1; kick(); });

    hud.addEventListener('click', () => { if (!state.locked) glide(D, 1500); });
    $$('a[href="#page"]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const top = state.locked ? 0 : D;
      glide(top, Math.abs(scrollY - top) > 2 * innerHeight ? 900 : 1500);
      if (a.classList.contains('skip')) { const b = $('.brand'); if (b) b.focus({ preventScroll: true }); }
    }));
    const back = $('#resample');
    if (back) back.addEventListener('click', () => { resetHold(); unlock(); glide(0, 1800); });
  }

  /* ------------------------------------------------------------ artificial potential field demo */

  function potentialField() {
    const cv = $('#apf-field');
    if (!cv) return;
    const wrap = cv.parentElement;
    const ctx = cv.getContext('2d');
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');

    // Obstacles and points in [0,1]² of the thumbnail; radii in units of its height.
    const OBS = [
      { x: 0.33, y: 0.40, r: 0.12 },
      { x: 0.60, y: 0.74, r: 0.10 },
      { x: 0.66, y: 0.28, r: 0.085 },
      { x: 0.18, y: 0.80, r: 0.06 },
    ];
    const HOME = { x: 0.88, y: 0.56 };
    const START = { x: 0.08, y: 0.14 };
    const K = 10; // large enough that the goal term wins away from the obstacles
    const WALL = 1.45; // workspace boundary: an ellipse that just encloses the thumbnail
    const H_STEP = 0.008;

    let W = 0, H = 0, dpr = 1, aspect = 4 / 3;
    let cx = 0, cy = 0, ax = 1, ay = 1;
    let obs = [], goal = null, start = null, path = [], idx = 0, hold = 0;
    let visible = false, looping = false, colors = {};

    const toWorld = (p) => ({ x: p.x * aspect, y: p.y });
    const wall = (x, y) => {
      const ex = (x - cx) / ax, ey = (y - cy) / ay;
      return 1 - ex * ex - ey * ey;
    };
    const free = (p, m = 0.025) =>
      p.x > 0.02 && p.x < aspect - 0.02 && p.y > 0.02 && p.y < 0.98 &&
      obs.every((o) => (p.x - o.x) ** 2 + (p.y - o.y) ** 2 > (o.r + m) ** 2);

    // U = γᵏ / (β₀ · Πβᵢ): goal attraction γ = ‖q − q_goal‖² over the workspace
    // boundary β₀ and obstacle barriers βᵢ = ‖q − oᵢ‖² − rᵢ². Returned as log(U)/k,
    // which spaces the contours evenly in log-distance.
    function field(x, y) {
      const b0 = wall(x, y);
      if (b0 <= 0) return NaN;
      let lb = Math.log(b0);
      for (const o of obs) {
        const v = (x - o.x) ** 2 + (y - o.y) ** 2 - o.r * o.r;
        if (v <= 0) return NaN;
        lb += Math.log(v);
      }
      return Math.log((x - goal.x) ** 2 + (y - goal.y) ** 2 + 1e-9) - lb / K;
    }

    // ∇ log U = k∇γ/γ − ∇β₀/β₀ − Σ ∇βᵢ/βᵢ (only its direction is used)
    function grad(x, y) {
      const dx = x - goal.x, dy = y - goal.y, g = dx * dx + dy * dy + 1e-12;
      let gx = (2 * K * dx) / g, gy = (2 * K * dy) / g;
      const ex = (x - cx) / ax, ey = (y - cy) / ay, b0 = Math.max(1e-6, 1 - ex * ex - ey * ey);
      gx += (2 * ex) / (ax * b0);
      gy += (2 * ey) / (ay * b0);
      for (const o of obs) {
        const ox = x - o.x, oy = y - o.y, b = ox * ox + oy * oy - o.r * o.r;
        gx -= (2 * ox) / b;
        gy -= (2 * oy) / b;
      }
      return [gx, gy];
    }

    function plan() {
      const pts = [{ ...start }];
      let p = { ...start };
      let anchor = { ...p };
      for (let i = 0; i < 900; i++) {
        const [gx, gy] = grad(p.x, p.y);
        const m = Math.hypot(gx, gy) || 1;
        p = { x: p.x - (H_STEP * gx) / m, y: p.y - (H_STEP * gy) / m };
        pts.push(p);
        if (Math.hypot(p.x - goal.x, p.y - goal.y) < H_STEP * 1.2) { pts.push({ ...goal }); break; }
        if (i % 40 === 39) { // stuck in a local minimum
          if (Math.hypot(p.x - anchor.x, p.y - anchor.y) < H_STEP * 4) break;
          anchor = { ...p };
        }
      }
      path = pts;
      idx = 0;
      hold = 0;
    }

    function readColors() {
      const cs = getComputedStyle(root);
      const get = (n) => cs.getPropertyValue(n).trim();
      colors = { surface: get('--surface'), fg: get('--fg'), muted: get('--muted'), faint: get('--faint'), accent: get('--accent') };
    }

    function renderField() {
      off.width = cv.width; off.height = cv.height;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.globalAlpha = 1;
      octx.fillStyle = colors.surface;
      octx.fillRect(0, 0, W, H);
      const g = 2; // CSS px per sample
      const nx = Math.ceil(W / g), ny = Math.ceil(H / g);
      const grid = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) grid[j * nx + i] = field(((i + 0.5) * g) / H, ((j + 0.5) * g) / H);
      }
      const VMIN = Math.log(0.035 * 0.035);
      const SPACING = 0.42;
      const band = (v) => Math.floor(Math.max(v, VMIN) / SPACING);
      // soft basin around the goal
      octx.fillStyle = colors.accent;
      for (let k = 0; k < grid.length; k++) {
        const v = grid[k];
        if (!(v === v)) continue; // NaN: inside an obstacle
        const t = Math.min(1, Math.max(0, 1 - (v - VMIN) / 4.5));
        if (t < 0.05) continue;
        octx.globalAlpha = 0.3 * t * t;
        octx.fillRect((k % nx) * g, Math.floor(k / nx) * g, g, g);
      }
      // iso-contours of log U
      octx.fillStyle = colors.faint;
      octx.globalAlpha = 0.8;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const v = grid[j * nx + i];
          if (!(v === v)) continue;
          const b = band(v);
          const r = grid[j * nx + i + 1], d = grid[(j + 1) * nx + i];
          if ((r === r && band(r) !== b) || (d === d && band(d) !== b)) octx.fillRect(i * g, j * g, 1, 1);
        }
      }
      octx.globalAlpha = 1;
      // obstacles
      for (const o of obs) {
        octx.beginPath();
        octx.arc(o.x * H, o.y * H, o.r * H, 0, Math.PI * 2);
        octx.fillStyle = colors.fg;
        octx.globalAlpha = 0.1;
        octx.fill();
        octx.globalAlpha = 0.55;
        octx.strokeStyle = colors.muted;
        octx.lineWidth = 1;
        octx.stroke();
      }
      octx.globalAlpha = 1;
    }

    function draw() {
      if (!W || !path.length) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const X = (p) => p.x * H, Y = (p) => p.y * H;

      // planned path
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = colors.muted;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // traversed path
      const k = Math.min(path.length - 1, Math.floor(idx));
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      for (let i = 0; i <= k; i++) (i ? ctx.lineTo(X(path[i]), Y(path[i])) : ctx.moveTo(X(path[i]), Y(path[i])));
      ctx.stroke();

      // start
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.strokeRect(X(start) - 3, Y(start) - 3, 6, 6);

      // goal
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(X(goal), Y(goal), 5, 0, Math.PI * 2);
      ctx.moveTo(X(goal) - 9, Y(goal)); ctx.lineTo(X(goal) - 6, Y(goal));
      ctx.moveTo(X(goal) + 6, Y(goal)); ctx.lineTo(X(goal) + 9, Y(goal));
      ctx.moveTo(X(goal), Y(goal) - 9); ctx.lineTo(X(goal), Y(goal) - 6);
      ctx.moveTo(X(goal), Y(goal) + 6); ctx.lineTo(X(goal), Y(goal) + 9);
      ctx.stroke();

      // robot (unicycle: body + heading)
      const p = path[k], q = path[Math.min(path.length - 1, k + 1)];
      const th = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.arc(X(p), Y(p), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(X(p), Y(p));
      ctx.lineTo(X(p) + Math.cos(th) * 8, Y(p) + Math.sin(th) * 8);
      ctx.stroke();
    }

    function tick() {
      if (!visible) { looping = false; return; }
      if (idx < path.length - 1) idx += 1.4;
      else if (++hold > 70) { start = { ...toWorld(START) }; plan(); }
      draw();
      raf(tick);
    }
    function loop() {
      if (!motion) { idx = path.length - 1; draw(); return; }
      if (!looping && visible) { looping = true; raf(tick); }
    }

    function retarget(newGoal) {
      const here = path.length ? path[Math.min(path.length - 1, Math.floor(idx))] : start;
      start = { ...here };
      goal = newGoal;
      renderField();
      plan();
      if (!motion || !visible) { idx = motion ? 0 : path.length - 1; draw(); }
    }

    function layout() {
      const r = cv.getBoundingClientRect();
      if (!r.width) return;
      dpr = Math.min(2, devicePixelRatio || 1);
      W = r.width; H = r.height; aspect = W / H;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      obs = OBS.map((o) => ({ x: o.x * aspect, y: o.y, r: o.r }));
      cx = aspect / 2; cy = 0.5; ax = (aspect / 2) * WALL; ay = 0.5 * WALL;
      goal = goal ? { ...goal } : toWorld(HOME);
      start = start ? { ...start } : toWorld(START);
      readColors();
      renderField();
      plan();
      if (!motion) idx = path.length - 1;
      draw();
    }

    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / H, y: (e.clientY - r.top) / H };
    };
    let pending = null;
    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const p = local(e);
      if (!free(p)) return;
      if (!pending) raf(() => { const g = pending; pending = null; retarget(g); });
      pending = p;
    });
    wrap.addEventListener('pointerleave', () => retarget(toWorld(HOME)));
    wrap.addEventListener('click', (e) => {
      const p = local(e);
      if (!free(p)) return;
      if (e.pointerType === 'touch' || (e.pointerType === undefined && 'ontouchstart' in window)) {
        retarget(p); // on touch, a tap places the goal
      } else {
        start = p;
        plan();
        if (!motion) { idx = path.length - 1; draw(); }
      }
    });

    new ResizeObserver(() => layout()).observe(cv);
    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      if (visible) loop();
    }).observe(cv);
    addEventListener('themechange', () => { if (W) { readColors(); renderField(); draw(); } });
  }

  /* ------------------------------------------------------------ chrome */

  function navigation() {
    const nav = $('.nav');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', scrollY > state.offset + 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function themeToggle() {
    const btn = $('#theme-toggle');
    const sys = matchMedia('(prefers-color-scheme: dark)');
    const current = () => root.getAttribute('data-theme') || (sys.matches ? 'dark' : 'light');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
        dispatchEvent(new Event('themechange'));
      });
    }
    if (sys.addEventListener) sys.addEventListener('change', () => dispatchEvent(new Event('themechange')));
  }

  /* ------------------------------------------------------------ go */

  navigation();
  themeToggle();
  try { potentialField(); } catch (e) { /* demo is optional */ }

  try {
    scrollDiffusion();
  } catch (e) {
    // never leave the page stuck behind the intro
    root.classList.remove('diffusing', 'pinned');
    document.body.style.minHeight = '';
    const pg = $('#page');
    if (pg) pg.style.filter = '';
    state.active = false;
    state.p = state.target = 1;
    state.offset = 0;
  }
  root.classList.remove('intro');

  const back = $('#resample');
  if (back && !state.active) back.hidden = true;
})();
