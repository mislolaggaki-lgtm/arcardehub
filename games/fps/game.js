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
const remotePlayers = new Map();   // socketId → { group, legL, legR, allMats, targetPos, targetRotY, walkClock, ... }
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

// Initialise HUD bucks — show cached value immediately, then sync from server
(function() {
  const el = document.getElementById('hud-bucks-val');
  if (el) el.textContent = localStorage.getItem('ah_bucks') || '0';
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
  pistol : { name:'PISTOL',  ammo:12,  reserve:84,  fireRate:0.48, damage:34,  spread:0.003, auto:false, kick:0.058 },
  smg    : { name:'SMG',     ammo:30,  reserve:150, fireRate:0.082,damage:18,  spread:0.020, auto:true,  kick:0.022 },
  minigun: { name:'MINIGUN', ammo:100, reserve:300, fireRate:0.046,damage:20,  spread:0.038, auto:true, spinUp:true, kick:0.010 },
  sniper : { name:'SNIPER',  ammo:1,   reserve:20,  fireRate:1.4,  damage:999, spread:0,     auto:false, oneShot:true, kick:0.130 },
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

// Minigun spin state
let mgSpinSpeed = 0;    // current rad/s
let mgSpin      = 0;    // accumulated angle (for visual)
let barrelCluster = null;  // the rotating barrel group
const MG_MAX_SPIN = 28, MG_UP = 26, MG_DOWN = 12;

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
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 200);
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

// ─── Scope / FOV state ───────────────────────────────────────
const NORMAL_FOV = 72;
const SCOPE_FOV  = 15;
let targetFov    = NORMAL_FOV;
let scopeActive  = false;

// ─── Lights ──────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x1a2040, 0.28));

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

function makeFloorTex() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const ctx = c.getContext('2d');
  // Base: dark concrete grey
  ctx.fillStyle='#060608'; ctx.fillRect(0,0,512,512);
  // Fine grid
  ctx.strokeStyle='#0d0d14'; ctx.lineWidth=0.8;
  for(let i=0;i<=512;i+=32){
    ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
  }
  // Major grid (slightly brighter)
  ctx.strokeStyle='#0e1220'; ctx.lineWidth=1.8;
  for(let i=0;i<=512;i+=128){
    ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
  }
  // Accent squares at grid intersections
  for(let x=128;x<512;x+=128) for(let y=128;y<512;y+=128){
    ctx.fillStyle='#0e0f1e'; ctx.fillRect(x-6,y-6,12,12);
    ctx.strokeStyle='#2233aa'; ctx.lineWidth=1;
    ctx.strokeRect(x-6,y-6,12,12);
  }
  // Diagonal scratch marks (adds grit)
  ctx.strokeStyle='#111224'; ctx.lineWidth=0.5;
  for(let i=0;i<24;i++){
    const x=Math.random()*512, y=Math.random()*512;
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+18,y+6);ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(36,36);
  return tex;
}

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

// Ground-floor cover walls (scaled for larger arena)
const COVER_DEFS = [
  // Original cover ring
  [10,1.2,  -12, -8],[1.2,10,  14,-14],[10,1.2,   6, 10],[1.2, 9, -18, 14],
  [ 8,1.2,   0,-22],[1.2, 8,  22,  2],[ 8,1.2,  -6, 20],[1.2, 8, -26, -6],
  [ 7,1.2,  18,-28],[1.2, 7, -28, 18],[ 6,1.2,  -8,  0],[1.2, 6,   8, -8],
  [12,1.2,   0, -4],[1.2,12, -4,   0],
  // Outer ring (near mezzanine stairs approach)
  [ 8,1.2,  26,-20],[1.2, 8,  20, 26],[ 8,1.2, -26, 20],[1.2, 8, -20,-26],
  [ 5,1.2,  -2,-28],[ 5,1.2,   2, 28],[1.2, 5, -28, -2],[1.2, 5,  28,  2],
  // Mid-field diagonal flankers
  [ 6,1.2,  16, -6],[1.2, 6, -6, 16],[ 6,1.2, -16,  6],[1.2, 6,  6,-16],
  // Low crouching covers (half height)
  [ 5, .8,  10, -18],[ 5, .8, -10, 18],[1.2, 5,  24,-10],[1.2, 5,-24, 10],
  // L-shaped corners (two boxes at right angles)
  [6,1.2,  16, 22],[1.2, 5,  19, 25],
  [6,1.2, -16,-22],[1.2, 5, -19,-25],
];
const coverBoxes = [];
COVER_DEFS.forEach(([w,d,cx,cz,customH])=>{
  const ch = customH !== undefined ? customH : WH*.72;
  addBox(w,ch,d, cx,ch/2,cz, ARENA_M.cover);
  addBox(w+.04,.12,d+.04, cx,ch+.06,cz, ARENA_M.ctrim,false,false);
  coverBoxes.push({cx,cz,hw:w/2,hd:d/2});
});

// Central raised platform — creates a height-advantage landmark
addBox(9, .45, 9,  0, .225, 0, ARENA_M.pillar, false, true);
addBox(9.1,.06,9.1, 0, .47, 0, ARENA_M.ctrim, false, false);
// Cover walls on top of the platform
[[9,.9, 0,-4.2],[9,.9, 0, 4.2],[.9,9,-4.2,0],[.9,9, 4.2,0]].forEach(
  ([w,d,x,z])=>addBox(w,WH*.36,d,x,.225+WH*.18,z,ARENA_M.cover)
);
coverBoxes.push({cx:0,cz:0,hw:4.5,hd:4.5});

