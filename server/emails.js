'use strict';

// Shared look for every ArcadeHub email: synthwave banner, neon badge, big
// arcade heading, scoreboard-style code tiles and a Nexus Connections footer.
// Table-based with inline styles, since Gmail and Outlook strip most modern CSS.
// Artwork lives in /email and is served from the live site.

const APP_URL = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const HEAD = "'Bebas Neue',Impact,'Arial Narrow Bold','Helvetica Neue',Arial,sans-serif";
const BODY = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const CARD = '#0B0B14';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const p = (html, style = '') =>
  `<p style="margin:0 0 16px;font-family:${BODY};font-size:15px;line-height:24px;color:#A1A1B5;${style}">${html}</p>`;

const small = html =>
  `<p style="margin:0;font-family:${BODY};font-size:12px;line-height:19px;color:#62627A">${html}</p>`;

const strong = html => `<strong style="color:#F4F4F8">${html}</strong>`;

const divider = () =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:26px 0"><div style="border-top:1px solid #1E1E2E;font-size:0;line-height:0">&nbsp;</div></td></tr></table>`;

function button(label, href = APP_URL) {
  if (!href) return '';
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate">
  <tr><td align="center" bgcolor="#C0392B" style="border-radius:8px;background-color:#C0392B;background-image:linear-gradient(135deg,#E74C3C 0%,#B0281A 100%);box-shadow:0 0 22px rgba(231,76,60,0.45)">
    <a href="${href}" target="_blank" style="display:inline-block;padding:15px 40px;font-family:${HEAD};font-size:21px;line-height:24px;letter-spacing:4px;color:#FFFFFF;text-decoration:none">${label}&nbsp;&rarr;</a>
  </td></tr>
</table>`;
}

// Each character in its own glowing tile, like an arcade high-score display.
function codeTiles(code) {
  const tiles = String(code).split('').map(ch => `
    <td align="center" valign="middle" width="46" height="60" bgcolor="#140811" style="width:46px;height:60px;border:1.5px solid #FF4D3D;border-radius:10px;background:#140811;box-shadow:0 0 12px rgba(255,77,61,0.45),inset 0 0 10px rgba(255,77,61,0.18);font-family:${HEAD};font-size:36px;line-height:60px;color:#FFFFFF;text-shadow:0 0 10px rgba(255,120,110,0.8)">${esc(ch)}</td>`).join('');
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;border-spacing:6px 0">
  <tr>${tiles}</tr>
</table>
<p style="margin:14px 0 0;text-align:center;font-family:${BODY};font-size:12px;line-height:18px;color:#62627A">Code: <span style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:14px;letter-spacing:2px;color:#D4D4E0;user-select:all">${esc(code)}</span></p>`;
}

