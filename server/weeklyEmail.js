'use strict';

// Weekly "This week on ArcadeHub" email: latest update, a rotating biome
// spotlight and the Gaming AI. Sent to every verified, non-banned account
// (admin included) at most once per 7 days.

const UPDATES = require('../updates.js');

const WEEK_MS   = 7 * 24 * 60 * 60 * 1000;
const DAY_MS    = 24 * 60 * 60 * 1000;
// One Gmail account sends for both ArcadeHub and iTutor (~500 emails/day total).
// Capping this job keeps verification and reset codes deliverable; anyone over
// the cap stays eligible and is picked up on the next daily run.
const DAILY_CAP = 150;

const APP_URL = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const BIOMES = [
  { name: 'Ice Tundra',        glow: '#7DD3FC', base: '#0B2233', blurb: 'Light-blue floors split by frost cracks while snowflakes drift through the arena.' },
  { name: 'Lava Forge',        glow: '#F97316', base: '#2A0E04', blurb: 'Orange lava glows through the cracks in the floor and embers float past your sights.' },
  { name: 'Neon Forest',       glow: '#22C55E', base: '#04180B', blurb: 'A dark leaf-patterned floor under a steady fall of glowing leaves.' },
  { name: 'Desert',            glow: '#E0A95C', base: '#2B1A07', blurb: 'Rippled sand underfoot and sand whipping across the battlefield.' },
  { name: 'Cyber City',        glow: '#A855F7', base: '#140A2E', blurb: 'Dark purple floors lit by a pulsing neon grid.' },
  { name: 'Space Station',     glow: '#94A3B8', base: '#02040C', blurb: 'Pitch-black floors dotted with stars and a starfield streaming by.' },
  { name: 'Toxic Swamp',       glow: '#84CC16', base: '#101C04', blurb: 'Murky green ground broken up by bubbling mud pools.' },
  { name: 'Haunted Crypt',     glow: '#A78BFA', base: '#141019', blurb: 'Cold dark stone threaded with eerie purple veins.' },
  { name: 'Underwater Ruins',  glow: '#14B8A6', base: '#03201E', blurb: 'Deep teal floors rippling with underwater light caustics.' },
  { name: 'Volcanic Ash',      glow: '#EF4444', base: '#161616', blurb: 'Grey-black ground with faint red cracks and ash hanging in the air.' },
  { name: 'Blood Moon',        glow: '#DC2626', base: '#220707', blurb: 'A dark crimson floor fractured under a blood-red sky.' },
  { name: 'Crystal Cave',      glow: '#67E8F9', base: '#0A0A1C', blurb: 'Glimmering geometric crystal facets catch every muzzle flash.' },
  { name: 'Biomech Core',      glow: '#F472B6', base: '#1A0912', blurb: 'An organic floor pulsing with tissue-like veins. Something is alive in here.' },
  { name: 'Storm Vault',       glow: '#60A5FA', base: '#080D1C', blurb: 'Electric veins crackle across the floor of a charged vault.' },
  { name: 'Deep Trench',       glow: '#2DD4BF', base: '#01060A', blurb: 'Near-total darkness lit only by bioluminescent glow patches.' },
  { name: 'Poison Jungle',     glow: '#A3E635', base: '#0C1604', blurb: 'Moss-covered ground dripping with toxic veins.' },
  { name: 'Acid Wastes',       glow: '#FACC15', base: '#2A1D03', blurb: 'Burnt-yellow wasteland pocked with glowing acid pools.' },
  { name: 'Midnight Rain',     glow: '#93C5FD', base: '#0A1020', blurb: 'Dark, rain-soaked tiles reflecting the fight in every puddle.' },
  { name: 'Ancient Temple',    glow: '#EAB308', base: '#211C14', blurb: 'Worn stone tiles inlaid with gold, older than any robot in the arena.' },
  { name: 'Infernal Pit',      glow: '#EA580C', base: '#0A0503', blurb: 'Scorched black ground torn open by deep, glowing orange cracks.' },
  { name: 'Frozen Void',       glow: '#BAE6FD', base: '#03060F', blurb: 'Icy fractures and hexagonal frost spread across a near-black void.' },
  { name: 'Neon Arena',        glow: '#EC4899', base: '#12030C', blurb: 'A hot-pink grid with retro scanlines. Pure arcade.' },
  { name: 'Dark Nebula',       glow: '#C084FC', base: '#05030D', blurb: 'Coloured nebula smears and distant stars beneath your feet.' },
  { name: 'Radiation Zone',    glow: '#4ADE80', base: '#0E2A16', blurb: 'Green concrete stamped with hazard triangles. Do not linger.' },
  { name: 'Burning Cathedral', glow: '#FB923C', base: '#1A100C', blurb: 'Dark stone blocks smouldering with patches of ember glow.' },
  { name: 'Nano Grid',         glow: '#2DD4BF', base: '#021F18', blurb: 'A teal micro-circuit floor, like fighting inside a motherboard.' },
];

