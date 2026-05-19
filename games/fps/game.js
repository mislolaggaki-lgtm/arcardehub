// ============================================================
//  ArcadeHub FPS · game.js v2
//  Three.js r128  –  robots, 3 guns, jump, two-handed weapons
// ============================================================
'use strict';

// ─── DOM ─────────────────────────────────────────────────────
const canvas        = document.getElementById('gameCanvas');
const startScreen   = document.getElementById('start-screen');
const playBtn       = document.getElementById('play-button');
const hudEl         = document.getElementById('hud');
const healthFill    = document.getElementById('health-fill');
const healthText    = document.getElementById('health-text');
const ammoDisplay   = document.getElementById('ammo-display');
const gunNameEl     = document.getElementById('gun-name');
const killCountEl   = document.getElementById('kill-count');
const killFeedEl    = document.getElementById('kill-feed');
const levelDisplayEl= document.getElementById('level-display');
const enemyCountEl  = document.getElementById('enemy-count');
const scopeOverlay  = document.getElementById('scope-overlay');
const crosshairEl   = document.getElementById('crosshair');
const pvpBtnEl      = document.getElementById('pvp-btn');

// ─── Multiplayer state ────────────────────────────────────────
let socket       = null;
let moveInterval = null;
const remotePlayers  = new Map();   // socketId → { group, legL, legR, allMats, targetPos, targetRotY, walkClock, ... }
const _emoteBodyMap  = new Map();   // socketId → { em, elapsed, _pyOffset, _spinY, _isSpin, _restoreTimer }
let pvpMode      = true;

// ── Co-op state ──────────────────────────────────────────────
let coopMode     = false;
let coopIsHost   = false;
let coopHostId   = null;
const coopGuests     = new Set();
const coopGhostBots  = [];
let coopBotTimer     = 0;

// ── Bucks helper ─────────────────────────────────────────────
const _isLocal = ['localhost','127.0.0.1'].includes(window.location.hostname);
const _API_BASE = _isLocal ? 'http://localhost:3001' : window.location.origin;

function awardBucks(n) {
  let cur = parseInt(localStorage.getItem('ah_bucks') || '0', 10);
  cur += n;
  localStorage.setItem('ah_bucks', String(cur));
  const el = document.getElementById('hud-bucks-val');
  if (el) el.textContent = cur;
  const token = localStorage.getItem('ah_token');
  if (token) {
    fetch(_API_BASE + '/api/bucks/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: n }),
    }).then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.bucks !== undefined) {
        localStorage.setItem('ah_bucks', String(d.bucks));
        if (el) el.textContent = d.bucks;
      }
    }).catch(() => {});
  }
}

// ── Persistent stats (pre-declared so the init IIFE below can assign them) ──
let totalKills  = 0;
let totalDeaths = 0;
let playerBio   = '';

// Initialise HUD bucks + player stats — show cached value immediately, then sync from server
(function() {
  const el = document.getElementById('hud-bucks-val');
  if (el) el.textContent = localStorage.getItem('ah_bucks') || '0';
  // Load cached stats
  totalKills  = parseInt(localStorage.getItem('ah_kills')  || '0', 10);
  totalDeaths = parseInt(localStorage.getItem('ah_deaths') || '0', 10);
  playerBio   = localStorage.getItem('ah_bio') || '';

  const token = localStorage.getItem('ah_token');
  if (!token) return;
  fetch(_API_BASE + '/api/shop/profile', {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    localStorage.setItem('ah_bucks',   String(d.bucks));
    localStorage.setItem('ah_owned',   JSON.stringify(d.ownedItems   || []));
    localStorage.setItem('ah_equipped',JSON.stringify(d.equippedItems|| []));
    if (el) el.textContent = d.bucks;
  }).catch(() => {});

  // Fetch player stats (kills, deaths, bio)
  const username = localStorage.getItem('ah_username');
  if (!username) return;
  fetch(_API_BASE + '/api/profile/' + encodeURIComponent(username))
    .then(r => r.ok ? r.json() : null).then(p => {
      if (!p || p.error) return;
      totalKills  = p.kills  || 0;
      totalDeaths = p.deaths || 0;
      playerBio   = p.bio    || '';
      localStorage.setItem('ah_kills',  String(totalKills));
      localStorage.setItem('ah_deaths', String(totalDeaths));
      localStorage.setItem('ah_bio',    playerBio);
      updateRankHUD();
    }).catch(() => {});
})();

// ── Badge unlock helper ──────────────────────────────────────
const _earnedBadges = new Set(JSON.parse(localStorage.getItem('ah_badges') || '[]'));
const _BADGE_NAMES  = { besto_frendo:'MY BESTO FRENDO', pro_gamer:'PRO GAMER', unstoppable:'UNSTOPPABLE', veteran:'VETERAN' };
function unlockBadge(badgeId) {
  if (_earnedBadges.has(badgeId)) return;
  _earnedBadges.add(badgeId);
  localStorage.setItem('ah_badges', JSON.stringify([..._earnedBadges]));
  const token = localStorage.getItem('ah_token');
  if (token) {
    fetch(_API_BASE + '/api/badges/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ badgeId }),
    }).catch(() => {});
  }
  pushKillFeed(`🏅 Badge unlocked: ${_BADGE_NAMES[badgeId] || badgeId}`);
}

// ─── Mobile state ────────────────────────────────────────────
const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0 ||
                 window.matchMedia('(pointer: coarse)').matches;
let  mobileGameActive = false;
const touchMoveInput  = { x: 0, y: 0 };  // normalised joystick vector (-1…1)
let  touchFireHeld    = false;

// ─── Gun definitions ─────────────────────────────────────────
const GUN_DEFS = {
  pistol : { id:'pistol',  name:'PISTOL',  ammo:12,  reserve:84,  fireRate:0.48, damage:34,  spread:0.003, auto:false, kick:0.058 },
  smg    : { id:'smg',     name:'SMG',     ammo:30,  reserve:150, fireRate:0.082,damage:18,  spread:0.020, auto:true,  kick:0.022 },
  minigun: { id:'minigun', name:'MINIGUN', ammo:100, reserve:300, fireRate:0.046,damage:20,  spread:0.038, auto:true, spinUp:true, kick:0.010 },
  sniper : { id:'sniper',  name:'SNIPER',  ammo:1,   reserve:20,  fireRate:1.4,  damage:999, spread:0,     auto:false, oneShot:true, kick:0.130 },
};
let selectedGunId = 'pistol';

document.querySelectorAll('.gun-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.gun-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedGunId = card.dataset.gun;
  });
});

// Active gun runtime state
const gun = { def:null, ammo:0, reserve:0, shootTimer:0, canShoot:true };
let recoilZ = 0, recoilY = 0;

// ─── Extended animation state ──────────────────────────────────
let _weaponRaiseT  = 0;        // countdown 0.5→0: weapon slides up on spawn
let _reloadActive  = false;    // visual-only reload animation
let _reloadT       = 0;        // 0→1 during reload animation
let _swayX         = 0;        // smoothed lateral sway
let _swayY         = 0;        // smoothed vertical sway
let _headBobY      = 0;        // current head-bob camera offset (un-applied each frame before physics)
let _prevGrounded  = true;     // landing detection
let _landDipT      = 0;        // landing camera dip timer
let _crouchOffset  = 0;        // smoothed crouch camera offset
let _crouchTarget  = 0;        // desired crouch offset (0 = standing, -0.4 = crouched)
let _vignetteAlpha = 0;        // damage vignette opacity
let _hitConfirmT   = 0;        // crosshair hit-confirm flash timer

// Minigun spin state
let mgSpinSpeed = 0;    // current rad/s
let mgSpin      = 0;    // accumulated angle (for visual)
let barrelCluster = null;  // the rotating barrel group
const MG_MAX_SPIN = 28, MG_UP = 26, MG_DOWN = 12;

// ─── Settings system (loaded first so NORMAL_FOV and quality are available) ──
const FPS_SETTINGS_KEY = 'fps_settings';
function _loadSettings() {
  try { return JSON.parse(localStorage.getItem(FPS_SETTINGS_KEY) || '{}'); } catch { return {}; }
}
const _settings = _loadSettings();
const _quality  = _settings.quality || 'medium';

// ─── Renderer ────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled    = true;
renderer.shadowMap.type       = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.outputEncoding      = THREE.sRGBEncoding;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;

// ─── Scene ───────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080810);
scene.fog = new THREE.FogExp2(0x080810, 0.008);

// ─── Camera ──────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(_settings.fov || 72, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
const EYE_H = 1.65;
camera.position.set(0, EYE_H, 2);
scene.add(camera);  // must be in scene for camera-child weapon to render

// ─── Post-processing ─────────────────────────────────────────
const composer  = new THREE.EffectComposer(renderer);
composer.addPass(new THREE.RenderPass(scene, camera));

const bloomPass = new THREE.UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.30,   // strength
  0.40,   // radius
  0.80    // threshold
);
composer.addPass(bloomPass);

const fxaaPass  = new THREE.ShaderPass(THREE.FXAAShader);
const _PR = Math.min(window.devicePixelRatio, 1.5);
fxaaPass.material.uniforms['resolution'].value.set(
  1 / (window.innerWidth  * _PR),
  1 / (window.innerHeight * _PR)
);
composer.addPass(fxaaPass);

// Apply quality settings to renderer + bloom (using the already-loaded _settings)
if (_quality === 'low') {
  renderer.shadowMap.enabled = false;
  bloomPass.strength = 0.3;
} else if (_quality === 'high') {
  bloomPass.strength = 1.4;
  renderer.shadowMap.enabled = true;
}

// ─── Audio system ────────────────────────────────────────────
let _ac = null;
function getAC() {
  if (!_ac) { _ac = new (window.AudioContext || window.webkitAudioContext)(); }
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}
function _getVol(type) {
  const s = _loadSettings();
  const master = s.masterVolume ?? 0.8;
  const sfx    = s.sfxVolume    ?? 0.7;
  return master * sfx;
}

// ─── Scope / FOV state ───────────────────────────────────────
const NORMAL_FOV = _settings.fov || 72;
const SCOPE_FOV  = 15;
let targetFov    = NORMAL_FOV;
let scopeActive  = false;