// Standalone cylindrical pillars as mid-field cover
[[10,-18],[-10,18],[20,-6],[-20,6],[18,12],[-18,-12]].forEach(([px,pz])=>{
  const m=new THREE.Mesh(new THREE.CylinderGeometry(.55,.55,WH*.75,10),ARENA_M.pillar);
  m.position.set(px,WH*.375,pz); m.castShadow=true; scene.add(m);
  coverBoxes.push({cx:px,cz:pz,hw:.65,hd:.65});
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

// ============================================================
//  PLAYER STATE
// ============================================================
const SPAWN = new THREE.Vector3(0, EYE_H, 2);
const P_SPEED = 9, P_RADIUS = 0.45;
const GRAVITY = -22, JUMP_VEL = 8.5;

const player = {
  health:100, maxHealth:100, kills:0,
  dead:false, hurtTimer:0,
};

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

function _drawLabelCanvas(ctx, name, hp, pvpOn, isAdmin, gunId, inCoop=false) {
  const W = 256, H = 100;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(6, 6, W - 12, H - 12);

  // Name (+ hammer badge for admins)
  const displayName = isAdmin ? name.slice(0, 16) + ' 🔨' : name.slice(0, 18);
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = isAdmin ? '#3b9ee8' : '#fff';
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

// ── Robot accessory attachment ────────────────────────────────
function addRobotAccessory(rob, accessoryId) {
  const rg = rob.group;
  // type = first underscore-segment of the ID (e.g. 'cowboy' from 'cowboy_brown_common')
  const type = accessoryId.split('_')[0];
  const St = (c,r=0.55,m=0.55) => new THREE.MeshStandardMaterial({color:c,roughness:r,metalness:m});
  const Bm = c => new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:0.85});
  const B  = (w,h,d)    => new THREE.BoxGeometry(w,h,d);
  const Cy = (rt,rb,h,s=16) => new THREE.CylinderGeometry(rt,rb,h,s);
  const Sp = (r,s=10)   => new THREE.SphereGeometry(r,s,s);
  const To = (r,t,rs=8,ts=16) => new THREE.TorusGeometry(r,t,rs,ts);
  function mk(geo,mat,px=0,py=0,pz=0,rx=0,ry=0,rz=0){
    const m=new THREE.Mesh(geo,mat); m.position.set(px,py,pz); m.rotation.set(rx,ry,rz); return m;
  }
  function grp(px,py,pz,parent){const g=new THREE.Group();g.position.set(px,py,pz);parent.add(g);return g;}

  switch (type) {
    /* ── HATS ─────────────────────────────────────────────── */
    case 'cowboy': {
      const g=grp(0,2.42,0,rg);
      g.add(mk(Cy(0.38,0.40,0.04,20),St(0x5a3010)));
      g.add(mk(Cy(0.22,0.28,0.26,18),St(0x7a4e2d),0,0.15,0));
      g.add(mk(Cy(0.23,0.23,0.04,18),St(0x3a1a08),0,0.03,0));
      break;
    }
    case 'tophat': {
      const g=grp(0,2.42,0,rg);
      g.add(mk(Cy(0.26,0.26,0.38,20),St(0x111111),0,0.19,0));
      g.add(mk(Cy(0.32,0.34,0.04,20),St(0x0d0d0d)));
      g.add(mk(Cy(0.235,0.235,0.04,20),St(0xcc1111),0,0.04,0));
      break;
    }
    case 'cap': {
      const g=grp(0,2.38,0,rg);
      g.add(mk(Sp(0.24,12),St(0x1a3a6e),0,0,0));
      g.add(mk(B(0.36,0.025,0.18),St(0x122a55),0,-0.06,-0.20));
      break;
    }
    case 'crown': {
      const g=grp(0,2.42,0,rg);
      g.add(mk(Cy(0.27,0.27,0.08,20),St(0xffd700,0.1,0.98)));
      [[-0.20,0.10],[-0.10,0.24],[0,0.10],[0.10,0.24],[0.20,0.10]].forEach(([x,yo])=>{
        g.add(mk(Cy(0.015,0.035,0.18,8),St(0xffcc00,0.08,0.99),x,0.04+yo*0.5+0.09,0));
        g.add(mk(Sp(0.028,8),St(0xff2222,0.05,0.4),x,0.04+yo*0.5+0.20,0));
      });
      break;
    }
    case 'helmet': {
      const g=grp(0,2.35,0,rg);
      g.add(mk(Sp(0.28,14),St(0xaabbcc),0,0.10,0));
      g.add(mk(B(0.32,0.10,0.06),St(0x8899aa,0.2,0.85),0,0.05,-0.24));
      g.add(mk(Cy(0.29,0.30,0.06,20),St(0x8899aa),0,-0.04,0));
      break;
    }
    case 'wizard': {
      const g=grp(0,2.40,0,rg);
      g.add(mk(Cy(0.01,0.26,0.48,18),St(0x4a1a8a),0,0.24,0));
      g.add(mk(Cy(0.30,0.32,0.04,18),St(0x3a1278)));
      g.add(mk(Sp(0.03,8),St(0xffd700,0.1,0.9),0,0.50,0));
      break;
    }
    case 'beanie': {
      const g=grp(0,2.38,0,rg);
      g.add(mk(Sp(0.24,14),St(0xcc2222),0,0.05,0));
      g.add(mk(Cy(0.245,0.245,0.06,20),St(0xaa1a1a),0,-0.12,0));
      g.add(mk(Sp(0.055,8),St(0xee4444),0,0.28,0));
      break;
    }
    case 'halo': {
      const g=grp(0,2.58,0,rg);
      g.add(mk(To(0.22,0.025,10,24),Bm(0xffd700)));
      break;
    }
    case 'party': {
      const g=grp(0,2.38,0,rg);
      g.add(mk(Cy(0.02,0.24,0.42,16),St(0xff44aa),0,0.21,0));
      g.add(mk(Cy(0.25,0.26,0.04,16),St(0xdd3388)));
      g.add(mk(Sp(0.038,8),St(0xffdd00,0.1,0.9),0,0.44,0));
      break;
    }
    case 'pirate': {
      const g=grp(0,2.36,0,rg);
      g.add(mk(Cy(0.25,0.27,0.18,18),St(0x111111),0,0.09,0));
      g.add(mk(B(0.54,0.06,0.36),St(0x0d0d0d),0,0.12,0));
      g.add(mk(B(0.18,0.10,0.08),St(0xdddddd),0,0.16,-0.18));
      break;
    }
    /* ── EYEWEAR ───────────────────────────────────────────── */
    case 'rounds': {
      const g=grp(0,1.982,-0.27,rg);
      const lm=St(0x111111,0.05,0.9);
      g.add(mk(Cy(0.075,0.075,0.022,14),lm,-0.095,0,0,Math.PI/2));
      g.add(mk(Cy(0.075,0.075,0.022,14),lm, 0.095,0,0,Math.PI/2));
      g.add(mk(B(0.044,0.014,0.014),St(0xc8a215)));
      break;
    }
    case 'squares': {
      const g=grp(0,1.982,-0.27,rg);
      const lm=St(0x111111,0.05,0.9);
      g.add(mk(B(0.10,0.072,0.022),lm,-0.075,0));
      g.add(mk(B(0.10,0.072,0.022),lm, 0.075,0));
      g.add(mk(B(0.044,0.012,0.014),St(0xc8a215)));
      break;
    }
    case 'cgoggles': {
      const g=grp(0,1.982,-0.27,rg);
      g.add(mk(B(0.28,0.10,0.040),St(0x222222,0.4,0.7)));
      g.add(mk(B(0.095,0.072,0.012),Bm(0x00ccff),-0.075,0,-0.026));
      g.add(mk(B(0.095,0.072,0.012),Bm(0x00ccff), 0.075,0,-0.026));
      break;
    }
    case 'vr': {
      const g=grp(0,1.982,-0.29,rg);
      g.add(mk(B(0.36,0.18,0.10),St(0x1a1a1a,0.35,0.65)));
      g.add(mk(B(0.28,0.13,0.004),Bm(0x2255ff),0,0,-0.052));
      g.add(mk(Sp(0.012,6),Bm(0x00ff44),0.15,0.07,-0.052));
      break;
    }
    case 'monocle': {
      const g=grp(0,1.982,-0.27,rg);
      g.add(mk(To(0.07,0.010,8,16),St(0xc8a215,0.15,0.95),-0.05,0,0));
      g.add(mk(B(0.004,0.14,0.004),St(0x888888),0.06,-0.06,0));
      break;
    }
    case 'skigoggles': {
      const g=grp(0,1.982,-0.27,rg);
      g.add(mk(B(0.32,0.11,0.048),St(0x222222,0.5,0.5)));
      g.add(mk(B(0.10,0.075,0.014),Bm(0xdd6600),-0.075,0,-0.028));
      g.add(mk(B(0.10,0.075,0.014),Bm(0xdd6600), 0.075,0,-0.028));
      break;
    }
    case 'cateye': {
      const g=grp(0,1.982,-0.27,rg);
      const lm=St(0x111111,0.05,0.9);
      g.add(mk(B(0.10,0.060,0.022),lm,-0.075, 0.010,0, 0,0,-0.20));
      g.add(mk(B(0.10,0.060,0.022),lm, 0.075, 0.010,0, 0,0, 0.20));
      g.add(mk(B(0.044,0.012,0.014),St(0xc8a215)));
      break;
    }
    /* ── NECK ──────────────────────────────────────────────── */
    case 'chain': {
      const g=grp(0,1.815,0,rg);
      for(let i=0;i<=12;i++){
        const a=Math.PI+(i/12)*Math.PI;
        const lk=mk(To(0.018,0.005,6,8),St(0xffd700,0.12,0.97));
        lk.position.set(Math.cos(a)*0.18,Math.sin(a)*0.06-0.04,-Math.abs(Math.sin(a))*0.10);
        lk.rotation.y=a; g.add(lk);
      }
      break;
    }
    case 'pendant': {
      const g=grp(0,1.815,0,rg);
      for(let i=0;i<=8;i++){const a=Math.PI+(i/8)*Math.PI;const lk=mk(To(0.016,0.004,6,8),St(0xffd700,0.12,0.97));lk.position.set(Math.cos(a)*0.16,Math.sin(a)*0.05-0.03,-Math.abs(Math.sin(a))*0.08);g.add(lk);}
      g.add(mk(Sp(0.032,10),St(0xff2222,0.05,0.4),0,-0.12,-0.14));
      break;
    }
    case 'dogtags': {
      const g=grp(0,1.815,0,rg);
      g.add(mk(B(0.055,0.075,0.005),St(0x9ba9b8,0.25,0.92),-0.020,-0.09,-0.12));
      g.add(mk(B(0.055,0.075,0.005),St(0xaabbcc,0.25,0.92), 0.020,-0.11,-0.13));
      g.add(mk(To(0.15,0.004,6,20),St(0x90a0b0,0.3,0.88),0,0,-0.08,0.3));
      break;
    }
    case 'bowtie': {
      const g=grp(0,1.76,-0.24,rg);
      g.add(mk(B(0.10,0.064,0.030),St(0x111111),-0.065,0,0, 0,0, 0.18));
      g.add(mk(B(0.10,0.064,0.030),St(0x111111), 0.065,0,0, 0,0,-0.18));
      g.add(mk(Sp(0.024,8),St(0x333333,0.3,0.6)));
      break;
    }
    case 'tie': {
      const g=grp(0,1.72,-0.24,rg);
      g.add(mk(B(0.055,0.22,0.018),St(0x111111),0,-0.06,0));
      g.add(mk(B(0.072,0.058,0.018),St(0x0d0d0d),0, 0.05,0));
      break;
    }
    case 'scarf': {
      const g=grp(0,1.790,-0.15,rg);
      g.add(mk(To(0.18,0.046,10,20),St(0xcc2222,0.8,0.1),0,0,0, Math.PI*0.12));
      g.add(mk(B(0.048,0.22,0.040),St(0xaa1a1a,0.8,0.1),0.12,-0.14,-0.02, 0,0,0.15));
      break;
    }
    /* ── WRIST ─────────────────────────────────────────────── */
    case 'rwatch': {
      const target = rob.armGroupL || rg;
      const g=grp(-0.090,-1.096,0,target);
      g.add(mk(Cy(0.048,0.048,0.055,14),St(0x1a1a1a,0.85,0.1),0,0,0, Math.PI/2));
      g.add(mk(B(0.064,0.064,0.020),St(0x111122,0.3,0.7),0,0,-0.036));
      g.add(mk(B(0.050,0.050,0.004),Bm(0x00ff88),0,0,-0.047));
      break;
    }
    case 'swatch': {
      const target = rob.armGroupL || rg;
      const g=grp(-0.090,-1.096,0,target);
      g.add(mk(Cy(0.048,0.048,0.055,14),St(0x1a1a1a,0.85,0.1),0,0,0, Math.PI/2));
      g.add(mk(B(0.072,0.072,0.020),St(0x111111,0.3,0.7),0,0,-0.036));
      g.add(mk(B(0.055,0.055,0.004),Bm(0x00ccff),0,0,-0.047));
      break;
    }
    case 'bracelet': {
      const target = rob.armGroupL || rg;
      const g=grp(-0.090,-1.096,0,target);
      g.add(mk(To(0.052,0.016,10,20),St(0xffd700,0.12,0.97),0,0,0, Math.PI/2));
      break;
    }
    case 'pband': {
      const target = rob.armGroupL || rg;
      const g=grp(-0.090,-1.096,0,target);
      g.add(mk(To(0.052,0.012,10,20),St(0x0a0a1a,0.5,0.7),0,0,0, Math.PI/2));
      [0xffaa00,0x22aaff,0xff2222].forEach((c,i)=>{
        const a=(i/3)*Math.PI*2;
        g.add(mk(Sp(0.008,6),Bm(c),Math.cos(a)*0.052,0,Math.sin(a)*0.052));
      });
      break;
    }
    case 'cbracelet': {
      const target = rob.armGroupL || rg;
      const g=grp(-0.090,-1.096,0,target);
      for(let i=0;i<12;i++){const a=(i/12)*Math.PI*2;const lk=mk(To(0.012,0.005,6,8),St(0xffd700,0.12,0.97));lk.position.set(Math.cos(a)*0.052,0,Math.sin(a)*0.052);lk.rotation.y=a;g.add(lk);}
      break;
    }
    /* ── BACK ──────────────────────────────────────────────── */
    case 'cape': {
      const g=grp(0,1.70,0.22,rg);
      g.add(mk(B(0.44,0.72,0.018),St(0x111111,0.85,0.05),0,-0.10,0));
      g.add(mk(B(0.44,0.06,0.022),St(0x222222,0.7,0.2),0, 0.26,0));
      break;
    }
    case 'wings': {
      const g=grp(0,1.72,0.18,rg);
      [-1,1].forEach(s=>{
        const w=new THREE.Group(); w.position.x=s*0.10;
        w.add(mk(B(0.38,0.58,0.018),St(0xf0f0f0,0.9,0.05),s*0.26,-0.05,0));
        w.add(mk(B(0.22,0.44,0.014),St(0xdddddd,0.9,0.05),s*0.42, 0.05,0));
        g.add(w);
      });
      break;
    }
    case 'jetpack': {
      const g=grp(0,1.68,0.22,rg);
      g.add(mk(B(0.24,0.30,0.12),St(0x888888,0.7,0.5)));
      g.add(mk(Cy(0.044,0.050,0.12,10),St(0x555555,0.5,0.7),-0.072,-0.22,0));
      g.add(mk(Cy(0.044,0.050,0.12,10),St(0x555555,0.5,0.7), 0.072,-0.22,0));
      g.add(mk(Cy(0.020,0.028,0.06,10),Bm(0xff5500),-0.072,-0.30,0));
      g.add(mk(Cy(0.020,0.028,0.06,10),Bm(0xff5500), 0.072,-0.30,0));
      break;
    }
    case 'backpack': {
      const g=grp(0,1.68,0.22,rg);
      g.add(mk(B(0.28,0.34,0.14),St(0x111111,0.8,0.1)));
      g.add(mk(B(0.20,0.20,0.04),St(0x0d0d0d,0.7,0.15),0, 0.04,-0.02));
      g.add(mk(B(0.04,0.30,0.02),St(0x0a0a0a,0.7,0.2),-0.16,0.04, 0.08));
      g.add(mk(B(0.04,0.30,0.02),St(0x0a0a0a,0.7,0.2), 0.16,0.04, 0.08));
      break;
    }
    case 'quiver': {
      const g=grp(0.18,1.70,0.18,rg);
      g.add(mk(Cy(0.050,0.055,0.38,12),St(0x7a4e2d,0.8,0.1),0,0,0));
      [-0.02,0,0.02].forEach(ox=>g.add(mk(Cy(0.005,0.005,0.30,6),St(0x888888),ox,0.24,0)));
      break;
    }
    /* ── SHOULDERS ─────────────────────────────────────────── */
    case 'spad': {
      [-1,1].forEach(s=>{
        const g=grp(s*0.62,2.0,0,rg);
        g.add(mk(B(0.18,0.22,0.08),St(0xaabbcc,0.4,0.7)));
        g.add(mk(B(0.14,0.04,0.10),St(0x8899aa,0.3,0.8),0,-0.13,0));
      });
      break;
    }
    case 'epaul': {
      [-1,1].forEach(s=>{
        const g=grp(s*0.62,2.02,0,rg);
        g.add(mk(B(0.20,0.06,0.10),St(0xc8a215,0.15,0.92)));
        g.add(mk(B(0.18,0.06,0.08),St(0xb89000,0.2,0.88),0,-0.07,0));
        for(let j=0;j<5;j++) g.add(mk(Cy(0.006,0.004,0.10,6),St(0xaa8800,0.3,0.8),(j-2)*0.028,-0.14,0));
      });
      break;
    }
    case 'xshoulder': {
      [-1,1].forEach(s=>{
        const g=grp(s*0.62,2.04,0,rg);
        g.add(mk(B(0.10,0.28,0.06),St(0xccddff,0.1,0.5)));
        g.add(mk(B(0.06,0.18,0.04),St(0xaaddff,0.05,0.6),0, 0.05,-0.04));
        g.add(mk(Sp(0.032,8),Bm(0x88ccff),0, 0.16,-0.02));
      });
      break;
    }
    /* ── FACE ──────────────────────────────────────────────── */
    case 'fmask': {
      const g=grp(0,1.982,-0.30,rg);
      g.add(mk(B(0.26,0.20,0.028),St(0xdddddd,0.4,0.3)));
      g.add(mk(B(0.06,0.04,0.010),St(0x888888,0.2,0.5),-0.072, 0.030,-0.015));
      g.add(mk(B(0.06,0.04,0.010),St(0x888888,0.2,0.5), 0.072, 0.030,-0.015));
      break;
    }
    case 'fpaint': {
      const g=grp(0,1.982,-0.26,rg);
      g.add(mk(B(0.08,0.016,0.008),Bm(0xcc2222),-0.10, 0.03));
      g.add(mk(B(0.08,0.016,0.008),Bm(0xcc2222), 0.10, 0.03));
      g.add(mk(B(0.04,0.04,0.008),Bm(0xffd700),0,-0.04));
      break;
    }
    case 'nosering': {
      const g=grp(0,1.946,-0.29,rg);
      g.add(mk(To(0.016,0.005,8,16),St(0xffd700,0.12,0.96)));
      break;
    }
    case 'fgem': {
      const g=grp(0,2.020,-0.295,rg);
      g.add(mk(Sp(0.020,10),St(0xcc1111,0.05,0.5)));
      break;
    }
    /* ── FEET ──────────────────────────────────────────────── */
    case 'boots': {
      [rob.legL, rob.legR].forEach(leg=>{
        if(!leg) return;
        const g=grp(0,-1.40,0,leg);
        g.add(mk(B(0.22,0.16,0.28),St(0x111111,0.8,0.1),0,0,0.02));
        g.add(mk(B(0.22,0.04,0.30),St(0x0d0d0d,0.7,0.15),0,-0.10,0.03));
      });
      break;
    }
    case 'heels': {
      [rob.legL, rob.legR].forEach(leg=>{
        if(!leg) return;
        const g=grp(0,-1.40,0,leg);
        g.add(mk(B(0.18,0.22,0.18),St(0xcc2222,0.4,0.3),0,0.04,0.02));
        g.add(mk(Cy(0.022,0.018,0.14,8),St(0xaa1111,0.3,0.5),0,-0.12,0.08));
      });
      break;
    }
    case 'rboots': {
      [rob.legL, rob.legR].forEach(leg=>{
        if(!leg) return;
        const g=grp(0,-1.40,0,leg);
        g.add(mk(B(0.22,0.18,0.28),St(0x888888,0.5,0.7),0,0,0.02));
        g.add(mk(Cy(0.028,0.036,0.10,10),St(0x555555,0.4,0.8),-0.055,-0.15,0.04));
        g.add(mk(Cy(0.028,0.036,0.10,10),St(0x555555,0.4,0.8), 0.055,-0.15,0.04));
        g.add(mk(Cy(0.014,0.020,0.06,8),Bm(0xff5500),-0.055,-0.22,0.04));
        g.add(mk(Cy(0.014,0.020,0.06,8),Bm(0xff5500), 0.055,-0.22,0.04));
      });
      break;
    }
    case 'hboots': {
      [rob.legL, rob.legR].forEach(leg=>{
        if(!leg) return;
        const g=grp(0,-1.40,0,leg);
        g.add(mk(B(0.22,0.18,0.28),St(0xdddddd,0.3,0.6),0,0,0.02));
        g.add(mk(To(0.115,0.018,8,18),Bm(0x88ddff),0,-0.14,0, Math.PI/2));
      });
      break;
    }
  }
}

// ── (legacy cases kept for backward compat – now handled by type dispatch above) ──
function _addRobotAccessory_OLD(rob, accessoryId) {
  const g = rob.group;
  const M = THREE.MeshStandardMaterial;
  const BM = THREE.MeshBasicMaterial;

  switch (accessoryId) {

    case 'cowboy_hat': {
      const grp = new THREE.Group();
      grp.position.set(0, 2.42, 0);
      // brim
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.40, 0.045, 20), new M({color:0x7a4e2d,roughness:0.85,metalness:0.05}));
      grp.add(brim);
      // crown
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.28, 20), new M({color:0x5c3317,roughness:0.9,metalness:0.04}));
      crown.position.y = 0.16;
      grp.add(crown);
      // band
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.231, 0.231, 0.042, 20), new M({color:0x3a1a08,roughness:0.7,metalness:0.08}));
      band.position.y = 0.04;
      grp.add(band);
      g.add(grp);
      break;
    }

    case 'top_hat': {
      const grp = new THREE.Group();
      grp.position.set(0, 2.42, 0);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.04, 20), new M({color:0x111111,roughness:0.6,metalness:0.3}));
      grp.add(brim);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.38, 20), new M({color:0x0d0d0d,roughness:0.55,metalness:0.35}));
      crown.position.y = 0.21;
      grp.add(crown);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.038, 20), new M({color:0xcc1111,roughness:0.5,metalness:0.1}));
      band.position.y = 0.04;
      grp.add(band);
      g.add(grp);
      break;
    }

    case 'cap': {
      const grp = new THREE.Group();
      grp.position.set(0, 2.38, 0);
      // dome
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 10, 0, Math.PI*2, 0, Math.PI*0.55), new M({color:0x1a3a6e,roughness:0.7,metalness:0.1}));
      grp.add(dome);
      // brim (flat half-disk shape approximated with a box)
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.025, 0.18), new M({color:0x122a55,roughness:0.65,metalness:0.12}));
      visor.position.set(0, -0.06, -0.20);
      grp.add(visor);
      g.add(grp);
      break;
    }

    case 'crown': {
      const grp = new THREE.Group();
      grp.position.set(0, 2.42, 0);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.08, 20), new M({color:0xffd700,roughness:0.1,metalness:0.98}));
      grp.add(base);
      const pts = [[-0.20,0.10],[-0.10,0.24],[0,0.10],[0.10,0.24],[0.20,0.10]];
      pts.forEach(([x,yOff]) => {
        const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.035, 0.18, 8), new M({color:0xffcc00,roughness:0.08,metalness:0.99}));
        spike.position.set(x, 0.04 + yOff * 0.5 + 0.09, 0);
        grp.add(spike);
        const gem = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), new M({color:0xff2222,roughness:0.05,metalness:0.4,emissive:0x880000}));
        gem.position.set(x, 0.04 + yOff * 0.5 + 0.20, 0);
        grp.add(gem);
      });
      g.add(grp);
      break;
    }

    case 'sunglasses': {
      const grp = new THREE.Group();
      grp.position.set(0, 1.982, -0.27);
      const lensMat = new M({color:0x111111,roughness:0.05,metalness:0.9,transparent:true,opacity:0.82});
      const frameMat = new M({color:0xd4af37,roughness:0.15,metalness:0.92});
      const lL = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.022, 14), lensMat);
      lL.rotation.x = Math.PI / 2;
      lL.position.set(-0.095, 0, 0);
      grp.add(lL);
      const lR = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.022, 14), lensMat);
      lR.rotation.x = Math.PI / 2;
      lR.position.set(0.095, 0, 0);
      grp.add(lR);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.014, 0.014), frameMat);
      grp.add(bridge);
      const armL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.010, 0.010), frameMat);
      armL.position.set(-0.155, 0, 0.04);
      armL.rotation.y = 0.3;
      grp.add(armL);
      const armR = armL.clone();
      armR.position.set(0.155, 0, 0.04);
      armR.rotation.y = -0.3;
      grp.add(armR);
      g.add(grp);
      break;
    }

    case 'cyber_goggles': {
      const grp = new THREE.Group();
      grp.position.set(0, 1.982, -0.27);
      const bodyMat = new M({color:0x222222,roughness:0.4,metalness:0.7});
      const lensMatL = new BM({color:0x00ccff, transparent:true, opacity:0.75});
      const lensMatR = new BM({color:0x00ccff, transparent:true, opacity:0.75});
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.10, 0.040), bodyMat);
      grp.add(body);
      const lL = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.072, 0.012), lensMatL);
      lL.position.set(-0.075, 0, -0.026);
      grp.add(lL);
      const lR = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.072, 0.012), lensMatR);
      lR.position.set(0.075, 0, -0.026);
      grp.add(lR);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.032, 0.012), new M({color:0x333333,roughness:0.8,metalness:0.2}));
      strap.position.z = 0.028;
      grp.add(strap);
      g.add(grp);
      break;
    }

    case 'vr_headset': {
      const grp = new THREE.Group();
      grp.position.set(0, 1.982, -0.29);
      const shellMat = new M({color:0x1a1a1a,roughness:0.35,metalness:0.65});
      const shell = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.10), shellMat);
      grp.add(shell);
      const screenMat = new BM({color:0x2255ff});
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.13, 0.004), screenMat);
      screen.position.z = -0.052;
      grp.add(screen);
      const scanline = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.006, 0.006), new BM({color:0x55aaff}));
      scanline.position.set(0, 0.028, -0.054);
      grp.add(scanline);
      const scanline2 = scanline.clone();
      scanline2.position.y = -0.028;
      grp.add(scanline2);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), new BM({color:0x00ff44}));
      led.position.set(0.15, 0.07, -0.052);
      grp.add(led);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.046, 0.020), new M({color:0x111111,roughness:0.9,metalness:0.1}));
      strap.position.z = 0.06;
      grp.add(strap);
      g.add(grp);
      break;
    }

    case 'gold_chain': {
      const grp = new THREE.Group();
      grp.position.set(0, 1.815, 0);
      const chainMat = new M({color:0xffd700,roughness:0.12,metalness:0.97});
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI + (i / 12) * Math.PI;
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 6, 8), chainMat);
        link.position.set(Math.cos(a) * 0.18, Math.sin(a) * 0.06 - 0.04, -Math.abs(Math.sin(a)) * 0.10);
        link.rotation.y = a;
        grp.add(link);
      }
      const pendant = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.016, 0.040, 8), chainMat);
      pendant.position.set(0, -0.10, -0.14);
      grp.add(pendant);
      g.add(grp);
      break;
    }

    case 'dog_tags': {
      const grp = new THREE.Group();
      grp.position.set(0, 1.815, 0);
      const tagMat = new M({color:0xaab8c8,roughness:0.25,metalness:0.92});
      const tag1 = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.005), tagMat);
      tag1.position.set(-0.020, -0.09, -0.12);
      tag1.rotation.z = 0.12;
      grp.add(tag1);
      const tag2 = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.005), tagMat);
      tag2.position.set(0.020, -0.11, -0.13);
      tag2.rotation.z = -0.10;
      grp.add(tag2);
      const chain = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.004, 6, 20, Math.PI), new M({color:0x90a0b0,roughness:0.3,metalness:0.88}));
      chain.rotation.x = -0.3;
      chain.position.set(0, 0, -0.08);
      grp.add(chain);
      g.add(grp);
      break;
    }

    case 'watch': {
      const grp = new THREE.Group();
      // attach to armGroupL in local arm space (wrist position)
      const target = rob.armGroupL || g;
      grp.position.set(-0.090, -1.096, 0);
      const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.055, 14), new M({color:0x1a1a1a,roughness:0.85,metalness:0.1}));
      strap.rotation.x = Math.PI / 2;
      grp.add(strap);
      const face = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.064, 0.020), new M({color:0x111111,roughness:0.3,metalness:0.7}));
      face.position.z = -0.036;
      grp.add(face);
      const display = new THREE.Mesh(new THREE.BoxGeometry(0.050, 0.050, 0.004), new BM({color:0x00ff88}));
      display.position.z = -0.047;
      grp.add(display);
      const crown = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.018, 0.010), new M({color:0x888888,roughness:0.3,metalness:0.9}));
      crown.position.set(0.038, 0, -0.040);
      grp.add(crown);
      target.add(grp);
      break;
    }

    case 'power_band': {
      const grp = new THREE.Group();
      const target = rob.armGroupL || g;
      grp.position.set(-0.090, -1.096, 0);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.012, 10, 20), new M({color:0x0a0a1a,roughness:0.5,metalness:0.7}));
      band.rotation.x = Math.PI / 2;
      grp.add(band);
      const colors = [0xff2222, 0xffcc00, 0x22aaff];
      colors.forEach((col, i) => {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 6), new BM({color:col}));
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        dot.position.set(Math.cos(a) * 0.052, 0, Math.sin(a) * 0.052 - 0.001);
        grp.add(dot);
      });
      target.add(grp);
      break;
    }
  }
}

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
      row.appendChild(nameEl);
      row.appendChild(btn);
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
function setupWeapon(id) {
  while (weaponRoot.children.length>0) weaponRoot.remove(weaponRoot.children[0]);
  weaponRoot.add(muzzleLight);  // re-add persistent light
  barrelCluster = null;
  mgSpinSpeed = 0;

  const def = GUN_DEFS[id];
  gun.def = def; gun.ammo = def.ammo; gun.reserve = def.reserve;
  gun.shootTimer = 0; gun.canShoot = true;

  if      (id==='pistol')  buildPistol(weaponRoot);
  else if (id==='smg')     buildSMG(weaponRoot);
  else if (id==='minigun') buildMinigun(weaponRoot);
  else if (id==='sniper')  buildSniper(weaponRoot);

  if (gunNameEl) gunNameEl.textContent = def.name;
  updateAmmoHUD();
  // Cache the base Y/X set by the build function so bob can offset from it
  weaponRoot.userData.baseY = weaponRoot.position.y;
  weaponRoot.userData.baseX = weaponRoot.position.x;
  weaponRoot.userData.baseZ = weaponRoot.position.z;
  recoilZ = 0; recoilY = 0;
}

