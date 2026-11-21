// The streak flame (from iTutor: the same flame, looks and states), used by streak.js in the hub
// and by the FPS game for its "streak kept" note.
//
// Built the way Duolingo builds its streak (layered states, a celebration every day the streak is
// kept, a bigger one on milestones), but drawn as our own flame:
// - One chunky flame in flat layers: a thick rim, the body with a shaded side and a highlight, an
//   inner flame and a hot core, with a glow, a shadow on the ground and embers around it. Its outline
//   really changes shape as it burns: each layer morphs between three shapes (SVG <animate>), at
//   speeds that never line up, so it never looks like a loop.
// - States: lit (kept today), dim (not kept yet today: grey and barely moving) and risk (the evening
//   and still not kept: grey, with a hot core flickering to stay alight).
// - Looks that change at milestones: Flame (day 1), Blaze (7), Red-Hot (30), Inferno (100), Legend (365).
// - streakFlame.celebrate({ streak, week, letters, badges }) is the screen for the day the streak is
//   kept: a burst, the flame springs out, the number rolls up and today fills in on the week.
//   Milestone days get more; on a day the look changes, the old flame evolves into the new one on
//   screen; badges earned with it are shown underneath.
//
// streakFlame(days, { size, small, state: 'lit' | 'dim' | 'risk', still }) → an <svg> (as text)
// streakFlame.rank(days) → { i, key, name, from, next: { name, at, left } | null }
// streakFlame.celebrate({ streak, week, letters, badges }) → a Promise, resolved when it's closed
(function () {
  const T = (en, v = {}) => (window.I18N ? I18N.t(en, v) : en.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)));
  const calm = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── The looks. rim, body, shade (the body's shaded side), inner flame, core, glow, the number's colours ──
  const TIERS = [
    { key: 'unlit', from: 0, name: 'Unlit' },
    { key: 'flame', from: 1, name: 'Flame', rim: '#d9480f', body: '#ff9f1c', shade: '#f76707', inner: '#ffd43b', core: '#fff4c2', glow: '#ff922b', embers: 2, num: ['#ffc145', '#f76707'] },
    { key: 'blaze', from: 7, name: 'Blaze', rim: '#fcc419', body: '#ff8a1c', shade: '#f0560c', inner: '#ffe066', core: '#fffbe6', glow: '#fcc419', embers: 3, num: ['#ffe066', '#ff8a1c'] },
    { key: 'redhot', from: 30, name: 'Red-Hot', rim: '#a61e1e', body: '#fa5252', shade: '#d62828', inner: '#ff922b', core: '#ffffff', glow: '#ff6b6b', embers: 4, hot: true, num: ['#ff8787', '#e03131'] },
    { key: 'inferno', from: 100, name: 'Inferno', rim: '#f06595', body: '#ff6b4a', shade: '#e8384f', inner: '#ffa94d', core: '#fff0f6', glow: '#f783ac', embers: 5, hot: true, side: true, num: ['#faa2c1', '#ff6b4a'] },
    { key: 'legend', from: 365, name: 'Legend', rim: '#e5dbff', body: '#7950f2', shade: '#5f3dc4', inner: '#66d9e8', core: '#ffffff', glow: '#9775fa', embers: 6, hot: true, side: true, stars: true, num: ['#d0bfff', '#66d9e8'] },
  ];
  const GREY = { rim: '#6b7380', body: '#a7afba', shade: '#8a939f', inner: '#cdd3da', core: '#eef1f4', glow: '#a7afba' };
  const RISK = { ...GREY, inner: '#ffb366', core: '#fff1d6', glow: '#ff922b' };
  // The days that get a milestone celebration (the looks change on 7, 30, 100 and 365)
  const MILESTONES = [7, 14, 30, 50, 100, 200, 365, 500, 1000];
  const isMilestone = n => MILESTONES.includes(n) || (n > 1000 && n % 500 === 0);

  function tierIndex(days) {
    days = Math.max(0, Math.floor(Number(days) || 0));
    let i = 0;
    TIERS.forEach((t, k) => { if (days >= t.from) i = k; });
    return i;
  }
  function rank(days) {
    const i = tierIndex(days), t = TIERS[i], nx = TIERS[i + 1];
    days = Math.max(0, Math.floor(Number(days) || 0));
    return { i, key: t.key, name: T(t.name), from: t.from, next: nx ? { name: T(nx.name), at: nx.from, left: nx.from - days } : null };
  }

  // ── The shapes ──
  // A chunky flame with a tall main tongue and a smaller one on the left. Every shape comes from the
  // same recipe, so any two of them can morph into each other smoothly.
  const f = x => Math.round(x * 100) / 100;
  function shape({ tx, ty, lx, ly, nx, ny, r, l, b }) {
    const s = b - 21, h = s - ty, hl = s - ly;
    return [
      `M32 ${b}`,
      `C${f(32 + (r - 32) * 0.66)} ${b} ${r} ${b - 9} ${r} ${s}`,                                        // bottom right, round to the right side
      `C${r} ${f(s - h * 0.32)} ${f(tx + (r - tx) * 0.35)} ${f(ty + h * 0.4)} ${f(tx + 2.4)} ${f(ty + 3)}`, // up to the main tip
      `C${f(tx + 1)} ${f(ty - 0.6)} ${f(tx - 1)} ${f(ty - 0.6)} ${f(tx - 2)} ${f(ty + 2.6)}`,               // its rounded point
      `C${f(tx - 2 - (tx - nx) * 0.4)} ${f(ty + (ny - ty) * 0.45)} ${f(nx + (tx - nx) * 0.3)} ${f(ny - (ny - ty) * 0.2)} ${nx} ${ny}`, // down into the notch
      `C${f(nx - (nx - lx) * 0.35)} ${f(ny - (ny - ly) * 0.25)} ${f(lx + 1.2 + (nx - lx) * 0.15)} ${f(ly + 1.6 + (ny - ly) * 0.35)} ${f(lx + 1.2)} ${f(ly + 1.6)}`, // up to the left tip
      `C${f(lx + 0.4)} ${f(ly - 0.4)} ${f(lx - 1.6)} ${f(ly - 0.2)} ${f(lx - 2)} ${f(ly + 1.8)}`,             // its rounded point
      `C${f(lx - 2 - (lx - l) * 0.5)} ${f(ly + 1.8 + hl * 0.35)} ${l} ${f(s - hl * 0.3)} ${l} ${s}`,          // down the left side
      `C${l} ${b - 9} ${f(32 - (32 - l) * 0.66)} ${b} 32 ${b}Z`,                                            // and round the bottom
    ].join('');
  }
  // Three poses for each layer: resting, licking up to the right, leaning left
  const OUTER = [
    { tx: 36, ty: 3, lx: 17, ly: 17, nx: 24, ny: 27, r: 53, l: 11, b: 66 },
    { tx: 38.6, ty: 4.6, lx: 15.6, ly: 15.4, nx: 23.4, ny: 26, r: 53.6, l: 10.6, b: 66 },
    { tx: 34, ty: 1.8, lx: 18.2, ly: 18.8, nx: 25, ny: 28.4, r: 52.4, l: 11.6, b: 66 },
  ];
  const INNER = [
    { tx: 34, ty: 23, lx: 24.5, ly: 33.5, nx: 28.5, ny: 39, r: 44.5, l: 19.5, b: 62.5 },
    { tx: 32.4, ty: 21.6, lx: 25.6, ly: 34.6, nx: 29, ny: 39.8, r: 45, l: 19.2, b: 62.5 },
    { tx: 35.8, ty: 24.2, lx: 23.6, ly: 32.4, nx: 28, ny: 38.4, r: 44, l: 20, b: 62.5 },
  ];
  const core = (x, y) => `M32 61.5C25.6 61.5 23.8 55.8 26.3 51.4C28.1 48.2 ${f(x - 1.4)} ${f(y + 5)} ${x} ${y}C${f(x + 1.4)} ${f(y + 5)} 35.9 48.2 37.7 51.4C40.2 55.8 38.4 61.5 32 61.5Z`;
  const CORE = [[32, 40], [33.2, 41.2], [31, 39.2]];
  // Inferno and Legend grow a tongue of fire on each side, curling out from low on the body like wings
  // (its inner edge is hidden behind the body). m = 1 for the right one, -1 for the left one.
  const tongue = (tx, ty, m) => {
    const X = x => f(32 + (x - 32) * m);
    return `M${X(46)} 58C${X(53)} 58 ${X(60)} 50 ${X(60.5)} 41C${X(60.8)} 36 ${X(60)} ${f(ty + 3.5)} ${X(tx)} ${ty}C${X(tx - 1.5)} ${f(ty + 5)} ${X(55)} 38 ${X(50)} 42Z`;
  };
  const SIDE_R = [[59, 29], [61, 31.4], [57.6, 27.4]].map(([x, y]) => tongue(x, y, 1));
  const SIDE_L = [[59, 30], [57.4, 28], [61, 32]].map(([x, y]) => tongue(x, y, -1));

  // The smooth morph between a layer's poses: rest → a → rest → b → rest, eased like a sine wave
  function morph(frames, dur, offset) {
    const v = [frames[0], frames[1], frames[0], frames[2], frames[0]].join(';');
    return `<animate attributeName="d" dur="${dur}s" begin="-${f(offset)}s" repeatCount="indefinite" values="${v}" keyTimes="0;.25;.5;.75;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1"/>`;
  }

  let n = 0;
  function flame(days, opts = {}) {
    const ti = tierIndex(days), tier = TIERS[ti];
    const state = ti === 0 ? 'dim' : opts.state || (opts.dim ? 'dim' : 'lit');
    const c = state === 'lit' ? tier : state === 'risk' ? RISK : GREY;
    const size = opts.size || 32, small = opts.small || size < 30, still = opts.still || calm();
    const u = `sf${++n}`, off = Math.random() * 6;
    // How fast it burns: calm when it's waiting, nervous when it's at risk
    const speed = state === 'lit' ? 1 : state === 'risk' ? 0.55 : 1.9;
    const slow = small ? 1.3 : 1;
    const anim = (frames, d, k) => (still ? '' : morph(frames, f(d * speed * slow), off * k));
    const outer = OUTER.map(shape), inner = INNER.map(shape), cores = CORE.map(([x, y]) => core(x, y));
    const lit = state === 'lit', rich = lit && !small;

    const outerPath = attrs => `<path d="${outer[0]}" ${attrs}>${anim(outer, 2.1, 1)}</path>`;
    const sidePath = attrs => `<path d="${SIDE_R[0]}" ${attrs}>${anim(SIDE_R, 1.6, 1.3)}</path><path d="${SIDE_L[0]}" ${attrs}>${anim(SIDE_L, 1.8, 0.5)}</path>`;
    const defs = `<defs>
      <radialGradient id="${u}g" cx="50%" cy="58%" r="50%"><stop offset="0" stop-color="${c.glow}" stop-opacity=".5"/><stop offset=".55" stop-color="${c.glow}" stop-opacity=".16"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
      <radialGradient id="${u}h"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".45" stop-color="${c.core}" stop-opacity=".55"/><stop offset="1" stop-color="${c.core}" stop-opacity="0"/></radialGradient>
      <clipPath id="${u}c">${outerPath('')}</clipPath>
    </defs>`;
    const embers = rich && tier.embers ? `<g class="sf-embers" fill="${c.inner}">${[[24, 18, 1.5, 0], [42, 14, 1.2, 0.55], [30, 8, 1.1, 1.1], [47, 28, 1.3, 1.5], [17, 30, 1.2, 0.8], [37, 4, 1, 1.9]]
      .slice(0, tier.embers).map(([x, y, r, d]) => `<circle cx="${x}" cy="${y}" r="${r}" style="animation-delay:-${d}s"/>`).join('')}</g>` : '';
    const star = (x, y, s, d) => `<path d="M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z" style="animation-delay:-${d}s"/>`;
    const stars = rich && tier.stars ? `<g class="sf-stars" fill="#fff">${star(9, 22, 4.2, 0)}${star(57, 14, 3.4, 0.7)}${star(55, 50, 2.8, 1.3)}${star(8, 48, 2.6, 1.9)}</g>` : '';

    const body = `
      ${state !== 'dim' ? `<ellipse class="sf-glow" cx="32" cy="42" rx="${small ? 30 : 36}" ry="${small ? 30 : 34}" fill="url(#${u}g)"/>` : ''}
      ${small ? '' : `<ellipse class="sf-ground" cx="32" cy="68.4" rx="17" ry="3.1" fill="#000" opacity="${state === 'dim' ? '.14' : '.22'}"/>`}
      <g class="sf-fire">
        ${tier.side && lit ? `<g class="sf-side">${sidePath(`fill="${c.rim}" stroke="${c.rim}" stroke-width="4.4" stroke-linejoin="round"`)}${sidePath(`fill="${c.body}"`)}</g>` : ''}
        ${outerPath(`fill="${c.rim}" stroke="${c.rim}" stroke-width="${small ? 5.2 : 4.6}" stroke-linejoin="round"`)}
        <g clip-path="url(#${u}c)">
          <rect x="0" y="0" width="64" height="72" fill="${c.shade}"/>
          <g transform="translate(-4.4 -2.2)">${outerPath(`fill="${c.body}"`)}</g>
          ${small ? '' : `<path d="M17.5 47C16.6 39.5 19.4 32.6 24.6 27.6" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" opacity="${lit ? '.42' : '.3'}"/><circle cx="16.8" cy="52.4" r="1.7" fill="#fff" opacity="${lit ? '.42' : '.3'}"/>`}
        </g>
        <path class="sf-inner" d="${inner[0]}" fill="${c.inner}">${anim(inner, 1.5, 0.7)}</path>
        ${tier.hot && lit && !small ? `<ellipse class="sf-bloom" cx="32" cy="53" rx="13" ry="13" fill="url(#${u}h)"/>` : ''}
        <path class="sf-core" d="${cores[0]}" fill="${c.core}">${anim(cores, 1.1, 0.4)}</path>
      </g>
      ${embers}${stars}`;
    const cls = `sf sf-${tier.key} is-${state}${small ? ' is-small' : ''}${still ? ' is-still' : ''}`;
    return `<svg class="${cls}" viewBox="0 0 64 72" width="${size}" height="${Math.round(size * 72 / 64)}" aria-hidden="true" overflow="visible">${defs}${body}</svg>`;
  }

  // ── The day the streak is kept ──
  // The number rolls from yesterday's count to today's, one digit column at a time
  function roller(from, to) {
    const a = String(Math.max(0, from)), b = String(to), w = b.length, pa = a.padStart(w, ' ');
    return [...b].map((d, k) => {
      const o = pa[k];
      const seq = o === d ? [d] : o === ' ' ? ['', d] : (() => { const s = []; let x = +o; while (x !== +d) { s.push(String(x)); x = (x + 1) % 10; } s.push(d); return s; })();
      return `<span class="sfc-col"><span class="sfc-strip" style="--steps:${seq.length - 1}">${seq.map(x => `<span>${x || '&nbsp;'}</span>`).join('')}</span></span>`;
    }).join('');
  }

  // ── The day the streak is kept ──
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let open = null;
  // week: [{ day, kept }] (today last); letters: a short name for each of those days;
  // badges: [{ name, color, svg }] earned along with today's streak day
  function celebrate({ streak, week = [], letters = [], badges = [] } = {}) {
    streak = Math.max(1, Math.floor(Number(streak) || 1));
    if (open) return open;
    const before = tierIndex(streak - 1), after = tierIndex(streak), t = TIERS[after];
    const evolved = after > before, milestone = isMilestone(streak), r = rank(streak);
    const still = calm(), big = milestone || evolved;
    const title = streak === 1 ? 'Streak started!' : evolved ? 'Your flame evolved!' : milestone ? `${streak}-day milestone!` : 'Streak kept!';
    const sub = evolved && streak > 1 ? `New look: ${T(t.name)}` : 'Play 5 minutes tomorrow to keep it going.';
    const next = r.next && !evolved ? (r.next.left === 1 ? `Next look: ${r.next.name} tomorrow` : `Next look: ${r.next.name} in ${r.next.left} days`) : '';
    const days = week.slice(-7);
    const burst = Array.from({ length: big ? 18 : 12 }, (_, j) => `<i style="--a:${f(j * (360 / (big ? 18 : 12)))}deg;--d:${(j % 3) * 0.05}s;--l:${70 + (j % 4) * 16}px"></i>`).join('');

    const el = document.createElement('div');
    el.className = `sfc${evolved ? ' is-evolve' : ''}${milestone ? ' is-milestone' : ''}${still ? ' is-calm' : ''}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title);
    el.style.setProperty('--glow', t.glow);
    el.style.setProperty('--n0', t.num[0]);
    el.style.setProperty('--n1', t.num[1]);
    el.innerHTML = `
      <div class="sfc-card">
        <div class="sfc-stage" aria-hidden="true">
          ${evolved ? `<div class="sfc-old">${flame(streak - 1, { size: 168, state: before === 0 ? 'dim' : 'lit' })}</div>` : ''}
          <div class="sfc-flash"></div><div class="sfc-ring"></div><div class="sfc-burst">${burst}</div>
          <div class="sfc-flame">${flame(streak, { size: 168, state: 'lit' })}</div>
        </div>
        <div class="sfc-count" aria-label="${streak}">${roller(streak - 1, streak)}</div>
        <div class="sfc-label">DAY STREAK</div>
        <h2 class="sfc-title">${title}</h2>
        <p class="sfc-sub">${sub}</p>
        ${days.length ? `<div class="sfc-week">${days.map((d, k) => `<span class="sfc-day${d.kept ? ' is-on' : ''}${k === days.length - 1 ? ' is-today' : ''}"><i>${d.kept || k === days.length - 1 ? flame(3, { size: 18, small: true, still: true }) : ''}</i><small>${esc(letters[week.length - days.length + k] || '')}</small></span>`).join('')}</div>` : ''}
        ${badges.length ? `<div class="sfc-badges">${badges.map(b => `<span class="sfc-badge"><span class="sfc-badge-icon" style="color:${esc(b.color || '#ffc145')}">${b.svg || ''}</span><span class="sfc-badge-text"><small>NEW BADGE</small>${esc(b.name)}</span></span>`).join('')}</div>` : ''}
        ${next ? `<p class="sfc-next">${next}</p>` : ''}
        <button type="button" class="sfc-go">CONTINUE</button>
      </div>`;
    document.body.appendChild(el);
    const go = el.querySelector('.sfc-go'), lastFocus = document.activeElement;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
    setTimeout(() => go.focus({ preventScroll: true }), still ? 0 : evolved ? 1900 : 1100);

    open = new Promise(resolve => {
      const close = () => {
        if (!el.isConnected || el.classList.contains('is-out')) return;
        el.classList.add('is-out');
        document.removeEventListener('keydown', onKey);
        setTimeout(() => { el.remove(); open = null; try { lastFocus && lastFocus.focus({ preventScroll: true }); } catch {} resolve(); }, still ? 0 : 320);
      };
      const onKey = e => { if (e.key === 'Escape' || (e.key === 'Enter' && document.activeElement === go)) { e.preventDefault(); close(); } };
      go.addEventListener('click', close);
      el.addEventListener('click', e => { if (e.target === el) close(); });
      document.addEventListener('keydown', onKey);
    });
    return open;
  }

  flame.rank = rank;
  flame.TIERS = TIERS;
  flame.MILESTONES = MILESTONES;
  flame.celebrate = celebrate;
  window.streakFlame = flame;
})();