// ─── Lights ──────────────────────────────────────────────────
const ambientLight = new THREE.AmbientLight(0x1a2040, 0.28);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff0dd, 0.80);
sun.position.set(8, 20, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(512, 512);
Object.assign(sun.shadow.camera, { near:1, far:200, left:-90, right:90, top:90, bottom:-90 });
scene.add(sun);

function mkPt(col, i, r, x, y, z) {
  const l = new THREE.PointLight(col, i, r); l.position.set(x,y,z); scene.add(l); return l;
}
// Store accent light refs so applyTheme() can recolour them each level
const accentLights = [
  mkPt(0xff2200, 2.4, 44, -15, 4, -15),
  mkPt(0x0044ff, 2.4, 44,  15, 4,  15),
  mkPt(0x00ff88, 1.8, 36,  15, 4, -15),
  mkPt(0xff9900, 1.8, 34, -15, 4,  15),
];

// ─── Shared materials (PBR) ──────────────────────────────────
const GLOVE  = new THREE.MeshStandardMaterial({ color:0x1e2814, roughness:0.88, metalness:0.05 });
const M_DARK = new THREE.MeshStandardMaterial({ color:0x181818, roughness:0.38, metalness:0.80 });
const M_MID  = new THREE.MeshStandardMaterial({ color:0x2e2e38, roughness:0.30, metalness:0.85 });
const M_LITE = new THREE.MeshStandardMaterial({ color:0x686878, roughness:0.18, metalness:0.92 });
const M_WOOD = new THREE.MeshStandardMaterial({ color:0x7a4020, roughness:0.94, metalness:0.00 });
const M_ORNG = new THREE.MeshStandardMaterial({ color:0xe06000, roughness:0.52, metalness:0.28, emissive:new THREE.Color(0x3a1800), emissiveIntensity:0.7 });
const M_YELO = new THREE.MeshBasicMaterial  ({ color:0xffee44 });

// ============================================================
//  ARENA
// ============================================================
const AW=40, AD=40, WH=9, WT=0.8;
const MEZZ_H     = 4.0;   // mezzanine floor surface height
const MEZZ_INNER = 33;    // inner edge of mezzanine (AW - 7)
// Staircase zones: x0/x1 = footprint width, zB = bottom (ground), zT = top (mezzanine)
const STAIR_DEFS = [
  { x0:24, x1:34,  zB:-27, zT:-33 },  // NE stair
  { x0:-34, x1:-24, zB:27,  zT:33  },  // SW stair
];
function getGroundY(pos) {
  for (const s of STAIR_DEFS) {
    const zLo = Math.min(s.zB, s.zT) - 1, zHi = Math.max(s.zB, s.zT) + 1;
    if (pos.x >= s.x0 && pos.x <= s.x1 && pos.z >= zLo && pos.z <= zHi) {
      const t = Math.max(0, Math.min(1, (pos.z - s.zB) / (s.zT - s.zB)));
      return t * MEZZ_H;
    }
  }
  if (Math.abs(pos.x) >= MEZZ_INNER || Math.abs(pos.z) >= MEZZ_INNER) return MEZZ_H;
  return 0;
}

function makeFloorTex(biomeId = 0) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const ctx = c.getContext('2d');

  if (biomeId === 0) {
    // Facility: dark concrete grid
    ctx.fillStyle='#060608'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='#0d0d14'; ctx.lineWidth=0.8;
    for(let i=0;i<=512;i+=32){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
    ctx.strokeStyle='#0e1220'; ctx.lineWidth=1.8;
    for(let i=0;i<=512;i+=128){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
    for(let x=128;x<512;x+=128) for(let y=128;y<512;y+=128){
      ctx.fillStyle='#0e0f1e'; ctx.fillRect(x-6,y-6,12,12);
      ctx.strokeStyle='#2233aa'; ctx.lineWidth=1;
      ctx.strokeRect(x-6,y-6,12,12);
    }
    ctx.strokeStyle='#111224'; ctx.lineWidth=0.5;
    for(let i=0;i<24;i++){
      const x=Math.random()*512, y=Math.random()*512;
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+18,y+6);ctx.stroke();
    }
  } else if (biomeId === 1) {
    // Ice Tundra: light blue with frost cracks
    ctx.fillStyle='#b8d8e8'; ctx.fillRect(0,0,512,512);
    // Subtle tile pattern
    ctx.strokeStyle='#cce4f0'; ctx.lineWidth=1;
    for(let i=0;i<=512;i+=64){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
    // Frost cracks: jagged white lines
    ctx.strokeStyle='rgba(220,240,255,0.85)'; ctx.lineWidth=1.2;
    for(let k=0;k<18;k++){
      let cx=Math.random()*512, cy=Math.random()*512;
      ctx.beginPath(); ctx.moveTo(cx,cy);
      for(let j=0;j<5;j++){
        cx+=(Math.random()-0.5)*60; cy+=(Math.random()-0.5)*60;
        ctx.lineTo(cx,cy);
      }
      ctx.stroke();
    }
  } else if (biomeId === 2) {
    // Lava Forge: dark grey with orange lava cracks
    ctx.fillStyle='#1a1008'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='#ff6600'; ctx.lineWidth=1.5;
    ctx.shadowColor='#ff4400'; ctx.shadowBlur=4;
    for(let k=0;k<14;k++){
      let cx=Math.random()*512, cy=Math.random()*512;
      ctx.beginPath(); ctx.moveTo(cx,cy);
      for(let j=0;j<6;j++){
        cx+=(Math.random()-0.5)*70; cy+=(Math.random()-0.5)*70;
        ctx.lineTo(cx,cy);
      }
      ctx.stroke();
    }
    ctx.shadowBlur=0;
  } else if (biomeId === 3) {
    // Neon Forest: dark with scattered leaf pattern
    ctx.fillStyle='#080e08'; ctx.fillRect(0,0,512,512);
    ctx.fillStyle='rgba(0,180,60,0.18)';
    for(let k=0;k<60;k++){
      const x=Math.random()*512, y=Math.random()*512;
      const r=3+Math.random()*6, a=Math.random()*Math.PI*2;
      ctx.save(); ctx.translate(x,y); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0,0,r,r*2.5,0,0,Math.PI*2);
      ctx.fill(); ctx.restore();
    }
    ctx.strokeStyle='rgba(0,200,80,0.1)'; ctx.lineWidth=0.6;
    for(let i=0;i<=512;i+=64){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
  } else if (biomeId === 4) {
    // Desert: sandy tan with ripple lines
    ctx.fillStyle='#c8a870'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(180,140,80,0.5)'; ctx.lineWidth=1;
    for(let i=0;i<512;i+=18){
      ctx.beginPath();
      ctx.moveTo(0, i+(Math.random()-0.5)*4);
      for(let x=0;x<=512;x+=32){
        ctx.lineTo(x, i+(Math.random()-0.5)*6);
      }
      ctx.stroke();
    }
  } else if (biomeId === 5) {
    // Cyber City: dark purple with neon grid
    ctx.fillStyle='#0a0010'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(180,0,255,0.25)'; ctx.lineWidth=0.8;
    for(let i=0;i<=512;i+=32){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
    ctx.strokeStyle='rgba(0,255,200,0.5)'; ctx.lineWidth=1.5;
    for(let i=0;i<=512;i+=128){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
  } else if (biomeId === 6) {
    // Space Station: black with tiny star dots
    ctx.fillStyle='#000005'; ctx.fillRect(0,0,512,512);
    ctx.fillStyle='rgba(255,255,255,0.7)';
    for(let k=0;k<120;k++){
      const x=Math.random()*512, y=Math.random()*512, r=0.5+Math.random()*1.5;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    }
    ctx.strokeStyle='rgba(100,120,140,0.15)'; ctx.lineWidth=0.5;
    for(let i=0;i<=512;i+=64){
      ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
    }
  } else if (biomeId === 7) {
    // Toxic Swamp: murky green with mud pools
    ctx.fillStyle='#081208'; ctx.fillRect(0,0,512,512);
    for(let k=0;k<22;k++){
      const x=Math.random()*512,y=Math.random()*512,r=14+Math.random()*26;
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,'rgba(28,48,8,0.65)'); g.addColorStop(1,'rgba(8,18,4,0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    }
    ctx.strokeStyle='rgba(80,180,30,0.10)'; ctx.lineWidth=0.6;
    for(let i=0;i<=512;i+=48){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 8) {
    // Haunted Crypt: dark stone with purple veins
    ctx.fillStyle='#100e18'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(130,90,200,0.22)'; ctx.lineWidth=1;
    for(let k=0;k<14;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<5;j++){cx+=(Math.random()-0.5)*80;cy+=(Math.random()-0.5)*80;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.strokeStyle='rgba(55,45,75,0.45)'; ctx.lineWidth=1.5;
    for(let i=0;i<=512;i+=64){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 9) {
    // Underwater Ruins: deep teal with wavy caustics
    ctx.fillStyle='#061c28'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(0,190,170,0.14)'; ctx.lineWidth=1;
    for(let y=0;y<512;y+=20){ctx.beginPath();ctx.moveTo(0,y);for(let x=0;x<=512;x+=16)ctx.lineTo(x,y+Math.sin(x*0.05)*6);ctx.stroke();}
    ctx.fillStyle='rgba(0,140,130,0.09)';
    for(let k=0;k<40;k++){ctx.beginPath();ctx.arc(Math.random()*512,Math.random()*512,2+Math.random()*5,0,Math.PI*2);ctx.fill();}
  } else if (biomeId === 10) {
    // Volcanic Ash: grey/black with faint red cracks and ash specks
    ctx.fillStyle='#181414'; ctx.fillRect(0,0,512,512);
    ctx.fillStyle='rgba(100,90,90,0.10)';
    for(let k=0;k<200;k++){ctx.beginPath();ctx.arc(Math.random()*512,Math.random()*512,0.5+Math.random()*1.5,0,Math.PI*2);ctx.fill();}
    ctx.strokeStyle='rgba(255,70,20,0.28)'; ctx.lineWidth=1; ctx.shadowColor='#ff3300'; ctx.shadowBlur=3;
    for(let k=0;k<10;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<4;j++){cx+=(Math.random()-0.5)*60;cy+=(Math.random()-0.5)*60;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.shadowBlur=0;
  } else if (biomeId === 11) {
    // Blood Moon: dark crimson with fracture lines
    ctx.fillStyle='#180408'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(195,18,38,0.28)'; ctx.lineWidth=1;
    for(let k=0;k<16;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<6;j++){cx+=(Math.random()-0.5)*55;cy+=(Math.random()-0.5)*55;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.strokeStyle='rgba(90,8,18,0.40)'; ctx.lineWidth=2;
    for(let i=0;i<=512;i+=96){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 12) {
    // Crystal Cave: dark with glimmering geometric facets
    ctx.fillStyle='#0c0418'; ctx.fillRect(0,0,512,512);
    for(let k=0;k<55;k++){
      const x=Math.random()*512,y=Math.random()*512,s=4+Math.random()*14,a=Math.random()*Math.PI;
      ctx.save();ctx.translate(x,y);ctx.rotate(a);
      const ri=Math.floor(Math.random()*3);
      ctx.strokeStyle=ri===0?'rgba(180,100,255,0.30)':ri===1?'rgba(140,80,220,0.22)':'rgba(220,160,255,0.18)';
      ctx.lineWidth=0.8;
      ctx.beginPath();ctx.moveTo(0,-s);ctx.lineTo(s*0.6,0);ctx.lineTo(0,s);ctx.lineTo(-s*0.6,0);ctx.closePath();ctx.stroke();
      ctx.restore();
    }
  } else if (biomeId === 13) {
    // Biomech Core: organic tissue-like veins
    ctx.fillStyle='#140608'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(195,38,58,0.16)'; ctx.lineWidth=1;
    for(let k=0;k<22;k++){let x=Math.random()*512,y=Math.random()*512;ctx.beginPath();ctx.moveTo(x,y);for(let j=0;j<10;j++){x+=(Math.random()-0.5)*38;y+=(Math.random()-0.5)*24;ctx.lineTo(x,y);}ctx.stroke();}
    ctx.strokeStyle='rgba(170,28,48,0.11)'; ctx.lineWidth=0.8;
    for(let k=0;k<30;k++){const x=Math.random()*512,y=Math.random()*512,r=6+Math.random()*18;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();}
  } else if (biomeId === 14) {
    // Storm Vault: dark with electric vein pattern
    ctx.fillStyle='#0a0e16'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(90,165,255,0.20)'; ctx.lineWidth=1;
    for(let k=0;k<14;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<7;j++){cx+=(Math.random()-0.5)*50;cy+=(Math.random()-0.5)*50;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.strokeStyle='rgba(55,100,170,0.24)'; ctx.lineWidth=2;
    for(let i=0;i<=512;i+=80){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 15) {
    // Deep Trench: near-black with bioluminescent glow patches
    ctx.fillStyle='#010508'; ctx.fillRect(0,0,512,512);
    for(let k=0;k<65;k++){
      const x=Math.random()*512,y=Math.random()*512,r=2+Math.random()*10;
      const c2=ctx.createRadialGradient(x,y,0,x,y,r);
      const a=k%3===0?'rgba(0,255,195,0.13)':k%3===1?'rgba(0,210,175,0.09)':'rgba(0,175,215,0.11)';
      c2.addColorStop(0,a);c2.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=c2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
  } else if (biomeId === 16) {
    // Poison Jungle: dark with toxic vein drips and moss
    ctx.fillStyle='#060e04'; ctx.fillRect(0,0,512,512);
    ctx.fillStyle='rgba(36,112,18,0.14)';
    for(let k=0;k<32;k++){const x=Math.random()*512,y=Math.random()*512,r=8+Math.random()*20;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
    ctx.strokeStyle='rgba(110,245,0,0.11)'; ctx.lineWidth=1;
    for(let k=0;k<10;k++){let cx=Math.random()*512,cy=0;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<8;j++){cx+=(Math.random()-0.5)*20;cy+=Math.random()*60;ctx.lineTo(cx,cy);}ctx.stroke();}
  } else if (biomeId === 17) {
    // Acid Wastes: burnt yellow with glowing acid pools
    ctx.fillStyle='#101200'; ctx.fillRect(0,0,512,512);
    for(let k=0;k<28;k++){
      const x=Math.random()*512,y=Math.random()*512,r=10+Math.random()*24;
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,'rgba(195,215,0,0.22)');g.addColorStop(1,'rgba(70,90,0,0)');
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
    ctx.strokeStyle='rgba(155,175,0,0.16)'; ctx.lineWidth=0.8;
    for(let i=0;i<=512;i+=48){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 18) {
    // Midnight Rain: dark wet tiles with puddle reflections
    ctx.fillStyle='#040810'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(75,115,175,0.11)'; ctx.lineWidth=0.8;
    for(let i=0;i<=512;i+=40){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    for(let k=0;k<18;k++){
      const x=Math.random()*512,y=Math.random()*512,r=12+Math.random()*22;
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,'rgba(75,115,195,0.14)');g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
  } else if (biomeId === 19) {
    // Ancient Temple: worn stone tiles with gold inlay
    ctx.fillStyle='#1a1608'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(58,48,18,0.60)'; ctx.lineWidth=2;
    for(let i=0;i<=512;i+=80){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.strokeStyle='rgba(195,155,48,0.28)'; ctx.lineWidth=1;
    for(let x=0;x<512;x+=80)for(let y=0;y<512;y+=80)ctx.strokeRect(x+4,y+4,72,72);
    ctx.strokeStyle='rgba(95,85,55,0.18)'; ctx.lineWidth=0.7;
    for(let k=0;k<12;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<4;j++){cx+=(Math.random()-0.5)*60;cy+=(Math.random()-0.5)*40;ctx.lineTo(cx,cy);}ctx.stroke();}
  } else if (biomeId === 20) {
    // Infernal Pit: scorched black with deep orange cracks
    ctx.fillStyle='#130300'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='#ff4400'; ctx.lineWidth=1.8; ctx.shadowColor='#ff2200'; ctx.shadowBlur=6;
    for(let k=0;k<18;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<5;j++){cx+=(Math.random()-0.5)*65;cy+=(Math.random()-0.5)*65;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(78,18,0,0.50)'; ctx.lineWidth=3;
    for(let i=0;i<=512;i+=128){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 21) {
    // Frozen Void: near-black with icy fractures and hex frost
    ctx.fillStyle='#010810'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(95,175,238,0.20)'; ctx.lineWidth=1;
    for(let k=0;k<22;k++){let cx=Math.random()*512,cy=Math.random()*512;ctx.beginPath();ctx.moveTo(cx,cy);for(let j=0;j<5;j++){cx+=(Math.random()-0.5)*70;cy+=(Math.random()-0.5)*70;ctx.lineTo(cx,cy);}ctx.stroke();}
    ctx.strokeStyle='rgba(175,215,255,0.07)'; ctx.lineWidth=0.6;
    for(let x=0;x<512;x+=44)for(let y=0;y<512;y+=50){ctx.beginPath();for(let j=0;j<6;j++)ctx.lineTo(x+22+22*Math.cos(j*Math.PI/3),y+25+22*Math.sin(j*Math.PI/3));ctx.closePath();ctx.stroke();}
  } else if (biomeId === 22) {
    // Neon Arena: dark with hot-pink grid and scanlines
    ctx.fillStyle='#090009'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(255,0,195,0.28)'; ctx.lineWidth=0.8;
    for(let i=0;i<=512;i+=32){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.strokeStyle='rgba(0,250,235,0.48)'; ctx.lineWidth=1.5;
    for(let i=0;i<=512;i+=128){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.strokeStyle='rgba(255,0,175,0.05)'; ctx.lineWidth=2;
    for(let i=0;i<512;i+=4){ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
  } else if (biomeId === 23) {
    // Dark Nebula: black with coloured nebula smears and star dots
    ctx.fillStyle='#030008'; ctx.fillRect(0,0,512,512);
    const nebC=['rgba(155,38,255,0.08)','rgba(75,0,175,0.06)','rgba(195,78,255,0.05)'];
    for(let k=0;k<22;k++){
      const x=Math.random()*512,y=Math.random()*512,rx=30+Math.random()*80,ry=20+Math.random()*60;
      const mx=Math.max(rx,ry);
      const g=ctx.createRadialGradient(x,y,0,x,y,mx);
      g.addColorStop(0,nebC[k%3]);g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g;ctx.save();ctx.translate(x,y);ctx.scale(rx/mx,ry/mx);ctx.translate(-x,-y);
      ctx.beginPath();ctx.arc(x,y,mx,0,Math.PI*2);ctx.fill();ctx.restore();
    }
    ctx.fillStyle='rgba(255,255,255,0.5)';
    for(let k=0;k<85;k++){ctx.beginPath();ctx.arc(Math.random()*512,Math.random()*512,0.5+Math.random(),0,Math.PI*2);ctx.fill();}
  } else if (biomeId === 24) {
    // Radiation Zone: green concrete with hazard triangles
    ctx.fillStyle='#080e00'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(95,175,0,0.18)'; ctx.lineWidth=1;
    for(let i=0;i<=512;i+=40){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.strokeStyle='rgba(145,215,0,0.18)'; ctx.lineWidth=1.5;
    for(let k=0;k<14;k++){const x=Math.random()*480+16,y=Math.random()*480+16,s=10+Math.random()*16;ctx.beginPath();ctx.moveTo(x,y-s);ctx.lineTo(x+s*0.87,y+s*0.5);ctx.lineTo(x-s*0.87,y+s*0.5);ctx.closePath();ctx.stroke();}
  } else if (biomeId === 25) {
    // Burning Cathedral: dark stone blocks with ember glow patches
    ctx.fillStyle='#0e0804'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(58,38,18,0.60)'; ctx.lineWidth=2;
    for(let i=0;i<=512;i+=80){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    for(let k=0;k<18;k++){
      const x=Math.random()*512,y=Math.random()*512,r=5+Math.random()*14;
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,'rgba(255,115,0,0.16)');g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
  } else if (biomeId === 26) {
    // Nano Grid: teal micro circuit board
    ctx.fillStyle='#020c0c'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle='rgba(0,215,195,0.22)'; ctx.lineWidth=0.7;
    for(let i=0;i<=512;i+=16){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.strokeStyle='rgba(0,250,225,0.48)'; ctx.lineWidth=1.5;
    for(let i=0;i<=512;i+=64){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    ctx.fillStyle='rgba(0,250,215,0.38)';
    for(let k=0;k<40;k++){const x=Math.round(Math.random()*8)*64,y=Math.round(Math.random()*8)*64;ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();}
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(36,36);
  return tex;
}

// Cache floor textures by biomeId (built on demand)
const _floorTexCache = {};

const ARENA_M = {
  floor  : new THREE.MeshStandardMaterial({ map:makeFloorTex(), roughness:0.88, metalness:0.08 }),
  ceil   : new THREE.MeshStandardMaterial({ color:0x030306,  roughness:1.00, metalness:0.00 }),
  wall   : new THREE.MeshStandardMaterial({ color:0x10182a,  roughness:0.78, metalness:0.22 }),
  trim   : new THREE.MeshStandardMaterial({ color:0x1a3a70,  emissive:new THREE.Color(0x1a3a90), emissiveIntensity:1.0, roughness:0.18, metalness:0.88 }),
  pillar : new THREE.MeshStandardMaterial({ color:0x18243a,  roughness:0.62, metalness:0.38 }),
  cover  : new THREE.MeshStandardMaterial({ color:0x1a0c0c,  roughness:0.80, metalness:0.18 }),
  ctrim  : new THREE.MeshStandardMaterial({ color:0x3e1010,  emissive:new THREE.Color(0x660e00), emissiveIntensity:0.8, roughness:0.20, metalness:0.78 }),
  clight : new THREE.MeshBasicMaterial  ({ color:0xccddff }),
};

function addBox(w,h,d,x,y,z,mat,cast=true,recv=true){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  m.position.set(x,y,z); m.castShadow=cast; m.receiveShadow=recv; scene.add(m); return m;
}

// Floor / ceiling
addBox(AW*2,.2,AD*2, 0,-0.1,0, ARENA_M.floor,false,true);
addBox(AW*2,.2,AD*2, 0,WH+.1,0, ARENA_M.ceil,false,false);

// Outer walls
addBox(AW*2+WT*2,WH,WT, 0,WH/2,-(AD+WT/2), ARENA_M.wall);
addBox(AW*2+WT*2,WH,WT, 0,WH/2,  AD+WT/2,  ARENA_M.wall);
addBox(WT,WH,AD*2, -(AW+WT/2),WH/2,0, ARENA_M.wall);
addBox(WT,WH,AD*2,   AW+WT/2, WH/2,0, ARENA_M.wall);

// Wall trim bands at two heights on all 4 walls
const TRIM_H = [0.9, WH-0.45];
TRIM_H.forEach(ty => {
  const t = 0.13;
  addBox(AW*2+WT*2,t,WT+.02, 0,ty,-(AD+WT/2), ARENA_M.trim,false,false);
  addBox(AW*2+WT*2,t,WT+.02, 0,ty,  AD+WT/2,  ARENA_M.trim,false,false);
  addBox(WT+.02,t,AD*2, -(AW+WT/2),ty,0, ARENA_M.trim,false,false);
  addBox(WT+.02,t,AD*2,   AW+WT/2, ty,0, ARENA_M.trim,false,false);
});

// Corner + mid-wall pillars
[[-AW,-AD],[AW,-AD],[-AW,AD],[AW,AD],[0,-AD],[0,AD],[-AW,0],[AW,0]].forEach(([px,pz])=>{
  addBox(.65,WH,.65, px,WH/2,pz, ARENA_M.pillar);
  addBox(.78,.14,.78, px,WH-.07,pz, ARENA_M.trim,false,false);
  addBox(.78,.14,.78, px,.07,pz, ARENA_M.trim,false,false);
});

// Ceiling light fixtures + point lights (spread over larger arena)
[[-20,-20],[20,-20],[-20,20],[20,20],[0,0],
 [0,-30],[0,30],[-30,0],[30,0],
 [-10,-10],[10,-10],[-10,10],[10,10]].forEach(([lx,lz])=>{
  addBox(4,.09,.3, lx,WH-.04,lz, ARENA_M.clight,false,false);
  const pl=new THREE.PointLight(0xaaccff,1.4,28); pl.position.set(lx,WH-.8,lz); scene.add(pl);
});

// Neon floor-edge strips along all 4 walls
const neonEdgeMat = new THREE.MeshBasicMaterial({ color:0x002db3 });
addBox(AW*2+WT*2,.03,.04, 0,.015,-(AD+WT/2), neonEdgeMat,false,false);
addBox(AW*2+WT*2,.03,.04, 0,.015,  AD+WT/2,  neonEdgeMat,false,false);
addBox(.04,.03,AD*2, -(AW+WT/2),.015,0, neonEdgeMat,false,false);
addBox(.04,.03,AD*2,   AW+WT/2, .015,0, neonEdgeMat,false,false);

// Ground-floor cover walls — randomised each level via _buildDynamicCovers(seed)
const coverBoxes = [];
let _dynamicCoverMeshes = [];

// Static collision entries for permanent scene objects (central platform + pillars)
const _STATIC_COVER_BOXES = [
  {cx:0,   cz:0,   hw:4.5, hd:4.5},
  {cx:10,  cz:-18, hw:.65, hd:.65},
  {cx:-10, cz:18,  hw:.65, hd:.65},
  {cx:20,  cz:-6,  hw:.65, hd:.65},
  {cx:-20, cz:6,   hw:.65, hd:.65},
  {cx:18,  cz:12,  hw:.65, hd:.65},
  {cx:-18, cz:-12, hw:.65, hd:.65},
];

function _seededRng(seed) {
  let s = (seed ^ 0xa3c59f1b) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function _buildDynamicCovers(seed) {
  _dynamicCoverMeshes.forEach(m => { scene.remove(m); m.geometry?.dispose(); });
  _dynamicCoverMeshes = [];
  coverBoxes.length = 0;
  _STATIC_COVER_BOXES.forEach(b => coverBoxes.push({...b}));

  const rng = _seededRng(seed);

  function _addCover(w, h, d, cx, cz) {
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), ARENA_M.cover);
    m1.position.set(cx, h/2, cz); m1.castShadow = true; m1.receiveShadow = true;
    scene.add(m1);
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(w+.04,.12,d+.04), ARENA_M.ctrim);
    m2.position.set(cx, h+.06, cz); scene.add(m2);
    _dynamicCoverMeshes.push(m1, m2);
    coverBoxes.push({cx, cz, hw:w/2, hd:d/2});
  }

  const total = 24 + Math.floor(rng() * 9);
  let placed = 0, tries = 0;
  while (placed < total && tries < total * 8) {
    tries++;
    const horiz = rng() > 0.5;
    const len = 4 + Math.floor(rng() * 8);
    const w = horiz ? len : 1.2, d = horiz ? 1.2 : len;
    const h = rng() > 0.22 ? WH * 0.72 : 0.8;
    const margin = Math.max(w, d) / 2 + 1.5;
    const cx = (rng() - 0.5) * 2 * (AW - margin - 3);
    const cz = (rng() - 0.5) * 2 * (AD - margin - 3);
    if (Math.abs(cx) < 6 && Math.abs(cz) < 6) continue;
    _addCover(w, h, d, cx, cz);
    placed++;
  }
  // 4 L-shaped clusters for variety
  for (let i = 0; i < 4; i++) {
    const bx = (rng() - 0.5) * 2 * (AW - 12);
    const bz = (rng() - 0.5) * 2 * (AD - 12);
    if (Math.abs(bx) < 6 && Math.abs(bz) < 6) continue;
    _addCover(6, WH * 0.72, 1.2, bx, bz);
    _addCover(1.2, WH * 0.72, 5, bx + 3.5, bz + 3.1);
  }
}

// Central raised platform — permanent landmark
addBox(9, .45, 9,  0, .225, 0, ARENA_M.pillar, false, true);
addBox(9.1,.06,9.1, 0, .47, 0, ARENA_M.ctrim, false, false);
[[9,.9, 0,-4.2],[9,.9, 0, 4.2],[.9,9,-4.2,0],[.9,9, 4.2,0]].forEach(
  ([w,d,x,z])=>addBox(w,WH*.36,d,x,.225+WH*.18,z,ARENA_M.cover)
);

// Standalone cylindrical pillars — permanent
[[10,-18],[-10,18],[20,-6],[-20,6],[18,12],[-18,-12]].forEach(([px,pz])=>{
  const m=new THREE.Mesh(new THREE.CylinderGeometry(.55,.55,WH*.75,10),ARENA_M.pillar);
  m.position.set(px,WH*.375,pz); m.castShadow=true; scene.add(m);
});

// ── MEZZANINE (second floor) ─────────────────────────────────
// AW=40, AD=40, MEZZ_INNER=33 → platforms are 7 units deep around the perimeter
const mezzFloorMat = new THREE.MeshStandardMaterial({ map:makeFloorTex(), roughness:0.85, metalness:0.10 });
const mezzFT = 0.4;           // slab thickness
const mezzCY = MEZZ_H - mezzFT/2;  // slab centre Y = 3.8

// North slab — leaves stair-A gap (x:24–34). Two boxes: left (-40→24) and right (34→40)
addBox(64, mezzFT, 7,  -8, mezzCY, -36.5, mezzFloorMat, false, true);  // x:-40→24, z:-40→-33
addBox( 6, mezzFT, 7,  37, mezzCY, -36.5, mezzFloorMat, false, true);  // x:34→40
// South slab — leaves stair-B gap (x:-34–-24)
addBox( 6, mezzFT, 7, -37, mezzCY,  36.5, mezzFloorMat, false, true);  // x:-40→-34
addBox(64, mezzFT, 7,   8, mezzCY,  36.5, mezzFloorMat, false, true);  // x:-24→40
// West slab (full z between inner edges)
addBox(7, mezzFT, 66, -36.5, mezzCY, 0, mezzFloorMat, false, true);    // x:-40→-33, z:-33→33
// East slab
addBox(7, mezzFT, 66,  36.5, mezzCY, 0, mezzFloorMat, false, true);    // x:33→40, z:-33→33

// Support pillars under mezzanine
[[-37,-37],[37,-37],[-37,37],[37,37],[-37,0],[37,0],[0,-37],[0,37]].forEach(([sx,sz])=>{
  addBox(.8, MEZZ_H, .8, sx, MEZZ_H/2, sz, ARENA_M.pillar);
});

// Inner railings — N/S have gaps for stairs; W/E are solid
const railH=1.0, railY=MEZZ_H+0.5, railT=0.22;
// North — left of stair A gap (x:-40→24, width=64, cx=-8)
addBox(64, railH, railT,  -8, railY, -33, ARENA_M.pillar, false, false);
// North — right of stair A gap (x:34→40, width=6, cx=37)
addBox( 6, railH, railT,  37, railY, -33, ARENA_M.pillar, false, false);
// South — left of stair B gap (x:-40→-34, width=6, cx=-37)
addBox( 6, railH, railT, -37, railY,  33, ARENA_M.pillar, false, false);
// South — right of stair B gap (x:-24→40, width=64, cx=8)
addBox(64, railH, railT,   8, railY,  33, ARENA_M.pillar, false, false);
// West and East — full inner edge
addBox(railT, railH, 66, -33, railY, 0, ARENA_M.pillar, false, false);
addBox(railT, railH, 66,  33, railY, 0, ARENA_M.pillar, false, false);

// Mezzanine neon strips along inner edge
const mezzNeon = new THREE.MeshBasicMaterial({ color:0x0044cc });
addBox(80, .025, .025,  0, MEZZ_H+.01, -33, mezzNeon, false, false);
addBox(80, .025, .025,  0, MEZZ_H+.01,  33, mezzNeon, false, false);
addBox(.025, .025, 66, -33, MEZZ_H+.01,  0, mezzNeon, false, false);
addBox(.025, .025, 66,  33, MEZZ_H+.01,  0, mezzNeon, false, false);

// Second-floor point lights
[[0,-37],[0,37],[-37,0],[37,0],[-20,-20],[20,20],[-20,20],[20,-20]].forEach(([lx,lz])=>{
  const pl2=new THREE.PointLight(0xbbccff, 1.2, 22);
  pl2.position.set(lx, MEZZ_H+2.5, lz); scene.add(pl2);
});

// ── STAIRCASES ───────────────────────────────────────────────
// Stair A: NE corner — x:24–34, z: −27 to −33 (10 steps, 0.4h × 0.6d)
for(let i=0;i<10;i++){
  const h=(i+1)*0.4;
  addBox(10, h, 0.6, 29, h/2, -27-(i+0.5)*0.6, mezzFloorMat, false, true);
}
// Stair B: SW corner — x:−34 to −24, z: 27 to 33
for(let i=0;i<10;i++){
  const h=(i+1)*0.4;
  addBox(10, h, 0.6, -29, h/2, 27+(i+0.5)*0.6, mezzFloorMat, false, true);
}

// Second-floor crates / cover on mezzanine
const cov2 = ARENA_M.cover;
const ch2 = 1.4;
[
  [4,1.2, -37,-18],[4,1.2,  37, 18],
  [1.2,4,  37,-18],[1.2,4, -37, 18],
  [4,1.2, -37,  0],[4,1.2,  37,  0],
  [1.2,3,   0,-37],[1.2,3,   0, 37],
].forEach(([w,d,cx,cz])=>{
  addBox(w,ch2,d, cx,MEZZ_H+ch2/2,cz, cov2);
  addBox(w+.04,.10,d+.04, cx,MEZZ_H+ch2+.05,cz, ARENA_M.ctrim,false,false);
  coverBoxes.push({cx,cz,hw:w/2,hd:d/2, minY:MEZZ_H, maxY:MEZZ_H+ch2+0.5});
});

// Decorative tech panels on walls
[[0,WH/2,-(AD+.01), 6,.6,1],[0,WH/2,AD+.01, 6,.6,1],
 [-(AW+.01),WH/2,0, 1,.6,6],[AW+.01,WH/2,0, 1,.6,6]].forEach(([x,y,z,w,h,d])=>{
  addBox(w,h,d,x,y,z, new THREE.MeshLambertMaterial({color:0x0a0a1e}),false,false);
});

// ── Environmental props ──────────────────────────────────────
const CRATE_MAT  = new THREE.MeshStandardMaterial({ color:0x4a3010, roughness:0.9, metalness:0.05 });
const CRATE_TRIM = new THREE.MeshStandardMaterial({ color:0x7a5020, emissive:new THREE.Color(0x2a1a08), emissiveIntensity:0.3, roughness:0.5, metalness:0.4 });
const BARREL_MAT = new THREE.MeshStandardMaterial({ color:0x222244, roughness:0.55, metalness:0.7 });
const BARREL_RNG = new THREE.MeshStandardMaterial({ color:0xff6600, emissive:new THREE.Color(0xff3300), emissiveIntensity:0.6, roughness:0.3, metalness:0.6 });

function addCrateStack(x, z, count) {
  for (let i = 0; i < count; i++) {
    const s = 0.88 - i * 0.04;
    addBox(s, s, s, x + (Math.random()-.5)*0.1, s/2 + i*s*0.98, z + (Math.random()-.5)*0.1, CRATE_MAT);
    // corner trim strips
    [[s/2,0,0],[-(s/2),0,0],[0,0,s/2],[0,0,-(s/2)]].forEach(([ox,oy,oz])=>{
      addBox(0.06,s,0.06, x+ox, s/2+i*s*0.98, z+oz, CRATE_TRIM, false, false);
    });
  }
}

function addBarrel(x, z, glowing) {
  const mat = glowing ? BARREL_RNG : BARREL_MAT;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.26, 0.9, 12), mat);
  body.position.set(x, 0.45, z); body.castShadow = true; scene.add(body);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), BARREL_MAT);
  lid.position.set(x, 0.92, z); scene.add(lid);
  if (glowing) {
    const glow = new THREE.PointLight(0xff3300, 1.2, 4);
    glow.position.set(x, 1.2, z); scene.add(glow);
  }
}

// Crate stacks at strategic positions
[[12,-8,2],[-12,8,2],[-8,-16,3],[8,16,3],[20,-20,2],[-20,20,2],
 [-24,0,2],[24,0,2],[0,-24,1],[0,24,1]].forEach(([x,z,n])=> addCrateStack(x,z,n));

// Barrels — mix of normal and glowing hazard barrels
[[-15,5,false],[15,-5,false],[-5,-22,true],[5,22,true],[22,14,false],
 [-22,-14,false],[30,-12,false],[-30,12,true],[18,-32,false],[-18,32,false]
].forEach(([x,z,g]) => addBarrel(x,z,g));

// Overhead colored accent spotlights for atmosphere
[
  [0xff0022,  8, 12], [0x0022ff, -8,-12],
  [0x00ff88, 12, -8], [0xff8800,-12,  8],
  [0xaa00ff, 22, 22], [0x00aaff,-22,-22],
].forEach(([col,x,z]) => {
  const sl = new THREE.PointLight(col, 0.8, 18);
  sl.position.set(x, WH-1, z); scene.add(sl);
});

// ============================================================
//  PLAYER STATE
// ============================================================
const SPAWN = new THREE.Vector3(0, EYE_H, 2);
const P_SPEED = 9, P_RADIUS = 0.45;
const GRAVITY = -22, JUMP_VEL = 8.5;

const player = {
  health:100, maxHealth:100, kills:0, deaths:0,
  dead:false, hurtTimer:0,
};

// ── Rank system ───────────────────────────────────────────────
const RANKS = [
  { name:'Bronze',  min:    0, color:'#cd7f32', glow:'rgba(205,127,50,0.35)'  },
  { name:'Silver',  min:  100, color:'#c0c0c0', glow:'rgba(192,192,192,0.35)' },
  { name:'Gold',    min:  500, color:'#ffd700', glow:'rgba(255,215,0,0.35)'   },
  { name:'Diamond', min: 2000, color:'#88eeff', glow:'rgba(136,238,255,0.4)'  },
];
function getRank(kills) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (kills >= RANKS[i].min) return RANKS[i];
  }
  return RANKS[0];
}

// ── Game mode ─────────────────────────────────────────────────
let gameMode  = 'solo';  // 'solo' | 'ffa' | 'tdm'
let myTeam    = null;    // 'red' | 'blue' for TDM
let tdmScores = { red: 0, blue: 0 };
let ffaBoard  = [];

// ── Static electricity particles (replaces blood) ─────────────
const bloodParticles = [];  // reused array name for hit-spark particles
const BLOOD_MAT = new THREE.MeshBasicMaterial({ color: 0x44aaff }); // blue/electric

// Static death particles
const staticParticles = [];
const STATIC_COLORS = [0x44aaff, 0x88ddff, 0xffffff, 0x0066ff];

// Shell casings
const shellCasings = [];
const SHELL_MAT = new THREE.MeshStandardMaterial({ color:0xc8a215, metalness:0.95, roughness:0.05 });

// Bullet impact particles
const impactParticles = [];
const DUST_MAT = new THREE.MeshBasicMaterial({ color:0xaaaaaa, transparent:true, opacity:0.7 });

camera.position.copy(SPAWN);
let yaw=0, pitch=0;
let velY=0, grounded=true;

const viewDir=new THREE.Vector3(), rightDir=new THREE.Vector3(), moveVec=new THREE.Vector3();

// ============================================================
//  WEAPON VIEWMODEL  (children of camera → moves with view)
// ============================================================
const weaponRoot = new THREE.Group();
camera.add(weaponRoot);

let bobClock=0, muzzleTimer=0;
const muzzleLight = new THREE.PointLight(0xffaa00, 0, 3);
muzzleLight.position.set(0,.04,-.7);
weaponRoot.add(muzzleLight);

// Build a gloved hand+forearm group.
// isRight: thumb side matches the hand
function makeHand(isRight) {
  const g = new THREE.Group();
  const s = isRight ? 1 : -1;
  // Palm
  const palm = new THREE.Mesh(new THREE.BoxGeometry(.10,.095,.13), GLOVE);
  g.add(palm);
  // Thumb nub
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(.04,.055,.04), GLOVE);
  thumb.position.set(s*.072,.018,.028); g.add(thumb);
  // Finger row (implied as a flat box below palm)
  const fingers = new THREE.Mesh(new THREE.BoxGeometry(.092,.065,.05), GLOVE);
  fingers.position.set(0,-.075,-.058); g.add(fingers);
  // Forearm (disappears downward off screen)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(.092,.32,.096), GLOVE);
  arm.position.y = -.215; g.add(arm);
  return g;
}

// ── Pistol viewmodel ─────────────────────────────────────────
function buildPistol(root) {
  root.position.set(.16,-.30,-.46);

  // Slide / receiver
  const slide = new THREE.Mesh(new THREE.BoxGeometry(.064,.088,.28), M_DARK);
  slide.position.set(0,.012,-.04); root.add(slide);
  // Ejection port cutout (slightly lighter face)
  const eject = new THREE.Mesh(new THREE.BoxGeometry(.012,.04,.08), M_MID);
  eject.position.set(.034,.02,-.02); root.add(eject);
  // Barrel (round)
  const brl = new THREE.Mesh(new THREE.CylinderGeometry(.013,.013,.16,10), M_MID);
  brl.rotation.x=Math.PI/2; brl.position.set(0,.02,-.22); root.add(brl);
  // Muzzle (slightly flared)
  const muz = new THREE.Mesh(new THREE.CylinderGeometry(.016,.013,.022,10), M_LITE);
  muz.rotation.x=Math.PI/2; muz.position.set(0,.02,-.30); root.add(muz);
  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(.054,.13,.068), M_WOOD);
  grip.position.set(0,-.068,.06); grip.rotation.x=.22; root.add(grip);
  // Trigger guard
  const tg = new THREE.Mesh(new THREE.BoxGeometry(.005,.036,.078), M_DARK);
  tg.position.set(0,-.034,.002); root.add(tg);
  // Red-dot sight
  const rdHousing = new THREE.Mesh(new THREE.BoxGeometry(.032,.022,.054), M_DARK);
  rdHousing.position.set(0,.074,-.18); root.add(rdHousing);
  const rdMount = new THREE.Mesh(new THREE.BoxGeometry(.030,.010,.028), M_MID);
  rdMount.position.set(0,.063,-.18); root.add(rdMount);
  // Glowing red dot (blooms)
  const rdDot = new THREE.Mesh(new THREE.SphereGeometry(.006,6,5), new THREE.MeshBasicMaterial({color:0xff0000}));
  rdDot.position.set(0,.074,-.18); root.add(rdDot);

  // Muzzle flash
  const flash = new THREE.Mesh(new THREE.SphereGeometry(.048,7,6), M_YELO);
  flash.position.set(0,.02,-.32); flash.visible=false; root.add(flash);
  root.userData.flash = flash;

  // Right hand at grip
  const rh = makeHand(true);
  rh.position.set(.02,-.092,.058); rh.rotation.x=.28; root.add(rh);
  // Left hand steadying (less visible for pistol)
  const lh = makeHand(false);
  lh.position.set(-.018,-.082,-.055); lh.rotation.x=.20; root.add(lh);
}

// ── SMG viewmodel ────────────────────────────────────────────
function buildSMG(root) {
  root.position.set(.10,-.28,-.52);

  // Receiver
  const recv = new THREE.Mesh(new THREE.BoxGeometry(.076,.09,.42), M_DARK);
  recv.position.set(0,.038,-.02); root.add(recv);
  // Top rail
  const rail = new THREE.Mesh(new THREE.BoxGeometry(.066,.018,.44), M_MID);
  rail.position.set(0,.088,-.02); root.add(rail);
  // Barrel (round)
  const brl = new THREE.Mesh(new THREE.CylinderGeometry(.014,.014,.22,10), M_MID);
  brl.rotation.x=Math.PI/2; brl.position.set(0,.062,-.28); root.add(brl);
  // Muzzle brake (hexagonal)
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(.022,.022,.04,6), M_LITE);
  brake.rotation.x=Math.PI/2; brake.position.set(0,.062,-.40); root.add(brake);
  // Magazine (angled slightly)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(.052,.18,.054), M_MID);
  mag.position.set(0,-.05,.04); mag.rotation.x=.08; root.add(mag);
  // Pistol grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(.054,.12,.060), M_WOOD);
  grip.position.set(0,-.066,.13); grip.rotation.x=.18; root.add(grip);
  // Handguard
  const hg = new THREE.Mesh(new THREE.BoxGeometry(.064,.068,.14), M_MID);
  hg.position.set(0,.04,-.18); root.add(hg);
  // Stock (partially visible)
  const stock = new THREE.Mesh(new THREE.BoxGeometry(.058,.058,.10), M_DARK);
  stock.position.set(0,.038,.22); root.add(stock);
  // Charging handle
  const ch = new THREE.Mesh(new THREE.BoxGeometry(.006,.026,.028), M_LITE);
  ch.position.set(.042,.062,.04); root.add(ch);
  // Holographic sight
  const holoFrame = new THREE.Mesh(new THREE.BoxGeometry(.044,.044,.010), M_DARK);
  holoFrame.position.set(0,.104,-.24); root.add(holoFrame);
  const holoInner = new THREE.Mesh(new THREE.BoxGeometry(.030,.030,.012), M_MID);
  holoInner.position.set(0,.104,-.245); root.add(holoInner);
  const holoMount = new THREE.Mesh(new THREE.BoxGeometry(.042,.008,.032), M_MID);
  holoMount.position.set(0,.092,-.24); root.add(holoMount);
  // Glowing red targeting dot (blooms)
  const holoDot = new THREE.Mesh(new THREE.SphereGeometry(.005,6,5), new THREE.MeshBasicMaterial({color:0xff0000}));
  holoDot.position.set(0,.104,-.252); root.add(holoDot);

  const flash = new THREE.Mesh(new THREE.SphereGeometry(.052,7,6), M_YELO);
  flash.position.set(0,.062,-.43); flash.visible=false; root.add(flash);
  root.userData.flash = flash;

  // Right hand on pistol grip
  const rh = makeHand(true);
  rh.position.set(.02,-.092,.125); rh.rotation.x=.24; root.add(rh);
  // Left hand on foregrip
  const lh = makeHand(false);
  lh.position.set(-.02,-.08,-.18); lh.rotation.x=.14; root.add(lh);
}

// ── Minigun viewmodel ────────────────────────────────────────
function buildMinigun(root) {
  root.position.set(.04,-.28,-.56);

  // Central housing
  const body = new THREE.Mesh(new THREE.BoxGeometry(.20,.20,.52), M_DARK);
  body.position.set(0,.06,.02); root.add(body);
  // Side armour plates
  const plL = new THREE.Mesh(new THREE.BoxGeometry(.04,.18,.48), M_MID);
  plL.position.set(-.13,.06,.02); root.add(plL);
  const plR = new THREE.Mesh(new THREE.BoxGeometry(.04,.18,.48), M_MID);
  plR.position.set( .13,.06,.02); root.add(plR);
  // Ammo box (left side)
  const abox = new THREE.Mesh(new THREE.BoxGeometry(.18,.18,.22), M_MID);
  abox.position.set(-.22,.06,.08); root.add(abox);
  const abelt = new THREE.Mesh(new THREE.BoxGeometry(.06,.06,.14), M_ORNG);
  abelt.position.set(-.16,.06,.00); root.add(abelt);
  // Right grip handle
  const gh = new THREE.Mesh(new THREE.BoxGeometry(.06,.16,.058), M_DARK);
  gh.position.set(.18,-.04,.10); root.add(gh);
  // Left front handle bar
  const lfh = new THREE.Mesh(new THREE.BoxGeometry(.048,.14,.048), M_DARK);
  lfh.position.set(-.10,-.04,-.14); root.add(lfh);

  // Spinning barrel cluster
  barrelCluster = new THREE.Group();
  barrelCluster.position.set(0,.06,-.10);
  const brlMat = new THREE.MeshLambertMaterial({color:0x3a3a4a});
  const brlDark= new THREE.MeshLambertMaterial({color:0x181820});
  const brlRad = .068;
  for (let i=0; i<6; i++) {
    const ang = (i/6)*Math.PI*2;
    const bx = Math.cos(ang)*brlRad;
    const by = Math.sin(ang)*brlRad;
    // Barrel tube (round cylinder)
    const bt = new THREE.Mesh(new THREE.CylinderGeometry(.016,.016,.44,8), brlDark);
    bt.rotation.x=Math.PI/2; bt.position.set(bx,by,-.14); barrelCluster.add(bt);
    // Muzzle ring (slightly flared)
    const mr = new THREE.Mesh(new THREE.CylinderGeometry(.022,.016,.018,8), brlMat);
    mr.rotation.x=Math.PI/2; mr.position.set(bx,by,-.36); barrelCluster.add(mr);
    // Barrel jacket rings (evenly spaced)
    [-0.06,0.06].forEach(rz=>{
      const ring=new THREE.Mesh(new THREE.CylinderGeometry(.020,.020,.014,8),brlMat);
      ring.rotation.x=Math.PI/2; ring.position.set(bx,by,rz-.14); barrelCluster.add(ring);
    });
  }
  // Centre axle
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.44,8), M_LITE);
  axle.rotation.x = Math.PI/2; axle.position.z=-.14; barrelCluster.add(axle);
  root.add(barrelCluster);

  // Targeting laser sight (green — blooms)
  const laserHousing = new THREE.Mesh(new THREE.BoxGeometry(.026,.020,.038), M_DARK);
  laserHousing.position.set(.11,.09,-.06); root.add(laserHousing);
  const laserDot = new THREE.Mesh(new THREE.SphereGeometry(.010,6,5), new THREE.MeshBasicMaterial({color:0x00ff44}));
  laserDot.position.set(.11,.09,-.08); root.add(laserDot);

  const flash = new THREE.Mesh(new THREE.SphereGeometry(.08,7,6), M_YELO);
  flash.position.set(0,.06,-.38); flash.visible=false; root.add(flash);
  root.userData.flash = flash;

  // Right hand on grip
  const rh = makeHand(true);
  rh.position.set(.18,-.10,.10); rh.rotation.set(.20,.0,.0); root.add(rh);
  // Left hand on front handle
  const lh = makeHand(false);
  lh.position.set(-.10,-.10,-.14); lh.rotation.x=.12; root.add(lh);
}

// ── Sniper viewmodel ─────────────────────────────────────────
function buildSniper(root) {
  root.position.set(.12, -.24, -.60);

  // Receiver / action body
  const recv = new THREE.Mesh(new THREE.BoxGeometry(.066, .070, .36), M_DARK);
  recv.position.set(0, .030, -.06); root.add(recv);
  // Picatinny rail on top
  const rail = new THREE.Mesh(new THREE.BoxGeometry(.054, .014, .38), M_MID);
  rail.position.set(0, .068, -.06); root.add(rail);

  // Barrel — long round tube
  const brl = new THREE.Mesh(new THREE.CylinderGeometry(.011,.011,.80,10), M_DARK);
  brl.rotation.x=Math.PI/2; brl.position.set(0,.020,-.43); root.add(brl);
  // Muzzle brake (fluted, hexagonal)
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,.054,6), M_LITE);
  brake.rotation.x=Math.PI/2; brake.position.set(0,.020,-.82); root.add(brake);

  // Scope body (round tube)
  const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(.022,.022,.30,12), M_DARK);
  scopeBody.rotation.x=Math.PI/2; scopeBody.position.set(0,.114,-.08); root.add(scopeBody);
  // Front objective bell (flared)
  const scopeObj = new THREE.Mesh(new THREE.CylinderGeometry(.026,.022,.016,12), M_MID);
  scopeObj.rotation.x=Math.PI/2; scopeObj.position.set(0,.114,-.24); root.add(scopeObj);
  // Lens optical coating glow (cyan — blooms)
  const lensGlow = new THREE.Mesh(new THREE.CylinderGeometry(.020,.020,.004,12), new THREE.MeshBasicMaterial({color:0x00eeff}));
  lensGlow.rotation.x=Math.PI/2; lensGlow.position.set(0,.114,-.249); root.add(lensGlow);
  // Rear eyepiece (flared)
  const scopeEye = new THREE.Mesh(new THREE.CylinderGeometry(.022,.018,.014,12), M_LITE);
  scopeEye.rotation.x=Math.PI/2; scopeEye.position.set(0,.114,.08); root.add(scopeEye);
  // Elevation turret (top)
  const elev = new THREE.Mesh(new THREE.BoxGeometry(.016, .036, .026), M_MID);
  elev.position.set(0, .140, -.08); root.add(elev);
  // Windage turret (right)
  const wind = new THREE.Mesh(new THREE.BoxGeometry(.038, .016, .026), M_MID);
  wind.position.set(.034, .114, -.08); root.add(wind);

  // Pistol grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(.050, .116, .060), M_WOOD);
  grip.position.set(0, -.060, .10); grip.rotation.x = .20; root.add(grip);
  // Trigger guard
  const tg = new THREE.Mesh(new THREE.BoxGeometry(.005, .026, .066), M_DARK);
  tg.position.set(0, -.026, .06); root.add(tg);
  // Magazine
  const mag = new THREE.Mesh(new THREE.BoxGeometry(.046, .110, .058), M_MID);
  mag.position.set(0, -.038, -.014); root.add(mag);

  // Bolt handle
  const boltShaft = new THREE.Mesh(new THREE.BoxGeometry(.050, .016, .016), M_MID);
  boltShaft.position.set(.058, .044, .038); root.add(boltShaft);
  const boltKnob = new THREE.Mesh(new THREE.BoxGeometry(.020, .026, .020), M_LITE);
  boltKnob.position.set(.072, .032, .038); root.add(boltKnob);

  // Stock
  const stock = new THREE.Mesh(new THREE.BoxGeometry(.058, .058, .18), M_WOOD);
  stock.position.set(0, .016, .24); root.add(stock);
  // Cheek rest
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(.056, .034, .12), M_WOOD);
  cheek.position.set(0, .052, .24); root.add(cheek);
  // Butt plate
  const butt = new THREE.Mesh(new THREE.BoxGeometry(.050, .080, .016), M_MID);
  butt.position.set(0, .026, .334); root.add(butt);

  // Bipod legs (folded along barrel)
  const bipL = new THREE.Mesh(new THREE.BoxGeometry(.006, .006, .10), M_LITE);
  bipL.position.set(-.020, -.002, -.60); root.add(bipL);
  const bipR = new THREE.Mesh(new THREE.BoxGeometry(.006, .006, .10), M_LITE);
  bipR.position.set( .020, -.002, -.60); root.add(bipR);

  const flash = new THREE.Mesh(new THREE.SphereGeometry(.058, 7, 6), M_YELO);
  flash.position.set(0, .020, -.86); flash.visible = false; root.add(flash);
  root.userData.flash = flash;

  // Right hand on pistol grip
  const rh = makeHand(true);
  rh.position.set(.020, -.086, .100); rh.rotation.x = .26; root.add(rh);
  // Left hand supporting the forend
  const lh = makeHand(false);
  lh.position.set(-.018, -.072, -.26); lh.rotation.x = .14; root.add(lh);
}

// ── Remote player helpers ────────────────────────────────────

const GUN_LABELS = { pistol:'PISTOL', smg:'SMG', minigun:'MINIGUN', sniper:'SNIPER' };

function _drawLabelCanvas(ctx, name, hp, pvpOn, isAdmin, gunId, inCoop=false, kills=0, team=null) {
  const W = 256, H = 100;
  ctx.clearRect(0, 0, W, H);
  // Team-colored background tint for TDM
  const bgCol = team === 'red' ? 'rgba(80,0,0,0.72)' : team === 'blue' ? 'rgba(0,20,80,0.72)' : 'rgba(0,0,0,0.65)';
  ctx.fillStyle = bgCol;
  ctx.fillRect(6, 6, W - 12, H - 12);

  // Name (+ hammer badge for admins)
  const rank = getRank(kills);
  const displayName = isAdmin ? name.slice(0, 16) + ' 🔨' : name.slice(0, 18);
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = isAdmin ? '#3b9ee8' : rank.color;
  ctx.fillText(displayName, 128, 26);

  // HP bar bg
  ctx.fillStyle = '#220000';
  ctx.fillRect(16, 33, 224, 9);
  const pct = Math.max(0, Math.min(100, hp)) / 100;
  ctx.fillStyle = hp > 60 ? '#22dd44' : hp > 30 ? '#ffaa00' : '#ff2200';
  ctx.fillRect(16, 33, Math.round(224 * pct), 9);

  // HP text
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ccc';
  ctx.fillText(Math.max(0, Math.round(hp)) + ' HP', 128, 57);

  // PVP indicator
  const pvpCol = pvpOn ? '#3b9ee8' : '#666';
  ctx.fillStyle = pvpCol;
  ctx.fillRect(72, 65, 8, 8);
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = pvpCol;
  ctx.textAlign = 'left';
  ctx.fillText(pvpOn ? 'PVP ON' : 'PVP OFF', 86, 73);

  // Co-op badge
  if (inCoop) {
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00ffaa';
    ctx.fillText('⚡CO-OP', 246, 73);
  }

  // Gun indicator
  const gunLabel = GUN_LABELS[gunId] || '';
  if (gunLabel) {
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f39c12';
    ctx.fillText('✦ ' + gunLabel, 128, 88);
  }
}

function makePlayerLabel(name, hp, pvpOn, isAdmin, gunId, inCoop=false) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 100;
  const ctx = c.getContext('2d');
  _drawLabelCanvas(ctx, name, hp, pvpOn, isAdmin, gunId, inCoop);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.8, 0.70, 1);
  sp.position.y = 3.5;
  sp.userData.canvas = c;
  sp.userData.ctx = ctx;
  return sp;
}

function refreshPlayerLabel(rp) {
  _drawLabelCanvas(rp.labelSprite.userData.ctx, rp.username, rp.health, rp.pvpMode, rp.isAdmin, rp.gunId, !!rp.inCoop);
  rp.labelSprite.material.map.needsUpdate = true;
}

function buildRemoteGun(gunId) {
  const g = new THREE.Group();
  const METAL = new THREE.MeshStandardMaterial({color:0x222233, roughness:0.25, metalness:0.92});
  const DARK  = new THREE.MeshStandardMaterial({color:0x111120, roughness:0.55, metalness:0.75});
  const GRIP  = new THREE.MeshStandardMaterial({color:0x1a1a1a, roughness:0.85, metalness:0.1});

  function box(w,h,d,x,y,z,mat){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z); g.add(m);
  }
  function brl(rt,rb,len,x,y,z){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,len,8),METAL);
    m.rotation.x=Math.PI/2; m.position.set(x,y,z); g.add(m);
  }

  if(gunId==='pistol'){
    box(.065,.11,.18,  0, 0,-.07, METAL);
    brl(.018,.018,.14,  0,.02,-.22);
    box(.040,.09,.06,  0,-.06,.02, GRIP);
  } else if(gunId==='smg'){
    box(.075,.12,.28,  0, 0,-.10, METAL);
    brl(.022,.022,.20,  0,.02,-.28);
    box(.055,.14,.08,  0,-.07,.04, GRIP);
    box(.085,.04,.20,  0,.07,-.10, DARK);
    box(.050,.08,.12,  0,-.05,-.10, DARK);
  } else if(gunId==='minigun'){
    box(.15,.13,.30,  0, 0,-.10, METAL);
    const R=0.045;
    for(let i=0;i<6;i++){
      const a=(i/6)*Math.PI*2;
      const m=new THREE.Mesh(new THREE.CylinderGeometry(.016,.016,.34,6),METAL);
      m.rotation.x=Math.PI/2;
      m.position.set(Math.cos(a)*R,Math.sin(a)*R,-.24); g.add(m);
    }
    box(.14,.12,.12,  0, 0,-.04, DARK);
  } else {  // sniper
    box(.052,.095,.50,  0,.01,-.22, METAL);
    brl(.013,.013,.30,  0,.01,-.54);
    box(.042,.042,.18,  0,.07,-.18, DARK);
    brl(.024,.020,.04,  0,.07,-.08);
    brl(.020,.024,.04,  0,.07,-.28);
    box(.035,.09,.07,  0,-.06,.01, GRIP);
  }

  const muzzleZ = gunId==='pistol'?-.31 : gunId==='smg'?-.40 : gunId==='minigun'?-.43 : -.71;
  const flashLight = new THREE.PointLight(0xffaa00, 0, 4);
  flashLight.position.set(0, .01, muzzleZ);
  g.add(flashLight);

  const flashMat = new THREE.MeshBasicMaterial({color:0xffcc44, transparent:true, opacity:0});
  const flashMesh = new THREE.Mesh(new THREE.SphereGeometry(.07,6,4), flashMat);
  flashMesh.position.set(0, .01, muzzleZ);
  g.add(flashMesh);

  return { group:g, flashLight, flashMat, flashTimer:0 };
}

// defined in robot-builder.js
/* addRobotAccessory removed — see robot-builder.js */

function addRemotePlayer(data) {
  if (remotePlayers.has(data.id)) return;
  const rob = buildRobot();
  const col = new THREE.Color(data.color || '#e74c3c');
  rob.eyeMatL.color.copy(col);
  rob.eyeMatR.color.copy(col);
  rob.hpBarGroup.visible = false;

  const groundY = Math.max(0, (data.y || EYE_H) - EYE_H);
  rob.group.position.set(data.x || 0, groundY, data.z || 0);
  scene.add(rob.group);

  const username = data.username || 'Player';
  const health   = data.health   !== undefined ? data.health   : 100;
  const pvpOn    = data.pvpMode  !== undefined ? data.pvpMode  : true;
  const isAdmin  = !!data.isAdmin;
  const gunId    = data.gunId || 'pistol';
  const labelSprite = makePlayerLabel(username, health, pvpOn, isAdmin, gunId);
  rob.group.add(labelSprite);

  // Raise both arms forward into gun-hold pose
  rob.armGroupR.rotation.x =  1.10;
  rob.armGroupL.rotation.x =  1.10;
  rob.armGroupR.rotation.z = -0.32;
  rob.armGroupL.rotation.z =  0.32;

  const remoteGun = buildRemoteGun(gunId);
  remoteGun.group.position.set(0, 1.20, -0.80);
  rob.group.add(remoteGun.group);

  if (data.equippedItems && data.equippedItems.length) {
    data.equippedItems.forEach(id => addRobotAccessory(rob, id));
  }

  remotePlayers.set(data.id, {
    ...rob,
    labelSprite,
    username,
    health,
    pvpMode:    pvpOn,
    isAdmin,
    isGuest:    !!data.isGuest,
    gunId,
    inCoop:     false,
    remoteGun,
    targetPos:  new THREE.Vector3(data.x || 0, groundY, data.z || 0),
    targetRotY: data.rotationY || 0,
    walkClock:  0,
  });
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (!rp) return;
  const ea = _emoteBodyMap.get(id);
  if (ea) { clearTimeout(ea._restoreTimer); _emoteBodyMap.delete(id); }
  scene.remove(rp.group);
  disposeGroup(rp.group);
  remotePlayers.delete(id);
}

// ── Ghost bots (co-op guest sees host's bots) ────────────────
function clearGhostBots() {
  coopGhostBots.forEach(gb => { if (gb.group.parent) scene.remove(gb.group); disposeGroup(gb.group); });
  coopGhostBots.length = 0;
}

function syncGhostBots(botData) {
  while (coopGhostBots.length < botData.length) {
    const r = buildRobot();
    r.allMats.forEach(m => { m.emissive.setHex(0x002233); m.emissiveIntensity = 0.5; });
    scene.add(r.group);
    coopGhostBots.push({ ...r, alive: true });
  }
  botData.forEach((bd, i) => {
    const gb = coopGhostBots[i];
    if (!bd.alive) {
      if (gb.alive) { gb.alive = false; if (gb.group.parent) scene.remove(gb.group); }
      return;
    }
    if (!gb.alive) { gb.alive = true; scene.add(gb.group); }
    gb.group.position.set(bd.x, bd.y, bd.z);
    gb.group.rotation.y = bd.ry;
  });
}

function findGhostBot(obj) {
  for (let i = 0; i < coopGhostBots.length; i++) {
    let cur = obj;
    while (cur) { if (cur === coopGhostBots[i].group) return i; cur = cur.parent; }
  }
  return null;
}

// ── Co-op panel ───────────────────────────────────────────────
const coopPanel  = document.getElementById('coop-panel');
const coopList   = document.getElementById('coop-player-list');
const coopStatus = document.getElementById('coop-status');

function showCoopPanel() {
  if (!coopPanel || !socket) return;
  coopList.innerHTML = '';
  const others = [...remotePlayers.entries()];
  if (others.length === 0) {
    const empty = document.createElement('span');
    empty.style.cssText = 'font-size:12px;color:#444466';
    empty.textContent = 'No other players connected.';
    coopList.appendChild(empty);
  } else {
    others.forEach(([rpId, rp]) => {
      const row = document.createElement('div');
      row.className = 'coop-player-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'coop-player-name';
      nameEl.textContent = rp.username || 'Player';
      const btn = document.createElement('button');
      btn.className = 'coop-invite-btn';
      if (rp.inCoop || coopMode) {
        btn.textContent = rp.inCoop ? 'CO-OP' : 'IN CO-OP';
        btn.disabled = true;
      } else {
        btn.textContent = 'INVITE';
        btn.addEventListener('click', () => {
          socket.emit('coopInvite', { targetId: rpId });
          btn.textContent = 'SENT';
          btn.disabled = true;
        });
      }
      const reportBtn = document.createElement('button');
      reportBtn.className = 'coop-report-btn';
      reportBtn.title = 'Report player';
      reportBtn.textContent = '⚑';
      reportBtn.addEventListener('click', () => {
        const reason = prompt(`Report ${rp.username || 'Player'} — describe the issue (optional):`);
        if (reason === null) return;
        if (socket) socket.emit('reportPlayer', {
          targetUsername: rp.username || '',
          reason,
          token: localStorage.getItem('ah_token') || '',
        });
        reportBtn.textContent = '✓';
        reportBtn.disabled = true;
        reportBtn.title = 'Report sent';
      });
      row.appendChild(nameEl);
      row.appendChild(btn);
      row.appendChild(reportBtn);
      coopList.appendChild(row);
    });
  }
  coopStatus.style.display = coopMode ? 'block' : 'none';
  if (coopMode) coopStatus.textContent = coopIsHost ? '⚡ You are the Co-op Host' : '⚡ You are a Co-op Guest';
  coopPanel.style.display = 'block';
}

function hideCoopPanel() {
  if (coopPanel) coopPanel.style.display = 'none';
}

// ── Co-op invite dialog ───────────────────────────────────────
let pendingInviteHostId = null;

function showCoopInviteDialog(fromId, fromUsername) {
  pendingInviteHostId = fromId;
  const dialog = document.getElementById('coop-invite-dialog');
  const text   = document.getElementById('coop-invite-text');
  if (dialog && text) {
    text.textContent = `${fromUsername} wants to co-op with you!`;
    dialog.style.display = 'block';
  }
}

(function setupCoopInviteDialog() {
  const dialog    = document.getElementById('coop-invite-dialog');
  const acceptBtn = document.getElementById('coop-accept-btn');
  const denyBtn   = document.getElementById('coop-deny-btn');
  if (!acceptBtn || !denyBtn) return;
  acceptBtn.addEventListener('click', () => {
    if (!pendingInviteHostId || !socket) return;
    socket.emit('coopAccept', { hostId: pendingInviteHostId });
    pendingInviteHostId = null;
    dialog.style.display = 'none';
  });
  denyBtn.addEventListener('click', () => {
    if (!pendingInviteHostId || !socket) return;
    socket.emit('coopDeny', { hostId: pendingInviteHostId });
    pendingInviteHostId = null;
    dialog.style.display = 'none';
  });
})();

// Walk up parent chain to find which remote player entry contains obj
function findRemotePlayer(obj) {
  let cur = obj;
  while (cur) {
    for (const [id, rp] of remotePlayers) {
      if (rp.group === cur) return [id, rp];
    }
    cur = cur.parent;
  }
  return null;
}

// Called when game starts or gun is switched from start screen
function getAttachments(gunId) {
  const eq = Array.from(JSON.parse(localStorage.getItem('ah_equipped') || '[]'));
  const out = { spread:1, kick:1, damage:1, ammoMult:1, fireRateMult:1, scope:false, hasScope:false };

  // Legacy generic attachments
  if (eq.includes('silencer_rare')) { out.spread *= 0.38; }
  if (eq.includes('scope_epic'))    { out.scope = true; out.hasScope = true; }
  if (eq.includes('extmag_rare'))   { out.ammoMult *= 2.0; }

  // Gun-specific attachments: only apply if they match current gun
  eq.forEach(id => {
    const parts = id.split('_');
    if (parts.length < 3) return;
    const effect = parts[0];
    const gun    = parts[1];
    if (gun !== gunId) return;
    switch (effect) {
      case 'sil':         out.spread       *= 0.38; break;
      case 'scope':       out.scope = true; out.hasScope = true; break;
      case 'extmag':      out.ammoMult     *= 2.0;  break;
      case 'laser':       out.spread       *= 0.52; break;
      case 'brake':       out.kick         *= 0.55; break;
      case 'comp':        out.spread       *= 0.62; out.kick *= 0.68; break;
      case 'foregrip':    out.spread       *= 0.58; break;
      case 'bipod':       out.spread       *= 0.45; break;
      case 'longbarrel':  out.damage       *= 1.30; break;
      case 'heavybarrel': out.damage       *= 1.30; break;
      case 'titanbarrel': out.damage       *= 1.45; break;
      case 'flashhider':  out.spread       *= 0.70; break;
      case 'quickdraw':   out.fireRateMult *= 1.25; break;
      case 'hollowpoint': out.damage       *= 1.40; break;
      case 'rapidfire':   out.fireRateMult *= 1.35; break;
      case 'armor':       out.damage       *= 1.45; break;
      case 'tracer':      /* visual only */ break;
      case 'quickmag':    out.ammoMult     *= 1.65; break;
      case 'infernomag':  out.ammoMult     *= 2.20; break;
      case 'overclocked': out.fireRateMult *= 1.45; break;
      case 'comprecoil':  out.kick         *= 0.48; break;
      case 'tracker':     /* visual only */ break;
      case 'suppressor':  out.spread       *= 0.32; break;
      case 'stockless':   out.fireRateMult *= 1.18; break;
      case 'quickbolt':   out.fireRateMult *= 1.40; break;
      case 'match':       out.damage       *= 1.38; break;
      case 'cheekrest':   out.kick         *= 0.42; break;
      case 'nightforce':  out.scope = true; out.hasScope = true; break;
    }
  });
  return out;
}

function setupWeapon(id) {
  while (weaponRoot.children.length>0) weaponRoot.remove(weaponRoot.children[0]);
  weaponRoot.add(muzzleLight);  // re-add persistent light
  barrelCluster = null;
  mgSpinSpeed = 0;

  const att = getAttachments(id);
  const def = Object.assign({}, GUN_DEFS[id]);
  def.spread   = Math.max(0.002, def.spread * att.spread);
  def.damage   = Math.round(def.damage * att.damage);
  def.fireRate = def.fireRate / att.fireRateMult;
  def.kick     = def.kick * att.kick;
  if (att.ammoMult > 1) {
    def.ammo    = Math.ceil(def.ammo    * att.ammoMult);
    def.reserve = Math.ceil(def.reserve * att.ammoMult);
  }
  gun.def = def; gun.ammo = def.ammo; gun.reserve = def.reserve;
  gun.shootTimer = 0; gun.canShoot = true;

  if      (id==='pistol')  buildPistol(weaponRoot);
  else if (id==='smg')     buildSMG(weaponRoot);
  else if (id==='minigun') buildMinigun(weaponRoot);
  else if (id==='sniper')  buildSniper(weaponRoot);

  if (gunNameEl) {
    const tags = [];
    if (att.spread   < 1)  tags.push('SIL');
    if (att.hasScope)      tags.push('SC');
    if (att.ammoMult > 1)  tags.push('EM');
    if (att.damage   > 1)  tags.push('DMG');
    if (att.fireRateMult>1)tags.push('FR');
    gunNameEl.textContent = def.name + (tags.length ? ' [' + tags.join('+') + ']' : '');
  }
  updateAmmoHUD();
  weaponRoot.userData.baseY = weaponRoot.position.y;
  weaponRoot.userData.baseX = weaponRoot.position.x;
  weaponRoot.userData.baseZ = weaponRoot.position.z;
  recoilZ = 0; recoilY = 0;
  _weaponRaiseT = 0.5;
  _reloadActive = false; _reloadT = 0;
  _swayX = 0; _swayY = 0;
}

// defined in robot-builder.js

// ─── Bot pool (populated per-level) ──────────────────────────
const BOT_DMG_INT   = 0.9;   // seconds between bot hits (melee)
const BOT_MELEE     = 2.2;
const BOT_RADIUS    = 0.42;
const BOT_SHOOT_DST = 26;    // max range bots will fire
const BOT_BULLET_V  = 22;    // bullet travel speed (units/s)
const BOT_BULLET_DMG= 7;     // damage per bot bullet
const botBullets    = [];    // live projectiles: { mesh, pos, vel, dist, maxDist }

// ── Line-vs-AABB helper (2D, x/z plane) ──────────────────────
function _lineHitsBox(x1,z1,x2,z2,minX,minZ,maxX,maxZ){
  const dx=x2-x1, dz=z2-z1;
  let tmin=0, tmax=1;
  for(const [lo,hi,p,d] of [[minX,maxX,x1,dx],[minZ,maxZ,z1,dz]]){
    if(Math.abs(d)<1e-9){ if(p<lo||p>hi) return false; }
    else{
      let t1=(lo-p)/d, t2=(hi-p)/d;
      if(t1>t2){const tmp=t1;t1=t2;t2=tmp;}
      tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2);
      if(tmin>tmax) return false;
    }
  }
  return true;
}

// Returns true if a clear line of sight exists between two XZ positions
function botHasLOS(bx,bz,tx,tz){
  for(const b of coverBoxes){
    if(_lineHitsBox(bx,bz,tx,tz, b.cx-b.hw,b.cz-b.hd, b.cx+b.hw,b.cz+b.hd)) return false;
  }
  return true;
}

// Returns true if XZ position is inside any cover box
function _inCoverBox(x,z,r=0){
  for(const b of coverBoxes){
    if(x>b.cx-b.hw-r&&x<b.cx+b.hw+r&&z>b.cz-b.hd-r&&z<b.cz+b.hd+r) return true;
  }
  return false;
}

// ── Bot pistol mesh ───────────────────────────────────────────
function buildBotPistol(){
  const g   = new THREE.Group();
  const M   = new THREE.MeshStandardMaterial({color:0x2a2e3c,roughness:0.35,metalness:0.9});
  const Mg  = c => new THREE.MeshBasicMaterial({color:c});
  // Slide / receiver
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.055,0.062,0.175),M);
  slide.position.set(0,0.012,-0.025); g.add(slide);
  // Barrel
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.028,0.028,0.14),M);
  barrel.position.set(0,-0.004,-0.145); g.add(barrel);
  // Muzzle tip accent
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.032,0.032,0.018),Mg(0x888888));
  tip.position.set(0,-0.004,-0.216); g.add(tip);
  // Handle
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.046,0.11,0.065),
    new THREE.MeshStandardMaterial({color:0x0e0e0e,roughness:0.9,metalness:0.1}));
  handle.position.set(0,-0.076,0.055); handle.rotation.x=0.18; g.add(handle);
  // Trigger guard
  const tg = new THREE.Mesh(new THREE.BoxGeometry(0.008,0.028,0.055),Mg(0x444444));
  tg.position.set(0,-0.038,0.014); g.add(tg);
  // Muzzle flash (hidden by default)
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.04,5,4),Mg(0xffee88));
  flash.position.set(0,-0.004,-0.23); flash.visible=false; g.add(flash);
  g.userData.flash = flash;
  return g;
}