// ============================================================
//  ROBOT ENEMY
// ============================================================
function buildRobot() {
  const g = new THREE.Group();

  // ── Materials ─────────────────────────────────────────────
  const HULL   = new THREE.MeshStandardMaterial({color:0x18202a, roughness:0.58, metalness:0.76});
  const ARMOR  = new THREE.MeshStandardMaterial({color:0x242c3a, roughness:0.65, metalness:0.55});
  const PANEL  = new THREE.MeshStandardMaterial({color:0x2c3448, roughness:0.74, metalness:0.42});
  const DARK   = new THREE.MeshStandardMaterial({color:0x08090e, roughness:0.92, metalness:0.12});
  const STEEL  = new THREE.MeshStandardMaterial({color:0x7c8ea2, roughness:0.04, metalness:0.99});
  const SERVO  = new THREE.MeshStandardMaterial({color:0x2a2e3c, roughness:0.10, metalness:0.97});
  const PIPE   = new THREE.MeshStandardMaterial({color:0x48525e, roughness:0.30, metalness:0.90});
  const ACCENT = new THREE.MeshStandardMaterial({color:0x580c10, roughness:0.42, metalness:0.62});
  const WORN   = new THREE.MeshStandardMaterial({color:0x3a1e1e, roughness:0.82, metalness:0.38});
  const EYE_L  = new THREE.MeshBasicMaterial({color:0xff0800});
  const EYE_R  = new THREE.MeshBasicMaterial({color:0xff0800});

  // ── Root-level helpers ─────────────────────────────────────
  function box(w,h,d,x,y,z,mat,rX=0,rZ=0){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z); if(rX)m.rotation.x=rX; if(rZ)m.rotation.z=rZ;
    g.add(m); return m;
  }
  function cyl(rt,rb,h,segs,x,y,z,mat,rX=0,rZ=0){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,segs),mat);
    m.position.set(x,y,z); if(rX)m.rotation.x=rX; if(rZ)m.rotation.z=rZ;
    g.add(m); return m;
  }
  function sph(r,segs,x,y,z,mat){
    const m=new THREE.Mesh(new THREE.SphereGeometry(r,segs,Math.ceil(segs*.72)),mat);
    m.position.set(x,y,z); g.add(m); return m;
  }
  function glow(w,h,d,x,y,z,col){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:col}));
    m.position.set(x,y,z); g.add(m); return m;
  }
  function glowCyl(rt,rb,h,segs,x,y,z,col,rX=0,rZ=0){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,segs),new THREE.MeshBasicMaterial({color:col}));
    m.position.set(x,y,z); if(rX)m.rotation.x=rX; if(rZ)m.rotation.z=rZ;
    g.add(m); return m;
  }

  // ════════════════════════════════════════════════════════
  // LEGS  (pivot group at side*0.22, 0.74, 0)
  // ════════════════════════════════════════════════════════
  function makeLeg(side) {
    const lg = new THREE.Group();
    lg.position.set(side*0.22, 0.74, 0);
    function lbox(w,h,d,x,y,z,mat,rZ=0){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat); m.position.set(x,y,z); if(rZ)m.rotation.z=rZ; lg.add(m); }
    function lcyl(rt,rb,h,n,x,y,z,mat,rX=0,rZ=0){ const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,n),mat); m.position.set(x,y,z); if(rX)m.rotation.x=rX; if(rZ)m.rotation.z=rZ; lg.add(m); }
    function lsph(r,n,x,y,z,mat){ const m=new THREE.Mesh(new THREE.SphereGeometry(r,n,Math.ceil(n*.72)),mat); m.position.set(x,y,z); lg.add(m); }
    function lglow(w,h,d,x,y,z,col){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:col})); m.position.set(x,y,z); lg.add(m); }

    // ── Hip joint cluster ──
    lsph(0.148,13,  0,0,0, SERVO);      // outer housing sphere
    lsph(0.108,10,  0,0,0, STEEL);      // polished inner ball
    lcyl(0.162,0.162,0.050,12, 0,0,side*0.045, DARK, 0,Math.PI/2); // socket collar
    lbox(0.072,0.120,0.145, side*0.158,0,-0.010, ARMOR);           // hip flange
    lbox(0.052,0.090,0.100, side*0.178,0,-0.012, PANEL);

    // ── Upper thigh ──
    lcyl(0.130,0.106,0.52,13, 0,-0.260,0, HULL);
    lbox(0.200,0.305,0.072, 0,-0.220,-0.118, ARMOR);   // front plate
    lbox(0.170,0.260,0.040, 0,-0.225,-0.138, PANEL);   // sub-plate
    lglow(0.155,0.022,0.038, 0,-0.378,-0.140, 0xff0800);
    lbox(0.065,0.295,0.195, side*0.122,-0.232,0.002, ARMOR); // outer side plate
    lbox(0.045,0.260,0.165, side*0.132,-0.232,0.002, PANEL);
    lbox(0.170,0.270,0.060, 0,-0.220,0.116, HULL);     // rear plate
    lcyl(0.024,0.020,0.44,9, side*0.068,-0.230,0.102, STEEL); // primary piston
    lcyl(0.014,0.014,0.34,8, side*0.090,-0.230,0.108, PIPE);
    lsph(0.028,7, side*0.068,-0.006,0.102, SERVO);    // piston top cap
    lsph(0.028,7, side*0.068,-0.452,0.102, SERVO);    // piston bottom cap
    lcyl(0.013,0.010,0.30,7, side*0.046,-0.260,0.095, PIPE); // secondary piston
    for(let i=0;i<3;i++) lbox(0.016,0.040,0.080, side*0.142,-0.165-i*0.058,0.010, DARK); // vent slits
    lbox(0.100,0.055,0.012, 0,-0.310,-0.152, DARK);   // detail indent

    // ── Knee mechanism ──
    lsph(0.112,13, 0,-0.555,0, SERVO);
    lsph(0.084, 9, 0,-0.555,0, STEEL);
    lbox(0.228,0.098,0.152, 0,-0.554,-0.105, ACCENT); // kneecap
    lbox(0.195,0.065,0.110, 0,-0.554,-0.128, DARK);   // recess
    lbox(0.210,0.030,0.152, 0,-0.601,-0.108, DARK);   // lower overhang
    lglow(0.198,0.012,0.142, 0,-0.607,-0.058, 0xff0800);
    lbox(0.045,0.125,0.152, side*0.130,-0.555,-0.042, ARMOR); // side guard
    lbox(0.038,0.100,0.115, side*0.142,-0.555,-0.042, PANEL);
    lcyl(0.024,0.024,0.058,9, side*0.148,-0.555,0.008, STEEL, 0,Math.PI/2); // axle bolt
    lsph(0.022,7, side*0.178,-0.555,0.008, DARK);

    // ── Shin ──
    lcyl(0.106,0.088,0.46,13, 0,-0.825,0, HULL);
    lbox(0.168,0.258,0.065, 0,-0.796,-0.118, ARMOR);  // front plate (3-layer)
    lbox(0.145,0.218,0.042, 0,-0.800,-0.140, PANEL);
    lbox(0.115,0.165,0.025, 0,-0.808,-0.155, DARK);
    lglow(0.065,0.012,0.032, 0,-0.706,-0.158, 0xff0800);
    lglow(0.048,0.008,0.030, 0,-0.868,-0.156, 0xff2200);
    lbox(0.062,0.240,0.195, side*0.118,-0.808,0.006, ARMOR); // outer plate
    lbox(0.118,0.225,0.092, 0,-0.824,0.126, DARK);           // calf housing
    lcyl(0.026,0.022,0.40,9, 0,-0.820,0.126, STEEL);
    lcyl(0.015,0.015,0.28,7, side*0.040,-0.820,0.130, PIPE);
    for(let i=0;i<2;i++) lbox(0.018,0.032,0.065, side*0.118,-0.766-i*0.062,0.005, DARK);

    // ── Ankle ──
    lsph(0.085,12, 0,-1.072,0, SERVO);
    lsph(0.062, 9, 0,-1.072,0, STEEL);
    lcyl(0.110,0.102,0.044,11, 0,-1.088,0, DARK);             // exo ring
    lbox(0.052,0.095,0.120, side*0.108,-1.072,0.010, ARMOR);
    lcyl(0.020,0.020,0.050,8, side*0.138,-1.062,0.010, STEEL, 0,Math.PI/2);

    // ── Foot ──
    lbox(0.255,0.085,0.402, 0,-1.148,0.044, HULL);
    lbox(0.235,0.028,0.380, 0,-1.106,0.044, ARMOR);  // top plate
    lbox(0.215,0.020,0.355, 0,-1.090,0.044, PANEL);  // inner top
    lbox(0.212,0.092,0.112, 0,-1.144,-0.188, ACCENT); // toe cap
    lglow(0.178,0.010,0.024, 0,-1.100,-0.232, 0xff0800);
    lbox(0.060,0.078,0.102, side*0.090,-1.144,-0.185, PANEL);
    lbox(0.165,0.065,0.090, 0,-1.148,0.228, DARK);   // heel
    lbox(0.145,0.040,0.072, 0,-1.148,0.240, ARMOR);
    lglow(0.188,0.010,0.280, 0,-1.192,0.044, 0xff1800); // sole glow
    lcyl(0.016,0.016,0.048,8, side*0.134,-1.118,0.038, STEEL, 0,Math.PI/2);

    g.add(lg);
    return lg;
  }
  const legL = makeLeg(-1);
  const legR = makeLeg( 1);

  // ════════════════════════════════════════════════════════
  // PELVIS
  // ════════════════════════════════════════════════════════
  box(0.555,0.212,0.402, 0,0.878,0, HULL);
  box(0.535,0.040,0.382, 0,0.984,0, ACCENT);
  box(0.535,0.040,0.382, 0,0.772,0, ACCENT);
  box(0.138,0.188,0.352, -0.352,0.878,0, DARK);
  box(0.138,0.188,0.352,  0.352,0.878,0, DARK);
  box(0.232,0.145,0.100, 0,0.822,-0.202, ARMOR);
  box(0.190,0.105,0.055, 0,0.822,-0.254, PANEL);
  glow(0.185,0.010,0.062, 0,0.873,-0.260, 0xff0800);
  for(let s=-1;s<=1;s+=2) for(let i=0;i<2;i++)
    box(0.016,0.052,0.290, s*0.276,0.905-i*0.074,0.042, DARK);

  // ════════════════════════════════════════════════════════
  // TORSO
  // ════════════════════════════════════════════════════════
  box(0.595,0.530,0.450, 0,1.272,0, HULL);
  box(0.680,0.310,0.465, 0,1.600,0, HULL);
  box(0.740,0.042,0.458, 0,1.050,0, ACCENT);
  for(let i=0;i<5;i++){
    box(0.610,0.054,0.424, 0,1.080+i*0.070,0, ARMOR);
    box(0.590,0.016,0.408, 0,1.080+i*0.070-0.016,0, DARK);
  }
  box(0.052,0.320,0.016, 0,1.120,-0.214, DARK);
  glow(0.018,0.290,0.010, 0,1.120,-0.222, 0xff0800);
  // Pectorals
  box(0.278,0.318,0.080, -0.174,1.570,-0.226, ARMOR);
  box(0.278,0.318,0.080,  0.174,1.570,-0.226, ARMOR);
  box(0.115,0.330,0.076,  0.000,1.570,-0.225, DARK);
  box(0.228,0.170,0.030, -0.174,1.558,-0.256, PANEL);
  box(0.228,0.170,0.030,  0.174,1.558,-0.256, PANEL);
  glow(0.226,0.016,0.038, -0.174,1.736,-0.252, 0xff0800);
  glow(0.226,0.016,0.038,  0.174,1.736,-0.252, 0xff0800);
  box(0.240,0.036,0.077, -0.174,1.425,-0.230, WORN);
  box(0.240,0.036,0.077,  0.174,1.425,-0.230, WORN);
  box(0.008,0.300,0.072, -0.048,1.570,-0.226, DARK); // lateral pec ridges
  box(0.008,0.300,0.072,  0.048,1.570,-0.226, DARK);
  // Energy core
  box(0.200,0.200,0.085, 0,1.395,-0.230, DARK);
  box(0.175,0.175,0.025, 0,1.395,-0.270, ACCENT);
  glow(0.116,0.116,0.016, 0,1.395,-0.285, 0x00ccff);
  glow(0.138,0.008,0.013, 0,1.395,-0.288, 0x0055cc);
  glow(0.008,0.138,0.013, 0,1.395,-0.288, 0x0055cc);
  [[-0.062,-0.062],[0.062,-0.062],[-0.062,0.062],[0.062,0.062]].forEach(([dx,dy])=>
    glow(0.018,0.018,0.012, dx,1.395+dy,-0.287, 0x00aaff));
  // Side rib cooling pipes
  for(let s=-1;s<=1;s+=2){
    for(let i=0;i<5;i++) cyl(0.013,0.013,0.42,7, s*0.358,1.210+i*0.088,0.098, PIPE);
    cyl(0.032,0.028,0.22,9, s*0.358,1.470,0.098, HULL);
    glow(0.012,0.195,0.008, s*0.358,1.385,0.100, 0xff2200);
    box(0.040,0.260,0.092, s*0.348,1.278,0.062, DARK);
    for(let i=0;i<6;i++) box(0.016,0.020,0.070, s*0.354,1.150+i*0.044,0.068, DARK);
  }
  // Back plate & power pack
  box(0.638,0.695,0.058, 0,1.332,0.235, ARMOR);
  box(0.298,0.350,0.208, 0,1.468,0.328, HULL);
  box(0.340,0.038,0.212, 0,1.618,0.330, DARK);
  box(0.340,0.038,0.212, 0,1.318,0.330, DARK);
  for(let i=0;i<4;i++) box(0.285,0.025,0.048, 0,1.490-i*0.062,0.428, DARK);
  cyl(0.030,0.024,0.34,9,  0.098,1.480,0.430, STEEL);
  cyl(0.030,0.024,0.34,9, -0.098,1.480,0.430, STEEL);
  cyl(0.037,0.030,0.065,9,  0.098,1.654,0.430, PIPE);
  cyl(0.037,0.030,0.065,9, -0.098,1.654,0.430, PIPE);
  glowCyl(0.021,0.021,0.055,8,  0.098,1.665,0.430, 0xff3300);
  glowCyl(0.021,0.021,0.055,8, -0.098,1.665,0.430, 0xff3300);
  glow(0.030,0.620,0.010, 0,1.332,0.248, 0xff4400);
  for(let i=0;i<7;i++) box(0.072,0.042,0.084, 0,0.988+i*0.086,0.180, ARMOR);

  // ════════════════════════════════════════════════════════
  // NECK
  // ════════════════════════════════════════════════════════
  cyl(0.144,0.165,0.148,12, 0,1.815,0, SERVO);
  cyl(0.160,0.160,0.026,12, 0,1.892,0, DARK);
  cyl(0.160,0.160,0.026,12, 0,1.738,0, DARK);
  for(let dx of [-0.050,0,0.050]) cyl(0.009,0.009,0.126,7, dx,1.815,-0.112, PIPE);
  for(let s=-1;s<=1;s+=2) for(let i=0;i<3;i++)
    box(0.030,0.030,0.010, s*0.115,1.845-i*0.040,0.068, DARK);
  box(0.228,0.022,0.228, 0,1.890,0, ACCENT);
  box(0.208,0.022,0.208, 0,1.740,0, ACCENT);

  // ════════════════════════════════════════════════════════
  // HEAD
  // ════════════════════════════════════════════════════════
  box(0.462,0.388,0.450, 0,1.982,0, HULL);           // skull main
  box(0.408,0.148,0.388, 0,2.168,0, HULL);            // cranial dome
  box(0.372,0.055,0.368, 0,2.248,-0.008, ARMOR);      // dome cap
  box(0.280,0.022,0.320, 0,2.278,0.018, DARK);        // top vent strip
  for(let i=0;i<4;i++) box(0.240,0.014,0.016, 0,2.275,-i*0.075+0.030, DARK);
  // Brow ridge
  box(0.480,0.070,0.102, 0,2.118,-0.220, DARK);
  box(0.442,0.024,0.092, 0,2.154,-0.228, ACCENT);
  glow(0.380,0.010,0.010, 0,2.084,-0.268, 0x0044ff);
  for(let s=-1;s<=1;s+=2) box(0.032,0.065,0.095, s*0.228,2.118,-0.228, WORN);
  // Cheeks
  box(0.068,0.238,0.318, -0.268,1.982,0, ARMOR);
  box(0.068,0.238,0.318,  0.268,1.982,0, ARMOR);
  box(0.062,0.210,0.285, -0.272,1.982,0, PANEL);
  box(0.062,0.210,0.285,  0.272,1.982,0, PANEL);
  box(0.065,0.040,0.105, -0.268,1.858,-0.060, WORN); // lower cheek notch
  box(0.065,0.040,0.105,  0.268,1.858,-0.060, WORN);
  // Visor system
  box(0.408,0.130,0.062, 0,1.982,-0.232, DARK);
  box(0.382,0.108,0.030, 0,1.982,-0.252, WORN);
  glow(0.348,0.065,0.010, 0,1.982,-0.270, 0xff0800);
  // Eye socket rings (two per side)
  for(let s=-1;s<=1;s+=2){
    cyl(0.065,0.065,0.016,10, s*0.100,1.982,-0.256, DARK, Math.PI/2);
    cyl(0.058,0.058,0.010,10, s*0.100,1.982,-0.262, WORN, Math.PI/2);
  }
  // Eye spheres
  const eyeL=new THREE.Mesh(new THREE.SphereGeometry(0.054,11,8),EYE_L); eyeL.position.set( 0.100,1.982,-0.250); g.add(eyeL);
  const eyeR=new THREE.Mesh(new THREE.SphereGeometry(0.054,11,8),EYE_R); eyeR.position.set(-0.100,1.982,-0.250); g.add(eyeR);
  glowCyl(0.056,0.056,0.008,10,  0.100,1.982,-0.254, 0xff3300, Math.PI/2); // eye scan ring
  glowCyl(0.056,0.056,0.008,10, -0.100,1.982,-0.254, 0xff3300, Math.PI/2);
  // Chin/jaw
  box(0.348,0.106,0.100, 0,1.804,-0.202, DARK);
  box(0.292,0.062,0.060, 0,1.756,-0.236, ACCENT);
  for(let i=0;i<3;i++) box(0.048,0.022,0.015, -0.072+i*0.072,1.820,-0.272, DARK);
  glow(0.228,0.009,0.010, 0,1.804,-0.274, 0xff2200);
  // Side sensor pods
  for(let s=-1;s<=1;s+=2){
    cyl(0.044,0.038,0.086,10, s*0.290,2.028,-0.055, STEEL, 0,Math.PI/2);
    cyl(0.038,0.038,0.012,10, s*0.312,2.028,-0.055, DARK, 0,Math.PI/2);
    glowCyl(0.036,0.036,0.008,10, s*0.314,2.028,-0.055, 0x00aaff, 0,Math.PI/2);
    cyl(0.011,0.007,0.096,6, s*0.274,2.086,-0.042, STEEL);
    sph(0.016,8, s*0.274,2.138,-0.042, new THREE.MeshBasicMaterial({color:0x00aaff}));
    cyl(0.024,0.020,0.058,8, s*0.282,1.948,-0.078, PIPE, 0,Math.PI/2);
    glowCyl(0.018,0.018,0.008,7, s*0.308,1.948,-0.078, 0xff0000, 0,Math.PI/2);
  }
  // Back of head
  box(0.388,0.248,0.030, 0,1.982,0.248, ARMOR);
  box(0.302,0.082,0.038, 0,1.950,0.244, DARK);
  box(0.255,0.042,0.038, 0,2.062,0.244, DARK);
  for(let i=0;i<5;i++) box(0.248,0.014,0.030, 0,1.933+i*0.018,0.248, DARK);
  for(let i=0;i<3;i++) box(0.062,0.024,0.022, -0.068+i*0.068,2.065,0.230, new THREE.MeshBasicMaterial({color:0x0022cc}));

  // ════════════════════════════════════════════════════════
  // SHOULDERS
  // ════════════════════════════════════════════════════════
  for(let s=-1;s<=1;s+=2){
    sph(0.138,13, s*0.46,1.68,0, SERVO);
    sph(0.100, 9, s*0.46,1.68,0, STEEL);
    box(0.192,0.238,0.448, s*0.620,1.700,0, HULL);
    box(0.215,0.060,0.450, s*0.620,1.818,0, DARK);
    box(0.215,0.060,0.450, s*0.620,1.580,0, DARK);
    box(0.195,0.200,0.428, s*0.622,1.700,0, ARMOR);
    box(0.030,0.138,0.194, s*0.622,1.700,-0.115, PANEL);
    box(0.026,0.105,0.042, s*0.624,1.700,-0.222, DARK);
    cyl(0.022,0.009,0.230,8, s*0.620,1.968,-0.036, STEEL);
    sph(0.020,8, s*0.620,2.086,-0.036, new THREE.MeshBasicMaterial({color:0xff0800}));
    glow(0.010,0.148,0.358, s*0.518,1.700,0, 0xff0800);
    for(let i=-1;i<=1;i+=2)
      cyl(0.015,0.015,0.032,8, s*0.624,1.700+i*0.058,-0.254, STEEL, 0,Math.PI/2);
  }

  // ════════════════════════════════════════════════════════
  // ARMS  (pivot group at side*0.46, 1.68, 0)
  // ════════════════════════════════════════════════════════
  function makeArmGroup(side) {
    const ag = new THREE.Group();
    ag.position.set(side*0.46, 1.68, 0);
    const sx = side*0.090;
    function abx(w,h,d,x,y,z,mat){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat); m.position.set(x,y,z); ag.add(m); }
    function acy(rt,rb,h,n,x,y,z,mat,rX=0,rZ=0){ const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,n),mat); m.position.set(x,y,z); if(rX)m.rotation.x=rX; if(rZ)m.rotation.z=rZ; ag.add(m); }
    function asp(r,n,x,y,z,mat){ const m=new THREE.Mesh(new THREE.SphereGeometry(r,n,Math.ceil(n*.72)),mat); m.position.set(x,y,z); ag.add(m); }
    function agl(w,h,d,x,y,z,col){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:col})); m.position.set(x,y,z); ag.add(m); }

    // ── Upper arm ──
    acy(0.116,0.094,0.48,13, sx,-0.390,0, HULL);
    abx(0.172,0.235,0.062, sx,-0.382,-0.092, ARMOR);
    abx(0.145,0.198,0.040, sx,-0.385,-0.112, PANEL);
    agl(0.135,0.020,0.038, sx,-0.508,-0.114, 0xff0800);
    abx(0.062,0.225,0.195, sx+side*0.122,-0.388,0.006, ARMOR); // outer plate
    abx(0.045,0.195,0.165, sx+side*0.132,-0.388,0.006, PANEL);
    acy(0.020,0.016,0.38,9, sx+side*0.076,-0.388,0.086, STEEL); // rear hydraulic
    acy(0.012,0.012,0.30,7, sx+side*0.095,-0.388,0.094, PIPE);
    asp(0.024,7, sx+side*0.076,-0.202,0.086, SERVO);  // piston caps
    asp(0.024,7, sx+side*0.076,-0.574,0.086, SERVO);
    asp(0.100,12, sx,-0.162,0, SERVO);  // shoulder-end cap
    asp(0.074, 9, sx,-0.162,0, STEEL);
    for(let i=0;i<3;i++) abx(0.016,0.038,0.072, sx+side*0.126,-0.288-i*0.060,0.010, DARK);

    // ── Elbow joint ──
    asp(0.100,13, sx,-0.662,0, SERVO);
    asp(0.074, 9, sx,-0.662,0, STEEL);
    abx(0.200,0.082,0.145, sx,-0.662,-0.085, ACCENT); // guard
    abx(0.168,0.055,0.102, sx,-0.662,-0.120, DARK);
    agl(0.162,0.010,0.082, sx,-0.698,-0.091, 0xff0800);
    acy(0.028,0.028,0.060,9, sx+side*0.122,-0.662,0.010, STEEL, 0,Math.PI/2);
    asp(0.022,7, sx+side*0.154,-0.662,0.010, DARK);

    // ── Forearm ──
    acy(0.095,0.078,0.45,13, sx,-0.882,0, HULL);
    abx(0.158,0.218,0.058, sx,-0.872,-0.096, ARMOR);   // 3-layer front
    abx(0.132,0.185,0.038, sx,-0.875,-0.116, PANEL);
    abx(0.110,0.148,0.022, sx,-0.880,-0.132, DARK);
    abx(0.058,0.208,0.195, sx+side*0.116,-0.875,0.008, ARMOR); // outer plate
    acy(0.010,0.010,0.34,8, sx+side*0.086,-0.862,0.054, new THREE.MeshBasicMaterial({color:0x0055cc})); // cables
    acy(0.008,0.008,0.30,7, sx+side*0.075,-0.862,0.068, STEEL);
    acy(0.009,0.009,0.26,6, sx+side*0.062,-0.862,0.058, new THREE.MeshBasicMaterial({color:0xcc3300}));
    acy(0.015,0.015,0.32,8, sx-side*0.085,-0.862,0.072, PIPE);
    agl(0.062,0.012,0.034, sx,-0.776,-0.125, 0xff0800);
    agl(0.046,0.008,0.030, sx,-0.934,-0.125, 0xff2200);
    if(side > 0){
      abx(0.062,0.105,0.200, sx,-0.940,-0.142, DARK);
      acy(0.018,0.018,0.148,7, sx,-0.940,-0.208, STEEL);
      acy(0.014,0.014,0.095,6, sx,-0.940,-0.268, PIPE);
    }

    // ── Wrist joint ──
    asp(0.082,11, sx,-1.108,0, SERVO);
    asp(0.060, 8, sx,-1.108,0, STEEL);
    acy(0.098,0.092,0.038,11, sx,-1.114,0, DARK);
    acy(0.102,0.102,0.010,11, sx,-1.096,0, ACCENT);

    // ── Palm ──
    abx(0.225,0.105,0.205, sx,-1.178,0, HULL);
    abx(0.200,0.032,0.185, sx,-1.128,0, ARMOR);
    abx(0.078,0.062,0.055, sx+side*0.145,-1.178,-0.040, HULL); // thumb stub
    acy(0.022,0.017,0.070,7, sx+side*0.145,-1.178,-0.090, STEEL);
    asp(0.020,7, sx+side*0.145,-1.178,-0.130, ACCENT);
    abx(0.200,0.038,0.062, sx,-1.228,-0.086, ACCENT); // knuckle ridge
    agl(0.175,0.010,0.042, sx,-1.234,-0.105, 0xff0800);
    abx(0.105,0.065,0.018, sx,-1.175,0.095, DARK); // palm tech indent
    agl(0.072,0.042,0.014, sx,-1.175,0.102, 0x00aaff);

    // ── Three articulated fingers ──
    for(let f=-1;f<=1;f++){
      const fx = sx+side*(0.018+f*0.062);
      acy(0.021,0.017,0.145,8, fx,-1.248,-0.102, HULL);  // proximal
      asp(0.024,8, fx,-1.330,-0.102, SERVO);              // knuckle joint
      acy(0.017,0.013,0.105,7, fx,-1.248,-0.188, STEEL);  // distal
      asp(0.018,7, fx,-1.248,-0.248, ACCENT);              // fingertip
      if(f===0) agl(0.010,0.008,0.010, fx,-1.248,-0.200, 0xff0000); // mid-finger LED
    }

    g.add(ag);
    return ag;
  }
  const armGroupL = makeArmGroup(-1);
  const armGroupR = makeArmGroup( 1);

  // ── Collect Standard materials for hit flash ──────────────
  const allMats=[];
  g.traverse(child=>{
    if(child.isMesh && child.material.isMeshStandardMaterial) allMats.push(child.material);
  });

  // ── Health bar ────────────────────────────────────────────
  const hpBarGroup=new THREE.Group();
  hpBarGroup.position.set(0, 2.88, 0);
  hpBarGroup.add(new THREE.Mesh(new THREE.BoxGeometry(.76,.115,.01),new THREE.MeshBasicMaterial({color:0x111111})));
  hpBarGroup.add(new THREE.Mesh(new THREE.BoxGeometry(.70,.075,.015),new THREE.MeshBasicMaterial({color:0x330000})));
  const hpFillMat=new THREE.MeshBasicMaterial({color:0x22dd44});
  const hpFill=new THREE.Mesh(new THREE.BoxGeometry(.68,.055,.02),hpFillMat);
  hpBarGroup.add(hpFill);
  [-0.226,0.226].forEach(dx=>{ const d=new THREE.Mesh(new THREE.BoxGeometry(.014,.09,.022),new THREE.MeshBasicMaterial({color:0x000000})); d.position.x=dx; hpBarGroup.add(d); });
  g.add(hpBarGroup);

  return { group:g, legL, legR, armGroupL, armGroupR, eyeMatL:EYE_L, eyeMatR:EYE_R, allMats, hpBarGroup, hpFill, hpFillMat };
}

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
  setTimeout(()=>{ bot.allMats.forEach(mat=>{ mat.emissive.setHex(0x000000); mat.emissiveIntensity=0; }); },80);
  if(bot.hp<=0) killBot(bot);
}

