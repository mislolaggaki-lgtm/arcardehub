// The daily streak in the hub (the server works it out: see "Daily streak" in server/server.js).
// - The top bar: your flame and number (lit once today is kept, grey until then, nervous in the
//   evening). Tapping it opens your streak: today's 5 minutes, the last 7 days, your best, when it
//   started, the flame's look and the next one.
// - The "streak kept" screen (streak-flame.js) when you come back to the hub after keeping it, or
//   straight away if the hub is open while you play in another tab, with any badges earned.
// - Friends: a small flame on each friend, and their whole streak (the last 5 weeks) from their
//   profile. Only friends can see it; the server checks.
// window.ahStreak = { refresh, clear, kept, openMine, openFriend, chip, row }
(function () {
  const api = () => (typeof API !== 'undefined' ? API : '/api'); // index.html's API base
  const token = () => localStorage.getItem('ah_token');
  const SF = () => window.streakFlame;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badgeDefs = () => (typeof BADGE_DEFS !== 'undefined' ? BADGE_DEFS : []);
  // Days come as 'YYYY-MM-DD' (UK days); shown in the player's own language
  const asDate = day => new Date(day + 'T12:00:00Z');
  const letter = day => asDate(day).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' });
  const dateText = day => asDate(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const mins = secs => Math.floor(secs / 60);

  let mine = null, celebrating = false;

  async function get(path) {
    const r = await fetch(api() + path, { headers: { Authorization: 'Bearer ' + token() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Couldn't load the streak. Please try again.");
    return d;
  }

  // ── The top bar ──
  function pill() {
    const el = document.getElementById('nav-streak');
    if (!el || !mine || !SF()) return;
    const left = Math.max(1, Math.ceil((mine.goalSecs - mine.playedSecs) / 60));
    el.className = `nav-streak is-on is-${mine.state}`;
    el.dataset.rank = SF().rank(mine.streak).key;
    el.innerHTML = SF()(mine.streak, { size: 20, small: true, state: mine.state }) + `<span>${mine.streak}</span>`;
    const label = mine.keptToday ? `${mine.streak}-day streak, kept today`
      : `${mine.streak}-day streak. Play ${left} more minute${left === 1 ? '' : 's'} of FPS Arena today to keep it`;
    el.title = label;
    el.setAttribute('aria-label', label);
  }

  async function refresh() {
    if (!token()) return;
    try { mine = await get('/streak'); } catch { return; }
    pill();
    if (mine.news) celebrate(mine.news.count, mine.news.badges || []);
  }
  function clear() {
    mine = null;
    const el = document.getElementById('nav-streak');
    if (el) { el.className = 'nav-streak'; el.innerHTML = ''; }
  }

  // ── The day the streak is kept ──
  // Not while the arcade start screen is still up (it waits for a tap): the screen would play unseen
  const startScreenGone = () => new Promise(res => {
    const t0 = Date.now();
    (function check() { if (!document.getElementById('ah-splash') || Date.now() - t0 > 30000) res(); else setTimeout(check, 200); })();
  });
  async function celebrate(count, badgeIds) {
    if (celebrating || !SF() || !mine) return;
    celebrating = true;
    await startScreenGone();
    await new Promise(r => setTimeout(r, 400));
    fetch(api() + '/streak/seen', { method: 'POST', headers: { Authorization: 'Bearer ' + token() } }).catch(() => {});
    const badges = badgeIds.map(id => badgeDefs().find(d => d.id === id)).filter(Boolean).map(d => ({ name: d.name, color: d.color, svg: d.svg }));
    try { await SF().celebrate({ streak: count, week: mine.days, letters: mine.days.map(d => letter(d.day)), badges }); }
    finally { celebrating = false; }
  }
  // Kept just now (the hub is open while the game plays in another tab)
  async function kept(msg) {
    if (!token()) return;
    try { mine = await get('/streak'); } catch { return; }
    pill();
    celebrate(msg.streak || mine.streak, msg.badges || []);
  }

  // ── The panels: yours and a friend's ──
  let overlay = null, lastFocus = null;
  function close() {
    if (!overlay) return;
    overlay.remove(); overlay = null;
    document.removeEventListener('keydown', onKey);
    try { lastFocus && lastFocus.focus({ preventScroll: true }); } catch {}
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function show(html, label) {
    close();
    lastFocus = document.activeElement;
    overlay = document.createElement('div');
    overlay.className = 'sp-overlay';
    overlay.innerHTML = `<div class="sp" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('.sp-close')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.sp-close')?.focus({ preventScroll: true });
  }
  function fill(html) { const sp = overlay && overlay.querySelector('.sp'); if (sp) sp.innerHTML = html; }

  function panel(d, who) {
    const sf = SF(), r = sf.rank(d.streak), tier = sf.TIERS[r.i];
    const left = Math.max(0, Math.ceil((d.goalSecs - d.playedSecs) / 60));
    const name = who ? `@${esc(who)}` : '';
    const state = who
      ? (d.keptToday ? `${name} kept their streak today.`
        : d.streak > 0 && d.state === 'risk' ? `${name}'s streak is at risk tonight: they haven't played their 5 minutes yet.`
        : d.streak > 0 ? `${name} hasn't played their 5 minutes yet today.`
        : `${name} doesn't have a streak going right now.`)
      : (d.keptToday ? 'Kept today. Come back tomorrow to keep it going.'
        : d.streak > 0 && d.state === 'risk' ? `Your streak is at risk! Play ${left} more minute${left === 1 ? '' : 's'} of FPS Arena before midnight (UK time).`
        : d.streak > 0 ? `Play ${left} more minute${left === 1 ? '' : 's'} of FPS Arena today to keep it going.`
        : d.lost ? `Your ${d.lost}-day streak ran out. Play 5 minutes of FPS Arena to start a new one.`
        : 'Play 5 minutes of FPS Arena to start a streak.');
    const pct = Math.min(100, Math.round((d.playedSecs / d.goalSecs) * 100));
    const today = `<div class="sp-today"><div class="sp-today-row"><span>${who ? 'Played today' : 'Today'}</span><b>${d.keptToday ? 'Done' : `${mins(d.playedSecs)} of ${mins(d.goalSecs)} min`}</b></div>
      <div class="sp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${d.keptToday ? 100 : pct}"><i style="--p:${d.keptToday ? 100 : pct}%"></i></div></div>`;
    const days = d.days.length > 7
      ? `<div class="sp-cal-head"><span>The last 5 weeks</span><span>${(n => `${n} day${n === 1 ? '' : 's'}`)(d.days.filter(x => x.kept).length)}</span></div>
         <div class="sp-cal">${d.days.map((x, k) => `<span class="${x.kept ? 'is-on' : ''}${k === d.days.length - 1 ? ' is-today' : ''}" title="${esc(dateText(x.day))}">${asDate(x.day).getUTCDate()}</span>`).join('')}</div>`
      : `<div class="sp-week">${d.days.map((x, k) => `<span class="sp-day${x.kept ? ' is-on' : ''}${k === d.days.length - 1 ? ' is-today' : ''}"><i>${x.kept ? sf(3, { size: 16, small: true, still: true }) : ''}</i><small>${esc(letter(x.day))}</small></span>`).join('')}</div>`;
    const next = r.next ? `<small>Next: ${esc(r.next.name)} ${r.next.left === 1 ? 'tomorrow' : `in ${r.next.left} days`}</small>` : '<small>The top look</small>';
    const colours = tier.num ? `--n0:${tier.num[0]};--n1:${tier.num[1]}` : '';
    return `
      <button type="button" class="sp-close" aria-label="Close">✕</button>
      <div class="sp-who">${who ? `${name}'s streak` : 'Your streak'}</div>
      <div class="sp-flame">${sf(d.streak, { size: 96, state: d.state })}</div>
      <div class="sp-num" style="${colours}">${d.streak}</div>
      <div class="sp-label">DAY STREAK</div>
      ${d.streak > 0 ? `<div class="sp-rank" style="${colours}">${esc(r.name)}${next}</div>` : ''}
      <p class="sp-state">${state}</p>
      ${today}
      ${days}
      <div class="sp-stats"><div><strong>${d.best}</strong><small>Best streak</small></div><div><strong>${d.startedOn ? esc(dateText(d.startedOn)) : '–'}</strong><small>Streak started</small></div></div>
      ${who ? '' : `<p class="sp-how">A day counts once you've played 5 minutes of FPS Arena: solo, co-op or online. Only time spent moving counts, and days run on UK time. Your friends can see your streak.</p>
      ${d.keptToday ? '' : '<a class="sp-play" href="/games/fps/index.html">PLAY FPS ARENA</a>'}`}`;
  }
  function stateClass(d) { const sp = overlay && overlay.querySelector('.sp'); if (sp) sp.classList.add(`is-${d.state}`); }

  async function openMine() {
    if (!SF()) return;
    show('<button type="button" class="sp-close" aria-label="Close">✕</button><p class="sp-msg">Loading…</p>', 'Your streak');
    try { mine = await get('/streak'); pill(); } catch (err) { if (!mine) return fill(`<button type="button" class="sp-close" aria-label="Close">✕</button><p class="sp-msg">${esc(err.message)}</p>`); }
    fill(panel(mine)); stateClass(mine);
  }
  async function openFriend(username) {
    if (!SF()) return;
    show('<button type="button" class="sp-close" aria-label="Close">✕</button><p class="sp-msg">Loading…</p>', `${username}'s streak`);
    try { const d = await get(`/friends/${encodeURIComponent(username)}/streak`); fill(panel(d, d.username)); stateClass(d); }
    catch (err) { fill(`<button type="button" class="sp-close" aria-label="Close">✕</button><p class="sp-msg">${esc(err.message)}</p>`); }
  }

  // ── Friends list helpers (index.html) ──
  // A small flame and number next to a friend's name, when they have a streak going
  function chip(f) {
    if (!SF() || !f || !(f.streak > 0)) return '';
    const st = f.streakState || 'dim';
    return `<span class="fl-streak is-${st}" title="${f.streak}-day streak">${SF()(f.streak, { size: 13, small: true, still: true, state: st })}${f.streak}</span>`;
  }
  // The streak row on a friend's profile card (opens their whole streak)
  function row(streak, state) {
    if (!SF()) return '';
    const n = Number(streak) || 0, st = state || 'dim';
    const text = n === 0 ? 'No streak right now' : st === 'lit' ? 'Kept today' : st === 'risk' ? 'At risk tonight' : 'Not played yet today';
    return `<button type="button" class="fl-pc-streak">${SF()(n, { size: 28, small: true, state: st })}<span><b>${n}-DAY STREAK</b><small>${text}</small></span><span class="go" aria-hidden="true">›</span></button>`;
  }

  document.addEventListener('click', e => { if (e.target.closest('#nav-streak')) openMine(); });
  window.ahStreak = { refresh, clear, kept, openMine, openFriend, chip, row };
})();