function rndPos(){
  return new THREE.Vector3((Math.random()-.5)*(AW*2-8),0,(Math.random()-.5)*(AD*2-8));
}

// Stair waypoints: ground entries and mezzanine exits
const STAIR_WP = {
  gndA: new THREE.Vector3(29, 0, -25),
  mezA: new THREE.Vector3(29, MEZZ_H, -35),
  gndB: new THREE.Vector3(-29, 0, 25),
  mezB: new THREE.Vector3(-29, MEZZ_H, 35),
};
function nearestStairEntry(bp, toMezz) {
  const candidates = toMezz
    ? [STAIR_WP.mezA, STAIR_WP.mezB]
    : [STAIR_WP.gndA, STAIR_WP.gndB];
  return candidates.reduce((best,p)=>
    bp.distanceTo(p)<bp.distanceTo(best)?p:best
  );
}

let bots = [];
const ammoPickups = [];   // { group, posX, posZ, bobClock, lifetime, amount }

// Walk up parent chain to find the bot whose group contains `obj`
function findBot(obj){
  let cur=obj;
  while(cur){ const b=bots.find(b=>b.group===cur); if(b) return b; cur=cur.parent; }
  return null;
}

// ============================================================
//  SHOOTING
// ============================================================
const raycaster=new THREE.Raycaster();
let mouseHeld=false;

function shoot(){
  const def=gun.def;
  if(!gun.canShoot||gun.ammo<=0||player.dead||!levelActive) return;
  if(def.spinUp && mgSpinSpeed < MG_MAX_SPIN*.38) return;  // minigun needs to spin up

  gun.ammo--; updateAmmoHUD();

  // Weapon sound
  playWeaponSound(def.id);

  // Shell casing (not for minigun)
  if (def.id !== 'minigun') spawnShellCasing();

  // Muzzle effects
  const fl=weaponRoot.userData.flash;
  if(fl){ fl.visible=true; muzzleTimer=.075; muzzleLight.intensity=3; }

  // Spread: offset ray from screen centre
  const sx=(Math.random()-.5)*2*def.spread;
  const sy=(Math.random()-.5)*2*def.spread;
  raycaster.setFromCamera(new THREE.Vector2(sx,sy), camera);

  const livingGroups  = bots.filter(b=>b.alive).map(b=>b.group);
  const remoteGroups  = [...remotePlayers.values()].map(rp=>rp.group);
  const ghostGroups   = (coopMode && !coopIsHost) ? coopGhostBots.filter(gb=>gb.alive).map(gb=>gb.group) : [];
  const hits = raycaster.intersectObjects([...livingGroups, ...remoteGroups, ...ghostGroups], true);
  if(hits.length>0){
    const bot = findBot(hits[0].object);
    if(bot){
      damageBot(bot);
    } else {
      const hit = findRemotePlayer(hits[0].object);
      if(hit && socket) socket.emit('shoot', { targetId: hit[0] });
      else {
        const ghostIdx = findGhostBot(hits[0].object);
        if(ghostIdx !== null && socket) socket.emit('coopBotHit', { botIndex: ghostIdx });
      }
    }
  } else {
    // Hit environment — cast against scene for wall impact
    const envHits = raycaster.intersectObjects(scene.children, false);
    if (envHits.length > 0 && envHits[0].face) {
      spawnImpactDust(envHits[0].point, envHits[0].face.normal);
    }
  }

  if(socket && socket.connected) socket.emit('playerShot', {});

  const maxZ = (def.kick || 0) * 2.5;
  const maxY = (def.kick || 0) * 0.9;
  recoilZ = Math.min(recoilZ + (def.kick || 0), maxZ);
  recoilY = Math.min(recoilY + (def.kick || 0) * 0.35, maxY);

  gun.canShoot=false; gun.shootTimer=def.fireRate;
}

function damageBot(bot){
  if(gun.def && gun.def.oneShot) bot.hp = 0; else bot.hp -= 1;
  bot.allMats.forEach(mat=>{ mat.emissive.setHex(0xff5500); mat.emissiveIntensity=4.0; });
  setTimeout(()=>{
    if(!bot.phantomGlowing) bot.allMats.forEach(mat=>{ mat.emissive.setHex(0x000000); mat.emissiveIntensity=0; });
  },80);
  // Hit sparks (bright blue + white, no blood)
  spawnHitSparks(bot.group.position.clone().setY(1.15 + Math.random() * 0.5));
  _hitConfirmT = 0.14;
  if(bot.hp<=0) killBot(bot);
}

function killBot(bot){
  bot.alive = false;
  bot.dying = true;
  bot.deathClock = 0;
  bot.hpBarGroup.visible = false;
  bot.eyeMatL.color.setHex(0x220000);
  bot.eyeMatR.color.setHex(0x220000);
  const hitPos = bot.group.position.clone().setY(1.2);
  spawnStaticDeath(hitPos);
  spawnAmmoPickup(bot.group.position);
  player.kills++;
  updateKillHUD();
  updateRankHUD();
  trackKill();
  pushKillFeed('Robot destroyed');
  updateEnemyCountHUD();
  checkLevelComplete();
  if(coopIsHost && socket) socket.emit('coopBotKill', { botIndex: bots.indexOf(bot) });
}

function trackKill() {
  totalKills++;
  const token = localStorage.getItem('ah_token');
  if (socket && token) socket.emit('statsKill', { token });
}

function trackDeath() {
  totalDeaths++;
  player.deaths++;
  const token = localStorage.getItem('ah_token');
  if (socket && token) socket.emit('statsDeath', { token });
}

function spawnSparks(pos){
  // kept for compatibility — redirects to static death effect
  spawnStaticDeath(pos);
}

function spawnHitSparks(pos) {
  for (let i = 0; i < 16; i++) {
    const isWhite = i < 6;
    const size = 0.012 + Math.random() * 0.022;
    const mat = new THREE.MeshBasicMaterial({ color: isWhite ? 0xffffff : 0x00aaff, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 4, 4), mat);
    mesh.position.copy(pos);
    const sp = 3.5 + Math.random() * 6.5;
    const th = Math.random() * Math.PI * 2;
    const ph = (Math.random() - 0.3) * Math.PI;
    const vel = new THREE.Vector3(
      Math.sin(ph) * Math.cos(th) * sp,
      Math.abs(Math.cos(ph)) * sp * 0.7 + 0.5,
      Math.sin(ph) * Math.sin(th) * sp
    );
    scene.add(mesh);
    bloodParticles.push({ mesh, vel, age: 0, maxAge: 0.28 });
  }
}

function spawnBlood(pos, count = 14) {
  // Small electric hit sparks (blue)
  for (let i = 0; i < count; i++) {
    const size = 0.04 + Math.random() * 0.07;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), BLOOD_MAT);
    mesh.position.copy(pos);
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      Math.random() * 5 + 1,
      (Math.random() - 0.5) * 6
    );
    scene.add(mesh);
    bloodParticles.push({ mesh, vel, age: 0 });
  }
}

function spawnStaticDeath(pos) {
  // Arc bolts — jagged line segments
  for (let bolt = 0; bolt < 8; bolt++) {
    const points = [];
    let cx = pos.x, cy = pos.y + 0.5 + Math.random() * 1.0, cz = pos.z;
    for (let j = 0; j < 6; j++) {
      cx += (Math.random() - 0.5) * 0.9;
      cy += (Math.random() - 0.5) * 0.6;
      cz += (Math.random() - 0.5) * 0.9;
      points.push(new THREE.Vector3(cx, cy, cz));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: STATIC_COLORS[bolt % STATIC_COLORS.length],
      transparent: true, opacity: 1.0
    }));
    scene.add(line);
    const delay = Math.random() * 300;
    setTimeout(() => { if (line.material) line.material.opacity = 0.3; }, delay + 80);
    setTimeout(() => { scene.remove(line); geo.dispose(); line.material.dispose(); }, delay + 300);
  }

  // Electric spark particles
  for (let i = 0; i < 35; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.025 + Math.random() * 0.025, 4, 4),
      new THREE.MeshBasicMaterial({ color: STATIC_COLORS[Math.floor(Math.random() * STATIC_COLORS.length)], transparent: true })
    );
    mesh.position.copy(pos).setY(pos.y + 0.5 + Math.random() * 1.0);
    const spd = 3 + Math.random() * 5;
    const angle = Math.random() * Math.PI * 2;
    const vy = 2 + Math.random() * 4;
    const vel = new THREE.Vector3(Math.cos(angle) * spd, vy, Math.sin(angle) * spd);
    scene.add(mesh);
    staticParticles.push({ mesh, vel, age: 0, maxAge: 0.5 + Math.random() * 0.4 });
  }

  // Blue flash ring
  const ringGeo = new THREE.RingGeometry(0.1, 0.4, 16);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(pos); ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  let ringAge = 0;
  const ringInterval = setInterval(() => {
    ringAge += 0.05;
    ring.scale.setScalar(1 + ringAge * 8);
    ring.material.opacity = Math.max(0, 0.9 - ringAge * 3);
    if (ringAge > 0.4) { clearInterval(ringInterval); scene.remove(ring); ringGeo.dispose(); ringMat.dispose(); }
  }, 50);
}

function spawnShellCasing() {
  const geo = new THREE.CylinderGeometry(0.007, 0.007, 0.022, 7);
  const mesh = new THREE.Mesh(geo, SHELL_MAT);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const pos = camera.position.clone().addScaledVector(right, 0.25);
  pos.y = camera.position.y - 0.12;
  mesh.position.copy(pos);
  const vel = new THREE.Vector3(
    right.x * (2 + Math.random()) + (Math.random() - 0.5),
    1.5 + Math.random() * 1.5,
    right.z * (2 + Math.random()) + (Math.random() - 0.5)
  );
  const rotVel = new THREE.Vector3(
    (Math.random() - 0.5) * 18,
    (Math.random() - 0.5) * 18,
    (Math.random() - 0.5) * 18
  );
  scene.add(mesh);
  shellCasings.push({ mesh, vel, rotVel, age: 0, bounced: false });
}

function spawnImpactDust(pos, normal) {
  for (let i = 0; i < 12; i++) {
    const size = 0.04 + Math.random() * 0.06;
    const mat = DUST_MAT.clone();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 4, 4), mat);
    mesh.position.copy(pos);
    const vel = new THREE.Vector3(
      (normal ? normal.x : 0) + (Math.random() - 0.5) * 2,
      0.5 + Math.random() * 2,
      (normal ? normal.z : 0) + (Math.random() - 0.5) * 2
    );
    impactParticles.push({ mesh, vel, age: 0, maxAge: 0.6 + Math.random() * 0.4 });
    scene.add(mesh);
  }
  // Small dark decal on hit surface
  if (normal) {
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.01),
      new THREE.MeshBasicMaterial({ color: 0x111111 })
    );
    mark.position.copy(pos).addScaledVector(normal, 0.01);
    mark.lookAt(pos.clone().add(normal));
    scene.add(mark);
    setTimeout(() => scene.remove(mark), 8000);
  }
}