const HEAD = "'Bebas Neue',Impact,'Arial Narrow Bold','Helvetica Neue',Arial,sans-serif";
const BODY = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function biomeOfTheWeek(now = Date.now()) {
  const i = Math.floor(now / WEEK_MS) % BIOMES.length;
  return { ...BIOMES[i], number: i + 1 };
}

// Player-facing highlights from the newest update: skip admin-only notes and
// split "Feature — details" into a bold title and a trimmed description.
function highlights(update, max = 4) {
  return update.changes
    .filter(c => !/admin|stotch/i.test(c))
    .slice(0, max)
    .map(c => {
      const [title, ...rest] = c.split(' — ');
      let text = rest.join(' — ');
      if (text.length > 120) text = text.slice(0, 117).replace(/\s+\S*$/, '') + '…';
      return { title, text };
    });
}

function subject(now = Date.now()) {
  return `This week on ArcadeHub: ${biomeOfTheWeek(now).name}, v${UPDATES[0].version} & your Gaming AI`;
}

function html(username, now = Date.now()) {
  const latest = UPDATES[0];
  const biome  = biomeOfTheWeek(now);
  const items  = highlights(latest);
  const cta    = APP_URL
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>
         <td align="center" bgcolor="#C0392B" style="border-radius:6px;background:#C0392B;box-shadow:0 8px 24px rgba(231,76,60,0.35)">
           <a href="${APP_URL}" target="_blank" style="display:inline-block;padding:16px 44px;font-family:${HEAD};font-size:22px;line-height:24px;letter-spacing:4px;color:#FFFFFF;text-decoration:none">PLAY NOW &rarr;</a>
         </td></tr></table>`
    : '';

  const updateRows = items.map(({ title, text }) => `
    <tr>
      <td valign="top" width="22" style="width:22px;padding:0 0 14px;font-family:${BODY};font-size:15px;line-height:22px;color:#E74C3C">&#9656;</td>
      <td valign="top" style="padding:0 0 14px;font-family:${BODY};font-size:14px;line-height:21px;color:#A1A1B5">
        ${text ? `<strong style="color:#F4F4F8">${esc(title)}</strong> &mdash; ${esc(text)}` : `<span style="color:#D4D4E0">${esc(title)}</span>`}
      </td>
    </tr>`).join('');

  const stat = (n, label) => `
    <td align="center" width="33%" style="padding:18px 6px;border:1px solid #1E1E2C;background:#0F0F18">
      <div style="font-family:${HEAD};font-size:32px;line-height:34px;letter-spacing:1px;color:#FFFFFF">${n}</div>
      <div style="font-family:${BODY};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;color:#6B6B80;margin-top:4px">${label}</div>
    </td>`;

  const section = (label, inner) => `
    <tr><td style="padding:36px 36px 0" class="pad">
      <div style="font-family:${BODY};font-size:11px;line-height:14px;font-weight:700;letter-spacing:4px;color:#E74C3C;margin:0 0 14px">${label}</div>
      ${inner}
    </td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>This week on ArcadeHub</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  @media (max-width:620px) {
    .container { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .hero-title { font-size:44px !important; line-height:44px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#050508">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#050508;opacity:0">Biome of the week: ${esc(biome.name)}. What's new in v${esc(latest.version)}, and the AI that knows every weapon, boss and biome.${'&#847;&zwnj;&nbsp;'.repeat(50)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050508" style="background:#050508">
<tr><td align="center" style="padding:28px 10px 40px">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#0A0A12;border:1px solid #1C1C28;border-radius:14px;border-collapse:separate;overflow:hidden">

  <!-- Hero -->
  <tr><td class="pad" align="center" bgcolor="#12060A" style="padding:40px 36px 36px;text-align:center;background-color:#12060A;background-image:radial-gradient(ellipse at 50% 0%, rgba(231,76,60,0.45) 0%, rgba(231,76,60,0) 65%),linear-gradient(180deg,#1A070B 0%,#0A0A12 100%)">
    ${APP_URL ? `<img src="${APP_URL}/icons/icon-192.png" width="64" height="64" alt="" style="display:block;margin:0 auto 18px;width:64px;height:64px;border:0;border-radius:16px">` : ''}
    <div style="font-family:${HEAD};font-size:30px;line-height:30px;letter-spacing:8px;color:#FFFFFF">ARCADE<span style="color:#E74C3C">HUB</span></div>
    <div style="font-family:${BODY};font-size:11px;line-height:14px;font-weight:700;letter-spacing:4px;color:#8B8BA3;margin:22px 0 10px">THIS WEEK ON ARCADEHUB</div>
    <h1 class="hero-title" style="margin:0;font-family:${HEAD};font-weight:400;font-size:54px;line-height:52px;letter-spacing:2px;color:#FFFFFF">YOUR ARENA IS WAITING, ${esc(username.toUpperCase())}</h1>
    <p style="margin:16px 0 0;font-family:${BODY};font-size:15px;line-height:24px;color:#A1A1B5">A new biome to fight through, the latest update, and an AI that knows the game better than anyone.</p>
  </td></tr>

  <!-- Stats -->
  <tr><td class="pad" style="padding:24px 36px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:6px 0"><tr>
      ${stat('27', 'BIOMES')}${stat('1,000', 'LEVELS')}${stat('61', 'EMOTES')}
    </tr></table>
  </td></tr>

  ${section('BIOME OF THE WEEK', `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
      <tr><td bgcolor="${biome.base}" style="border-radius:10px;border:1px solid ${biome.glow}55;padding:34px 26px;background-color:${biome.base};background-image:radial-gradient(ellipse at 20% 0%, ${biome.glow}66 0%, ${biome.glow}00 60%),linear-gradient(135deg,${biome.base} 0%,#050508 100%)">
        <div style="font-family:${BODY};font-size:11px;line-height:14px;font-weight:700;letter-spacing:3px;color:${biome.glow}">BIOME #${biome.number}</div>
        <div style="font-family:${HEAD};font-size:44px;line-height:46px;letter-spacing:2px;color:#FFFFFF;margin:8px 0 10px">${esc(biome.name.toUpperCase())}</div>
        <div style="font-family:${BODY};font-size:15px;line-height:23px;color:#D4D4E0">${esc(biome.blurb)}</div>
      </td></tr>
    </table>
    <p style="margin:14px 0 0;font-family:${BODY};font-size:13px;line-height:20px;color:#6B6B80">Biomes rotate every 5 levels, and the robots change colour to match.</p>`)}

  ${section(`WHAT'S NEW &middot; V${esc(latest.version)}`, `
    <div style="font-family:${HEAD};font-size:28px;line-height:30px;letter-spacing:1.5px;color:#FFFFFF;margin:0 0 4px">${esc(latest.title)}</div>
    <div style="font-family:${BODY};font-size:12px;line-height:16px;color:#6B6B80;margin:0 0 18px">${esc(latest.date)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${updateRows}</table>`)}

  ${section('MEET YOUR GAMING AI', `
    <div style="font-family:${HEAD};font-size:30px;line-height:32px;letter-spacing:1.5px;color:#FFFFFF;margin:0 0 10px">A PRO PLAYER ON CALL, 24/7</div>
    <p style="margin:0 0 18px;font-family:${BODY};font-size:15px;line-height:24px;color:#A1A1B5">It knows <strong style="color:#F4F4F8">every weapon, all 27 biomes, every boss, potion, attachment and cosmetic</strong> &mdash; and answers in seconds. Stuck on a level? Planning a loadout? Just ask.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
      <tr><td align="right" style="padding:0 0 10px">
        <span style="display:inline-block;max-width:80%;padding:12px 16px;border-radius:14px 14px 4px 14px;background:#C0392B;font-family:${BODY};font-size:14px;line-height:20px;color:#FFFFFF;text-align:left">How do I beat a boss level?</span>
      </td></tr>
      <tr><td align="left">
        <span style="display:inline-block;max-width:85%;padding:12px 16px;border-radius:14px 14px 14px 4px;background:#16162A;border:1px solid #26263C;font-family:${BODY};font-size:14px;line-height:21px;color:#D4D4E0">Bosses are 3&times; normal size and switch between <strong style="color:#FFFFFF">Melee, Shooter and Phantom</strong> modes as their HP drops, so watch for the switch and adapt. Win and you're healed <strong style="color:#FFFFFF">+75 HP</strong>. 💪</span>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-family:${BODY};font-size:13px;line-height:20px;color:#6B6B80">Open the menu in ArcadeHub and tap <strong style="color:#A1A1B5">AI</strong> to try it.</p>`)}

  <!-- CTA -->
  <tr><td class="pad" align="center" style="padding:40px 36px 40px">${cta}</td></tr>

  <!-- Footer -->
  <tr><td class="pad" align="center" style="padding:24px 36px 30px;border-top:1px solid #1C1C28;text-align:center">
    <div style="font-family:${BODY};font-size:12px;line-height:19px;color:#6B6B80">ArcadeHub is made by <strong style="color:#818CF8">Nexus Connections</strong></div>
    <div style="font-family:${BODY};font-size:11px;line-height:18px;color:#4A4A5E;margin-top:6px">You're receiving this weekly update because you have an ArcadeHub account.</div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function runOnce({ usersCol, sendMail }) {
  try {
    const cutoff = new Date(Date.now() - WEEK_MS).toISOString();
    const users = await usersCol.find({
      email:         { $type: 'string', $ne: '' },
      emailVerified: true,
      banned:        { $ne: true },
      $or: [{ lastWeeklyEmailAt: { $exists: false } }, { lastWeeklyEmailAt: { $lt: cutoff } }],
    }, { projection: { username: 1, email: 1 } })
      .sort({ lastWeeklyEmailAt: 1 })
      .limit(DAILY_CAP)
      .toArray();

    let sent = 0;
    for (const u of users) {
      try {
        await sendMail(u.email, subject(), html(u.username));
        await usersCol.updateOne({ _id: u._id }, { $set: { lastWeeklyEmailAt: new Date().toISOString() } });
        sent++;
      } catch (err) {
        console.error(`[WEEKLY] Failed to email ${u.username}:`, err.message);
        // Sending limit hit, or the Gmail connection itself is broken: every other send
        // would fail too, so stop and retry on tomorrow's run.
        if (/429|quota|limit exceeded|rate limit|Gmail OAuth|not configured/i.test(err.message)) break;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    if (users.length) console.log(`[WEEKLY] Sent ${sent}/${users.length} weekly emails`);
  } catch (err) {
    console.error('[WEEKLY] Run failed:', err.message);
  }
}

function start(deps) {
  if (!APP_URL) console.warn('[WEEKLY] RAILWAY_PUBLIC_DOMAIN/PUBLIC_URL not set: weekly emails will have no link or images');
  setTimeout(() => runOnce(deps), 2 * 60 * 1000); // let the DB and mailer settle after boot
  setInterval(() => runOnce(deps), DAY_MS);
}

module.exports = { start, runOnce, subject, html, biomeOfTheWeek, highlights };