function killBot(bot){
  bot.alive=false;
  bot.hpBarGroup.visible=false;
  bot.eyeMatL.color.setHex(0x220000);
  bot.eyeMatR.color.setHex(0x220000);
  spawnSparks(bot.group.position.clone().setY(1.2));
  setTimeout(()=>{ bot.group.visible=false; },180);
  spawnAmmoPickup(bot.group.position);
  player.kills++;
  updateKillHUD();
  pushKillFeed('Robot destroyed');
  updateEnemyCountHUD();
  checkLevelComplete();
  if(coopIsHost && socket) socket.emit('coopBotKill', { botIndex: bots.indexOf(bot) });
}

function spawnSparks(pos){
  const mat=new THREE.MeshBasicMaterial({color:0xff4400});
  for(let i=0;i<8;i++){
    const p=new THREE.Mesh(new THREE.BoxGeometry(.10,.10,.10),mat);
    p.position.copy(pos).addScaledVector(
      new THREE.Vector3(Math.random()-.5, Math.random()*.8+.2, Math.random()-.5).normalize(), .5);
    scene.add(p); setTimeout(()=>scene.remove(p),350);
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
document.addEventListener('keydown',e=>{
  keys[e.code]=true;
  if(e.code==='KeyR') reloadGun();
  if(e.code==='KeyT' && pointerLocked()) { deactivateScope(); document.exitPointerLock(); }
  if(e.code==='KeyP') togglePvp();
});
document.addEventListener('keyup', e=>{ keys[e.code]=false; });

document.addEventListener('mousedown', e=>{
  if(isMobile) return;
  if(e.button!==0) return;
  mouseHeld=true;
  if(!pointerLocked()||!gun.def) return;
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
  targetFov=SCOPE_FOV;
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

const SENS = 0.0055;  // high sensitivity as requested
document.addEventListener('mousemove',e=>{
  if(!pointerLocked()) return;
  yaw   -= e.movementX * SENS;
  pitch -= e.movementY * SENS;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
});

function reloadGun(){
  if(player.dead) return;
  const need=gun.def.ammo - gun.ammo;
  const take=Math.min(need, gun.reserve);
  gun.ammo+=take; gun.reserve-=take; updateAmmoHUD();
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
    hideBanPanel();
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
function flashDmg(){ flashOverlay.style.background='rgba(220,0,0,.42)'; setTimeout(()=>{ flashOverlay.style.background='rgba(220,0,0,0)'; },150); }

const deathScreen=document.createElement('div');
deathScreen.style.cssText='position:fixed;inset:0;background:rgba(120,0,0,.65);display:none;flex-direction:column;align-items:center;justify-content:center;color:#fff;z-index:60;pointer-events:none;font-family:Courier New,monospace';
deathScreen.innerHTML='<div style="font-size:72px;color:#e74c3c;letter-spacing:6px;text-shadow:0 0 20px #e74c3c">YOU DIED</div><div style="font-size:18px;margin-top:18px;color:#bbb;letter-spacing:4px">RESPAWNING...</div>';
document.body.appendChild(deathScreen);

function killPlayer(){
  if(player.dead) return;
  deactivateScope();
  player.dead=true; player.health=0; updateHealthHUD();
  deathScreen.style.display='flex'; hudEl.style.display='none';
  setTimeout(respawnPlayer,2300);
}
function respawnPlayer(){
  player.health=player.maxHealth; player.dead=false;
  camera.position.copy(SPAWN); yaw=0; pitch=0; velY=0; grounded=true;
  deathScreen.style.display='none';
  if(pointerLocked() || mobileGameActive) hudEl.style.display='block';
  updateHealthHUD();
  // Restore ammo
  gun.ammo=gun.def.ammo; gun.reserve=gun.def.reserve; updateAmmoHUD();
}

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

  // ── Jump / gravity ──────────────────────────────────────
  velY += GRAVITY*dt;
  camera.position.y += velY*dt;
  const _floorY = getGroundY(camera.position) + EYE_H;
  if(camera.position.y <= _floorY){ camera.position.y = _floorY; velY=0; grounded=true; }
  if(camera.position.y >= WH-.6){ camera.position.y=WH-.6; velY=Math.min(0,velY); }

  if((!pointerLocked() && !mobileGameActive)||player.dead) return;

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
  if((mouseHeld || touchFireHeld) && gun.def && gun.def.auto) shoot();

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

  // ── Weapon bob + recoil ──────────────────────────────────
  const bobRate=moving?9.0:2.2, bobAmp=moving?.014:.005;
  bobClock+=dt*bobRate;
  const decay = 1 - Math.min(1, dt * 11);
  recoilZ *= decay;
  recoilY *= decay;
  if(weaponRoot.userData.baseY !== undefined){
    weaponRoot.position.y = weaponRoot.userData.baseY + Math.sin(bobClock)*bobAmp + recoilY;
    weaponRoot.position.x = weaponRoot.userData.baseX + Math.sin(bobClock*.5)*bobAmp*.55;
    weaponRoot.position.z = weaponRoot.userData.baseZ + recoilZ;
    weaponRoot.rotation.x = -recoilY * 1.6;
  }

  // ── Hurt cooldown ───────────────────────────────────────
  if(player.hurtTimer>0) player.hurtTimer-=dt;

  // ── Bot AI ──────────────────────────────────────────────
  const px=camera.position.x, pz=camera.position.z;
  const playerGroundY = getGroundY(camera.position);
  bots.forEach(bot=>{
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
      bot.group.rotation.y = Math.atan2(dx,dz);

      if(dist > 0.15 && distToPlayer > BOT_MELEE * 0.8){
        const mv = (distToPlayer > 12 ? spd : spd * 0.75) * dt;
        bp.x += (dx/dist)*mv; bp.z += (dz/dist)*mv;
        bot.walkClock += dt*spd;
      }

      // Melee attack
      if(!diffFloor && distToPlayer<BOT_MELEE && player.hurtTimer<=0){
        player.health -= dmg; player.hurtTimer = BOT_DMG_INT;
        updateHealthHUD(); flashDmg();
        if(player.health<=0) killPlayer();
      }

      // ── Bot shooting ─────────────────────────────────────
      bot.shootTimer -= dt;
      if(bot.flashTimer > 0){
        bot.flashTimer -= dt;
        if(bot.flashTimer <= 0 && bot.pistol) bot.pistol.userData.flash.visible = false;
      }

      if(bot.shootTimer <= 0 && los && distToPlayer < BOT_SHOOT_DST && distToPlayer > BOT_MELEE){
        bot.shootTimer = bot.shootCooldown;

        // Wide spread — ±0.18 on each axis
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
        botBullets.push({ mesh:bMesh, pos:bPos.clone(), vel:dir.clone().multiplyScalar(BOT_BULLET_V), dist:0, maxDist:maxD });

        // Muzzle flash on pistol
        if(bot.pistol){ bot.pistol.userData.flash.visible=true; bot.flashTimer=0.08; }

        // Raise right arm slightly toward player for aim pose
        bot.armGroupR.rotation.x = 0.55;
      } else if(bot.shootTimer > bot.shootCooldown * 0.6){
        // Gradually return arm to walking pose
        bot.armGroupR.rotation.x += (1.10 - bot.armGroupR.rotation.x) * dt * 4;
      }

    } else {
      // Patrol
      bot.patrolTimer -= dt;
      if(bot.patrolTimer<=0){ bot.patrolTarget=rndPos(); bot.patrolTimer=2.5+Math.random()*3.5; }
      const pdx=bot.patrolTarget.x-bp.x, pdz=bot.patrolTarget.z-bp.z;
      const pd=Math.sqrt(pdx*pdx+pdz*pdz);
      if(pd > 0.6){
        const s=spd*0.52*dt;
        bp.x+=(pdx/pd)*s; bp.z+=(pdz/pd)*s;
        bot.group.rotation.y=Math.atan2(pdx,pdz);
        bot.walkClock+=dt*spd*0.52;
      } else { bot.patrolTimer=0; }
    }

    // Wall collision — bots can't walk through cover
    resolveCollision(bp, BOT_RADIUS);
    bp.x=Math.max(-AW+1,Math.min(AW-1,bp.x));
    bp.z=Math.max(-AD+1,Math.min(AD-1,bp.z));

    // Leg swing animation
    const legSwing = Math.sin(bot.walkClock*2.5)*.32;
    bot.legL.rotation.x =  legSwing;
    bot.legR.rotation.x = -legSwing;

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
        if(player.health<=0) killPlayer();
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
  remotePlayers.forEach(rp => {
    const moving = rp.group.position.distanceTo(rp.targetPos) > 0.02;
    rp.group.position.lerp(rp.targetPos, 0.18);
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

// Visual themes — one changes every 5 levels, cycling through 10 palettes
const THEMES = [
  { bg:0x080810, wall:0x10182a, trim:0x2050a0, trimE:0x2255ee, lights:[0xff2200,0x0044ff,0x00ff88,0xff9900] },
  { bg:0x0c0404, wall:0x281408, trim:0xa02818, trimE:0xdd2200, lights:[0xff4400,0xffaa00,0xff2200,0xaa4400] },
  { bg:0x040c04, wall:0x102810, trim:0x22882a, trimE:0x22dd44, lights:[0x00ff44,0x44ff00,0x00cc22,0x88ff00] },
  { bg:0x0c000c, wall:0x1c0c28, trim:0x7028a0, trimE:0xaa00ff, lights:[0xaa00ff,0xff00aa,0x6600ff,0xff0066] },
  { bg:0x000608, wall:0x0c1c28, trim:0x1060a0, trimE:0x0088ff, lights:[0x00aaff,0x0066ff,0x00ffff,0x0044cc] },
  { bg:0x0c0c04, wall:0x282408, trim:0x887820, trimE:0xffcc00, lights:[0xffee00,0xff8800,0xffcc00,0xddaa00] },
  { bg:0x060410, wall:0x140c24, trim:0x504090, trimE:0x8855ff, lights:[0x8844ff,0x4488ff,0x44aaff,0x8800ff] },
  { bg:0x0c0204, wall:0x280810, trim:0xc02840, trimE:0xff0044, lights:[0xff0044,0xff4488,0xff0022,0xcc0033] },
  { bg:0x040c04, wall:0x0c2410, trim:0x28a060, trimE:0x00ff88, lights:[0x00ff88,0x00dd44,0x44ff88,0x00bb66] },
  { bg:0x080808, wall:0x181818, trim:0x888888, trimE:0xccddff, lights:[0xffffff,0xccccff,0xffffff,0xccffff] },
];

function applyTheme(level) {
  const t = THEMES[Math.floor((level-1)/5) % THEMES.length];
  scene.background.setHex(t.bg);
  scene.fog.color.setHex(t.bg);
  ARENA_M.wall.color.setHex(t.wall);
  ARENA_M.trim.color.setHex(t.trim);
  ARENA_M.trim.emissive.setHex(t.trimE);
  ARENA_M.trim.emissiveIntensity = 1.0;
  ARENA_M.pillar.color.setHex(t.wall);
  accentLights.forEach((l,i) => l.color.setHex(t.lights[i % t.lights.length]));
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

function spawnBots(cfg) {
  for(let i=0; i<cfg.botCount; i++){
    const r = buildRobot();
    r.group.position.copy(rndPos());
    scene.add(r.group);

    // Attach pistol to right arm wrist/palm region
    const pistol = buildBotPistol();
    // armGroupR local space: palm is around y=-1.18, sx=0.09
    pistol.position.set(0.09, -1.22, -0.06);
    pistol.rotation.x = -Math.PI * 0.08;
    r.armGroupR.add(pistol);

    bots.push({ ...r,
      hp:cfg.botHP, maxHp:cfg.botHP,
      alive:true,
      speed:cfg.speed, damage:cfg.damage, detectR:cfg.detectR,
      patrolTarget:rndPos(), patrolTimer:Math.random()*3, walkClock:0,
      pistol,
      shootTimer: 0.6 + Math.random() * 1.2,  // time until next shot
      shootCooldown: 1.2 + Math.random() * 0.8,
      flashTimer: 0,
      lastPos: new THREE.Vector3(),
      stuckTimer: 0,
      flankAngle: (Math.random()-.5) * 1.2,
      flankChangeTimer: 2 + Math.random() * 2,
      alertLevel: 0,   // 0=patrol, 1=investigating, 2=chase
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
  transScreen.style.display = 'flex';
  setTimeout(() => { transScreen.style.display='none'; then && then(); }, dur);
}

function startLevel(n) {
  currentLevel = n;
  levelActive  = false;
  if (coopMode && !coopIsHost) clearGhostBots();
  clearBots();
  applyTheme(n);
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
      spawnSparks(gb.group.position.clone().setY(1.2));
      setTimeout(() => { if (gb.group.parent) scene.remove(gb.group); }, 180);
      player.kills++;
      updateKillHUD();
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
animate();