// ─── Sound system ────────────────────────────────────────────
function playWeaponSound(gunId) {
  const ac = getAC(); const vol = _getVol('sfx');
  const g = ac.createGain(); g.gain.value = vol; g.connect(ac.destination);
  switch(gunId) {
    case 'pistol': {
      const buf = ac.createBuffer(1, ac.sampleRate*0.12, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*Math.exp(-i/(data.length*0.08));
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1200; bp.Q.value=0.8;
      src.connect(bp); bp.connect(g); src.start();
      break;
    }
    case 'smg': {
      const buf=ac.createBuffer(1,ac.sampleRate*0.07,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12));
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=900; bp.Q.value=1.2;
      src.connect(bp); bp.connect(g); src.start();
      break;
    }
    case 'minigun': {
      if (Math.random() > 0.33) return;
      const osc=ac.createOscillator(); osc.type='sawtooth'; osc.frequency.value=180;
      const envG=ac.createGain(); envG.gain.setValueAtTime(vol*0.4,ac.currentTime); envG.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.05);
      osc.connect(envG); envG.connect(ac.destination); osc.start(); osc.stop(ac.currentTime+0.05);
      break;
    }
    case 'sniper': {
      const buf=ac.createBuffer(1,ac.sampleRate*0.5,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.18));
      const src=ac.createBufferSource(); src.buffer=buf;
      const lp=ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=400;
      src.connect(lp); lp.connect(g); src.start();
      const osc=ac.createOscillator(); osc.type='sine'; osc.frequency.setValueAtTime(120,ac.currentTime); osc.frequency.exponentialRampToValueAtTime(30,ac.currentTime+0.3);
      const envG2=ac.createGain(); envG2.gain.setValueAtTime(vol*0.9,ac.currentTime); envG2.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.3);
      osc.connect(envG2); envG2.connect(ac.destination); osc.start(); osc.stop(ac.currentTime+0.3);
      break;
    }
  }
}

function playReloadSound() {
  const ac=getAC(); const vol=_getVol('sfx');
  const osc=ac.createOscillator(); osc.type='square'; osc.frequency.value=320;
  const g=ac.createGain(); g.gain.setValueAtTime(vol*0.3,ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.18);
  osc.connect(g); g.connect(ac.destination); osc.start(); osc.stop(ac.currentTime+0.18);
  setTimeout(()=>{
    const ac2=getAC();
    const o2=ac2.createOscillator(); o2.type='square'; o2.frequency.value=440;
    const g2=ac2.createGain(); g2.gain.setValueAtTime(vol*0.35,ac2.currentTime); g2.gain.exponentialRampToValueAtTime(0.001,ac2.currentTime+0.12);
    o2.connect(g2); g2.connect(ac2.destination); o2.start(); o2.stop(ac2.currentTime+0.12);
  }, 300);
}

let _footstepTimer = 0;
function playFootstep(biomeType) {
  const ac=getAC(); const vol=_getVol('sfx');
  const g=ac.createGain(); g.connect(ac.destination);
  switch(biomeType) {
    case 'ice': {
      const osc=ac.createOscillator(); osc.type='sine'; osc.frequency.value=1800+Math.random()*400;
      const gE=ac.createGain(); gE.gain.setValueAtTime(vol*0.18,ac.currentTime); gE.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.08);
      osc.connect(gE); gE.connect(ac.destination); osc.start(); osc.stop(ac.currentTime+0.08);
      break;
    }
    case 'lava': {
      const buf=ac.createBuffer(1,ac.sampleRate*0.15,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.2))*0.8;
      const src=ac.createBufferSource(); src.buffer=buf;
      const lp=ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=300;
      src.connect(lp); lp.connect(g); g.gain.value=vol*0.5; src.start();
      break;
    }
    case 'forest': {
      const buf=ac.createBuffer(1,ac.sampleRate*0.12,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.25))*0.5;
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=600; bp.Q.value=0.5;
      src.connect(bp); bp.connect(g); g.gain.value=vol*0.3; src.start();
      break;
    }
    case 'desert': {
      const buf=ac.createBuffer(1,ac.sampleRate*0.1,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.3))*0.4;
      const src=ac.createBufferSource(); src.buffer=buf;
      const hp=ac.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=2000;
      src.connect(hp); hp.connect(g); g.gain.value=vol*0.35; src.start();
      break;
    }
    case 'swamp': {
      // Wet slap/squelch
      const buf=ac.createBuffer(1,ac.sampleRate*0.18,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.15))*0.7;
      const src=ac.createBufferSource(); src.buffer=buf;
      const lp=ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=450;
      src.connect(lp); lp.connect(g); g.gain.value=vol*0.55; src.start();
      break;
    }
    case 'stone': {
      // Hard hollow echo
      const buf=ac.createBuffer(1,ac.sampleRate*0.12,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.08))*0.9;
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1200; bp.Q.value=3;
      src.connect(bp); bp.connect(g); g.gain.value=vol*0.40; src.start();
      break;
    }
    case 'splash': {
      // Water splash — two-layer: low thud + high-freq spray
      const buf=ac.createBuffer(1,ac.sampleRate*0.16,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.18))*0.65;
      const src=ac.createBufferSource(); src.buffer=buf;
      const lp=ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=600;
      const hp=ac.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=2500;
      src.connect(lp); lp.connect(g);
      const src2=ac.createBufferSource(); src2.buffer=buf;
      src2.connect(hp); hp.connect(g); g.gain.value=vol*0.42; src.start(); src2.start();
      break;
    }
    case 'crumble': {
      // Crunchy debris — mid-noise burst
      const buf=ac.createBuffer(1,ac.sampleRate*0.14,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12))*0.75;
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=900; bp.Q.value=1.5;
      src.connect(bp); bp.connect(g); g.gain.value=vol*0.50; src.start();
      break;
    }
    case 'jungle': {
      // Soft leaf rustle + wet under-layer
      const buf=ac.createBuffer(1,ac.sampleRate*0.14,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.22))*0.45;
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=700; bp.Q.value=0.8;
      src.connect(bp); bp.connect(g); g.gain.value=vol*0.35; src.start();
      break;
    }
    case 'rain': {
      // Light wet tap with short decay
      const buf=ac.createBuffer(1,ac.sampleRate*0.09,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.14))*0.55;
      const src=ac.createBufferSource(); src.buffer=buf;
      const hp=ac.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1800;
      src.connect(hp); hp.connect(g); g.gain.value=vol*0.30; src.start();
      break;
    }
    default: {
      const buf=ac.createBuffer(1,ac.sampleRate*0.08,ac.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.1))*0.6;
      const src=ac.createBufferSource(); src.buffer=buf;
      const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=800; bp.Q.value=2;
      src.connect(bp); bp.connect(g); g.gain.value=vol*0.25; src.start();
    }
  }
}

function updateAudioListener() {
  if (!_ac) return;
  const listener = _ac.listener;
  if (listener.positionX) {
    listener.positionX.value = camera.position.x;
    listener.positionY.value = camera.position.y;
    listener.positionZ.value = camera.position.z;
    const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
    const up  = new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
    listener.forwardX.value = fwd.x; listener.forwardY.value = fwd.y; listener.forwardZ.value = fwd.z;
    listener.upX.value = up.x; listener.upY.value = up.y; listener.upZ.value = up.z;
  }
}

function playSpatialBotSound(worldPos, type) {
  if (!_ac) return;
  const vol = _getVol('sfx');
  const panner = _ac.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 2;
  panner.maxDistance = 60;
  panner.rolloffFactor = 1.2;
  if (panner.positionX) {
    panner.positionX.value = worldPos.x;
    panner.positionY.value = worldPos.y;
    panner.positionZ.value = worldPos.z;
  } else {
    panner.setPosition(worldPos.x, worldPos.y, worldPos.z);
  }
  const g = _ac.createGain(); g.gain.value = vol;
  panner.connect(g); g.connect(_ac.destination);
  if (type === 'botShoot') {
    const buf=_ac.createBuffer(1,_ac.sampleRate*0.1,_ac.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.1));
    const src=_ac.createBufferSource(); src.buffer=buf;
    src.connect(panner); src.start();
  } else if (type === 'botFootstep') {
    const osc=_ac.createOscillator(); osc.type='sine'; osc.frequency.value=80+Math.random()*40;
    const gE=_ac.createGain(); gE.gain.setValueAtTime(vol*0.3,_ac.currentTime); gE.gain.exponentialRampToValueAtTime(0.001,_ac.currentTime+0.12);
    osc.connect(panner); osc.start(); osc.stop(_ac.currentTime+0.12);
  }
}

function spawnAmmoPickup(pos) {
  const amount = 6 + Math.floor(Math.random() * 13);  // 6–18 bullets

  const g = new THREE.Group();

  // Crate body (golden-orange)
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xb8860b, emissive: new THREE.Color(0x3a2400) });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.30, 0.30), bodyMat));

  // Glowing top & bottom rims
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xffdd00 });
  const rimT = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.32), rimMat);
  rimT.position.y = 0.145; g.add(rimT);
  const rimB = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.32), rimMat);
  rimB.position.y = -0.145; g.add(rimB);

  // Bullet silhouette on front face (shaft + wider tip)
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bShaft = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.01), bulletMat);
  bShaft.position.set(0, -0.01, -0.16); g.add(bShaft);
  const bTip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.05, 0.01), bulletMat);
  bTip.position.set(0, 0.095, -0.16); g.add(bTip);
  const bBase = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.01), bulletMat);
  bBase.position.set(0, -0.09, -0.16); g.add(bBase);

  g.position.set(pos.x, 0.55, pos.z);
  scene.add(g);

  ammoPickups.push({ group: g, posX: pos.x, posZ: pos.z, bobClock: Math.random() * Math.PI * 2, lifetime: 14, amount });
}

// ============================================================
//  INPUT
// ============================================================
function togglePvp() {
  pvpMode = !pvpMode;
  if (pvpBtnEl) {
    pvpBtnEl.textContent = pvpMode ? '⚔ PVP ON' : '⚔ PVP OFF';
    pvpBtnEl.classList.toggle('pvp-off', !pvpMode);
  }
  if (socket && socket.connected) socket.emit('pvpMode', { enabled: pvpMode });
}

if (pvpBtnEl) pvpBtnEl.addEventListener('click', togglePvp);

const keys={};
let _chatTyping = false;
document.addEventListener('keydown',e=>{
  // While typing in chat: block all game keys; Escape cancels chat
  if(_chatTyping){
    if(e.key==='Escape'){ e.preventDefault(); _closeChatTyping(); }
    return;
  }
  keys[e.code]=true;
  if(e.code==='Space' && killcamActive) { exitKillcam(); return; }
  if(e.code==='KeyB' && (pointerLocked() || mobileGameActive) && !player.dead && !killcamActive) { toggleEmoteWheel(); return; }
  if(e.code==='Escape' && emoteWheelOpen) { hideEmoteWheel(); return; }
  if(e.code==='KeyR') reloadGun();
  if(e.code==='KeyT' && pointerLocked()) { deactivateScope(); document.exitPointerLock(); }
  if(e.code==='KeyP') togglePvp();
  // Press / while in-game to open chat without unpausing
  if(e.code==='Slash' && pointerLocked() && !isMobile){
    e.preventDefault();
    _openChatTyping();
  }
});
document.addEventListener('keyup', e=>{ if(!_chatTyping) keys[e.code]=false; });

document.addEventListener('mousedown', e=>{
  if(isMobile) return;
  if(e.button!==0) return;
  mouseHeld=true;
  if(!pointerLocked()||!gun.def||_chatTyping) return;
  if(gun.def.oneShot){
    // Sniper: hold to scope in, release to fire
    if(gun.ammo>0) activateScope();
  } else if(!gun.def.auto){
    shoot();
  }
});

document.addEventListener('mouseup', e=>{
  if(isMobile) return;
  if(e.button!==0) return;
  mouseHeld=false;
  if(scopeActive){
    shoot();
    deactivateScope();
  }
});

function activateScope(){
  scopeActive=true;
  targetFov = getAttachments(selectedGunId).scope ? 7 : SCOPE_FOV;
  scopeOverlay.style.display='block';
  crosshairEl.style.display='none';
  weaponRoot.visible=false;
}

function deactivateScope(){
  if(!scopeActive) return;
  scopeActive=false;
  targetFov=NORMAL_FOV;
  scopeOverlay.style.display='none';
  crosshairEl.style.display='';
  weaponRoot.visible=true;
}

const SENS_BASE = 0.0055;  // base sensitivity
document.addEventListener('mousemove',e=>{
  if(!pointerLocked() || _chatTyping) return;
  const sens = SENS_BASE * (_settings.sensitivity || 1.0);
  const invertY = _settings.invertY ? -1 : 1;
  yaw   -= e.movementX * sens;
  pitch -= e.movementY * sens * invertY;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
});

function reloadGun(){
  if(player.dead) return;
  const need=gun.def.ammo - gun.ammo;
  const take=Math.min(need, gun.reserve);
  if(take > 0){
    playReloadSound();
    gun.ammo+=take; gun.reserve-=take; updateAmmoHUD();
    _reloadActive = true; _reloadT = 0;
  }
}

// ============================================================
//  POINTER LOCK
// ============================================================
function pointerLocked(){ return document.pointerLockElement===canvas; }

let gameStarted = false;

playBtn.addEventListener('click', () => {
  if (isMobile) startMobileGame();
  else canvas.requestPointerLock();
});

document.getElementById('main-menu-btn').addEventListener('click', () => {
  window.location.href = '/';
});

const touchPauseBtn = document.getElementById('touch-pause-btn');
if (touchPauseBtn) {
  touchPauseBtn.addEventListener('click', () => {
    mobileGameActive = false;
    const tc = document.getElementById('touch-controls');
    if (tc) tc.style.display = 'none';
    hudEl.style.display = 'none';
    startScreen.style.display = 'flex';
    showBanPanel();
    showCoopPanel();
  });
}

document.getElementById('reset-button').addEventListener('click', () => {
  gameStarted    = false;
  currentLevel   = 1;
  levelActive    = false;
  levelTransitioning = false;
  player.kills   = 0;
  player.health  = player.maxHealth;
  transScreen.style.display = 'none';
  clearBots();
  updateKillHUD();
  updateLevelHUD();
  updateEnemyCountHUD();
  updateHealthHUD();
  if (isMobile) {
    mobileGameActive = false;
    const tc = document.getElementById('touch-controls');
    if (tc) tc.style.display = 'none';
    startScreen.style.display = 'flex';
    hudEl.style.display = 'none';
  }
});

document.addEventListener('pointerlockchange',()=>{
  if(pointerLocked()){
    setupWeapon(selectedGunId);   // always re-setup in case gun was switched
    startScreen.style.display='none';
    hudEl.style.display='block';
    hideBanPanel();
    hideCoopPanel();
    if(!gameStarted){
      gameStarted=true;
      startLevel(1);
      initSocket();
    }
  } else if(!player.dead && !levelTransitioning && !mobileGameActive){
    deactivateScope();
    startScreen.style.display='flex';
    hudEl.style.display='none';
    showBanPanel();
    showCoopPanel();
  }
});

// ============================================================
//  COLLISION
// ============================================================
function resolveCollision(pos, r){
  const e=r+.05;
  pos.x=Math.max(-AW+e, Math.min(AW-e, pos.x));
  pos.z=Math.max(-AD+e, Math.min(AD-e, pos.z));
  for(const b of coverBoxes){
    // Skip second-floor cover when player is on ground floor and vice-versa
    if(b.minY !== undefined){
      const playerFloorY = getGroundY(pos);
      if(playerFloorY < b.minY - 1.0) continue;
    }
    const dx=pos.x-b.cx, dz=pos.z-b.cz;
    const ox=b.hw+r-Math.abs(dx), oz=b.hd+r-Math.abs(dz);
    if(ox>0&&oz>0){
      if(ox<oz) pos.x+=dx>=0?ox:-ox;
      else      pos.z+=dz>=0?oz:-oz;
    }
  }
}

// ============================================================
//  HUD
// ============================================================
function updateHealthHUD(){
  const pct=Math.max(0,player.health)/player.maxHealth*100;
  healthFill.style.width=pct+'%';
  healthText.textContent=Math.max(0,player.health);
  healthFill.style.background = pct>60?'#2ecc71':pct>30?'#f39c12':'#e74c3c';
}
function updateAmmoHUD(){ ammoDisplay.textContent=gun.ammo+' / '+gun.reserve; }
function updateKillHUD(){ killCountEl.textContent='KILLS: '+player.kills; }

function updateRankHUD() {
  const el = document.getElementById('rank-display');
  if (!el) return;
  const rank = getRank(totalKills + player.kills);
  el.textContent = rank.name.toUpperCase();
  el.style.color  = rank.color;
  el.style.textShadow = `0 0 8px ${rank.color}`;
}

function updateModeHUD() {
  const el = document.getElementById('mode-display');
  if (!el) return;
  el.textContent = gameMode.toUpperCase();
  el.style.color = gameMode === 'ffa' ? '#ff4444' : gameMode === 'tdm' ? '#44aaff' : '#888';
}

let _pingMs = 0;
function updatePingHUD() {
  const el = document.getElementById('ping-display');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = _pingMs + ' ms';
  el.className = _pingMs < 60 ? 'ping-good' : _pingMs < 130 ? 'ping-ok' : 'ping-bad';
}

function updateFFAHUD() {
  const el = document.getElementById('ffa-scoreboard');
  if (!el) return;
  if (gameMode !== 'ffa') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div class="ffa-title">FREE FOR ALL</div>' +
    ffaBoard.slice(0, 8).map((r, i) =>
      `<div class="ffa-row">${i===0?'👑':'#'+(i+1)} <span>${_esc(r.username)}</span> <b>${r.kills}</b></div>`
    ).join('');
}

function updateTDMHUD() {
  const el = document.getElementById('tdm-scoreboard');
  if (!el) return;
  if (gameMode !== 'tdm') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const teamLabel = myTeam ? `<div class="tdm-myteam" style="color:${myTeam==='red'?'#ff4444':'#4488ff'}">YOUR TEAM: ${myTeam.toUpperCase()}</div>` : '';
  el.innerHTML = `<div class="tdm-title">TEAM DEATHMATCH</div>
    ${teamLabel}
    <div class="tdm-scores">
      <span style="color:#ff4444">RED ${tdmScores.red}</span>
      <span style="color:#888">vs</span>
      <span style="color:#4488ff">${tdmScores.blue} BLUE</span>
    </div>`;
}
function pushKillFeed(msg){
  const d=document.createElement('div'); d.className='kill-entry';
  d.textContent='» '+msg; killFeedEl.prepend(d);
  setTimeout(()=>d.remove(),3200);
}

// ============================================================
//  SCREEN EFFECTS
// ============================================================
const flashOverlay=document.createElement('div');
flashOverlay.style.cssText='position:fixed;inset:0;background:rgba(220,0,0,0);pointer-events:none;z-index:40;transition:background .12s ease';
document.body.appendChild(flashOverlay);
const vignetteEl=document.createElement('div');
vignetteEl.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:39;opacity:0;background:radial-gradient(ellipse at center,transparent 48%,rgba(200,0,0,0.88) 100%)';
document.body.appendChild(vignetteEl);
function flashDmg(){
  flashOverlay.style.background='rgba(220,0,0,.42)';
  setTimeout(()=>{ flashOverlay.style.background='rgba(220,0,0,0)'; },150);
  _vignetteAlpha=Math.min(1,_vignetteAlpha+0.55);
  vignetteEl.style.opacity=_vignetteAlpha;
}

const deathScreen=document.createElement('div');
deathScreen.style.cssText='position:fixed;inset:0;background:rgba(120,0,0,.65);display:none;flex-direction:column;align-items:center;justify-content:center;color:#fff;z-index:60;pointer-events:none;font-family:Courier New,monospace';
deathScreen.innerHTML='<div style="font-size:72px;color:#e74c3c;letter-spacing:6px;text-shadow:0 0 20px #e74c3c">YOU DIED</div><div style="font-size:18px;margin-top:18px;color:#bbb;letter-spacing:4px">RESPAWNING...</div>';
document.body.appendChild(deathScreen);

// ── Killcam ─────────────────────────────────────────────────────
let killcamActive   = false;
let killcamKiller   = null;   // bot reference that killed the player
let killcamDeathPos = null;   // camera position at moment of death
let _killcamTimer   = null;
let _killcamCountdown = null;

function enterKillcam(killerRef) {
  killcamActive = true;
  killcamKiller = killerRef || null;
  killcamDeathPos = camera.position.clone();

  const overlay = document.getElementById('killcam-overlay');
  if (overlay) overlay.style.display = 'flex';

  // Position camera at killer's head, face toward player's death spot
  if (killcamKiller && killcamKiller.group) {
    const kp = killcamKiller.group.position;
    camera.position.set(kp.x, kp.y + 1.65, kp.z);
    const lookDir = killcamDeathPos.clone().sub(camera.position).normalize();
    yaw   = Math.atan2(-lookDir.x, -lookDir.z);
    pitch = Math.asin(Math.max(-1, Math.min(1, lookDir.y)));
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
  }

  let remaining = 5;
  const countEl = document.getElementById('killcam-countdown');
  if (countEl) countEl.textContent = remaining;
  _killcamCountdown = setInterval(() => {
    remaining--;
    if (countEl) countEl.textContent = remaining;
    if (remaining <= 0) exitKillcam();
  }, 1000);
}

function exitKillcam() {
  if (!killcamActive) return;
  clearInterval(_killcamCountdown);
  _killcamCountdown = null;
  killcamActive = false;
  const overlay = document.getElementById('killcam-overlay');
  if (overlay) overlay.style.display = 'none';
  deathScreen.style.display = 'flex';
  hudEl.style.display = 'none';
  setTimeout(respawnPlayer, 2300);
}

// ── Emote wheel ─────────────────────────────────────────────────
const EMOTE_DEFS = [
  // original 8
  { id:'emote_wave',       emoji:'👋', label:'Wave',       anim:'ea-wave',       dur:5 },
  { id:'emote_dance',      emoji:'💃', label:'Dance',      anim:'ea-dance',      dur:5 },
  { id:'emote_salute',     emoji:'🫡', label:'Salute',     anim:'ea-salute',     dur:4 },
  { id:'emote_point',      emoji:'👆', label:'Point',      anim:'ea-pulse',      dur:4 },
  { id:'emote_laugh',      emoji:'😂', label:'Laugh',      anim:'ea-shake',      dur:5 },
  { id:'emote_taunt',      emoji:'😏', label:'Taunt',      anim:'ea-swagger',    dur:5 },
  { id:'emote_bow',        emoji:'🙇', label:'Bow',        anim:'ea-bow',        dur:5 },
  { id:'emote_flex',       emoji:'💪', label:'Flex',       anim:'ea-zoom',       dur:5 },
  // 53 new
  { id:'emote_clap',       emoji:'👏', label:'Clap',       anim:'ea-pulse',      dur:4 },
  { id:'emote_thumbsup',   emoji:'👍', label:'Thumbs Up',  anim:'ea-bounce',     dur:4 },
  { id:'emote_facepalm',   emoji:'🤦', label:'Facepalm',   anim:'ea-bow',        dur:5 },
  { id:'emote_shrug',      emoji:'🤷', label:'Shrug',      anim:'ea-float',      dur:5 },
  { id:'emote_peace',      emoji:'✌️', label:'Peace',      anim:'ea-float',      dur:4 },
  { id:'emote_heart',      emoji:'❤️', label:'Love',       anim:'ea-heartbeat',  dur:5 },
  { id:'emote_skull',      emoji:'💀', label:'GG',         anim:'ea-float',      dur:5 },
  { id:'emote_fire',       emoji:'🔥', label:'On Fire',    anim:'ea-wiggle',     dur:5 },
  { id:'emote_dizzy',      emoji:'😵', label:'Dizzy',      anim:'ea-spin',       dur:5 },
  { id:'emote_sleep',      emoji:'😴', label:'Sleep',      anim:'ea-float',      dur:6 },
  { id:'emote_cry',        emoji:'😭', label:'Cry',        anim:'ea-cry',        dur:5 },
  { id:'emote_rage',       emoji:'😡', label:'Rage',       anim:'ea-shake',      dur:4 },
  { id:'emote_cool',       emoji:'😎', label:'Cool',       anim:'ea-swagger',    dur:5 },
  { id:'emote_nervous',    emoji:'😅', label:'Nervous',    anim:'ea-headtilt',   dur:4 },
  { id:'emote_think',      emoji:'🤔', label:'Think',      anim:'ea-swing',      dur:5 },
  { id:'emote_kiss',       emoji:'😘', label:'Kiss',       anim:'ea-heartbeat',  dur:5 },
  { id:'emote_explode',    emoji:'🤯', label:'Mind Blown', anim:'ea-explode',    dur:5 },
  { id:'emote_ghost',      emoji:'👻', label:'Ghost',      anim:'ea-float',      dur:5 },
  { id:'emote_robot',      emoji:'🤖', label:'Robot',      anim:'ea-robot',      dur:5 },
  { id:'emote_alien',      emoji:'👽', label:'Alien',      anim:'ea-float',      dur:5 },
  { id:'emote_clown',      emoji:'🤡', label:'Clown',      anim:'ea-spin',       dur:5 },
  { id:'emote_ninja',      emoji:'🥷', label:'Ninja',      anim:'ea-jump',       dur:5 },
  { id:'emote_zombie',     emoji:'🧟', label:'Zombie',     anim:'ea-zombie',     dur:5 },
  { id:'emote_cowboy',     emoji:'🤠', label:'Cowboy',     anim:'ea-swagger',    dur:5 },
  { id:'emote_pirate',     emoji:'⚔️', label:'Pirate',     anim:'ea-swagger',    dur:5 },
  { id:'emote_crown',      emoji:'👑', label:'Crown',      anim:'ea-bounce',     dur:4 },
  { id:'emote_trophy',     emoji:'🏆', label:'Win',        anim:'ea-zoom',       dur:4 },
  { id:'emote_money',      emoji:'💰', label:'Money',      anim:'ea-bounce',     dur:5 },
  { id:'emote_diamond',    emoji:'💎', label:'Diamond',    anim:'ea-sparkle',    dur:5 },
  { id:'emote_sparkle',    emoji:'✨', label:'Sparkle',    anim:'ea-sparkle',    dur:5 },
  { id:'emote_rainbow',    emoji:'🌈', label:'Rainbow',    anim:'ea-rainbow',    dur:6 },
  { id:'emote_thunder',    emoji:'⚡', label:'Thunder',    anim:'ea-flash',      dur:4 },
  { id:'emote_star',       emoji:'⭐', label:'Star',       anim:'ea-sparkle',    dur:5 },
  { id:'emote_100',        emoji:'💯', label:'Perfect',    anim:'ea-zoom',       dur:4 },
  { id:'emote_eyes',       emoji:'👀', label:'Watch Out',  anim:'ea-peek',       dur:5 },
  { id:'emote_run',        emoji:'🏃', label:'Sprint',     anim:'ea-run',        dur:5 },
  { id:'emote_jump',       emoji:'🦘', label:'Jump',       anim:'ea-jump',       dur:4 },
  { id:'emote_spin',       emoji:'🌀', label:'Spin',       anim:'ea-spin',       dur:5 },
  { id:'emote_dab',        emoji:'🫳', label:'Dab',        anim:'ea-dab',        dur:4 },
  { id:'emote_breakdance', emoji:'🕺', label:'Breakdance', anim:'ea-breakdance', dur:5 },
  { id:'emote_moonwalk',   emoji:'🌙', label:'Moonwalk',   anim:'ea-moonwalk',   dur:5 },
  { id:'emote_floss',      emoji:'🎵', label:'Floss',      anim:'ea-floss',      dur:5 },
  { id:'emote_worm',       emoji:'🪱', label:'Worm',       anim:'ea-worm',       dur:5 },
  { id:'emote_splits',     emoji:'🤸', label:'Splits',     anim:'ea-splits',     dur:5 },
  { id:'emote_headbang',   emoji:'🎸', label:'Headbang',   anim:'ea-headbang',   dur:4 },
  { id:'emote_airguitar',  emoji:'🎶', label:'Air Guitar', anim:'ea-airguitar',  dur:5 },
  { id:'emote_sing',       emoji:'🎤', label:'Sing',       anim:'ea-float',      dur:5 },
  { id:'emote_confused',   emoji:'😕', label:'Confused',   anim:'ea-headtilt',   dur:5 },
  { id:'emote_surprised',  emoji:'😲', label:'Surprised',  anim:'ea-explode',    dur:4 },
  { id:'emote_rofl',       emoji:'🤣', label:'ROFL',       anim:'ea-rofl',       dur:5 },
  { id:'emote_sneeze',     emoji:'🤧', label:'Sneeze',     anim:'ea-explode',    dur:4 },
  { id:'emote_sick',       emoji:'🤢', label:'Sick',       anim:'ea-worm',       dur:5 },
  { id:'emote_party',      emoji:'🎉', label:'Party',      anim:'ea-party',      dur:5 },
];
let emoteWheelOpen = false;
let _emotePage     = 0;

function toggleEmoteWheel() {
  emoteWheelOpen ? hideEmoteWheel() : showEmoteWheel();
}

function showEmoteWheel() {
  const equipped  = new Set(JSON.parse(localStorage.getItem('ah_equipped') || '[]'));
  const available = EMOTE_DEFS.filter(e => equipped.has(e.id)).slice(0, 5);
  _renderEmoteWheel(available);
  document.getElementById('emote-wheel').style.display = 'flex';
  document.exitPointerLock();
  emoteWheelOpen = true;
}

function _renderEmoteWheel(available) {
  const ring = document.getElementById('emote-wheel-ring');
  if (!ring) return;
  ring.innerHTML = '';
  const SLOTS = 5, cx = 250, cy = 250, r = 165, sw = 115, sh = 115;
  for (let i = 0; i < SLOTS; i++) {
    const angle = (i / SLOTS) * Math.PI * 2 - Math.PI / 2;
    const x = cx + r * Math.cos(angle) - sw / 2;
    const y = cy + r * Math.sin(angle) - sh / 2;
    const em  = available[i];
    const el  = document.createElement('div');
    el.style.cssText = `left:${x}px;top:${y}px;width:${sw}px;height:${sh}px`;
    if (em) {
      el.className = 'emote-seg';
      el.innerHTML = `<div class="emote-seg-emoji">${em.emoji}</div><div class="emote-seg-label">${em.label}</div>`;
      el.addEventListener('click', () => selectEmote(em));
    } else {
      el.className = 'emote-slot-empty';
      el.innerHTML = `<div class="emote-slot-empty-icon">＋</div><div class="emote-slot-empty-text">EMPTY</div>`;
    }
    ring.appendChild(el);
  }
}

function hideEmoteWheel() {
  document.getElementById('emote-wheel').style.display = 'none';
  emoteWheelOpen = false;
  document.getElementById('gameCanvas').requestPointerLock();
}

function selectEmote(em) {
  hideEmoteWheel();
  playEmote(em);
}

function playEmote(em) {
  const el  = document.getElementById('emote-self-display');
  const dur = (em.dur || 5) * 1000;
  if (el) {
    el.textContent   = em.emoji;
    el.style.opacity = '1';
    el.style.display = 'block';
    el.style.animation = em.anim
      ? `${em.anim} ${em.dur || 5}s ease-in-out infinite`
      : 'none';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; el.style.animation = 'none'; }, 400);
    }, dur);
  }
  const token = localStorage.getItem('ah_token');
  if (socket && socket.connected && token)
    socket.emit('emotePlay', { token, emoteId: em.id });
}