function renderEmail({ title, preheader, badge, eyebrow, heading, intro = '', body, footerNote }) {
  const banner = APP_URL
    ? `<img src="${APP_URL}/email/banner.jpg" width="600" alt="ArcadeHub" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:14px 14px 0 0;font-family:${HEAD};font-size:36px;letter-spacing:6px;color:#FFFFFF;background:#07060D">`
    : `<div style="padding:40px 0 30px;text-align:center;font-family:${HEAD};font-size:40px;letter-spacing:10px;color:#FFFFFF">ARCADE<span style="color:#FF4D3D">HUB</span></div>`;
  const badgeImg = badge && APP_URL
    ? `<img src="${APP_URL}/email/badge-${badge}.png" width="96" height="96" alt="" style="display:block;margin:-10px auto -6px;width:96px;height:96px;border:0">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  img { -ms-interpolation-mode:bicubic; }
  @media (max-width:620px) {
    .container { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .heading { font-size:38px !important; line-height:40px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#050508">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#050508;opacity:0">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(50)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050508" style="background:#050508">
<tr><td align="center" style="padding:28px 10px 40px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:600px;max-width:600px;background:${CARD};border:1px solid #22101A;border-radius:14px;border-collapse:separate;box-shadow:0 0 40px rgba(231,76,60,0.12)">
  <tr><td style="padding:0;font-size:0;line-height:0">${banner}</td></tr>
  <tr><td class="pad" align="center" style="padding:30px 40px 0;text-align:center">
    ${badgeImg}
    <div style="font-family:${BODY};font-size:11px;line-height:14px;font-weight:700;letter-spacing:4px;color:#FF4D3D;margin:10px 0 10px">${eyebrow}</div>
    <h1 class="heading" style="margin:0;font-family:${HEAD};font-weight:400;font-size:46px;line-height:46px;letter-spacing:2px;color:#FFFFFF">${heading}</h1>
    ${intro ? `<p style="margin:16px 0 0;font-family:${BODY};font-size:15px;line-height:24px;color:#A1A1B5">${intro}</p>` : ''}
  </td></tr>
  <tr><td class="pad" style="padding:28px 40px 36px">${body}</td></tr>
  <tr><td class="pad" align="center" style="padding:22px 40px 28px;border-top:1px solid #1E1E2E;text-align:center">
    <div style="font-family:${BODY};font-size:12px;line-height:19px;color:#6B6B80">ArcadeHub is made by <strong style="color:#818CF8">Nexus Connections</strong></div>
    ${footerNote ? `<div style="font-family:${BODY};font-size:11px;line-height:18px;color:#4A4A5E;margin-top:6px">${footerNote}</div>` : ''}
  </td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

// ── Code emails ───────────────────────────────────────────────
const CODE_EMAILS = {
  welcome: {
    badge: 'shield', eyebrow: 'PLAYER 1 HAS ENTERED',
    heading: u => `WELCOME TO THE ARENA, ${u}`,
    intro:   () => 'Thanks for signing up. Enter this code in ArcadeHub to verify your email and start playing.',
    expires: '24 hours',
    ignore:  "Didn't create an ArcadeHub account? You can safely ignore this email.",
  },
  resend: {
    badge: 'refresh', eyebrow: 'FRESH CODE, JUST DROPPED',
    heading: () => "HERE'S YOUR NEW CODE",
    intro:   u => `Hi ${u}, here's a brand-new verification code. Any code we sent you before no longer works.`,
    expires: '24 hours',
    ignore:  "Didn't ask for a new code? You can safely ignore this email.",
  },
  login: {
    badge: 'login', eyebrow: 'ONE LAST STEP',
    heading: () => 'VERIFY TO KEEP PLAYING',
    intro:   u => `Hi ${u}, verify your email to finish logging in. Your arena is waiting.`,
    expires: '24 hours',
    ignore:  "Wasn't you trying to log in? Nothing happens without this code, and you can ignore this email.",
  },
  change: {
    badge: 'mail', eyebrow: 'ACCOUNT SECURITY',
    heading: () => 'CONFIRM YOUR NEW EMAIL',
    intro:   (u, email) => `Enter this code in ArcadeHub to link ${strong(email)} to ${u ? `the account ${strong(u)}` : 'your account'}.`,
    expires: '24 hours',
    ignore:  "Didn't request this? You can safely ignore this email, and nothing on your account will change.",
  },
  reset: {
    badge: 'key', eyebrow: 'RESPAWN YOUR PASSWORD',
    heading: () => 'RESET YOUR PASSWORD',
    intro:   u => `Hi ${u}, use this code to set a new ArcadeHub password.`,
    expires: '15 minutes',
    ignore:  "Didn't ask for a reset? Your password hasn't changed, and you can safely ignore this email.",
  },
};

function codeEmail(kind, { username = '', code, email = '' }) {
  const t = CODE_EMAILS[kind];
  const u = esc(username), e = esc(email);
  const subject = kind === 'reset'
    ? `${code} is your ArcadeHub password reset code`
    : `${code} is your ArcadeHub verification code`;
  const html = renderEmail({
    title: subject,
    preheader: `Your code is ${code}. It expires in ${t.expires}.`,
    badge: t.badge,
    eyebrow: t.eyebrow,
    heading: t.heading(u.toUpperCase()),
    intro: t.intro(u, e),
    body: `
      ${codeTiles(code)}
      <p style="margin:18px 0 0;text-align:center;font-family:${BODY};font-size:13px;line-height:20px;color:#A1A1B5">&#9201;&nbsp; Expires in ${strong(t.expires)}</p>
      ${APP_URL ? `<div style="height:26px;line-height:26px;font-size:0">&nbsp;</div>${button('OPEN ARCADEHUB')}` : ''}
      ${divider()}
      ${small(`${t.ignore} Never share this code with anyone. ArcadeHub will never ask you for it.`)}`,
    footerNote: 'You received this because this email address was entered on ArcadeHub.',
  });
  return { subject, html };
}

module.exports = { APP_URL, HEAD, BODY, esc, p, small, strong, divider, button, codeTiles, renderEmail, codeEmail };