function showRemoteEmote(socketId, rp, em) {
  if (!rp || !rp.group) return;
  const worldPos = rp.group.position.clone().setY(rp.group.position.y + 2.6);
  const v = worldPos.project(camera);
  if (v.z > 1) return;
  const x   = (v.x *  0.5 + 0.5) * window.innerWidth;
  const y   = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const dur = (em.dur || 5) * 1000;
  const el  = document.createElement('div');
  el.style.cssText = `position:fixed;left:${x}px;top:${y}px;transform:translate(-50%,-50%);font-size:42px;z-index:120;pointer-events:none;transition:opacity 0.4s;filter:drop-shadow(0 2px 8px #000);transform-origin:center center`;
  el.textContent = em.emoji;
  if (em.anim) el.style.animation = `${em.anim} ${em.dur || 5}s ease-in-out infinite`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, dur - 400);
  setTimeout(() => el.remove(), dur);
  _startEmoteBody(socketId, rp, em);
}

function _restoreEmoteBody(rp) {
  rp.armGroupR.rotation.x =  1.10;
  rp.armGroupL.rotation.x =  1.10;
  rp.armGroupR.rotation.z = -0.32;
  rp.armGroupL.rotation.z =  0.32;
  rp.legL.rotation.x      =  0;
  rp.legR.rotation.x      =  0;
  rp.group.rotation.x     =  0;
  rp.group.rotation.z     =  0;
  rp.group.scale.setScalar(1);
}

function _startEmoteBody(socketId, rp, em) {
  const existing = _emoteBodyMap.get(socketId);
  if (existing) clearTimeout(existing._restoreTimer);
  const spinAnims = new Set(['ea-spin','ea-breakdance']);
  const dur = (em.dur || 5) * 1000;
  const ea = { em, elapsed: 0, _pyOffset: 0, _spinY: rp.group.rotation.y, _isSpin: spinAnims.has(em.anim) };
  ea._restoreTimer = setTimeout(() => {
    _emoteBodyMap.delete(socketId);
    _restoreEmoteBody(rp);
  }, dur + 400);
  _emoteBodyMap.set(socketId, ea);
}

function _tickEmoteBody(ea, rp, dt) {
  ea.elapsed += dt;
  const t = ea.elapsed;
  ea._pyOffset = 0;
  const anim = ea.em.anim;

  switch (anim) {
    case 'ea-wave': {
      // Full raised-arm wave with natural wrist oscillation and body sway
      const ph = t * 5.0;
      rp.armGroupR.rotation.x = 2.05 + Math.sin(ph) * 0.42;
      rp.armGroupR.rotation.z = -0.88 + Math.sin(ph * 0.8) * 0.22;
      rp.armGroupL.rotation.x = 1.10;
      rp.armGroupL.rotation.z = 0.32;
      rp.group.rotation.z     = Math.sin(ph * 0.4) * 0.05;
      ea._pyOffset             = 0.02;
      break;
    }
    case 'ea-dance': {
      // Full-body rhythmic: alternating arm pumps, leg kicks, hip sway, bounce
      const beat = t * 3.8;
      rp.armGroupR.rotation.x = 1.10 + Math.sin(beat + Math.PI) * 0.95;
      rp.armGroupL.rotation.x = 1.10 + Math.sin(beat) * 0.95;
      rp.armGroupR.rotation.z = -0.32 + Math.cos(beat) * 0.20;
      rp.armGroupL.rotation.z =  0.32 - Math.cos(beat) * 0.20;
      rp.legL.rotation.x      =  Math.sin(beat + 0.6) * 0.28;
      rp.legR.rotation.x      = -Math.sin(beat + 0.6) * 0.28;
      rp.group.rotation.z     =  Math.sin(beat * 0.9) * 0.14;
      ea._pyOffset             =  Math.abs(Math.sin(beat)) * 0.26;
      break;
    }
    case 'ea-bow': {
      // Deep respectful bow — torso bends forward, arms sweep down and back
      const bv  = Math.max(0, Math.sin(t * 1.4));
      rp.group.rotation.x     =  bv * 0.62;
      rp.armGroupL.rotation.x = 1.10 + bv * 0.70;
      rp.armGroupR.rotation.x = 1.10 + bv * 0.70;
      rp.armGroupL.rotation.z =  0.32 + bv * 0.35;
      rp.armGroupR.rotation.z = -0.32 - bv * 0.35;
      ea._pyOffset             = -bv * 0.12;
      break;
    }
    case 'ea-salute': {
      // Military salute: right hand rises to brow and holds, slight body straighten
      const hold = Math.min(1, t * 2.5);
      rp.armGroupR.rotation.x =  1.10 + hold * 1.10;
      rp.armGroupR.rotation.z = -0.32 - hold * 0.60;
      rp.armGroupL.rotation.x =  1.10;
      rp.armGroupL.rotation.z =  0.32;
      rp.group.rotation.x     = -hold * 0.04;
      break;
    }
    case 'ea-pulse':
    case 'ea-heartbeat': {
      // Double-beat pulse with arm raise on each beat
      const hb = t * 6;
      const sc = 1 + Math.max(0, Math.sin(hb) * 0.5) * 0.14;
      rp.group.scale.setScalar(sc);
      rp.armGroupL.rotation.x = 1.10 + Math.max(0, Math.sin(hb)) * 0.5;
      rp.armGroupR.rotation.x = 1.10 + Math.max(0, Math.sin(hb)) * 0.5;
      break;
    }
    case 'ea-shake':
    case 'ea-wiggle': {
      // Angry rapid whole-body shake with flailing arms
      const sh = t * 9;
      rp.group.rotation.z     =  Math.sin(sh) * 0.16;
      rp.armGroupR.rotation.z = -0.32 + Math.sin(sh) * 0.30;
      rp.armGroupL.rotation.z =  0.32 + Math.sin(sh) * 0.30;
      rp.armGroupR.rotation.x =  1.10 + Math.sin(sh + 1) * 0.22;
      rp.armGroupL.rotation.x =  1.10 - Math.sin(sh + 1) * 0.22;
      ea._pyOffset             =  Math.abs(Math.sin(sh * 0.5)) * 0.08;
      break;
    }
    case 'ea-swing': {
      // Pendulum swing with alternating arms and hip counter-rotation
      const sw = Math.sin(t * 3.2);
      rp.armGroupR.rotation.x = 1.10 + sw * 0.88;
      rp.armGroupL.rotation.x = 1.10 - sw * 0.88;
      rp.armGroupR.rotation.z = -0.32 - sw * 0.15;
      rp.armGroupL.rotation.z =  0.32 + sw * 0.15;
      rp.group.rotation.z     =  sw * 0.07;
      break;
    }
    case 'ea-zoom': {
      // Bicep flex — both arms curl up to flex position, body pulses
      const fl = 0.65 + Math.sin(t * 2.2) * 0.35;
      rp.armGroupR.rotation.x =  1.10 + fl * 0.95;
      rp.armGroupL.rotation.x =  1.10 + fl * 0.95;
      rp.armGroupR.rotation.z = -0.88;
      rp.armGroupL.rotation.z =  0.88;
      rp.group.scale.setScalar(1 + Math.sin(t * 3) * 0.05);
      ea._pyOffset             = fl * 0.08;
      break;
    }
    case 'ea-explode': {
      rp.group.scale.setScalar(Math.max(0.8, 1 + Math.sin(t * 2.5) * 0.18));
      rp.armGroupR.rotation.z = -0.62 - Math.sin(t * 2.5) * 0.25;
      rp.armGroupL.rotation.z =  0.62 + Math.sin(t * 2.5) * 0.25;
      break;
    }
    case 'ea-bounce':
    case 'ea-jump': {
      // Springy jump with squat prep and leg tuck
      const jt  = t * 4.2;
      const air = Math.max(0, Math.sin(jt));
      ea._pyOffset       = air * 0.62;
      rp.legL.rotation.x =  air * 0.30;
      rp.legR.rotation.x =  air * 0.30;
      rp.armGroupL.rotation.x = 1.10 - air * 0.45;
      rp.armGroupR.rotation.x = 1.10 - air * 0.45;
      rp.group.rotation.x     = -air * 0.08;
      break;
    }
    case 'ea-float': {
      // Serene floating — gentle rise, arms spread wide, slow sway
      ea._pyOffset             = Math.sin(t * 1.4) * 0.35 + 0.40;
      rp.armGroupL.rotation.x  = 0.72 + Math.sin(t * 1.4) * 0.12;
      rp.armGroupR.rotation.x  = 0.72 + Math.sin(t * 1.4) * 0.12;
      rp.armGroupL.rotation.z  =  0.65;
      rp.armGroupR.rotation.z  = -0.65;
      rp.group.rotation.z      =  Math.sin(t * 0.9) * 0.04;
      break;
    }
    case 'ea-spin': {
      ea._spinY += dt * 5;
      rp.group.rotation.y = ea._spinY;
      rp.armGroupL.rotation.z =  0.88;
      rp.armGroupR.rotation.z = -0.88;
      rp.armGroupL.rotation.x =  0.65;
      rp.armGroupR.rotation.x =  0.65;
      ea._pyOffset             =  0.15;
      break;
    }
    case 'ea-sparkle':
    case 'ea-rainbow':
    case 'ea-flash': {
      rp.armGroupL.rotation.x =  1.90;
      rp.armGroupR.rotation.x =  1.90;
      rp.armGroupL.rotation.z =  0.32 + Math.sin(t * 7) * 0.35;
      rp.armGroupR.rotation.z = -0.32 - Math.sin(t * 7) * 0.35;
      ea._pyOffset             =  Math.abs(Math.sin(t * 3.5)) * 0.14;
      break;
    }
    case 'ea-robot': {
      // Mechanical stepped movement — quantised, jerky, deliberate
      const freq = 2.8;
      const sR   = Math.sign(Math.sin(t * freq)) * 0.5;
      const sL   = Math.sign(Math.sin(t * freq + Math.PI)) * 0.5;
      rp.armGroupR.rotation.x = 1.10 + sR * 0.85;
      rp.armGroupL.rotation.x = 1.10 + sL * 0.85;
      rp.armGroupR.rotation.z = -0.32 + sR * 0.22;
      rp.armGroupL.rotation.z =  0.32 - sL * 0.22;
      rp.legL.rotation.x      =  sL * 0.22;
      rp.legR.rotation.x      = -sR * 0.22;
      rp.group.rotation.z     =  Math.sign(Math.sin(t * freq * 0.75)) * 0.07;
      break;
    }
    case 'ea-zombie': {
      // Slow lurch with outstretched arms and faltering gait
      const lch = t * 0.9;
      rp.armGroupL.rotation.x =  2.10 + Math.sin(lch) * 0.12;
      rp.armGroupR.rotation.x =  2.00 + Math.sin(lch + 0.5) * 0.18;
      rp.armGroupL.rotation.z =  0.10;
      rp.armGroupR.rotation.z = -0.10;
      rp.group.rotation.x     = -0.22 + Math.sin(lch * 0.85) * 0.10;
      rp.group.rotation.z     =  Math.sin(lch * 0.7) * 0.10;
      rp.legL.rotation.x      =  Math.sin(lch) * 0.20;
      rp.legR.rotation.x      = -Math.sin(lch) * 0.20;
      break;
    }
    case 'ea-swagger': {
      // Hip swagger with loose swinging arms and light bounce
      const sw = Math.sin(t * 2.4);
      rp.group.rotation.z     =  sw * 0.20;
      rp.armGroupR.rotation.z = -0.32 + sw * 0.35;
      rp.armGroupL.rotation.z =  0.32 + sw * 0.35;
      rp.armGroupR.rotation.x =  1.10 - Math.abs(sw) * 0.18;
      rp.armGroupL.rotation.x =  1.10 - Math.abs(sw) * 0.18;
      rp.legL.rotation.x      =  sw * 0.14;
      rp.legR.rotation.x      = -sw * 0.14;
      ea._pyOffset             =  Math.abs(sw) * 0.14;
      break;
    }
    case 'ea-rofl': {
      // Rolling on the floor — deep forward bend, arms flailing, bouncing body
      const rf = t * 4.5;
      rp.group.rotation.x     =  0.38 + Math.sin(rf) * 0.15;
      rp.group.rotation.z     =  Math.sin(rf * 0.7) * 0.14;
      rp.armGroupL.rotation.x =  1.10 + Math.sin(rf) * 0.45;
      rp.armGroupR.rotation.x =  1.10 + Math.sin(rf + 1.2) * 0.45;
      ea._pyOffset             = -0.08;
      break;
    }
    case 'ea-headbang': {
      // Aggressive headbang with torso and arms
      const hb = t * 9;
      rp.group.rotation.x     =  Math.sin(hb) * 0.35;
      rp.armGroupL.rotation.x =  1.10 + Math.sin(hb + 0.5) * 0.42;
      rp.armGroupR.rotation.x =  1.10 + Math.sin(hb) * 0.42;
      rp.armGroupL.rotation.z =  0.62;
      rp.armGroupR.rotation.z = -0.62;
      ea._pyOffset             =  Math.abs(Math.sin(hb)) * 0.10;
      break;
    }
    case 'ea-moonwalk': {
      // Smooth moonwalk — backward slide, arms low and casual
      rp.group.rotation.x     = -0.12;
      rp.legL.rotation.x      =  Math.sin(t * 3.2) * 0.38;
      rp.legR.rotation.x      = -Math.sin(t * 3.2) * 0.38;
      rp.armGroupL.rotation.z =  0.18;
      rp.armGroupR.rotation.z = -0.18;
      rp.armGroupL.rotation.x =  0.95;
      rp.armGroupR.rotation.x =  0.95;
      ea._pyOffset             =  Math.abs(Math.sin(t * 3.2)) * 0.06;
      break;
    }
    case 'ea-floss': {
      // Floss dance — hips twist, arms swing hard side to side, legs bounce
      const f = Math.sin(t * 4.5);
      rp.armGroupR.rotation.z = -0.32 + f * 0.95;
      rp.armGroupL.rotation.z =  0.32 + f * 0.95;
      rp.armGroupR.rotation.x =  1.35;
      rp.armGroupL.rotation.x =  1.35;
      rp.group.rotation.z     =  f * 0.10;
      rp.legL.rotation.x      =  Math.abs(f) * 0.15;
      ea._pyOffset             =  Math.abs(f) * 0.12;
      break;
    }
    case 'ea-worm': {
      // Ground-level worm — body undulates, low position
      const wv = Math.sin(t * 3.2);
      rp.group.rotation.x =  wv * 0.38;
      rp.group.rotation.z =  Math.sin(t * 1.6) * 0.06;
      ea._pyOffset         = (wv + 1) * 0.14;
      break;
    }
    case 'ea-dab': {
      // Proper dab — arm shoots up diagonally, head tilts into elbow
      const hold = Math.min(1, t * 3.5);
      rp.armGroupR.rotation.x =  1.10 + hold * 1.30;
      rp.armGroupR.rotation.z = -0.32 - hold * 0.58;
      rp.armGroupL.rotation.x =  1.48;
      rp.armGroupL.rotation.z =  0.55;
      rp.group.rotation.z     = -hold * 0.20;
      rp.group.rotation.x     =  hold * 0.12;
      break;
    }
    case 'ea-run': {
      // Sprint in place — fast leg drive, arm pump, forward lean
      const rt = t * 8;
      rp.legL.rotation.x      =  Math.sin(rt) * 0.60;
      rp.legR.rotation.x      = -Math.sin(rt) * 0.60;
      rp.armGroupL.rotation.x =  1.10 + Math.sin(rt + Math.PI) * 0.62;
      rp.armGroupR.rotation.x =  1.10 + Math.sin(rt) * 0.62;
      rp.group.rotation.x     = -0.12;
      ea._pyOffset             =  Math.abs(Math.sin(rt)) * 0.18;
      break;
    }
    case 'ea-breakdance': {
      ea._spinY += dt * 7.5;
      rp.group.rotation.y = ea._spinY;
      const bd = Math.sin(t * 6);
      rp.armGroupL.rotation.x =  1.10 + bd * 1.05;
      rp.armGroupR.rotation.x =  1.10 - bd * 1.05;
      rp.armGroupL.rotation.z =  0.95;
      rp.armGroupR.rotation.z = -0.95;
      rp.legL.rotation.x      =  Math.sin(t * 6 + 1.5) * 0.45;
      rp.legR.rotation.x      = -Math.sin(t * 6 + 1.5) * 0.45;
      ea._pyOffset             =  Math.abs(bd) * 0.32;
      break;
    }
    case 'ea-splits': {
      rp.legL.rotation.x      = -0.45;
      rp.legR.rotation.x      = -0.45;
      rp.armGroupL.rotation.z =  0.92;
      rp.armGroupR.rotation.z = -0.92;
      rp.armGroupL.rotation.x =  0.80;
      rp.armGroupR.rotation.x =  0.80;
      ea._pyOffset             = -0.22;
      break;
    }
    case 'ea-airguitar': {
      // Air guitar — strumming arm, chord arm, body groove
      const ag = Math.sin(t * 5.5);
      rp.armGroupR.rotation.x =  1.10 + ag * 0.65;
      rp.armGroupR.rotation.z = -0.48;
      rp.armGroupL.rotation.x =  1.45;
      rp.armGroupL.rotation.z =  0.14;
      rp.group.rotation.z     =  Math.sin(t * 2.8) * 0.12;
      ea._pyOffset             =  Math.abs(Math.sin(t * 2.8)) * 0.14;
      break;
    }
    case 'ea-party': {
      // Big celebration — arms thrown up high alternating, whole body bounce
      const p = Math.sin(t * 4.2);
      rp.armGroupL.rotation.x =  1.75 + p * 0.42;
      rp.armGroupR.rotation.x =  1.75 - p * 0.42;
      rp.armGroupL.rotation.z =  0.32 + p * 0.50;
      rp.armGroupR.rotation.z = -0.32 - p * 0.50;
      rp.group.rotation.z     =  p * 0.10;
      rp.legL.rotation.x      =  Math.abs(p) * 0.18;
      ea._pyOffset             =  Math.abs(p) * 0.28;
      break;
    }
    case 'ea-peek': {
      // Cautious peek — lean left then right, arms guard position
      const pk = Math.sin(t * 1.6);
      rp.group.rotation.z     =  pk * 0.30;
      rp.armGroupL.rotation.x =  1.10 + pk * 0.25;
      rp.armGroupR.rotation.x =  1.10 - pk * 0.25;
      rp.armGroupL.rotation.z =  0.55;
      rp.armGroupR.rotation.z = -0.55;
      break;
    }
    case 'ea-cry': {
      // Sobbing — face buried in hands, body shaking
      const cv = t * 3.5;
      rp.group.rotation.x     =  0.20 + Math.sin(cv) * 0.07;
      rp.group.rotation.z     =  Math.sin(cv * 0.8) * 0.06;
      rp.armGroupL.rotation.x =  1.78;
      rp.armGroupR.rotation.x =  1.78;
      rp.armGroupL.rotation.z =  0.04;
      rp.armGroupR.rotation.z = -0.04;
      ea._pyOffset             = -0.04;
      break;
    }
    case 'ea-headtilt': {
      // Confused head tilt with shrug arms
      rp.group.rotation.z     =  Math.sin(t * 2.2) * 0.26;
      rp.armGroupL.rotation.z =  0.32 + Math.sin(t * 2.2) * 0.22;
      rp.armGroupR.rotation.z = -0.32 - Math.sin(t * 2.2) * 0.22;
      rp.armGroupL.rotation.x =  0.85;
      rp.armGroupR.rotation.x =  0.85;
      break;
    }
    default: {
      rp.armGroupR.rotation.x = 1.10 + Math.sin(t * 3) * 0.4;
      break;
    }
  }
}

function killPlayer(killerRef) {
  if(player.dead) return;
  deactivateScope();
  player.dead=true; player.health=0; updateHealthHUD();
  trackDeath();
  _decrementAttachDurability();
  hudEl.style.display='none';
  enterKillcam(killerRef || null);
}
function respawnPlayer(){
  player.health=player.maxHealth; player.dead=false;
  camera.position.copy(SPAWN); yaw=0; pitch=0; velY=0; grounded=true;
  deathScreen.style.display='none';
  if(pointerLocked() || mobileGameActive) hudEl.style.display='block';
  updateHealthHUD();
  gun.ammo=gun.def.ammo; gun.reserve=gun.def.reserve; updateAmmoHUD();
  _weaponRaiseT = 0.5;
  _reloadActive = false; _reloadT = 0;
  _headBobY = 0; _landDipT = 0; _vignetteAlpha = 0;
  vignetteEl.style.opacity = '0';
}

function _decrementAttachDurability() {
  const equipped = JSON.parse(localStorage.getItem('ah_equipped') || '[]');
  const owned    = JSON.parse(localStorage.getItem('ah_owned')    || '[]');
  const uses     = JSON.parse(localStorage.getItem('ah_attach_uses') || '{}');
  const GUN_NAMES = new Set(['pistol','smg','minigun','sniper']);
  const GENERIC   = new Set(['silencer_rare','scope_epic','extmag_rare']);
  let changed = false;

  for (let i = equipped.length - 1; i >= 0; i--) {
    const id    = equipped[i];
    const parts = id.split('_');
    const isGunAttach = parts.length >= 3 && GUN_NAMES.has(parts[parts.length - 2]);
    if (!isGunAttach && !GENERIC.has(id)) continue;

    if (uses[id] === undefined) uses[id] = 2;
    uses[id]--;
    changed = true;

    if (uses[id] <= 0) {
      delete uses[id];
      equipped.splice(i, 1);
      const oi = owned.indexOf(id);
      if (oi !== -1) owned.splice(oi, 1);
      // Tell server to remove the item from ownedItems so it can be repurchased
      const tok = localStorage.getItem('ah_token');
      if (tok) {
        fetch(`${_API_BASE}/api/shop/attachment/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tok}` }
        }).catch(() => {});
      }
    }
  }

  if (changed) {
    localStorage.setItem('ah_equipped',      JSON.stringify(equipped));
    localStorage.setItem('ah_owned',         JSON.stringify(owned));
    localStorage.setItem('ah_attach_uses',   JSON.stringify(uses));
    setupWeapon(selectedGunId);
  }
}

// ── FPS counter state ─────────────────────────────────────────
let _fpsFrames=0, _fpsClock=0, _fpsDisplay=0;

// ============================================================
//  UPDATE
// ============================================================
function update(dt){
  // Smooth FOV zoom for sniper scope
  if(Math.abs(camera.fov - targetFov) > 0.05){
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt*14);
    camera.updateProjectionMatrix();
  }

  camera.rotation.y=yaw; camera.rotation.x=pitch;

  // ── Remove last frame's head-bob offset before physics ──
  camera.position.y -= _headBobY;
  _prevGrounded = grounded;

  // ── Jump / gravity ──────────────────────────────────────
  velY += GRAVITY*dt;
  camera.position.y += velY*dt;
  const _floorY = getGroundY(camera.position) + EYE_H;
  if(camera.position.y <= _floorY){ camera.position.y = _floorY; velY=0; grounded=true; }
  if(camera.position.y >= WH-.6){ camera.position.y=WH-.6; velY=Math.min(0,velY); }

  // ── Landing dip detection ──────────────────────────────
  if(!_prevGrounded && grounded) _landDipT = 0.16;

  // During killcam: track killer bot, keep bots alive, skip player movement
  if (killcamActive) {
    if (killcamKiller && killcamKiller.group) {
      const kp = killcamKiller.group.position;
      camera.position.set(kp.x, kp.y + 1.65, kp.z);
      if (killcamDeathPos) {
        const d = killcamDeathPos.clone().sub(camera.position).normalize();
        yaw   = Math.atan2(-d.x, -d.z);
        pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
        camera.rotation.y = yaw;
        camera.rotation.x = pitch;
      }
    }
    // Fall through to bot AI below (skip player movement via dead-check)
  }
  if((!pointerLocked() && !mobileGameActive && !killcamActive)||player.dead) return;

  // ── Jump input ──────────────────────────────────────────
  if(keys['Space']&&grounded){ velY=JUMP_VEL; grounded=false; }

  // ── Movement ────────────────────────────────────────────
  viewDir.set(-Math.sin(yaw),0,-Math.cos(yaw));
  rightDir.set(Math.cos(yaw),0,-Math.sin(yaw));
  moveVec.set(0,0,0);
  if(keys['KeyW']) moveVec.add(viewDir);
  if(keys['KeyS']) moveVec.sub(viewDir);
  if(keys['KeyA']) moveVec.sub(rightDir);
  if(keys['KeyD']) moveVec.add(rightDir);
  // Touch joystick movement (mobile)
  if(touchMoveInput.x !== 0 || touchMoveInput.y !== 0){
    moveVec.addScaledVector(viewDir,  -touchMoveInput.y);
    moveVec.addScaledVector(rightDir,  touchMoveInput.x);
  }

  const moving=moveVec.lengthSq()>0;
  if(moving){
    moveVec.normalize().multiplyScalar(P_SPEED*dt);
    camera.position.add(moveVec);
    resolveCollision(camera.position,P_RADIUS);
  }

  // ── Auto fire ───────────────────────────────────────────
  if((mouseHeld || touchFireHeld) && gun.def && gun.def.auto && !_chatTyping) shoot();

  // ── Shoot cooldown ──────────────────────────────────────
  if(!gun.canShoot){ gun.shootTimer-=dt; if(gun.shootTimer<=0) gun.canShoot=true; }

  // ── Minigun spin ────────────────────────────────────────
  if(gun.def && gun.def.spinUp){
    const spinning = (mouseHeld || touchFireHeld) && gun.ammo>0;
    mgSpinSpeed = spinning
      ? Math.min(MG_MAX_SPIN, mgSpinSpeed+MG_UP*dt)
      : Math.max(0, mgSpinSpeed-MG_DOWN*dt);
    mgSpin += mgSpinSpeed*dt;
    if(barrelCluster) barrelCluster.rotation.z = mgSpin;
  }

  // ── Muzzle flash timer ──────────────────────────────────
  if(muzzleTimer>0){
    muzzleTimer-=dt;
    if(muzzleTimer<=0){
      const fl=weaponRoot.userData.flash;
      if(fl) fl.visible=false;
      muzzleLight.intensity=0;
    }
  }

  // ── Weapon animations (bob, recoil, sway, raise, reload, sprint) ──
  const bobRate = moving ? 9.0 : 2.2;
  const bobAmp  = moving ? 0.014 : 0.005;
  bobClock += dt * bobRate;
  const decay = 1 - Math.min(1, dt * 11);
  recoilZ *= decay;
  recoilY *= decay;

  if(weaponRoot.userData.baseY !== undefined){
    const bY = weaponRoot.userData.baseY;
    const bX = weaponRoot.userData.baseX;
    const bZ = weaponRoot.userData.baseZ;

    // 1. Weapon raise on spawn/respawn — slides up from -0.35 over 0.5s
    let raiseOffset = 0;
    if(_weaponRaiseT > 0){
      _weaponRaiseT = Math.max(0, _weaponRaiseT - dt);
      const p = _weaponRaiseT / 0.5;  // 1→0
      raiseOffset = -0.35 * p * p;    // quadratic ease
    }

    // 2. Velocity-based weapon sway (move direction relative to view)
    const swayTargetX = moving ? -moveVec.dot(rightDir) * 18 : 0;
    const swayTargetY = moving ? -moveVec.dot(viewDir) * 10 : 0;
    _swayX += (swayTargetX * 0.022 - _swayX) * Math.min(1, dt * 6);
    _swayY += (swayTargetY * 0.014 - _swayY) * Math.min(1, dt * 6);

    // 3. Sprint tilt — weapon tilts right when running forward
    const isSprinting = (keys['KeyW'] || (touchMoveInput.y < -0.5)) && moving;
    const sprintTiltTarget = isSprinting ? 0.14 : 0;
    const _sprintTilt = (weaponRoot.userData._sprintTilt || 0);
    weaponRoot.userData._sprintTilt = _sprintTilt + (sprintTiltTarget - _sprintTilt) * Math.min(1, dt * 7);

    // 4. Per-weapon reload animation (visual only)
    let reloadOffsetY = 0, reloadOffsetZ = 0;
    let reloadRotX = 0, reloadRotZ = 0;
    if(_reloadActive){
      _reloadT = Math.min(1, _reloadT + dt * 1.6);
      const rt = _reloadT;
      const wave = Math.sin(rt * Math.PI);  // 0→1→0 arc
      const gId = gun.def ? gun.def.id : '';
      if(gId === 'pistol'){
        reloadRotZ = wave * 0.55;            // tilt sideways
        reloadOffsetY = -wave * 0.06;
      } else if(gId === 'smg'){
        reloadOffsetY = -wave * 0.14;        // drops down and snaps back
        reloadOffsetZ = wave * 0.05;
      } else if(gId === 'minigun'){
        // Minigun handled by spin; slight raise only
        reloadOffsetY = wave * 0.04;
      } else if(gId === 'sniper'){
        reloadRotX = rt < 0.5                // pull bolt back then forward
          ? rt * 2 * 0.32
          : (1 - (rt - 0.5) * 2) * 0.32;
        reloadOffsetZ = reloadRotX * 0.08;
      }
      if(_reloadT >= 1) _reloadActive = false;
    }

    // 5. Compose final position/rotation
    weaponRoot.position.y  = bY + Math.sin(bobClock) * bobAmp + recoilY + raiseOffset + _swayY + reloadOffsetY;
    weaponRoot.position.x  = bX + Math.sin(bobClock * 0.5) * bobAmp * 0.55 + _swayX;
    weaponRoot.position.z  = bZ + recoilZ + reloadOffsetZ;
    weaponRoot.rotation.x  = -recoilY * 1.6 + reloadRotX;
    weaponRoot.rotation.z  = weaponRoot.userData._sprintTilt + reloadRotZ;
  }

  // ── Head bob (camera) ────────────────────────────────────
  const hbAmp = moving ? 0.022 : 0.004;
  _headBobY = Math.sin(bobClock) * hbAmp;
  // Landing dip adds an extra downward snap
  if(_landDipT > 0){
    _landDipT = Math.max(0, _landDipT - dt);
    const dipFrac = _landDipT / 0.16;
    _headBobY -= Math.sin(dipFrac * Math.PI) * 0.065;
  }
  // Smooth crouch
  _crouchTarget = keys['KeyC'] ? -0.35 : 0;
  _crouchOffset += (_crouchTarget - _crouchOffset) * Math.min(1, dt * 10);
  camera.position.y += _headBobY + _crouchOffset;

  // ── Low-health breathing pulse ───────────────────────────
  if(player.health > 0 && player.health < 25 && !player.dead){
    const breathe = Math.sin(Date.now() * 0.003) * 0.009;
    camera.position.y += breathe;
    camera.fov = (camera.fov || 72) + breathe * 1.2;
    camera.updateProjectionMatrix();
  }

  // ── Damage vignette fade ─────────────────────────────────
  if(_vignetteAlpha > 0){
    _vignetteAlpha = Math.max(0, _vignetteAlpha - dt * 1.1);
    vignetteEl.style.opacity = _vignetteAlpha.toFixed(3);
  }

  // ── Crosshair hit-confirm flash ──────────────────────────
  if(_hitConfirmT > 0){
    _hitConfirmT = Math.max(0, _hitConfirmT - dt);
    const scale = 1 + (_hitConfirmT / 0.14) * 0.22;
    crosshairEl.style.transform = `scale(${scale.toFixed(3)})`;
    crosshairEl.style.filter    = `brightness(${(1 + (_hitConfirmT / 0.14) * 3).toFixed(2)}) drop-shadow(0 0 4px #00aaff)`;
  } else if(crosshairEl.style.transform){
    crosshairEl.style.transform = '';
    crosshairEl.style.filter    = '';
  }

  // ── Hurt cooldown ───────────────────────────────────────
  if(player.hurtTimer>0) player.hurtTimer-=dt;

  // ── Footstep timer ──────────────────────────────────────
  if(moving && !player.dead && levelActive){
    _footstepTimer += dt;
    if(_footstepTimer >= 0.45){
      _footstepTimer = 0;
      playFootstep(currentBiome ? currentBiome.footstep : 'default');
    }
  } else {
    _footstepTimer = 0;
  }

  // ── Audio listener update ────────────────────────────────
  updateAudioListener();

  // ── Hit-spark particles (blue) ───────────────────────────
  for(let i=bloodParticles.length-1; i>=0; i--){
    const p=bloodParticles[i];
    p.age += dt;
    p.vel.y -= 18 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    const pMaxAge = p.maxAge || 0.55;
    if(p.age > pMaxAge){
      scene.remove(p.mesh);
      p.mesh.geometry.dispose(); p.mesh.material.dispose();
      bloodParticles.splice(i,1);
    } else {
      p.mesh.material.opacity = Math.max(0, 1 - p.age / pMaxAge);
      if(!p.mesh.material.transparent){ p.mesh.material.transparent = true; }
    }
  }

  // ── Static death particles ────────────────────────────────
  for(let i=staticParticles.length-1;i>=0;i--){
    const p=staticParticles[i]; p.age+=dt;
    if(p.age>p.maxAge){ scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); staticParticles.splice(i,1); continue; }
    p.vel.y-=12*dt;
    p.mesh.position.addScaledVector(p.vel,dt);
    const t=p.age/p.maxAge;
    p.mesh.material.opacity=1-t;
  }

  // ── Shell casings ─────────────────────────────────────────
  for(let i=shellCasings.length-1;i>=0;i--){
    const c=shellCasings[i];
    c.age+=dt;
    if(c.age>3.5){ scene.remove(c.mesh); c.mesh.geometry.dispose(); shellCasings.splice(i,1); continue; }
    c.vel.y-=9.8*dt;
    c.mesh.position.addScaledVector(c.vel,dt);
    c.mesh.rotation.x+=c.rotVel.x*dt;
    c.mesh.rotation.z+=c.rotVel.z*dt;
    if(c.mesh.position.y<0.05&&!c.bounced){
      c.vel.y=Math.abs(c.vel.y)*0.3;
      c.vel.x*=0.5; c.vel.z*=0.5;
      c.rotVel.multiplyScalar(0.4);
      c.bounced=true;
      c.mesh.position.y=0.05;
    }
  }

  // ── Bullet impact dust ────────────────────────────────────
  for(let i=impactParticles.length-1;i>=0;i--){
    const p=impactParticles[i]; p.age+=dt;
    if(p.age>p.maxAge){ scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); impactParticles.splice(i,1); continue; }
    p.vel.y-=4*dt;
    p.mesh.position.addScaledVector(p.vel,dt);
    const t=p.age/p.maxAge;
    p.mesh.material.opacity=0.7*(1-t);
    p.mesh.scale.setScalar(1+t*0.5);
  }

  // ── Biome ambient particles ───────────────────────────────
  if(biomeParticles.length>0 && currentBiome){
    const pType = currentBiome.particleType;
    const px2=camera.position.x, py2=camera.position.y, pz2=camera.position.z;
    const RADIUS=20;
    for(let i=0;i<biomeParticles.length;i++){
      const bp2=biomeParticles[i];
      const m=bp2.mesh;
      if(pType==='snow'){
        m.position.y-=(bp2.vy+0)*dt; // snow falls
        m.position.x+=bp2.vx*dt*0.3;
        m.position.z+=bp2.vz*dt*0.3;
        if(m.position.y<0){ m.position.y=py2+4+Math.random()*4; m.position.x=px2+(Math.random()-0.5)*RADIUS*2; m.position.z=pz2+(Math.random()-0.5)*RADIUS*2; }
      } else if(pType==='embers'){
        m.position.y+=bp2.vy*dt; // embers rise
        m.position.x+=bp2.vx*dt*0.5;
        m.position.z+=bp2.vz*dt*0.5;
        m.rotation.x+=bp2.rx*dt; m.rotation.z+=bp2.rz*dt;
        if(m.position.y>WH){ m.position.y=0.2+Math.random()*0.5; m.position.x=px2+(Math.random()-0.5)*RADIUS*2; m.position.z=pz2+(Math.random()-0.5)*RADIUS*2; }
      } else if(pType==='leaves'){
        m.position.y-=bp2.vy*dt;
        m.position.x+=Math.sin(Date.now()*0.001+bp2.phase)*dt*1.2;
        m.position.z+=Math.cos(Date.now()*0.001+bp2.phase)*dt*1.2;
        m.rotation.y+=bp2.ry*dt; m.rotation.x+=bp2.rx*dt;
        if(m.position.y<0){ m.position.y=py2+5+Math.random()*3; m.position.x=px2+(Math.random()-0.5)*RADIUS*2; m.position.z=pz2+(Math.random()-0.5)*RADIUS*2; }
      } else if(pType==='sand'){
        m.position.x+=bp2.vx*dt;
        m.position.z+=bp2.vz*dt;
        m.position.y+=Math.sin(Date.now()*0.002+bp2.phase)*dt*0.5;
        const dx2=m.position.x-px2, dz2=m.position.z-pz2;
        if(dx2*dx2+dz2*dz2>RADIUS*RADIUS){ m.position.x=px2+(Math.random()-0.5)*RADIUS*2; m.position.z=pz2+(Math.random()-0.5)*RADIUS*2; m.position.y=Math.random()*2; }
      } else if(pType==='stars'){
        // Stars: nearly static, move gently with player
        const dist=Math.sqrt((m.position.x-px2)**2+(m.position.z-pz2)**2);
        if(dist>60){ m.position.x=px2+(Math.random()-0.5)*100; m.position.z=pz2+(Math.random()-0.5)*100; m.position.y=Math.random()*WH; }
      }
    }
  }

  // ── FPS counter ──────────────────────────────────────────
  _fpsFrames++;
  _fpsClock+=dt;
  if(_fpsClock>=0.5){ _fpsDisplay=Math.round(_fpsFrames/_fpsClock); _fpsFrames=0; _fpsClock=0; }
  const fpsEl=document.getElementById('fps-counter');
  if(fpsEl) fpsEl.textContent=(_settings.showFps||_loadSettings().showFps)?_fpsDisplay+'fps':'';

  // ── Bot AI ──────────────────────────────────────────────
  const px=camera.position.x, pz=camera.position.z;
  const playerGroundY = getGroundY(camera.position);
  bots.forEach(bot=>{
    // Bot death animation — collapse backward with electric glow
    if(bot.dying){
      bot.deathClock += dt;
      bot.deathArcT  += dt;
      const t = Math.min(1, bot.deathClock / 0.5);
      // Ease-in backward fall
      const tEased = t * t;
      bot.group.rotation.x = tEased * (Math.PI * 0.52);
      bot.group.position.y = Math.max(0, getGroundY(bot.group.position) - tEased * 0.28);
      // Arms spread outward as bot falls
      bot.armGroupL.rotation.z =  0.32 + tEased * 0.9;
      bot.armGroupR.rotation.z = -0.32 - tEased * 0.9;
      // Electric glow pulses blue during collapse
      if(bot.deathArcT < 0.8){
        const glowPulse = 0.8 + Math.sin(bot.deathArcT * 28) * 0.5;
        bot.allMats.forEach(m => { m.emissive.setHex(0x0066ff); m.emissiveIntensity = glowPulse * (1 - bot.deathArcT / 0.8); });
      }
      if(t >= 1 && !bot.group.userData.fallen){
        bot.group.userData.fallen = true;
        bot.allMats.forEach(m => { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; });
        setTimeout(() => { if(bot.group.parent) bot.group.visible = false; }, 400);
      }
      return;
    }
    if(!bot.alive) return;

    const bp  = bot.group.position;
    const spd = bot.speed, det=bot.detectR, dmg=bot.damage;

    // Snap bot Y to terrain height
    const botGY = getGroundY(bp);
    bp.y = botGY;

    // Determine if player is on a different floor
    const heightDiff = playerGroundY - botGY;
    const diffFloor  = Math.abs(heightDiff) > 1.5;

    const distToPlayer = Math.sqrt((px-bp.x)**2+(pz-bp.z)**2);
    const los = !diffFloor && botHasLOS(bp.x, bp.z, px, pz);

    // Alert level: escalate on detect or LOS, slowly decay on patrol
    if(los && distToPlayer < det)        bot.alertLevel = 2;
    else if(distToPlayer < det * 0.65)   bot.alertLevel = Math.max(bot.alertLevel, 1);
    else if(bot.alertLevel > 0)          bot.alertLevel = Math.max(0, bot.alertLevel - dt * 0.4);

    // ── Stuck detection ────────────────────────────────────
    const moved = Math.sqrt((bp.x-bot.lastPos.x)**2+(bp.z-bot.lastPos.z)**2);
    if(moved < 0.01 * dt * spd){ bot.stuckTimer += dt; } else { bot.stuckTimer = 0; }
    bot.lastPos.set(bp.x, bp.y, bp.z);
    if(bot.stuckTimer > 0.9){
      // Nudge toward player with a random perpendicular offset
      const angle = Math.atan2(px-bp.x, pz-bp.z) + (Math.random()-.5)*Math.PI;
      bot.patrolTarget.set(bp.x+Math.sin(angle)*6, 0, bp.z+Math.cos(angle)*6);
      bot.patrolTimer = 1.8; bot.stuckTimer = 0;
    }

    // ── Flank angle drift ──────────────────────────────────
    bot.flankChangeTimer -= dt;
    if(bot.flankChangeTimer <= 0){
      bot.flankAngle    = (Math.random()-.5) * 1.4;
      bot.flankChangeTimer = 1.8 + Math.random() * 2.2;
    }

    // ── Movement ───────────────────────────────────────────
    if(bot.alertLevel >= 2){
      // Choose movement target — steer toward staircase when floors differ
      let targetX = px, targetZ = pz;
      if(diffFloor){
        const wp = heightDiff > 0
          ? nearestStairEntry(bp, false)
          : nearestStairEntry(bp, true);
        targetX = wp.x; targetZ = wp.z;
      } else if(distToPlayer > BOT_MELEE + 1.5){
        // Approach with a slight flank offset to avoid head-on rushing
        const baseAngle = Math.atan2(px-bp.x, pz-bp.z);
        const fa = baseAngle + bot.flankAngle * 0.5;
        const flankDist = Math.min(distToPlayer * 0.4, 8);
        targetX = px + Math.sin(fa + Math.PI) * flankDist;
        targetZ = pz + Math.cos(fa + Math.PI) * flankDist;
        // If that target is inside a cover box, fall back to direct
        if(_inCoverBox(targetX, targetZ, BOT_RADIUS)) { targetX=px; targetZ=pz; }
      }

      const dx=targetX-bp.x, dz=targetZ-bp.z;
      const dist=Math.sqrt(dx*dx+dz*dz);
      bot.group.rotation.y = Math.atan2(dx,dz) + Math.PI;

      if(dist > 0.15 && distToPlayer > BOT_MELEE * 0.8){
        const targetSpd = (distToPlayer > 12 ? spd : spd * 0.75);
        const accel = 9.0;
        bot.velX += ((dx/dist)*targetSpd - bot.velX) * Math.min(1, dt * accel);
        bot.velZ += ((dz/dist)*targetSpd - bot.velZ) * Math.min(1, dt * accel);
        bp.x += bot.velX * dt; bp.z += bot.velZ * dt;
        bot.walkClock += dt * spd;
      } else {
        // Decelerate to stop
        bot.velX *= Math.max(0, 1 - dt * 12);
        bot.velZ *= Math.max(0, 1 - dt * 12);
      }

      // Melee attack — phantom bots deal 30% extra damage
      const meleeDmg = bot.mode === 'phantom' ? Math.round(dmg * 1.3) : dmg;
      if(!diffFloor && distToPlayer<BOT_MELEE && player.hurtTimer<=0){
        player.health -= meleeDmg; player.hurtTimer = BOT_DMG_INT;
        updateHealthHUD(); flashDmg();
        if(player.health<=0) killPlayer(bot);
      }

      // ── Bot shooting (shooter mode only) ─────────────────
      if(bot.mode === 'shooter'){
        bot.shootTimer -= dt;
        if(bot.flashTimer > 0){
          bot.flashTimer -= dt;
          if(bot.flashTimer <= 0 && bot.pistol) bot.pistol.userData.flash.visible = false;
        }

        if(bot.shootTimer <= 0 && los && distToPlayer < BOT_SHOOT_DST && distToPlayer > BOT_MELEE){
          bot.shootTimer = bot.shootCooldown;

          const spread = 0.18;
          const eyeY = bp.y + 1.4;
          const ex=bp.x, ez=bp.z;
          const tx=px+(Math.random()-.5)*spread*distToPlayer*0.22;
          const tz=pz+(Math.random()-.5)*spread*distToPlayer*0.22;
          const ty=EYE_H + (Math.random()-.5)*0.35;

          const dir = new THREE.Vector3(tx-ex, ty-eyeY, tz-ez).normalize();
          const bPos = new THREE.Vector3(ex, eyeY, ez);

          const bMat = new THREE.MeshBasicMaterial({color:0xffcc22});
          const bMesh= new THREE.Mesh(new THREE.SphereGeometry(0.055,4,4), bMat);
          bMesh.position.copy(bPos);
          scene.add(bMesh);

          const maxD = distToPlayer + 4;
          botBullets.push({ mesh:bMesh, pos:bPos.clone(), vel:dir.clone().multiplyScalar(BOT_BULLET_V), dist:0, maxDist:maxD, sourceBot:bot });

          if(bot.pistol){ bot.pistol.userData.flash.visible=true; bot.flashTimer=0.08; }
          playSpatialBotSound(bPos, 'botShoot');
          bot.armGroupR.rotation.x = 0.55;
        } else if(bot.shootTimer > bot.shootCooldown * 0.6){
          bot.armGroupR.rotation.x += (1.10 - bot.armGroupR.rotation.x) * dt * 4;
        }
      }

      // ── Phantom mode: glow + teleport behind player ───────
      if(bot.mode === 'phantom'){
        if(bot.phantomTpCooldown > 0) bot.phantomTpCooldown -= dt;

        // Check if player is looking at this bot (dot product of camera forward vs direction to bot)
        const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
        const toDX = bp.x - px, toDZ = bp.z - pz;
        const toDLen = Math.sqrt(toDX*toDX + toDZ*toDZ);
        const lookDot = toDLen > 0.1 ? (fwdX*(toDX/toDLen) + fwdZ*(toDZ/toDLen)) : 0;
        const playerSeesBot = lookDot > 0.60 && los && distToPlayer < det;

        if(playerSeesBot && bot.phantomTpCooldown <= 0){
          bot.phantomLookTimer += dt;
          if(!bot.phantomGlowing){
            bot.phantomGlowing = true;
          }
          // Pulse purple glow intensity
          const pulse = 1.2 + Math.sin(bot.phantomLookTimer * Math.PI * 3) * 0.5;
          bot.allMats.forEach(m => { m.emissive.setHex(0x9900ff); m.emissiveIntensity = pulse; });

          if(bot.phantomLookTimer >= 2.0){
            // Teleport directly behind the player
            bot.phantomLookTimer = 0;
            bot.phantomTpCooldown = 3.0;
            bot.phantomGlowing = false;
            bot.allMats.forEach(m => { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; });
            // "Behind" = opposite of camera forward direction
            bp.x = px + Math.sin(yaw) * 1.4;
            bp.z = pz + Math.cos(yaw) * 1.4;
            bp.y = getGroundY(bp);
            bot.alertLevel = 2;
          }
        } else if(!playerSeesBot && bot.phantomGlowing){
          bot.phantomGlowing = false;
          bot.phantomLookTimer = Math.max(0, bot.phantomLookTimer - dt * 2);
          bot.allMats.forEach(m => { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; });
        }
      }

    } else {
      // Patrol
      bot.patrolTimer -= dt;
      if(bot.patrolTimer<=0){ bot.patrolTarget=rndPos(); bot.patrolTimer=2.5+Math.random()*3.5; }
      const pdx=bot.patrolTarget.x-bp.x, pdz=bot.patrolTarget.z-bp.z;
      const pd=Math.sqrt(pdx*pdx+pdz*pdz);
      if(pd > 0.6){
        const patSpd = spd * 0.52;
        bot.velX += ((pdx/pd)*patSpd - bot.velX) * Math.min(1, dt * 7);
        bot.velZ += ((pdz/pd)*patSpd - bot.velZ) * Math.min(1, dt * 7);
        bp.x += bot.velX * dt; bp.z += bot.velZ * dt;
        bot.group.rotation.y = Math.atan2(pdx, pdz) + Math.PI;
        bot.walkClock += dt * patSpd;
      } else {
        bot.velX *= Math.max(0, 1 - dt * 10);
        bot.velZ *= Math.max(0, 1 - dt * 10);
        bot.patrolTimer = 0;
      }
    }

    // Wall collision — bots can't walk through cover
    resolveCollision(bp, BOT_RADIUS);
    bp.x=Math.max(-AW+1,Math.min(AW-1,bp.x));
    bp.z=Math.max(-AD+1,Math.min(AD-1,bp.z));

    // Idle bob — bots gently bob when standing still
    const isMoving = Math.sqrt(bot.velX*bot.velX + bot.velZ*bot.velZ) > 0.3;
    bot.idleClock += dt * (isMoving ? 0 : 1.6);
    const idleBob = isMoving ? 0 : Math.sin(bot.idleClock) * 0.032;
    bot.group.position.y = getGroundY(bot.group.position) + idleBob;

    // Leg swing animation (only when moving)
    const legSwing = isMoving ? Math.sin(bot.walkClock*2.5)*0.32 : 0;
    bot.legL.rotation.x =  legSwing;
    bot.legR.rotation.x = -legSwing;

    // Shooting aim — torso slightly leans toward player when aiming
    if(bot.mode === 'shooter' && bot.alertLevel >= 2){
      const aimTarget = distToPlayer < BOT_SHOOT_DST ? -0.10 : 0;
      bot.shootAimT += (aimTarget - bot.shootAimT) * Math.min(1, dt * 5);
      bot.group.rotation.x = bot.shootAimT;
    } else {
      bot.shootAimT += (0 - bot.shootAimT) * Math.min(1, dt * 5);
      bot.group.rotation.x = bot.shootAimT;
    }

    // Health bar
    const f = bot.hp / bot.maxHp;
    bot.hpFill.scale.x    = Math.max(0.001, f);
    bot.hpFill.position.x = (f-1)*0.34;
    bot.hpFillMat.color.setHex(f>.66 ? 0x22dd44 : f>.33 ? 0xffaa00 : 0xff2200);
    bot.hpBarGroup.lookAt(camera.position);
  });

  // ── Bot bullet update ────────────────────────────────────
  for(let i=botBullets.length-1; i>=0; i--){
    const b = botBullets[i];
    const step = b.vel.clone().multiplyScalar(dt);
    b.pos.add(step);
    b.dist += step.length();
    b.mesh.position.copy(b.pos);

    let remove = false;

    // Hit arena boundary
    if(Math.abs(b.pos.x)>AW||Math.abs(b.pos.z)>AD) remove=true;

    // Hit cover box
    if(!remove && _inCoverBox(b.pos.x, b.pos.z, 0.05)) remove=true;

    // Max travel distance
    if(!remove && b.dist > b.maxDist) remove=true;

    // Hit player
    if(!remove){
      const dx=b.pos.x-px, dz=b.pos.z-pz, dy=b.pos.y-camera.position.y;
      if(Math.sqrt(dx*dx+dy*dy+dz*dz)<0.65 && player.hurtTimer<=0){
        player.health -= BOT_BULLET_DMG;
        player.hurtTimer = 0.18;
        updateHealthHUD(); flashDmg();
        spawnBlood(b.pos.clone(), 6);
        if(player.health<=0) killPlayer(b.sourceBot || null);
        remove=true;
      }
    }

    if(remove){
      scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      botBullets.splice(i,1);
    }
  }

  // ── Remote player interpolation ─────────────────────────────
  remotePlayers.forEach((rp, _rpId) => {
    const ea     = _emoteBodyMap.get(_rpId);
    const moving = rp.group.position.distanceTo(rp.targetPos) > 0.02;
    rp.group.position.lerp(rp.targetPos, 0.18);

    if (ea) {
      _tickEmoteBody(ea, rp, dt);
      rp.group.position.y += ea._pyOffset;
      // Spin animations drive yaw themselves; skip normal lerp
      if (!ea._isSpin) {
        let dy = rp.targetRotY - rp.group.rotation.y;
        if (dy >  Math.PI) dy -= Math.PI * 2;
        if (dy < -Math.PI) dy += Math.PI * 2;
        rp.group.rotation.y += dy * 0.2;
      }
    } else {
      // Smooth yaw: find shortest angle delta
      let dy = rp.targetRotY - rp.group.rotation.y;
      if(dy >  Math.PI) dy -= Math.PI*2;
      if(dy < -Math.PI) dy += Math.PI*2;
      rp.group.rotation.y += dy * 0.2;
      // Leg swing when moving
      if(moving) {
        rp.walkClock += 0.1;
        rp.legL.rotation.x =  Math.sin(rp.walkClock * 2.5) * 0.32;
        rp.legR.rotation.x = -Math.sin(rp.walkClock * 2.5) * 0.32;
      }
    }
    // Muzzle flash fade
    if(rp.remoteGun.flashTimer > 0) {
      rp.remoteGun.flashTimer -= dt;
      const t = Math.max(0, rp.remoteGun.flashTimer / 0.10);
      rp.remoteGun.flashLight.intensity = t * 5;
      rp.remoteGun.flashMat.opacity = t;
      if(rp.remoteGun.flashTimer <= 0) {
        rp.remoteGun.flashLight.intensity = 0;
        rp.remoteGun.flashMat.opacity = 0;
      }
    }
  });

  // ── Co-op: host broadcasts bot states to guests ─────────────
  if (coopIsHost && coopGuests.size > 0 && socket) {
    coopBotTimer += dt;
    if (coopBotTimer > 0.12) {
      coopBotTimer = 0;
      socket.emit('coopBots', bots.map(b => ({
        alive: b.alive,
        x: b.group.position.x, y: b.group.position.y, z: b.group.position.z,
        ry: b.group.rotation.y,
      })));
    }
  }

  // ── Ammo pickup animation & collection ──────────────────────
  for (let i = ammoPickups.length - 1; i >= 0; i--) {
    const pk = ammoPickups[i];
    pk.lifetime -= dt;
    pk.bobClock += dt * 2.4;

    // Float and spin
    pk.group.position.y  = 0.44 + Math.sin(pk.bobClock) * 0.14;
    pk.group.rotation.y += dt * 1.8;

    // Blink during last 4 seconds
    if (pk.lifetime < 4) {
      pk.group.visible = Math.sin(pk.lifetime * 14) > 0;
    }

    // Collect on proximity
    const dx = camera.position.x - pk.posX;
    const dz = camera.position.z - pk.posZ;
    if (dx * dx + dz * dz < 1.6 * 1.6) {
      gun.reserve += pk.amount;
      updateAmmoHUD();
      pushKillFeed(`+${pk.amount} AMMO PICKED UP`);
      scene.remove(pk.group);
      ammoPickups.splice(i, 1);
      continue;
    }

    // Expire
    if (pk.lifetime <= 0) {
      scene.remove(pk.group);
      ammoPickups.splice(i, 1);
    }
  }
}

// ============================================================
//  RESIZE
// ============================================================
window.addEventListener('resize',()=>{
  const w=window.innerWidth, h=window.innerHeight;
  camera.aspect=w/h;
  camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
  composer.setSize(w,h);
  const pr=Math.min(window.devicePixelRatio,1.5);
  fxaaPass.material.uniforms['resolution'].value.set(1/(w*pr), 1/(h*pr));
});

// ============================================================
//  RENDER LOOP
// ============================================================
const clock=new THREE.Clock();
let _lastFrameTs = 0;
const _FRAME_MS  = 1000 / 60;  // ~16.67 ms — hard 60 fps cap

function animate(ts = 0) {
  requestAnimationFrame(animate);
  if (ts - _lastFrameTs < _FRAME_MS) return;
  _lastFrameTs = ts;
  const dt = Math.min(clock.getDelta(), 0.05);
  if (levelActive) renderer.shadowMap.needsUpdate = true;
  update(dt);
  composer.render();
}

// ============================================================
//  LEVEL SYSTEM
// ============================================================

let currentLevel     = 1;
let levelActive      = false;
let levelTransitioning = false;

// ─── BIOMES ──────────────────────────────────────────────────
const BIOMES = [
  {
    name: 'FACILITY',
    bg: 0x080810, fogDensity: 0.008,
    wall: 0x10182a, floor: null, ceil: 0x030306,
    trim: 0x1a3a70, trimE: 0x1a3a90,
    pillar: 0x18243a, ambient: 0x1a2040, ambientI: 0.28,
    sun: 0xfff0dd, sunI: 0.80,
    accentColors: [0xff2200, 0x0044ff, 0x00ff88, 0xff9900],
    particleType: null, footstep: 'default', biomeId: 0,
  },
  {
    name: 'ICE TUNDRA',
    bg: 0xaaccdd, fogDensity: 0.014,
    wall: 0x7aaccc, floor: 0xc0d8e8, ceil: 0x4488aa,
    trim: 0x44ccff, trimE: 0x88eeff,
    pillar: 0x6699aa, ambient: 0x8ab4cc, ambientI: 0.45,
    sun: 0xe0f0ff, sunI: 0.6,
    accentColors: [0x44ccff, 0x88eeff, 0x22aadd, 0x66ddff],
    particleType: 'snow', footstep: 'ice', biomeId: 1,
  },
  {
    name: 'LAVA FORGE',
    bg: 0x1a0800, fogDensity: 0.010,
    wall: 0x2a1008, floor: 0x1a0e04, ceil: 0x140600,
    trim: 0xff4400, trimE: 0xff6600,
    pillar: 0x3a1808, ambient: 0x3a1800, ambientI: 0.35,
    sun: 0xff8833, sunI: 0.9,
    accentColors: [0xff4400, 0xff8800, 0xff2200, 0xffaa00],
    particleType: 'embers', footstep: 'lava', biomeId: 2,
  },
  {
    name: 'NEON FOREST',
    bg: 0x020a04, fogDensity: 0.011,
    wall: 0x0c1e0c, floor: 0x080e08, ceil: 0x040804,
    trim: 0x00cc44, trimE: 0x00ff66,
    pillar: 0x0a180a, ambient: 0x0a1e08, ambientI: 0.38,
    sun: 0x88ffaa, sunI: 0.5,
    accentColors: [0x00ff44, 0x44ff88, 0x00cc22, 0x88ff00],
    particleType: 'leaves', footstep: 'forest', biomeId: 3,
  },
  {
    name: 'SAND DESERT',
    bg: 0xc8a060, fogDensity: 0.009,
    wall: 0xa07840, floor: 0xc8a870, ceil: 0x8a6428,
    trim: 0xffdd88, trimE: 0xffe0a0,
    pillar: 0x9a7040, ambient: 0xb89060, ambientI: 0.55,
    sun: 0xfff0bb, sunI: 1.0,
    accentColors: [0xffee00, 0xff8800, 0xffcc00, 0xddaa00],
    particleType: 'sand', footstep: 'desert', biomeId: 4,
  },
  {
    name: 'CYBER CITY',
    bg: 0x080010, fogDensity: 0.010,
    wall: 0x1a0030, floor: 0x0a0018, ceil: 0x080008,
    trim: 0xcc00ff, trimE: 0xff00ff,
    pillar: 0x180028, ambient: 0x1a0040, ambientI: 0.40,
    sun: 0xff00dd, sunI: 0.7,
    accentColors: [0xaa00ff, 0xff00aa, 0x6600ff, 0xff0066],
    particleType: null, footstep: 'default', biomeId: 5,
  },
  {
    name: 'SPACE STATION',
    bg: 0x000005, fogDensity: 0.006,
    wall: 0x1e2030, floor: 0x000005, ceil: 0x050508,
    trim: 0x888888, trimE: 0xccddff,
    pillar: 0x1a1c28, ambient: 0x101018, ambientI: 0.20,
    sun: 0xddeeff, sunI: 0.5,
    accentColors: [0xffffff, 0xccccff, 0xffffff, 0xccffff],
    particleType: 'stars', footstep: 'default', biomeId: 6,
  },
  {
    name: 'TOXIC SWAMP',
    bg: 0x040c02, fogDensity: 0.018,
    wall: 0x0c1a08, floor: 0x0a1606, ceil: 0x060e04,
    trim: 0x44ff22, trimE: 0x66ff44,
    pillar: 0x0a1406, ambient: 0x0a1608, ambientI: 0.38,
    sun: 0x88ff44, sunI: 0.35,
    accentColors: [0x44ff22, 0x22aa11, 0x88ff44, 0x00dd22],
    particleType: 'bubbles', footstep: 'swamp', biomeId: 7,
  },
  {
    name: 'HAUNTED CRYPT',
    bg: 0x060410, fogDensity: 0.014,
    wall: 0x181420, floor: 0x10101a, ceil: 0x080610,
    trim: 0x9966ff, trimE: 0xaa77ff,
    pillar: 0x14121e, ambient: 0x0c0a18, ambientI: 0.25,
    sun: 0x8866cc, sunI: 0.35,
    accentColors: [0x8855ff, 0xaa77ff, 0x6644dd, 0xcc88ff],
    particleType: 'ash', footstep: 'stone', biomeId: 8,
  },
  {
    name: 'UNDERWATER RUINS',
    bg: 0x001822, fogDensity: 0.020,
    wall: 0x082030, floor: 0x061828, ceil: 0x041018,
    trim: 0x00ddcc, trimE: 0x00ffee,
    pillar: 0x061c28, ambient: 0x0a2230, ambientI: 0.52,
    sun: 0x44ddcc, sunI: 0.35,
    accentColors: [0x00ccbb, 0x44ffee, 0x0099aa, 0x22eedd],
    particleType: 'bubbles', footstep: 'splash', biomeId: 9,
  },
  {
    name: 'VOLCANIC ASH',
    bg: 0x141010, fogDensity: 0.016,
    wall: 0x282020, floor: 0x201818, ceil: 0x101010,
    trim: 0xff4422, trimE: 0xff6644,
    pillar: 0x201a1a, ambient: 0x241a14, ambientI: 0.30,
    sun: 0xff8833, sunI: 0.6,
    accentColors: [0xff4422, 0xdd2200, 0xff6600, 0xaa2200],
    particleType: 'ash', footstep: 'crumble', biomeId: 10,
  },
  {
    name: 'BLOOD MOON',
    bg: 0x1a0208, fogDensity: 0.011,
    wall: 0x2e0812, floor: 0x20060e, ceil: 0x14040a,
    trim: 0xff2244, trimE: 0xff4466,
    pillar: 0x260610, ambient: 0x2a0810, ambientI: 0.38,
    sun: 0xff4433, sunI: 0.8,
    accentColors: [0xff1133, 0xff4466, 0xdd0022, 0xff6688],
    particleType: 'sparks', footstep: 'default', biomeId: 11,
  },
  {
    name: 'CRYSTAL CAVE',
    bg: 0x06020a, fogDensity: 0.012,
    wall: 0x1a0a30, floor: 0x10061e, ceil: 0x08041a,
    trim: 0xcc88ff, trimE: 0xeebfff,
    pillar: 0x180828, ambient: 0x140620, ambientI: 0.45,
    sun: 0xddaaff, sunI: 0.6,
    accentColors: [0xcc88ff, 0xaa44ff, 0xeeccff, 0x8833cc],
    particleType: 'crystals', footstep: 'stone', biomeId: 12,
  },
  {
    name: 'BIOMECH CORE',
    bg: 0x0a0408, fogDensity: 0.013,
    wall: 0x200a10, floor: 0x180808, ceil: 0x100406,
    trim: 0xff3366, trimE: 0xff5588,
    pillar: 0x1a0810, ambient: 0x1e0a0c, ambientI: 0.38,
    sun: 0xff2244, sunI: 0.55,
    accentColors: [0xff2255, 0xcc0033, 0xff5577, 0xdd1144],
    particleType: 'drips', footstep: 'swamp', biomeId: 13,
  },
  {
    name: 'STORM VAULT',
    bg: 0x060a12, fogDensity: 0.012,
    wall: 0x141c2a, floor: 0x0e161e, ceil: 0x08101a,
    trim: 0x88ccff, trimE: 0xaaddff,
    pillar: 0x121a26, ambient: 0x10182a, ambientI: 0.32,
    sun: 0xaaddff, sunI: 0.65,
    accentColors: [0x66aaff, 0xaaddff, 0x4488dd, 0xcceeFF],
    particleType: 'lightning', footstep: 'stone', biomeId: 14,
  },
  {
    name: 'DEEP TRENCH',
    bg: 0x000508, fogDensity: 0.022,
    wall: 0x040e14, floor: 0x020a10, ceil: 0x000608,
    trim: 0x00ffcc, trimE: 0x44ffdd,
    pillar: 0x040c12, ambient: 0x04101a, ambientI: 0.28,
    sun: 0x00ddaa, sunI: 0.28,
    accentColors: [0x00ffbb, 0x00ddaa, 0x44ffcc, 0x00bb99],
    particleType: 'orbs', footstep: 'splash', biomeId: 15,
  },
  {
    name: 'POISON JUNGLE',
    bg: 0x040a02, fogDensity: 0.015,
    wall: 0x0e1e08, floor: 0x081408, ceil: 0x04080a,
    trim: 0x88ff00, trimE: 0xaaff22,
    pillar: 0x0a1806, ambient: 0x0c1a08, ambientI: 0.42,
    sun: 0x88ff22, sunI: 0.38,
    accentColors: [0x66ff00, 0xaaff44, 0x44dd00, 0x88ee22],
    particleType: 'spores', footstep: 'jungle', biomeId: 16,
  },
  {
    name: 'ACID WASTES',
    bg: 0x0a0c00, fogDensity: 0.013,
    wall: 0x1a1c04, floor: 0x141600, ceil: 0x0a0c00,
    trim: 0xddff00, trimE: 0xeeff22,
    pillar: 0x181a04, ambient: 0x181c04, ambientI: 0.44,
    sun: 0xccff00, sunI: 0.70,
    accentColors: [0xddff00, 0xaaee00, 0xeeff22, 0x88cc00],
    particleType: 'spores', footstep: 'swamp', biomeId: 17,
  },
  {
    name: 'MIDNIGHT RAIN',
    bg: 0x030510, fogDensity: 0.016,
    wall: 0x08101c, floor: 0x060c16, ceil: 0x020408,
    trim: 0x4488cc, trimE: 0x66aadd,
    pillar: 0x070e18, ambient: 0x081220, ambientI: 0.30,
    sun: 0x6699cc, sunI: 0.40,
    accentColors: [0x4488cc, 0x6699dd, 0x2266aa, 0x88aabb],
    particleType: 'rain', footstep: 'rain', biomeId: 18,
  },
  {
    name: 'ANCIENT TEMPLE',
    bg: 0x100e06, fogDensity: 0.010,
    wall: 0x28220c, floor: 0x1e1808, ceil: 0x141008,
    trim: 0xddaa44, trimE: 0xeecc66,
    pillar: 0x24200a, ambient: 0x241e0c, ambientI: 0.50,
    sun: 0xffdd88, sunI: 0.75,
    accentColors: [0xddaa44, 0xffcc55, 0xcc8822, 0xeecc66],
    particleType: 'ash', footstep: 'stone', biomeId: 19,
  },
  {
    name: 'INFERNAL PIT',
    bg: 0x1a0400, fogDensity: 0.014,
    wall: 0x2e0800, floor: 0x200600, ceil: 0x150400,
    trim: 0xff6600, trimE: 0xff8800,
    pillar: 0x280600, ambient: 0x2e0800, ambientI: 0.42,
    sun: 0xff5500, sunI: 0.95,
    accentColors: [0xff4400, 0xff8800, 0xdd2200, 0xffaa00],
    particleType: 'smoke', footstep: 'lava', biomeId: 20,
  },
  {
    name: 'FROZEN VOID',
    bg: 0x00040c, fogDensity: 0.009,
    wall: 0x04101c, floor: 0x020c18, ceil: 0x000408,
    trim: 0x88ccff, trimE: 0xaaddff,
    pillar: 0x040e18, ambient: 0x061018, ambientI: 0.22,
    sun: 0xaaccee, sunI: 0.45,
    accentColors: [0x66aaff, 0xaaccff, 0x44aacc, 0x88ddff],
    particleType: 'crystals', footstep: 'ice', biomeId: 21,
  },
  {
    name: 'NEON ARENA',
    bg: 0x08000e, fogDensity: 0.011,
    wall: 0x1a001a, floor: 0x100010, ceil: 0x080008,
    trim: 0xff00cc, trimE: 0xff44dd,
    pillar: 0x160016, ambient: 0x1e001a, ambientI: 0.44,
    sun: 0xff22cc, sunI: 0.75,
    accentColors: [0xff00ff, 0xff00cc, 0xcc00ff, 0xff44ee],
    particleType: 'sparks', footstep: 'default', biomeId: 22,
  },
  {
    name: 'DARK NEBULA',
    bg: 0x04000c, fogDensity: 0.007,
    wall: 0x100620, floor: 0x080418, ceil: 0x040210,
    trim: 0xcc44ff, trimE: 0xdd66ff,
    pillar: 0x0e0418, ambient: 0x0c0418, ambientI: 0.30,
    sun: 0xaa44ff, sunI: 0.45,
    accentColors: [0xaa22ff, 0xcc66ff, 0x8800ee, 0xdd88ff],
    particleType: 'nebula', footstep: 'default', biomeId: 23,
  },
  {
    name: 'RADIATION ZONE',
    bg: 0x040c00, fogDensity: 0.012,
    wall: 0x0e1a00, floor: 0x0a1400, ceil: 0x060e00,
    trim: 0x88ff44, trimE: 0xaaff66,
    pillar: 0x0c1800, ambient: 0x0c1a00, ambientI: 0.48,
    sun: 0xaaff44, sunI: 0.60,
    accentColors: [0x66ff22, 0xaaff44, 0x44ee00, 0x88ff66],
    particleType: 'radiation', footstep: 'default', biomeId: 24,
  },
  {
    name: 'BURNING CATHEDRAL',
    bg: 0x0c0600, fogDensity: 0.012,
    wall: 0x201008, floor: 0x181008, ceil: 0x0e0804,
    trim: 0xff8822, trimE: 0xffaa44,
    pillar: 0x1c0e06, ambient: 0x201208, ambientI: 0.40,
    sun: 0xff9933, sunI: 0.85,
    accentColors: [0xff6600, 0xffaa00, 0xff4400, 0xffcc44],
    particleType: 'smoke', footstep: 'stone', biomeId: 25,
  },
  {
    name: 'NANO GRID',
    bg: 0x000808, fogDensity: 0.008,
    wall: 0x0a1818, floor: 0x081414, ceil: 0x040e0e,
    trim: 0x00ffee, trimE: 0x44ffff,
    pillar: 0x081414, ambient: 0x0a1a1a, ambientI: 0.38,
    sun: 0x44ffee, sunI: 0.55,
    accentColors: [0x00ffee, 0x44ffff, 0x00ddcc, 0x22eedd],
    particleType: 'data', footstep: 'default', biomeId: 26,
  },
];

let currentBiome = null;
let biomeParticles = [];
let _biomeBanner = null;

function _clearBiomeParticles() {
  biomeParticles.forEach(p => scene.remove(p.mesh));
  biomeParticles = [];
}

function _initBiomeParticles(biome) {
  _clearBiomeParticles();
  if (!biome.particleType) return;

  const COUNT = 80;
  for (let i = 0; i < COUNT; i++) {
    let mesh;
    if (biome.particleType === 'snow') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.04 + Math.random() * 0.04, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0xeef8ff, transparent: true, opacity: 0.8 })
      );
    } else if (biome.particleType === 'embers') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.04 + Math.random() * 0.04, 4, 4),
        new THREE.MeshBasicMaterial({ color: Math.random() > 0.5 ? 0xff4400 : 0xff8800 })
      );
    } else if (biome.particleType === 'leaves') {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.08 + Math.random()*0.05, 0.005, 0.06 + Math.random()*0.04),
        new THREE.MeshBasicMaterial({ color: Math.random() > 0.5 ? 0x00aa44 : 0x006622 })
      );
    } else if (biome.particleType === 'sand') {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.04 + Math.random()*0.03, 0.02, 0.04 + Math.random()*0.03),
        new THREE.MeshBasicMaterial({ color: 0xd4a060, transparent: true, opacity: 0.7 })
      );
    } else if (biome.particleType === 'stars') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 + Math.random() * 0.03, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
    } else if (biome.particleType === 'bubbles') {
      const col = (biome.biomeId === 9 || biome.biomeId === 15) ? 0x00ffdd : 0x88ff44;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 + Math.random() * 0.05, 5, 5),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 + Math.random() * 0.3 })
      );
    } else if (biome.particleType === 'ash') {
      const col = biome.biomeId === 10 ? 0x888080 : biome.biomeId === 19 ? 0xd4b870 : 0xbbbbcc;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.05 + Math.random() * 0.04, 0.01, 0.05 + Math.random() * 0.04),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 })
      );
    } else if (biome.particleType === 'sparks') {
      const col = biome.biomeId === 22 ? (Math.random() > 0.5 ? 0xff00ff : 0x00ffee) : (Math.random() > 0.5 ? 0xff2244 : 0xffaa00);
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.02 + Math.random() * 0.025, 4, 4),
        new THREE.MeshBasicMaterial({ color: col })
      );
    } else if (biome.particleType === 'crystals') {
      const col = biome.biomeId === 21 ? 0x88ccff : 0xcc88ff;
      mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.04 + Math.random() * 0.06),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7 })
      );
    } else if (biome.particleType === 'drips') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.008, 0.06 + Math.random() * 0.06, 4),
        new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.65 })
      );
    } else if (biome.particleType === 'lightning') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.025 + Math.random() * 0.03, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: Math.random() * 0.5 })
      );
    } else if (biome.particleType === 'orbs') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.05 + Math.random() * 0.08, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.22 + Math.random() * 0.25 })
      );
    } else if (biome.particleType === 'spores') {
      const col = biome.biomeId === 17 ? 0xddff00 : 0x88ff44;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 + Math.random() * 0.04, 4, 4),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 })
      );
    } else if (biome.particleType === 'rain') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 0.14 + Math.random() * 0.08, 3),
        new THREE.MeshBasicMaterial({ color: 0x6699cc, transparent: true, opacity: 0.5 })
      );
    } else if (biome.particleType === 'smoke') {
      const col = biome.biomeId === 25 ? 0x443322 : 0x331a00;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.09 + Math.random() * 0.10, 5, 5),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22 + Math.random() * 0.18 })
      );
    } else if (biome.particleType === 'nebula') {
      const col = Math.random() > 0.5 ? 0xaa44ff : 0xcc66ff;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.04 + Math.random() * 0.06, 4, 4),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28 + Math.random() * 0.22 })
      );
    } else if (biome.particleType === 'radiation') {
      const col = Math.random() > 0.5 ? 0x88ff44 : 0xaaff00;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 + Math.random() * 0.04, 4, 4),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45 })
      );
    } else if (biome.particleType === 'data') {
      const col = Math.random() > 0.5 ? 0x00ffee : 0x44ffff;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.06 + Math.random() * 0.06, 0.02),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.60 })
      );
    }
    if (!mesh) continue;

    // Random position around spawn
    mesh.position.set(
      (Math.random() - 0.5) * 40,
      Math.random() * 8,
      (Math.random() - 0.5) * 40
    );
    scene.add(mesh);

    const pt = biome.particleType;
    const vx = (Math.random() - 0.5) * (pt === 'sand' ? 4 : pt === 'sparks' ? 3 : pt === 'rain' ? 0.2 : 1);
    const vy = pt === 'embers' || pt === 'bubbles' || pt === 'smoke' ? 0.4 + Math.random() * 0.8
             : pt === 'stars' || pt === 'orbs' || pt === 'nebula' || pt === 'radiation' ? (Math.random() - 0.5) * 0.2
             : pt === 'rain' ? -(2.5 + Math.random() * 1.5)
             : pt === 'drips' ? -(1.2 + Math.random() * 0.8)
             : pt === 'sparks' ? (Math.random() - 0.5) * 3
             : pt === 'lightning' ? (Math.random() - 0.5) * 0.3
             : -(0.4 + Math.random() * 0.8);
    const vz = (Math.random() - 0.5) * (pt === 'sand' ? 4 : pt === 'sparks' ? 3 : pt === 'rain' ? 0.2 : 1);

    biomeParticles.push({ mesh, vx, vy, vz,
      rx: (Math.random()-0.5)*2, ry: (Math.random()-0.5)*2, rz: (Math.random()-0.5)*2,
      phase: Math.random() * Math.PI * 2 });
  }
}

function _showBiomeBanner(name) {
  if (_biomeBanner) { document.body.removeChild(_biomeBanner); _biomeBanner = null; }
  const d = document.createElement('div');
  d.style.cssText = [
    'position:fixed','top:22%','left:50%','transform:translateX(-50%)',
    'z-index:56','pointer-events:none',
    'font-family:Courier New,monospace','text-align:center',
    'background:rgba(0,0,0,0.72)',
    'border:1px solid rgba(150,200,255,0.25)',
    'border-radius:10px','padding:14px 36px 12px',
    'transition:opacity 0.6s',
  ].join(';');
  d.innerHTML = `<div style="font-size:10px;color:#88aacc;letter-spacing:5px;margin-bottom:6px">ENTERING</div>`
              + `<div style="font-size:32px;color:#fff;letter-spacing:8px;text-shadow:0 0 16px #aaddff">${name}</div>`;
  document.body.appendChild(d);
  _biomeBanner = d;
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => { if (d.parentNode) document.body.removeChild(d); if (_biomeBanner === d) _biomeBanner = null; }, 700); }, 2500);
}

// Random biome sequence — index 0 always FACILITY, subsequent blocks random (no repeats)
const _biomeSeq = [0];
function _biomeForBlock(block) {
  if (block === 0) return BIOMES[0];
  while (_biomeSeq.length <= block) {
    const prev = _biomeSeq[_biomeSeq.length - 1];
    const pool = BIOMES.slice(1).map((_, i) => i + 1).filter(i => i !== prev);
    _biomeSeq.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return BIOMES[_biomeSeq[block]];
}

function applyBiome(level) {
  const biome = _biomeForBlock(Math.floor((level - 1) / 5));
  currentBiome = biome;

  // Scene fog + background
  scene.background.setHex(biome.bg);
  scene.fog.color.setHex(biome.bg);
  scene.fog.density = biome.fogDensity;

  // Arena materials
  ARENA_M.wall.color.setHex(biome.wall);
  ARENA_M.ceil.color.setHex(biome.ceil);
  ARENA_M.trim.color.setHex(biome.trim);
  ARENA_M.trim.emissive.setHex(biome.trimE);
  ARENA_M.trim.emissiveIntensity = 1.0;
  ARENA_M.pillar.color.setHex(biome.pillar);
  if (biome.floor !== null) ARENA_M.floor.color.setHex(biome.floor);
  else ARENA_M.floor.color.setHex(0xffffff);

  // Floor texture per biome
  if (!_floorTexCache[biome.biomeId]) {
    _floorTexCache[biome.biomeId] = makeFloorTex(biome.biomeId);
  }
  ARENA_M.floor.map = _floorTexCache[biome.biomeId];
  ARENA_M.floor.needsUpdate = true;

  // Lights
  ambientLight.color.setHex(biome.ambient);
  ambientLight.intensity = biome.ambientI;
  sun.color.setHex(biome.sun);
  sun.intensity = biome.sunI;
  accentLights.forEach((l, i) => l.color.setHex(biome.accentColors[i % biome.accentColors.length]));

  // Biome particles
  _initBiomeParticles(biome);

  // Biome banner (skip for initial level 1 facility)
  if (biome.biomeId !== 0 || level > 1) _showBiomeBanner(biome.name);
}

// Difficulty formula for level n
function getLevelConfig(n) {
  return {
    botCount : Math.min(15, 1 + Math.floor(n/7)),
    botHP    : Math.min(15, Math.ceil((3 + Math.floor((n-1)/12)) * 1.5)),
    speed    : Math.min(7.65, (2.8 + (n-1)*0.0428) * 1.02),  // +2% faster
    damage   : Math.min(30, 8  + Math.floor(n/10)*2),
    detectR  : Math.min(32, 18 + Math.floor(n/18)*2),
  };
}

function disposeGroup(group) {
  group.traverse(child => {
    if (child.isMesh || child.isSprite) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    }
  });
}

function clearBots() {
  bots.forEach(b => { scene.remove(b.group); disposeGroup(b.group); });
  bots.length = 0;
  ammoPickups.forEach(pk => { scene.remove(pk.group); disposeGroup(pk.group); });
  ammoPickups.length = 0;
  botBullets.forEach(b => { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); });
  botBullets.length = 0;
}

// 'melee' = levels 1-24, 'shooter' = 25-49, 'phantom' = 50-100
function botModeForLevel(n) {
  if (n <= 24) return 'melee';
  if (n <= 49) return 'shooter';
  return 'phantom';
}

function spawnBots(cfg) {
  const mode = botModeForLevel(currentLevel);
  for(let i=0; i<cfg.botCount; i++){
    const r = buildRobot();
    r.group.position.copy(rndPos());
    scene.add(r.group);

    // Attach pistol to right arm wrist/palm region
    const pistol = buildBotPistol();
    pistol.position.set(0.09, -1.22, -0.06);
    pistol.rotation.x = -Math.PI * 0.08;
    r.armGroupR.add(pistol);
    // Only shooter-mode bots carry a visible gun
    pistol.visible = (mode === 'shooter');

    bots.push({ ...r,
      hp:cfg.botHP, maxHp:cfg.botHP,
      alive:true,
      speed:cfg.speed, damage:cfg.damage, detectR:cfg.detectR,
      patrolTarget:rndPos(), patrolTimer:Math.random()*3, walkClock:0,
      pistol,
      shootTimer: 0.6 + Math.random() * 1.2,
      shootCooldown: 1.2 + Math.random() * 0.8,
      flashTimer: 0,
      lastPos: new THREE.Vector3(),
      stuckTimer: 0,
      flankAngle: (Math.random()-.5) * 1.2,
      flankChangeTimer: 2 + Math.random() * 2,
      alertLevel: 0,
      mode,
      // phantom-mode state
      phantomLookTimer: 0,
      phantomGlowing: false,
      phantomTpCooldown: 0,
      // animation state
      idleClock: Math.random() * Math.PI * 2,
      velX: 0, velZ: 0,
      shootAimT: 0,
      deathArcT: 0,
    });
  }
}

// ── Transition overlay ────────────────────────────────────────
const transScreen = document.createElement('div');
transScreen.style.cssText = [
  'position:fixed','inset:0','display:none',
  'flex-direction:column','align-items:center','justify-content:center',
  'z-index:55','pointer-events:none',
  'font-family:Courier New,monospace','color:#fff',
  'background:rgba(0,0,0,0.72)',
  'transition:background .3s',
].join(';');
document.body.appendChild(transScreen);

function transShow(html, dur, then) {
  transScreen.innerHTML = html;
  transScreen.style.transition = 'opacity 0.28s ease';
  transScreen.style.opacity    = '0';
  transScreen.style.display    = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => { transScreen.style.opacity = '1'; }));
  const fadeOutAt = Math.max(0, dur - 320);
  setTimeout(() => {
    transScreen.style.opacity = '0';
    setTimeout(() => { transScreen.style.display = 'none'; then && then(); }, 320);
  }, fadeOutAt);
}

function startLevel(n) {
  currentLevel = n;
  levelActive  = false;
  if (coopMode && !coopIsHost) clearGhostBots();
  clearBots();
  _buildDynamicCovers(n);
  applyBiome(n);
  const cfg = getLevelConfig(n);
  if (!coopMode || coopIsHost) spawnBots(cfg);  // guests see host's ghost bots instead
  levelActive        = true;
  levelTransitioning = false;
  updateLevelHUD();
  updateEnemyCountHUD();
  if (coopIsHost && socket) socket.emit('coopLevelUp', { level: n });
  if (n >= 25)  unlockBadge('pro_gamer');
  if (n >= 50)  unlockBadge('unstoppable');
  if (n >= 100) { unlockBadge('veteran'); awardBucks(100); }
}

function checkLevelComplete() {
  if(coopMode && !coopIsHost) return;   // guests follow host's level progression
  if(!levelActive || levelTransitioning) return;
  if(bots.some(b => b.alive)) return;   // still enemies alive
  levelTransitioning = true;
  levelActive = false;

  // Reward: restore 25 HP between rooms (no ammo refill)
  player.health = Math.min(player.maxHealth, player.health + 25);
  updateHealthHUD();

  const cleared = `
    <div style="font-size:52px;color:#22dd44;letter-spacing:6px;text-shadow:0 0 20px #22dd44">
      ROOM CLEARED
    </div>
    <div style="font-size:16px;margin-top:14px;color:#aaa;letter-spacing:4px">
      +25 HP
    </div>`;

  transShow(cleared, 2000, () => {
    if(currentLevel >= 100){
      showVictory();
    } else {
      const next = currentLevel + 1;
      const cfg  = getLevelConfig(next);
      const bucksLine = next >= 100
        ? `<div style="font-size:14px;margin-top:14px;color:#ffd700;letter-spacing:3px;text-shadow:0 0 10px #ffd700">+100 BUCKS AWARDED</div>`
        : '';
      const intro = `
        <div style="font-size:14px;color:#88ccff;letter-spacing:6px;margin-bottom:8px">
          ENTERING
        </div>
        <div style="font-size:68px;color:#fff;letter-spacing:8px;text-shadow:0 0 16px #fff">
          LEVEL ${next}
        </div>
        <div style="font-size:13px;margin-top:18px;color:#aaa;letter-spacing:4px;line-height:2.2">
          ENEMIES: ${cfg.botCount} &nbsp;&nbsp; HP: ${cfg.botHP}<br>
          SPEED: ${cfg.speed.toFixed(1)} &nbsp;&nbsp; DAMAGE: ${cfg.damage}
        </div>
        ${bucksLine}`;
      transShow(intro, 2600, () => startLevel(next));
    }
  });
}

function showVictory() {
  transScreen.innerHTML = `
    <div style="font-size:56px;color:#f1c40f;letter-spacing:6px;text-shadow:0 0 24px #f1c40f">
      YOU WIN
    </div>
    <div style="font-size:18px;margin-top:16px;color:#aaa;letter-spacing:4px">
      ALL 100 LEVELS CLEARED
    </div>
    <div style="font-size:14px;margin-top:10px;color:#888;letter-spacing:3px">
      TOTAL KILLS: ${player.kills}
    </div>`;
  transScreen.style.display='flex';
  // Keep showing indefinitely — player can ESC to menu
}

// ── HUD level / enemy-count helpers ──────────────────────────
function updateLevelHUD(){
  if(levelDisplayEl) levelDisplayEl.textContent = `LVL ${currentLevel}`;
}
function updateEnemyCountHUD(){
  if(!enemyCountEl) return;
  const alive = bots.filter(b=>b.alive).length;
  enemyCountEl.textContent = `ENEMIES: ${alive}/${bots.length}`;
}

// ============================================================
//  SOCKET.IO — MULTIPLAYER
// ============================================================
function initSocket() {
  if (socket) return;   // already connected
  const isLocal = ['localhost','127.0.0.1'].includes(window.location.hostname);
  const SOCKET_URL = isLocal ? 'http://localhost:3001' : window.location.origin;
  socket = io(SOCKET_URL);

  const username = localStorage.getItem('ah_username') || 'Guest';

  socket.on('connect', () => {
    socket.emit('join', { username, equippedItems: JSON.parse(localStorage.getItem('ah_equipped') || '[]') });

    // Broadcast position + health every 50 ms
    if (moveInterval) clearInterval(moveInterval);
    moveInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('move', {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          rotationY: yaw,
          health: player.health,
          gunId: selectedGunId,
        });
      }
    }, 50);

    // Sync initial PVP state with server on connect
    socket.emit('pvpMode', { enabled: pvpMode });

    // Join chat (logged-in users only)
    const _tok = localStorage.getItem('ah_token');
    if (_tok) {
      socket.emit('chatJoin', { token: _tok });
      socket.emit('getFriends', { token: _tok });
    }

    // Start ping loop
    setInterval(() => {
      if (socket && socket.connected) socket.emit('latency_ping', Date.now());
    }, 2000);
  });

  socket.on('latency_pong', (t) => { _pingMs = Date.now() - t; updatePingHUD(); });

  // ── Text chat ────────────────────────────────────────────────
  socket.on('chatMsg', ({ username: sender, text }) => {
    const isSelf = sender === localStorage.getItem('ah_username');
    _fpsChatAppend(sender, text, isSelf);
    // Speech bubble above remote player
    if (!isSelf) {
      for (const rp of remotePlayers.values()) {
        if (rp.username === sender) { _showSpeechBubble(rp, text); break; }
      }
    }
  });

  // ── Emote from remote player ─────────────────────────────────
  socket.on('remoteEmote', ({ socketId, emoteId }) => {
    const em = EMOTE_DEFS.find(e => e.id === emoteId);
    if (!em) return;
    const rp = remotePlayers.get(socketId);
    if (rp) showRemoteEmote(socketId, rp, em);
    else pushKillFeed(`${em.emoji}`);
  });

  // ── Trade notifications ───────────────────────────────────────
  socket.on('tradeOffer', (trade) => {
    pushKillFeed(`⇄ TRADE OFFER from ${trade.fromUsername}`);
    // The main page handles accept/decline via its own socket
  });
  socket.on('tradeAccepted', ({ withUsername }) => {
    pushKillFeed(`✓ ${withUsername} accepted your trade`);
  });
  socket.on('tradeDeclined', ({ byUsername }) => {
    pushKillFeed(`✗ ${byUsername} declined your trade`);
  });

  // ── Voice signaling ──────────────────────────────────────────

  // Server tells us who is already in voice when WE join.
  // WE are the joiner → WE create offers to all of them.
  socket.on('voiceExisting', async (users) => {
    for (const { socketId, username: uname } of users) {
      _fpsVoicePeerMap.set(socketId, uname);
      await _fpsCreateOffer(socketId);
    }
  });

  // Someone else joined voice while we are already here.
  // THEY will create an offer to us via voiceExisting — we must NOT
  // create one back, that would cause "glare" (both sides in
  // have-local-offer state simultaneously → silent crash).
  socket.on('voiceUserJoined', ({ socketId, username: uname }) => {
    _fpsVoicePeerMap.set(socketId, uname);
    // Intentionally NOT calling _fpsCreateOffer here.
  });

  socket.on('voiceUserLeft', ({ socketId }) => {
    _fpsVoicePeerMap.delete(socketId);
    _fpsClosePeer(socketId);
  });

  // We are the answerer — the remote peer initiated the call.
  socket.on('voiceOffer', async ({ fromId, offer }) => {
    if (!_fpsVoiceOn || !_fpsLocalStream) return; // ignore if we're not in voice
    const pc = _fpsGetOrCreatePeer(fromId);
    // Add our mic tracks, guarding against duplicates
    const existingSenders = new Set(pc.getSenders().map(s => s.track));
    _fpsLocalStream.getTracks().forEach(t => {
      if (!existingSenders.has(t)) pc.addTrack(t, _fpsLocalStream);
    });
    try {
      await _fpsSetRemoteDesc(pc, fromId, offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voiceAnswer', { targetId: fromId, answer: pc.localDescription });
    } catch (err) {
      console.warn('[Voice] voiceOffer processing error:', err);
      _fpsClosePeer(fromId);
    }
  });

  // We are the offerer — the remote peer accepted our offer.
  socket.on('voiceAnswer', async ({ fromId, answer }) => {
    const pc = _fpsPeers.get(fromId);
    if (!pc) return;
    // Only valid when we have an outstanding offer
    if (pc.signalingState !== 'have-local-offer') return;
    try {
      await _fpsSetRemoteDesc(pc, fromId, answer);
    } catch (err) {
      console.warn('[Voice] voiceAnswer processing error:', err);
    }
  });

  // Trickle-ICE candidate from the remote side.
  // If the remote description isn't set yet, buffer the candidate.
  socket.on('voiceIce', async ({ fromId, candidate }) => {
    if (!candidate) return;
    const pc = _fpsPeers.get(fromId);
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    } else {
      // Buffer — will be flushed by _fpsSetRemoteDesc once the answer/offer arrives
      if (!_fpsIceQueue.has(fromId)) _fpsIceQueue.set(fromId, []);
      _fpsIceQueue.get(fromId).push(candidate);
    }
  });

  // Populate existing players when we first join
  socket.on('currentPlayers', players => {
    players.forEach(p => addRemotePlayer(p));
  });

  // Another player just connected
  socket.on('playerJoined', data => {
    addRemotePlayer(data);
    pushKillFeed(`${data.username} joined`);
  });

  // Positional update from a remote player
  socket.on('playerMoved', data => {
    const rp = remotePlayers.get(data.id);
    if (!rp) return;
    rp.targetPos.set(data.x, Math.max(0, data.y - EYE_H), data.z);
    rp.targetRotY = data.rotationY;
    let needsLabelRefresh = false;
    if (data.health !== undefined && data.health !== rp.health) {
      rp.health = data.health;
      needsLabelRefresh = true;
    }
    if (data.gunId !== undefined && data.gunId !== rp.gunId) {
      rp.gunId = data.gunId;
      rp.group.remove(rp.remoteGun.group);
      disposeGroup(rp.remoteGun.group);
      rp.remoteGun = buildRemoteGun(data.gunId);
      rp.remoteGun.group.position.set(0, 1.22, -0.62);
      rp.group.add(rp.remoteGun.group);
      needsLabelRefresh = true;
    }
    if (needsLabelRefresh) refreshPlayerLabel(rp);
  });

  // PVP mode changed for a remote player
  socket.on('pvpModeChanged', data => {
    const rp = remotePlayers.get(data.id);
    if (!rp) return;
    rp.pvpMode = data.pvpMode;
    refreshPlayerLabel(rp);
  });

  // A hit was registered by the server
  socket.on('playerHit', data => {
    if (data.targetId === socket.id) {
      // We were hit — only apply if we have PVP on (server already guards, but belt+suspenders)
      if (!pvpMode) return;
      player.health -= data.damage;
      updateHealthHUD();
      flashDmg();
      if (player.health <= 0) killPlayer();
    } else {
      // Someone else was hit — flash their robot
      const rp = remotePlayers.get(data.targetId);
      if (rp) {
        rp.allMats.forEach(m => { m.emissive.setHex(0xff5500); m.emissiveIntensity=4.0; });
        setTimeout(() => rp.allMats.forEach(m => { m.emissive.setHex(0x000000); m.emissiveIntensity=0; }), 80);
      }
    }
  });

  // ── Co-op socket handlers ─────────────────────────────────
  socket.on('coopInviteReceived', ({ fromId, fromUsername }) => {
    if (pointerLocked()) document.exitPointerLock();
    showCoopInviteDialog(fromId, fromUsername);
  });

  socket.on('coopAccepted', ({ guestId, guestUsername }) => {
    coopGuests.add(guestId);
    coopMode   = true;
    coopIsHost = true;
    const rp = remotePlayers.get(guestId);
    if (rp) { rp.inCoop = true; refreshPlayerLabel(rp); }
    pushKillFeed(`${guestUsername} accepted the request`);
    unlockBadge('besto_frendo');
    // Send current level immediately
    if (socket) socket.emit('coopLevelUp', { level: currentLevel });
  });

  socket.on('coopDenied', ({ denierUsername }) => {
    pushKillFeed(`${denierUsername} has denied the request`);
  });

  socket.on('coopStart', ({ hostId, hostUsername, level }) => {
    coopMode   = true;
    coopIsHost = false;
    coopHostId = hostId;
    const rp = remotePlayers.get(hostId);
    if (rp) { rp.inCoop = true; refreshPlayerLabel(rp); }
    startLevel(level);
    pushKillFeed(`Now co-oping with ${hostUsername}`);
  });

  socket.on('coopBots', ({ bots: bd }) => {
    if (!coopMode || coopIsHost) return;
    syncGhostBots(bd);
  });

  socket.on('coopBotKill', ({ botIndex }) => {
    const gb = coopGhostBots[botIndex];
    if (gb && gb.alive) {
      gb.alive = false;
      const hp = gb.group.position.clone().setY(1.2);
      spawnSparks(hp);
      spawnBlood(hp, 12);
      setTimeout(() => { if (gb.group.parent) scene.remove(gb.group); }, 180);
      player.kills++;
      updateKillHUD();
      updateRankHUD();
      trackKill();
      updateEnemyCountHUD();
      pushKillFeed('Robot destroyed');
    }
  });

  socket.on('coopBotHit', ({ botIndex }) => {
    if (!coopIsHost) return;
    const bot = bots[botIndex];
    if (bot && bot.alive) damageBot(bot);
  });

  socket.on('coopLevelUp', ({ level }) => {
    if (!coopMode || coopIsHost) return;
    startLevel(level);
    pushKillFeed(`Level ${level} — synced with co-op host`);
  });

  // ── Game mode events ─────────────────────────────────────────
  socket.on('gameModeChanged', ({ mode, teams, tdmScores: scores }) => {
    gameMode = mode;
    if (teams && socket.id) myTeam = teams[socket.id] || null;
    if (scores) tdmScores = scores;
    updateModeHUD();
    updateFFAHUD();
    updateTDMHUD();
    // Show mode announcement
    const names = { solo:'SOLO MODE', ffa:'FREE FOR ALL', tdm:'TEAM DEATHMATCH' };
    if (names[mode]) pushKillFeed('Mode changed: ' + names[mode]);
  });

  socket.on('ffaScoreUpdate', (board) => {
    ffaBoard = board;
    updateFFAHUD();
  });

  socket.on('tdmScoreUpdate', ({ scores, teams }) => {
    tdmScores = scores;
    if (teams && socket.id && teams[socket.id]) myTeam = teams[socket.id];
    updateTDMHUD();
  });

  // ── Friends events ────────────────────────────────────────────
  socket.on('friendsList', (friends) => {
    renderFriendsList(friends);
  });

  socket.on('friendResult', ({ success, error, username: fn, removed }) => {
    const statusEl = document.getElementById('friends-status');
    if (statusEl) {
      statusEl.textContent = error ? error : success ? `Added ${fn}!` : removed ? `Removed ${removed}` : '';
      statusEl.style.color = error ? '#ff5555' : '#22dd88';
    }
    if (success || removed) {
      const tok = localStorage.getItem('ah_token');
      if (socket && tok) socket.emit('getFriends', { token: tok });
    }
  });

  // Admin: receive player reports
  socket.on('adminReport', ({ reporter, targetUsername, reason, timestamp }) => {
    if (localStorage.getItem('isAdmin') !== 'true') return;
    const time = new Date(timestamp).toLocaleTimeString();
    pushKillFeed(`⚑ REPORT [${time}] ${reporter} reported ${targetUsername}: "${reason || 'No reason'}"`);
    const reportList = document.getElementById('report-list');
    if (reportList) {
      const entry = document.createElement('div');
      entry.className = 'report-entry';
      entry.innerHTML = `<span class="report-time">${time}</span> <b>${reporter}</b> → <b>${targetUsername}</b>: <span class="report-reason">${reason || '—'}</span>`;
      reportList.insertBefore(entry, reportList.firstChild);
    }
  });

  // Request current game mode on connect
  socket.emit('getGameMode');

  // Another player fired
  socket.on('playerShot', data => {
    const rp = remotePlayers.get(data.id);
    if(rp && rp.remoteGun) rp.remoteGun.flashTimer = 0.10;
  });

  // A player disconnected
  socket.on('playerLeft', data => {
    const rp = remotePlayers.get(data.id);
    if (rp) pushKillFeed(`${rp.username || 'Player'} left`);
    // Co-op cleanup
    if (coopHostId === data.id) {
      coopMode = false; coopIsHost = false; coopHostId = null;
      clearGhostBots();
      spawnBots(getLevelConfig(currentLevel));
      pushKillFeed('Co-op host left — returning to solo');
    }
    if (coopGuests.delete(data.id) && coopGuests.size === 0) {
      coopMode = false; coopIsHost = false;
    }
    removeRemotePlayer(data.id);
  });

  // Kicked by admin ban
  socket.on('banned', () => {
    socket.disconnect();
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    remotePlayers.forEach((_, id) => removeRemotePlayer(id));
    document.exitPointerLock();
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;font-family:sans-serif;color:#e74c3c;font-size:22px;font-weight:700;letter-spacing:2px;text-transform:uppercase';
    msg.innerHTML = `<div>🔨 BANNED</div><div style="font-size:14px;color:#aaaacc;font-weight:400;letter-spacing:1px;text-transform:none;max-width:480px;text-align:center;line-height:1.6">You have been banned by Stotch the Dev.<br>You have been placed on a private server until you are unbanned.</div>`;
    document.body.appendChild(msg);
  });

  // Server went away — clean up all ghosts
  socket.on('disconnect', () => {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    remotePlayers.forEach((_, id) => removeRemotePlayer(id));
  });
}

// ════════════════════════════════════════════════════════════
// LEADERBOARD / PROFILE / FRIENDS / GAME MODE UI
// ════════════════════════════════════════════════════════════

async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    renderLeaderboard(data.leaderboard || []);
  } catch { console.warn('Leaderboard fetch failed'); }
}

function renderLeaderboard(rows) {
  const el = document.getElementById('leaderboard-list');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div style="color:#555;font-size:12px;padding:8px">No data yet.</div>'; return; }
  el.innerHTML = rows.map((r, i) => {
    const rank = getRank(r.kills);
    return `<div class="lb-row">
      <span class="lb-pos">${i===0?'🏆':i===1?'🥈':i===2?'🥉':'#'+(i+1)}</span>
      <span class="lb-name" style="color:${rank.color}">${_esc(r.username)}</span>
      <span class="lb-kills">${r.kills}K</span>
      <span class="lb-kd" style="color:#888">${r.kd}</span>
    </div>`;
  }).join('');
}

async function showProfileModal(username) {
  const modal = document.getElementById('profile-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.querySelector('#pm-username').textContent = '…';
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
    const p = await res.json();
    if (p.error) { modal.querySelector('#pm-username').textContent = p.error; return; }
    const rank = getRank(p.kills);
    const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills;
    modal.querySelector('#pm-username').textContent  = p.username;
    modal.querySelector('#pm-rank').textContent      = rank.name;
    modal.querySelector('#pm-rank').style.color      = rank.color;
    modal.querySelector('#pm-online').textContent    = p.online ? '● Online' : '○ Offline';
    modal.querySelector('#pm-online').style.color    = p.online ? '#22dd44' : '#555';
    modal.querySelector('#pm-kills').textContent     = p.kills;
    modal.querySelector('#pm-deaths').textContent    = p.deaths;
    modal.querySelector('#pm-kd').textContent        = kd;
    modal.querySelector('#pm-bio').textContent       = p.bio || 'No bio set.';
    const isSelf = username === localStorage.getItem('ah_username');
    const editRow = modal.querySelector('#pm-bio-edit-row');
    if (editRow) editRow.style.display = isSelf ? 'flex' : 'none';
  } catch { modal.querySelector('#pm-username').textContent = 'Error loading profile.'; }
}

async function saveBio() {
  const inp = document.getElementById('pm-bio-input');
  if (!inp) return;
  const token = localStorage.getItem('ah_token');
  if (!token) return;
  try {
    await fetch('/api/profile/bio', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio: inp.value }),
    });
    playerBio = inp.value;
    await showProfileModal(localStorage.getItem('ah_username'));
  } catch {}
}

function renderFriendsList(friends) {
  const el = document.getElementById('friends-list');
  if (!el) return;
  if (!friends.length) {
    el.innerHTML = '<div style="color:#555;font-size:12px;padding:8px 0">No friends yet. Add someone!</div>';
    return;
  }
  el.innerHTML = friends.map(f =>
    `<div class="friend-row ${f.online ? 'online' : ''}">
      <span class="friend-dot"></span>
      <span class="friend-name" onclick="showProfileModal('${_esc(f.username)}')">${_esc(f.username)}</span>
      <button class="friend-remove-btn" onclick="removeFriend('${_esc(f.username)}')">✕</button>
    </div>`
  ).join('');
}

function addFriend() {
  const inp = document.getElementById('friend-add-input');
  const token = localStorage.getItem('ah_token');
  if (!inp || !socket || !token) return;
  const name = inp.value.trim();
  if (!name) return;
  inp.value = '';
  socket.emit('addFriend', { token, targetUsername: name });
}

function removeFriend(username) {
  const token = localStorage.getItem('ah_token');
  if (!socket || !token) return;
  socket.emit('removeFriend', { token, targetUsername: username });
}

function loadFriends() {
  const token = localStorage.getItem('ah_token');
  if (!socket || !token) return;
  socket.emit('getFriends', { token });
}

function setGameModeAndBroadcast(mode) {
  const token = localStorage.getItem('ah_token');
  if (!socket || !token) { gameMode = mode; updateModeHUD(); return; }
  socket.emit('setGameMode', { token, mode });
}

// ════════════════════════════════════════════════════════════
// CHAT + VOICE (FPS)
// ════════════════════════════════════════════════════════════

// ── Show/hide chat & mic based on login state ────────────────
(function() {
  const token = localStorage.getItem('ah_token');
  if (token) {
    const micBtn  = document.getElementById('voice-mic-btn');
    const chatBtn = document.getElementById('chat-toggle-btn');
    if (micBtn)  micBtn.style.display  = 'flex';
    if (chatBtn) chatBtn.style.display = 'flex';
  }
})();

// ── Speech bubble above remote player ────────────────────────
function _showSpeechBubble(rp, text) {
  if (rp.speechBubble) {
    rp.group.remove(rp.speechBubble);
    rp.speechBubble.material.map.dispose();
    rp.speechBubble.material.dispose();
    rp.speechBubble = null;
    if (rp._sbTimer) clearTimeout(rp._sbTimer);
  }
  const W = 320, H = 72;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');

  // White rounded bubble
  cx.beginPath();
  const r = 14;
  cx.moveTo(r, 4); cx.lineTo(W-r, 4);
  cx.quadraticCurveTo(W-4, 4, W-4, 4+r);
  cx.lineTo(W-4, H-20-r);
  cx.quadraticCurveTo(W-4, H-20, W-4-r, H-20);
  cx.lineTo(W/2+10, H-20);
  cx.lineTo(W/2, H-4);          // tail point
  cx.lineTo(W/2-10, H-20);
  cx.lineTo(r, H-20);
  cx.quadraticCurveTo(4, H-20, 4, H-20-r);
  cx.lineTo(4, 4+r);
  cx.quadraticCurveTo(4, 4, r, 4);
  cx.closePath();
  cx.fillStyle   = 'rgba(255,255,255,0.96)';
  cx.shadowColor = 'rgba(0,0,0,0.4)';
  cx.shadowBlur  = 8;
  cx.fill();

  // Black text (truncate if long)
  cx.shadowBlur = 0;
  cx.fillStyle  = '#111';
  cx.font       = 'bold 18px Inter,Arial,sans-serif';
  cx.textAlign  = 'center';
  cx.textBaseline = 'middle';
  const maxLen = 36;
  const label = text.length > maxLen ? text.slice(0, maxLen-1) + '…' : text;
  cx.fillText(label, W/2, (H-20)/2 + 4);

  const tex = new THREE.CanvasTexture(cv);
  const sp  = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(2.2, 0.50, 1);
  sp.position.set(0, 3.05, 0);  // above the name label
  rp.group.add(sp);
  rp.speechBubble = sp;
  rp._sbTimer = setTimeout(() => {
    if (rp.speechBubble === sp) {
      rp.group.remove(sp);
      sp.material.map.dispose();
      sp.material.dispose();
      rp.speechBubble = null;
    }
  }, 5000);
}

// ── Chat UI ───────────────────────────────────────────────────
let _fpsChatOpen  = false;
let _fpsUnread    = 0;

function _openChatTyping() {
  _chatTyping = true;
  _fpsChatOpen = true;
  const panel = document.getElementById('fps-chat-panel');
  if (panel) panel.style.display = 'block';
  _fpsUnread = 0;
  const dot = document.getElementById('chat-unread-dot');
  if (dot) dot.style.display = 'none';
  const msgs = document.getElementById('fps-chat-msgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  setTimeout(() => {
    const inp = document.getElementById('fps-chat-input');
    if (inp) inp.focus();
  }, 30);
}

function _closeChatTyping() {
  _chatTyping = false;
  _fpsChatOpen = false;
  const panel = document.getElementById('fps-chat-panel');
  if (panel) panel.style.display = 'none';
  const inp = document.getElementById('fps-chat-input');
  if (inp) { inp.blur(); inp.value = ''; }
  // Clear any keys that were down so movement doesn't stick
  Object.keys(keys).forEach(k => { keys[k] = false; });
  // Re-lock pointer if game is active
  const canvas = document.getElementById('fps-canvas');
  if (canvas && !isMobile) canvas.requestPointerLock();
}

function fpsChatToggle() {
  _fpsChatOpen = !_fpsChatOpen;
  const panel = document.getElementById('fps-chat-panel');
  if (panel) {
    panel.style.display = _fpsChatOpen ? 'block' : 'none';
    if (_fpsChatOpen) {
      _fpsUnread = 0;
      document.getElementById('chat-unread-dot').style.display = 'none';
      const msgs = document.getElementById('fps-chat-msgs');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      // Focus input but don't capture pointer lock events
      setTimeout(() => {
        const inp = document.getElementById('fps-chat-input');
        if (inp) inp.focus();
      }, 50);
    }
  }
}

function fpsChatSend() {
  if (!socket) return;
  const inp = document.getElementById('fps-chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) { _closeChatTyping(); return; }
  socket.emit('chatMsg', { text });
  inp.value = '';
  if (_chatTyping) _closeChatTyping();
}

function _fpsChatAppend(sender, text, isSelf, isSystem) {
  const box = document.getElementById('fps-chat-msgs');
  if (!box) return;
  const line = document.createElement('div');
  if (isSystem) {
    line.className = 'fps-chat-line sys';
    line.textContent = text;
  } else {
    line.className = 'fps-chat-line msg' + (isSelf ? ' self' : '');
    line.innerHTML = `<span class="fps-chat-user">${_esc(sender)}:</span><span class="fps-chat-text"> ${_esc(text)}</span>`;
  }
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  if (!_fpsChatOpen && !isSystem) {
    _fpsUnread++;
    const dot = document.getElementById('chat-unread-dot');
    if (dot) dot.style.display = 'block';
  }
  // Prune old messages (keep last 120)
  while (box.children.length > 120) box.removeChild(box.firstChild);
}

function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Patch pushKillFeed to also post system messages to chat ──
const _origPushKillFeed = pushKillFeed;
window.pushKillFeed = function(msg) {
  _origPushKillFeed(msg);
  _fpsChatAppend(null, msg, false, true);
};

// ════════════════════════════════════════════════════════════
// VOICE CHAT (WebRTC)
// ════════════════════════════════════════════════════════════
//
// Architecture:
//   • Only the *joining* user creates offers (via voiceExisting).
//     Existing users NEVER initiate — they only answer.
//     This eliminates the "glare" race where both sides create
//     simultaneous offers and the WebRTC state machine crashes.
//
//   • ICE candidates that arrive before setRemoteDescription
//     completes are queued per-peer and flushed afterward.
//     Without this, all ICE candidates are silently dropped
//     and the DTLS/SRTP channel never opens.
//
//   • Audio is explicitly play()-ed with an AudioContext that
//     was unlocked during the mic-button user gesture so that
//     iOS Safari's autoplay policy is satisfied.
// ────────────────────────────────────────────────────────────

let _fpsVoiceOn     = false;
let _fpsLocalStream = null;
let _fpsAudioCtx    = null;       // created in user-gesture context (iOS fix)

const _fpsPeers      = new Map(); // socketId → RTCPeerConnection
const _fpsAudios     = new Map(); // socketId → HTMLAudioElement
const _fpsIceQueue   = new Map(); // socketId → RTCIceCandidateInit[] (buffered pre-remoteDesc)
const _fpsVoicePeerMap = new Map(); // socketId → username

const _FPS_RTC_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ── Toggle ────────────────────────────────────────────────────
async function fpsVoiceToggle() {
  if (_fpsVoiceOn) { _fpsVoiceOff(); } else { await _fpsVoiceOn_fn(); }
}

// ── Turn voice ON ─────────────────────────────────────────────
async function _fpsVoiceOn_fn() {
  const token = localStorage.getItem('ah_token');
  if (!token || !socket) return;

  // Unlock audio playback while still inside the user-gesture handler (iOS Safari)
  try {
    if (!_fpsAudioCtx)
      _fpsAudioCtx = new (window.AudioContext || (window).webkitAudioContext)();
    if (_fpsAudioCtx.state === 'suspended') await _fpsAudioCtx.resume();
  } catch {}

  try {
    _fpsLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    _fpsChatAppend(null, 'Microphone access denied.', false, true);
    return;
  }

  _fpsVoiceOn = true;
  _fpsUpdateMicBtn();
  // Server will respond with voiceExisting → we create offers from there
  socket.emit('voiceJoin', { token });
}

// ── Turn voice OFF ────────────────────────────────────────────
function _fpsVoiceOff() {
  _fpsVoiceOn = false;
  if (socket) socket.emit('voiceLeave');
  if (_fpsLocalStream) { _fpsLocalStream.getTracks().forEach(t => t.stop()); _fpsLocalStream = null; }
  for (const sid of [..._fpsPeers.keys()]) _fpsClosePeer(sid);
  _fpsAudios.forEach(a => { a.pause(); a.srcObject = null; });
  _fpsAudios.clear();
  _fpsIceQueue.clear();
  _fpsVoicePeerMap.clear();
  _fpsUpdateMicBtn();
}

// ── Mic button icon ───────────────────────────────────────────
function _fpsUpdateMicBtn() {
  const btn     = document.getElementById('voice-mic-btn');
  const onIcon  = document.getElementById('mic-on-icon');
  const offIcon = document.getElementById('mic-off-icon');
  if (!btn) return;
  if (_fpsVoiceOn) {
    btn.classList.remove('muted');
    if (onIcon)  onIcon.style.display  = 'block';
    if (offIcon) offIcon.style.display = 'none';
    btn.title = 'Voice ON — click to mute';
  } else {
    btn.classList.add('muted');
    if (onIcon)  onIcon.style.display  = 'none';
    if (offIcon) offIcon.style.display = 'block';
    btn.title = 'Voice OFF — click to unmute';
  }
}

// ── Create / retrieve RTCPeerConnection for a remote peer ─────
function _fpsGetOrCreatePeer(targetId) {
  if (_fpsPeers.has(targetId)) return _fpsPeers.get(targetId);

  const pc = new RTCPeerConnection(_FPS_RTC_CFG);
  _fpsPeers.set(targetId, pc);
  _fpsIceQueue.set(targetId, []); // start with empty candidate queue

  // Trickle-ICE: send each candidate to the remote side as it's gathered
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && socket) socket.emit('voiceIce', { targetId, candidate });
  };

  // Clean up automatically if the connection breaks
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      _fpsClosePeer(targetId);
    }
  };

  // Incoming audio from the remote peer
  pc.ontrack = ({ track, streams }) => {
    const stream = (streams && streams.length) ? streams[0] : new MediaStream([track]);
    let audio = _fpsAudios.get(targetId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay    = true;
      audio.playsInline = true; // iOS: must not go fullscreen
      _fpsAudios.set(targetId, audio);
    }
    audio.srcObject = stream;
    // Resume AudioContext first (iOS suspends it between gesture and async callback)
    if (_fpsAudioCtx && _fpsAudioCtx.state === 'suspended') _fpsAudioCtx.resume();
    // Explicitly trigger playback — autoplay alone is blocked by modern browsers
    audio.play().catch(() => {});
  };

  return pc;
}

// ── Set remote description AND flush buffered ICE candidates ──
async function _fpsSetRemoteDesc(pc, targetId, desc) {
  await pc.setRemoteDescription(new RTCSessionDescription(desc));
  // Apply any ICE candidates that arrived before the remote description was ready
  const queue = _fpsIceQueue.get(targetId) || [];
  for (const c of queue) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }
  _fpsIceQueue.set(targetId, []); // clear the queue
}

// ── Initiate a call to a remote peer (we are the offerer) ─────
async function _fpsCreateOffer(targetId) {
  const pc = _fpsGetOrCreatePeer(targetId);
  // Add our mic tracks — guard against duplicates if called more than once
  if (_fpsLocalStream) {
    const existing = new Set(pc.getSenders().map(s => s.track));
    _fpsLocalStream.getTracks().forEach(t => {
      if (!existing.has(t)) pc.addTrack(t, _fpsLocalStream);
    });
  }
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (socket) socket.emit('voiceOffer', { targetId, offer: pc.localDescription });
  } catch (err) {
    console.warn('[Voice] createOffer error:', err);
    _fpsClosePeer(targetId);
  }
}

// ── Tear down one peer connection ─────────────────────────────
function _fpsClosePeer(sid) {
  const pc = _fpsPeers.get(sid);
  if (pc) { try { pc.close(); } catch {} _fpsPeers.delete(sid); }
  const a = _fpsAudios.get(sid);
  if (a) { a.pause(); a.srcObject = null; _fpsAudios.delete(sid); }
  _fpsIceQueue.delete(sid);
}

// ── Give Bucks panel (Stotch only) ────────────────────────────
const giveBucksPanel = document.getElementById('give-bucks-panel');

function _isStotch() {
  return localStorage.getItem('isAdmin') === 'true' &&
         localStorage.getItem('ah_username') === 'Stotch';
}

function showGiveBucksPanel() {
  if (!_isStotch() || !giveBucksPanel) return;
  // Populate online players dropdown — registered accounts only
  const sel = document.getElementById('gb-player-select');
  sel.innerHTML = '<option value="">— select online player —</option>';
  [...remotePlayers.values()]
    .filter(rp => !rp.isGuest)
    .forEach(rp => {
      const opt = document.createElement('option');
      opt.value = rp.username || '';
      opt.textContent = rp.username || 'Player';
      sel.appendChild(opt);
    });
  // Sync dropdown → text input
  sel.onchange = () => {
    if (sel.value) document.getElementById('gb-player-input').value = sel.value;
  };
  giveBucksPanel.style.display = 'block';
}

function hideGiveBucksPanel() {
  if (giveBucksPanel) giveBucksPanel.style.display = 'none';
}

(function setupGiveBucks() {
  if (!giveBucksPanel) return;

  const confirmBtn  = document.getElementById('gb-confirm-btn');
  const resetBtn    = document.getElementById('gb-reset-btn');
  const playerInput = document.getElementById('gb-player-input');
  const amountInput = document.getElementById('gb-amount-input');
  const statusEl    = document.getElementById('gb-status');
  const sel         = document.getElementById('gb-player-select');

  function resetForm() {
    sel.value = '';
    playerInput.value = '';
    amountInput.value = '';
    statusEl.style.display = 'none';
    statusEl.textContent = '';
    statusEl.className = '';
    confirmBtn.disabled = false;
  }

  function showStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'error' : '';
    statusEl.style.display = 'block';
  }

  resetBtn.addEventListener('click', resetForm);

  confirmBtn.addEventListener('click', async () => {
    const username = playerInput.value.trim() || sel.value.trim();
    const amount   = parseInt(amountInput.value);
    if (!username) { showStatus('Select or type a username.', true); return; }
    if (username === localStorage.getItem('ah_username')) { showStatus('Cannot give bucks to yourself.', true); return; }
    if (!amount || amount < 1) { showStatus('Enter a valid amount (≥ 1).', true); return; }

    confirmBtn.disabled = true;
    showStatus('Sending…', false);

    try {
      const token = localStorage.getItem('ah_token');
      const res = await fetch(_API_BASE + '/api/admin/give-bucks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetUsername: username, amount }),
      });
      const data = await res.json();
      if (res.ok) {
        showStatus(`✓ Gave ${amount} bucks to ${data.username}. New balance: ${data.bucks}`, false);
        amountInput.value = '';
      } else {
        showStatus(data.error || 'Failed.', true);
        confirmBtn.disabled = false;
      }
    } catch {
      showStatus('Network error.', true);
      confirmBtn.disabled = false;
    }
  });
})();

// ── Admin ban panel ───────────────────────────────────────────
const banPanel = document.getElementById('ban-panel');
const banList  = document.getElementById('ban-player-list');

function showBanPanel() {
  if (localStorage.getItem('isAdmin') !== 'true' || !banPanel) return;
  banList.innerHTML = '';
  const others = [...remotePlayers.values()];
  if (others.length === 0) {
    const empty = document.createElement('span');
    empty.id = 'ban-panel-empty';
    empty.style.cssText = 'font-size:12px;color:#444466';
    empty.textContent = 'No other players connected.';
    banList.appendChild(empty);
  } else {
    others.forEach(rp => {
      const row = document.createElement('div');
      row.className = 'ban-player-row';
      const name = document.createElement('span');
      name.className = 'ban-player-name';
      name.textContent = rp.username || 'Player';
      const btn = document.createElement('button');
      btn.className = 'ban-btn';
      btn.textContent = 'BAN';
      btn.addEventListener('click', () => {
        if (!socket) return;
        socket.emit('banPlayer', { targetUsername: rp.username });
        btn.disabled = true;
        btn.textContent = 'BANNED';
        btn.style.opacity = '0.4';
      });
      row.appendChild(name);
      row.appendChild(btn);
      banList.appendChild(row);
    });
  }
  banPanel.style.display = 'block';
  showGiveBucksPanel();
}

function hideBanPanel() {
  if (banPanel) banPanel.style.display = 'none';
  hideGiveBucksPanel();
  const unbanConfirm = document.getElementById('unban-confirm');
  const unbanInput   = document.getElementById('unban-input');
  if (unbanConfirm) unbanConfirm.style.display = 'none';
  if (unbanInput)   unbanInput.value = '';
}

// ── Unban wiring ──────────────────────────────────────────────
(function setupUnban() {
  const unbanBtn     = document.getElementById('unban-btn');
  const unbanInput   = document.getElementById('unban-input');
  const unbanConfirm = document.getElementById('unban-confirm');
  const unbanText    = document.getElementById('unban-confirm-text');
  const unbanYes     = document.getElementById('unban-yes');
  const unbanNo      = document.getElementById('unban-no');
  if (!unbanBtn) return;

  unbanBtn.addEventListener('click', () => {
    const name = unbanInput.value.trim();
    if (!name) return;
    unbanText.textContent = `Unban "${name}"?`;
    unbanConfirm.style.display = 'block';
  });

  unbanNo.addEventListener('click', () => {
    unbanConfirm.style.display = 'none';
    unbanInput.value = '';
  });

  unbanYes.addEventListener('click', () => {
    const name = unbanInput.value.trim();
    if (!name || !socket) return;
    socket.emit('unbanPlayer', { targetUsername: name });
    unbanConfirm.style.display = 'none';
    unbanInput.value = '';
    unbanBtn.textContent = 'UNBANNED';
    unbanBtn.style.opacity = '0.5';
    setTimeout(() => { unbanBtn.textContent = 'UNBAN'; unbanBtn.style.opacity = ''; }, 2000);
  });
})();

// ============================================================
//  MOBILE TOUCH CONTROLS
// ============================================================
function startMobileGame() {
  mobileGameActive = true;
  setupWeapon(selectedGunId);
  startScreen.style.display = 'none';
  hudEl.style.display = 'block';
  hideBanPanel();
  hideCoopPanel();
  const tc = document.getElementById('touch-controls');
  if (tc) tc.style.display = 'block';
  if (!gameStarted) {
    gameStarted = true;
    startLevel(1);
    initSocket();
  }
}

if (isMobile) {
  const moveZone  = document.getElementById('touch-move-zone');
  const lookZone  = document.getElementById('touch-look-zone');
  const joyOuter  = document.getElementById('touch-joystick-outer');
  const joyInner  = document.getElementById('touch-joystick-inner');
  const shootBtn  = document.getElementById('touch-shoot-btn');
  const jumpBtn   = document.getElementById('touch-jump-btn');
  const reloadBtn = document.getElementById('touch-reload-btn');

  const JOYSTICK_RADIUS = 52;
  let joystickTouchId = null, joystickCenterX = 0, joystickCenterY = 0;
  let lookTouchId = null, lookLastX = 0, lookLastY = 0;
  const TOUCH_SENS = 0.0055;

  // ── Movement joystick ──────────────────────────────────
  if (moveZone) {
    moveZone.addEventListener('touchstart', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (joystickTouchId === null) {
          joystickTouchId  = t.identifier;
          joystickCenterX  = t.clientX;
          joystickCenterY  = t.clientY;
          joyOuter.style.left    = t.clientX + 'px';
          joyOuter.style.top     = t.clientY + 'px';
          joyOuter.style.display = 'block';
        }
      }
    }, { passive: false });

    moveZone.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue;
        let dx = t.clientX - joystickCenterX;
        let dy = t.clientY - joystickCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > JOYSTICK_RADIUS) { dx = dx / dist * JOYSTICK_RADIUS; dy = dy / dist * JOYSTICK_RADIUS; }
        joyInner.style.left = (50 + dx / JOYSTICK_RADIUS * 50) + '%';
        joyInner.style.top  = (50 + dy / JOYSTICK_RADIUS * 50) + '%';
        touchMoveInput.x    = dx / JOYSTICK_RADIUS;
        touchMoveInput.y    = dy / JOYSTICK_RADIUS;
      }
    }, { passive: false });

    const endJoy = e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue;
        joystickTouchId     = null;
        touchMoveInput.x    = 0;
        touchMoveInput.y    = 0;
        joyOuter.style.display = 'none';
        joyInner.style.left = '50%';
        joyInner.style.top  = '50%';
      }
    };
    moveZone.addEventListener('touchend',    endJoy, { passive: false });
    moveZone.addEventListener('touchcancel', endJoy, { passive: false });
  }

  // ── Camera look ────────────────────────────────────────
  if (lookZone) {
    lookZone.addEventListener('touchstart', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (lookTouchId === null) {
          lookTouchId = t.identifier;
          lookLastX   = t.clientX;
          lookLastY   = t.clientY;
        }
      }
    }, { passive: false });

    lookZone.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== lookTouchId) continue;
        yaw   -= (t.clientX - lookLastX) * TOUCH_SENS;
        pitch -= (t.clientY - lookLastY) * TOUCH_SENS;
        pitch = Math.max(-1.35, Math.min(1.35, pitch));
        lookLastX = t.clientX;
        lookLastY = t.clientY;
      }
    }, { passive: false });

    const endLook = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouchId) lookTouchId = null;
      }
    };
    lookZone.addEventListener('touchend',    endLook, { passive: false });
    lookZone.addEventListener('touchcancel', endLook, { passive: false });
  }

  // ── Shoot button ───────────────────────────────────────
  if (shootBtn) {
    shootBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      if (!mobileGameActive || player.dead || !gun.def) return;
      if (gun.def.oneShot) {
        if (gun.ammo > 0) activateScope();
      } else if (gun.def.auto) {
        touchFireHeld = true;
      } else {
        shoot();
      }
    }, { passive: false });

    const endShoot = e => {
      e.preventDefault();
      touchFireHeld = false;
      if (scopeActive) { shoot(); deactivateScope(); }
    };
    shootBtn.addEventListener('touchend',    endShoot, { passive: false });
    shootBtn.addEventListener('touchcancel', e => { e.preventDefault(); touchFireHeld = false; if (scopeActive) deactivateScope(); }, { passive: false });
  }

  // ── Jump button ────────────────────────────────────────
  if (jumpBtn) {
    jumpBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      if (grounded && mobileGameActive && !player.dead) { velY = JUMP_VEL; grounded = false; }
    }, { passive: false });
  }

  // ── Reload button ──────────────────────────────────────
  if (reloadBtn) {
    reloadBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      reloadGun();
    }, { passive: false });
  }
}

// ─── Bootstrap ───────────────────────────────────────────────
updateHealthHUD(); updateAmmoHUD(); updateKillHUD();
updateRankHUD(); updateModeHUD();
animate();
