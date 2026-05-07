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

// ─── Multiplayer state ────────────────────────────────────────
let socket       = null;
let moveInterval = null;
const remotePlayers = new Map();   // socketId → { group, legL, legR, allMats, targetPos, targetRotY, walkClock }

// ─── Gun definitions ─────────────────────────────────────────
const GUN_DEFS = {
  pistol : { name:'PISTOL',  ammo:12,  reserve:84,  fireRate:0.48, damage:34,  spread:0.003, auto:false },
  smg    : { name:'SMG',     ammo:30,  reserve:150, fireRate:0.082,damage:18,  spread:0.020, auto:true  },
  minigun: { name:'MINIGUN', ammo:100, reserve:300, fireRate:0.046,damage:20,  spread:0.038, auto:true, spinUp:true },
  sniper : { name:'SNIPER',  ammo:1,   reserve:20,  fireRate:1.4,  damage:999, spread:0,     auto:false, oneShot:true },
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

// Minigun spin state
let mgSpinSpeed = 0;    // current rad/s
let mgSpin      = 0;    // accumulated angle (for visual)
let barrelCluster = null;  // the rotating barrel group
const MG_MAX_SPIN = 28, MG_UP = 10, MG_DOWN = 7;

// ─── Renderer ────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ─── Scene ───────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080810);
scene.fog = new THREE.FogExp2(0x080810, 0.014);

// ─── Camera ──────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
const EYE_H = 1.65;
camera.position.set(0, EYE_H, 2);
scene.add(camera);  // must be in scene for camera-child weapon to render

// ─── Scope / FOV state ───────────────────────────────────────
const NORMAL_FOV = 72;
const SCOPE_FOV  = 15;
let targetFov    = NORMAL_FOV;
let scopeActive  = false;

// ─── Lights ──────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x303050, 0.7));

const sun = new THREE.DirectionalLight(0xffeedd, 0.85);
sun.position.set(8, 20, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { near:1, far:130, left:-58, right:58, top:58, bottom:-58 });
scene.add(sun);

function mkPt(col, i, r, x, y, z) {
  const l = new THREE.PointLight(col, i, r); l.position.set(x,y,z); scene.add(l); return l;
}
// Store accent light refs so applyTheme() can recolour them each level
const accentLights = [
  mkPt(0xff2200, 1.8, 30, -15, 4, -15),
  mkPt(0x0044ff, 1.8, 30,  15, 4,  15),
  mkPt(0x00ff88, 1.3, 24,  15, 4, -15),
  mkPt(0xff9900, 1.1, 22, -15, 4,  15),
];

// ─── Shared materials ────────────────────────────────────────
const GLOVE  = new THREE.MeshLambertMaterial({ color:0x1e2814 });
const M_DARK = new THREE.MeshLambertMaterial({ color:0x181818 });
const M_MID  = new THREE.MeshLambertMaterial({ color:0x2e2e38 });
const M_LITE = new THREE.MeshLambertMaterial({ color:0x484858 });
const M_WOOD = new THREE.MeshLambertMaterial({ color:0x7a4020 });
const M_ORNG = new THREE.MeshLambertMaterial({ color:0xe06000 });
const M_YELO = new THREE.MeshBasicMaterial ({ color:0xffdd44 });

// ============================================================
//  ARENA
// ============================================================
const AW=22, AD=22, WH=7, WT=0.8;

function makeFloorTex() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle='#10101e'; ctx.fillRect(0,0,512,512);
  ctx.strokeStyle='#1e1e3a'; ctx.lineWidth=1;
  for (let i=0;i<=512;i+=32){
    ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
  }
  ctx.strokeStyle='#2c2c5a'; ctx.lineWidth=1.5;
  for (let i=0;i<=512;i+=128){
    ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(20,20);
  return tex;
}

const ARENA_M = {
  floor  : new THREE.MeshLambertMaterial({ map:makeFloorTex() }),
  ceil   : new THREE.MeshLambertMaterial({ color:0x060610 }),
  wall   : new THREE.MeshLambertMaterial({ color:0x18243c }),
  trim   : new THREE.MeshLambertMaterial({ color:0x3060a0, emissive:new THREE.Color(0x081828) }),
  pillar : new THREE.MeshLambertMaterial({ color:0x20304a }),
  cover  : new THREE.MeshLambertMaterial({ color:0x281414 }),
  ctrim  : new THREE.MeshLambertMaterial({ color:0x602020, emissive:new THREE.Color(0x200808) }),
  clight : new THREE.MeshBasicMaterial ({ color:0x88aaff }),
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

// Ceiling light fixtures + point lights
[[-8,-8],[8,-8],[-8,8],[8,8],[0,0],[0,-14],[0,14],[-14,0],[14,0]].forEach(([lx,lz])=>{
  addBox(4,.09,.3, lx,WH-.04,lz, ARENA_M.clight,false,false);
  const pl=new THREE.PointLight(0xaaccff,1.3,18); pl.position.set(lx,WH-.8,lz); scene.add(pl);
});

// Internal cover walls
const COVER_DEFS = [
  [9,1,-6,-4],[1,7,9,-9],[7,1,4,7],[1,6,-11,9],
  [5,1,0,-14],[1,5,14,1],[5,1,-4,13],[1,5,-16,-4],
  [4,1,10,-17],[1,4,-17,12],
];
const coverBoxes = [];
COVER_DEFS.forEach(([w,d,cx,cz])=>{
  const ch=WH*.72;
  addBox(w,ch,d, cx,ch/2,cz, ARENA_M.cover);
  addBox(w+.04,.12,d+.04, cx,ch+.06,cz, ARENA_M.ctrim,false,false);
  coverBoxes.push({cx,cz,hw:w/2,hd:d/2});
});

// Decorative tech panels on walls (dark recessed insets)
[[0,WH/2,-(AD+.01), 4,.5,1],[0,WH/2,AD+.01, 4,.5,1],
 [-(AW+.01),WH/2,0, 1,.5,4],[AW+.01,WH/2,0, 1,.5,4]].forEach(([x,y,z,w,h,d])=>{
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
  // Barrel
  const brl = new THREE.Mesh(new THREE.BoxGeometry(.028,.028,.16), M_MID);
  brl.position.set(0,.02,-.22); root.add(brl);
  // Muzzle
  const muz = new THREE.Mesh(new THREE.BoxGeometry(.032,.032,.022), M_LITE);
  muz.position.set(0,.02,-.30); root.add(muz);
  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(.054,.13,.068), M_WOOD);
  grip.position.set(0,-.068,.06); grip.rotation.x=.22; root.add(grip);
  // Trigger guard
  const tg = new THREE.Mesh(new THREE.BoxGeometry(.005,.036,.078), M_DARK);
  tg.position.set(0,-.034,.002); root.add(tg);
  // Iron sights
  const sightR = new THREE.Mesh(new THREE.BoxGeometry(.012,.018,.010), M_LITE);
  sightR.position.set(0,.060,-.24); root.add(sightR);
  const sightF = new THREE.Mesh(new THREE.BoxGeometry(.008,.014,.010), M_LITE);
  sightF.position.set(0,.060,-.14); root.add(sightF);

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
  // Barrel
  const brl = new THREE.Mesh(new THREE.BoxGeometry(.032,.032,.22), M_MID);
  brl.position.set(0,.062,-.28); root.add(brl);
  // Muzzle brake
  const brake = new THREE.Mesh(new THREE.BoxGeometry(.046,.046,.04), M_LITE);
  brake.position.set(0,.062,-.40); root.add(brake);
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
  // Sights
  const sf = new THREE.Mesh(new THREE.BoxGeometry(.010,.020,.010), M_LITE);
  sf.position.set(0,.100,-.28); root.add(sf);

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
    // Barrel tube
    const bt = new THREE.Mesh(new THREE.BoxGeometry(.038,.038,.44), brlDark);
    bt.position.set(bx,by,-.14); barrelCluster.add(bt);
    // Muzzle ring
    const mr = new THREE.Mesh(new THREE.BoxGeometry(.048,.048,.018), brlMat);
    mr.position.set(bx,by,-.36); barrelCluster.add(mr);
  }
  // Centre axle
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.44,8), M_LITE);
  axle.rotation.x = Math.PI/2; axle.position.z=-.14; barrelCluster.add(axle);
  root.add(barrelCluster);

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

  // Barrel (long)
  const brl = new THREE.Mesh(new THREE.BoxGeometry(.024, .024, .80), M_DARK);
  brl.position.set(0, .020, -.43); root.add(brl);
  // Muzzle brake
  const brake = new THREE.Mesh(new THREE.BoxGeometry(.034, .034, .054), M_LITE);
  brake.position.set(0, .020, -.82); root.add(brake);

  // Scope body
  const scopeBody = new THREE.Mesh(new THREE.BoxGeometry(.046, .046, .30), M_DARK);
  scopeBody.position.set(0, .114, -.08); root.add(scopeBody);
  // Front objective lens
  const scopeObj = new THREE.Mesh(new THREE.BoxGeometry(.040, .040, .016), M_MID);
  scopeObj.position.set(0, .114, -.24); root.add(scopeObj);
  // Rear eyepiece
  const scopeEye = new THREE.Mesh(new THREE.BoxGeometry(.036, .036, .014), M_LITE);
  scopeEye.position.set(0, .114, .08); root.add(scopeEye);
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

// Sprite with player's name drawn on a canvas texture
function makeNameSprite(name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(8, 14, 240, 36);
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name.slice(0, 18), 128, 38);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.6, 0.4, 1);
  sp.position.y = 3.2;
  return sp;
}

function addRemotePlayer(data) {
  if (remotePlayers.has(data.id)) return;
  const rob = buildRobot();
  // Colour the eyes to this player's unique server-assigned colour
  const col = new THREE.Color(data.color || '#e74c3c');
  rob.eyeMatL.color.copy(col);
  rob.eyeMatR.color.copy(col);
  // Hide the HP bar — we don't track remote HP client-side
  rob.hpBarGroup.visible = false;

  const groundY = Math.max(0, (data.y || EYE_H) - EYE_H);
  rob.group.position.set(data.x || 0, groundY, data.z || 0);
  scene.add(rob.group);

  const nameSprite = makeNameSprite(data.username || 'Player');
  rob.group.add(nameSprite);

  remotePlayers.set(data.id, {
    ...rob,
    targetPos:  new THREE.Vector3(data.x || 0, groundY, data.z || 0),
    targetRotY: data.rotationY || 0,
    walkClock:  0,
  });
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (!rp) return;
  scene.remove(rp.group);
  remotePlayers.delete(id);
}

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
}

// ============================================================
//  ROBOT ENEMY
// ============================================================
function buildRobot() {
  const g = new THREE.Group();

  // Per-bot material instances so hit flash is isolated to this bot
  const BODY   = new THREE.MeshLambertMaterial({color:0x3a3a50});
  const DARK   = new THREE.MeshLambertMaterial({color:0x1a1a28});
  const CHROME = new THREE.MeshLambertMaterial({color:0x6a7888});
  const RED    = new THREE.MeshLambertMaterial({color:0xcc1818});
  const PANEL  = new THREE.MeshLambertMaterial({color:0x252538});
  const JOINT  = new THREE.MeshLambertMaterial({color:0x505060});
  const EYE_L  = new THREE.MeshBasicMaterial({color:0xff2200});
  const EYE_R  = new THREE.MeshBasicMaterial({color:0xff2200});
  const LED_G  = new THREE.MeshBasicMaterial({color:0x00ff88});
  const LED_B  = new THREE.MeshBasicMaterial({color:0x44aaff});

  // Helper: add a box part to the root group
  function bp(w,h,d,x,y,z,mat){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z); g.add(m); return m;
  }

  // ── Torso ─────────────────────────────────────────────────
  bp(.70,.84,.46,  0,1.32,0,  BODY);           // main block
  bp(.72,.10,.48,  0,1.32,0,  RED);            // horizontal accent band
  bp(.72,.10,.48,  0,1.56,0,  DARK);           // upper chest band
  bp(.72,.10,.48,  0,1.08,0,  DARK);           // lower chest band
  // Chest armour plates (two angled side panels)
  bp(.24,.42,.06,  .20,1.32,-.24, PANEL);
  bp(.24,.42,.06, -.20,1.32,-.24, PANEL);
  // Centre chest display
  bp(.18,.18,.06,  0,1.40,-.25, DARK);
  bp(.12,.12,.02,  0,1.40,-.29, PANEL);
  bp(.04,.04,.02,  .05,1.40,-.29, LED_G);       // green status LED
  bp(.04,.04,.02, -.05,1.46,-.29, LED_G);
  bp(.04,.04,.02,  .05,1.34,-.29, new THREE.MeshBasicMaterial({color:0xff4400}));  // orange LED
  // Torso side hydraulic cylinders
  bp(.04,.38,.04,  .38,1.30,.14, CHROME);
  bp(.04,.38,.04, -.38,1.30,.14, CHROME);
  bp(.04,.38,.04,  .38,1.30,-.14, CHROME);
  bp(.04,.38,.04, -.38,1.30,-.14, CHROME);
  // Waist reinforcement band
  bp(.68,.08,.44,  0,1.04,0, RED);
  // Back armour plate
  bp(.60,.72,.06,  0,1.32,.25, PANEL);
  // Back power pack
  bp(.32,.32,.14,  0,1.44,.30, BODY);
  bp(.34,.06,.16,  0,1.58,.30, DARK);           // pack vent top
  bp(.34,.06,.16,  0,1.30,.30, DARK);           // pack vent bottom
  bp(.08,.28,.04,  .10,1.44,.38, CHROME);       // exhaust pipe R
  bp(.08,.28,.04, -.10,1.44,.38, CHROME);       // exhaust pipe L

  // ── Pelvis ────────────────────────────────────────────────
  bp(.56,.22,.42,  0,.87,0, DARK);
  bp(.58,.06,.44,  0,.97,0, RED);               // hip trim band
  bp(.58,.06,.44,  0,.77,0, RED);

  // ── Head ──────────────────────────────────────────────────
  bp(.44,.42,.44,  0,1.94,0, BODY);             // main head block
  // Forehead brow ridge
  bp(.46,.06,.08,  0,2.08,-.22, DARK);
  // Visor slit
  bp(.40,.12,.06,  0,1.94,-.23, DARK);
  bp(.42,.02,.04,  0,2.00,-.24, LED_B);         // visor glow line
  // Side ear modules
  bp(.05,.22,.18,  .24,1.94,0, RED);
  bp(.05,.22,.18, -.24,1.94,0, RED);
  bp(.04,.08,.08,  .27,2.00,-.04, CHROME);      // ear sensor R
  bp(.04,.08,.08, -.27,2.00,-.04, CHROME);      // ear sensor L
  // Side vents on ears
  bp(.02,.06,.14,  .26,1.90,.04, DARK);
  bp(.02,.06,.14, -.26,1.90,.04, DARK);
  // Chin guard
  bp(.32,.10,.08,  0,1.76,-.22, DARK);
  bp(.30,.06,.04,  0,1.72,-.24, RED);
  // Top head fin / crest
  bp(.08,.18,.32,  0,2.22,0, DARK);
  bp(.10,.04,.34,  0,2.32,0, RED);
  // Eyes (glowing spheres)
  const eGeo=new THREE.SphereGeometry(.062,8,6);
  const eyeL=new THREE.Mesh(eGeo,EYE_L); eyeL.position.set( .11,1.95,-.25); g.add(eyeL);
  const eyeR=new THREE.Mesh(eGeo,EYE_R); eyeR.position.set(-.11,1.95,-.25); g.add(eyeR);
  // Extra small eye detail rings
  bp(.10,.10,.02,  .11,1.95,-.23, DARK);
  bp(.10,.10,.02, -.11,1.95,-.23, DARK);

  // ── Neck ──────────────────────────────────────────────────
  bp(.20,.10,.20,  0,1.75,0, DARK);
  bp(.24,.05,.24,  0,1.80,0, RED);              // neck collar ring
  bp(.16,.14,.16,  0,1.70,0, JOINT);           // neck ball joint

  // ── Antenna ───────────────────────────────────────────────
  bp(.08,.08,.08,  .08,2.44,0, RED);
  const apole=new THREE.Mesh(new THREE.CylinderGeometry(.016,.016,.28,6),CHROME);
  apole.position.set(.08,2.60,0); g.add(apole);
  const atip=new THREE.Mesh(new THREE.SphereGeometry(.042,7,5),EYE_L);
  atip.position.set(.08,2.75,0); g.add(atip);

  // ── Shoulders ─────────────────────────────────────────────
  // Shoulder ball joints (sphere at junction)
  const sjGeo=new THREE.SphereGeometry(.12,8,6);
  const sjL=new THREE.Mesh(sjGeo,JOINT); sjL.position.set(-.46,1.68,0); g.add(sjL);
  const sjR=new THREE.Mesh(sjGeo,JOINT); sjR.position.set( .46,1.68,0); g.add(sjR);
  // Shoulder pauldrons
  bp(.20,.18,.42, -.58,1.68,0, RED);
  bp(.20,.18,.42,  .58,1.68,0, RED);
  bp(.22,.06,.44, -.58,1.78,0, DARK);          // pauldron top edge
  bp(.22,.06,.44,  .58,1.78,0, DARK);

  // ── Upper arms ────────────────────────────────────────────
  bp(.20,.46,.20, -.58,1.28,0, BODY);
  bp(.20,.46,.20,  .58,1.28,0, BODY);
  // Arm detail strips
  bp(.06,.40,.22, -.58,1.28,-.02, PANEL);
  bp(.06,.40,.22,  .58,1.28,-.02, PANEL);
  // Elbow ball joints
  const ejGeo=new THREE.SphereGeometry(.10,8,6);
  const ejL=new THREE.Mesh(ejGeo,JOINT); ejL.position.set(-.58,1.02,0); g.add(ejL);
  const ejR=new THREE.Mesh(ejGeo,JOINT); ejR.position.set( .58,1.02,0); g.add(ejR);
  // Elbow guards
  bp(.18,.12,.20, -.58,1.02,-.08, RED);
  bp(.18,.12,.20,  .58,1.02,-.08, RED);

  // ── Forearms ──────────────────────────────────────────────
  bp(.18,.40,.18, -.58,.84,0, CHROME);
  bp(.18,.40,.18,  .58,.84,0, CHROME);
  // Forearm armour plates
  bp(.10,.36,.20, -.58,.84,-.06, PANEL);
  bp(.10,.36,.20,  .58,.84,-.06, PANEL);
  // Hydraulic tubes on forearms
  bp(.04,.34,.04, -.50,.84,.08, RED);
  bp(.04,.34,.04,  .50,.84,.08, RED);
  // Right arm weapon mount (blaster on right forearm)
  bp(.08,.08,.22,  .58,.76,-.14, DARK);
  bp(.03,.03,.18,  .58,.78,-.22, CHROME);       // weapon barrel

  // ── Hands / Claws ─────────────────────────────────────────
  bp(.22,.14,.22, -.58,.59,0, DARK);
  bp(.22,.14,.22,  .58,.59,0, DARK);
  // Knuckle ridge
  bp(.20,.05,.06, -.58,.54,-.10, RED);
  bp(.20,.05,.06,  .58,.54,-.10, RED);
  // Three claw fingers per hand (longer, more menacing)
  for(let f=-1;f<=1;f++){
    bp(.04,.04,.16, -.54+f*.06,.56,-.14, DARK);
    bp(.04,.04,.16,  .54+f*.06,.56,-.14, DARK);
    // Claw tips
    bp(.03,.03,.04, -.54+f*.06,.56,-.23, CHROME);
    bp(.03,.03,.04,  .54+f*.06,.56,-.23, CHROME);
  }

  // ── Legs (groups pivoted at hip for walk animation) ────────
  function makeLeg(side) {
    const lg=new THREE.Group();
    lg.position.set(side*.22, .74, 0);

    // Upper leg main block
    const ul=new THREE.Mesh(new THREE.BoxGeometry(.22,.50,.22),BODY);
    ul.position.y=-.25; lg.add(ul);
    // Thigh armour plate (front face)
    const tap=new THREE.Mesh(new THREE.BoxGeometry(.16,.26,.06),RED);
    tap.position.set(0,-.22,-.14); lg.add(tap);
    // Thigh side trim
    const tst=new THREE.Mesh(new THREE.BoxGeometry(.24,.06,.24),DARK);
    tst.position.y=-.08; lg.add(tst);
    // Thigh hydraulic (back)
    const th=new THREE.Mesh(new THREE.BoxGeometry(.04,.36,.04),CHROME);
    th.position.set(0,-.22,.12); lg.add(th);

    // Knee cap (larger, more mechanical)
    const kn=new THREE.Mesh(new THREE.BoxGeometry(.22,.12,.24),RED);
    kn.position.y=-.54; lg.add(kn);
    const knb=new THREE.Mesh(new THREE.BoxGeometry(.18,.06,.18),JOINT);
    knb.position.y=-.62; lg.add(knb);

    // Lower leg
    const ll=new THREE.Mesh(new THREE.BoxGeometry(.19,.44,.19),CHROME);
    ll.position.y=-.78; lg.add(ll);
    // Shin armour plate
    const sh=new THREE.Mesh(new THREE.BoxGeometry(.14,.24,.06),PANEL);
    sh.position.set(0,-.74,-.13); lg.add(sh);
    // Shin LED strip
    const sl=new THREE.Mesh(new THREE.BoxGeometry(.06,.02,.04),EYE_L);
    sl.position.set(0,-.66,-.16); lg.add(sl);
    // Calf hydraulic
    const cl=new THREE.Mesh(new THREE.BoxGeometry(.04,.32,.04),RED);
    cl.position.set(0,-.78,.10); lg.add(cl);

    // Ankle joint
    const an=new THREE.Mesh(new THREE.BoxGeometry(.20,.10,.22),DARK);
    an.position.y=-1.02; lg.add(an);
    const aj=new THREE.Mesh(new THREE.SphereGeometry(.08,7,5),JOINT);
    aj.position.y=-1.01; lg.add(aj);

    // Foot with toe cap
    const ft=new THREE.Mesh(new THREE.BoxGeometry(.24,.09,.36),DARK);
    ft.position.set(0,-1.11,.06); lg.add(ft);
    const tc=new THREE.Mesh(new THREE.BoxGeometry(.22,.10,.10),RED);  // toe cap
    tc.position.set(0,-1.10,-.18); lg.add(tc);
    const heel=new THREE.Mesh(new THREE.BoxGeometry(.18,.06,.08),DARK);
    heel.position.set(0,-1.12,.18); lg.add(heel);

    g.add(lg);
    return lg;
  }

  const legL=makeLeg(-1);
  const legR=makeLeg( 1);

  // Collect all Lambert materials for hit flash (skip MeshBasicMaterial LEDs/eyes)
  const allMats=[];
  g.traverse(child=>{
    if(child.isMesh && child.material.isMeshLambertMaterial) allMats.push(child.material);
  });

  // ── Health bar (world-space billboard above head) ──────────
  const hpBarGroup=new THREE.Group();
  hpBarGroup.position.set(0, 2.88, 0);

  // Outer border
  const hpBorder=new THREE.Mesh(
    new THREE.BoxGeometry(.76,.115,.01),
    new THREE.MeshBasicMaterial({color:0x111111})
  );
  hpBarGroup.add(hpBorder);

  // Background track
  const hpBg=new THREE.Mesh(
    new THREE.BoxGeometry(.70,.075,.015),
    new THREE.MeshBasicMaterial({color:0x330000})
  );
  hpBarGroup.add(hpBg);

  // Fill bar — scale.x and position.x updated each frame
  const hpFillMat=new THREE.MeshBasicMaterial({color:0x22dd44});
  const hpFill=new THREE.Mesh(new THREE.BoxGeometry(.68,.055,.02), hpFillMat);
  hpBarGroup.add(hpFill);

  // Segment dividers (2 lines splitting into 3 HP sections)
  [-0.226, 0.226].forEach(dx=>{
    const div=new THREE.Mesh(
      new THREE.BoxGeometry(.014,.09,.022),
      new THREE.MeshBasicMaterial({color:0x000000})
    );
    div.position.x=dx; hpBarGroup.add(div);
  });

  g.add(hpBarGroup);

  return { group:g, legL, legR, eyeMatL:EYE_L, eyeMatR:EYE_R, allMats, hpBarGroup, hpFill, hpFillMat };
}

// ─── Bot pool (populated per-level) ──────────────────────────
const BOT_DMG_INT = 0.9;   // seconds between bot hits (fixed)
const BOT_MELEE   = 2.2;

function rndPos(){
  return new THREE.Vector3((Math.random()-.5)*(AW*2-5),0,(Math.random()-.5)*(AD*2-5));
}

let bots = [];

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
  if(def.spinUp && mgSpinSpeed < MG_MAX_SPIN*.72) return;  // minigun needs to spin up

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
  const hits = raycaster.intersectObjects([...livingGroups, ...remoteGroups], true);
  if(hits.length>0){
    const bot = findBot(hits[0].object);
    if(bot){
      damageBot(bot);
    } else {
      const hit = findRemotePlayer(hits[0].object);
      if(hit && socket) socket.emit('shoot', { targetId: hit[0] });
    }
  }

  gun.canShoot=false; gun.shootTimer=def.fireRate;
}

function damageBot(bot){
  if(gun.def && gun.def.oneShot) bot.hp = 0; else bot.hp -= 1;
  bot.allMats.forEach(mat=>{ mat.emissive.set(0xffffff); });
  setTimeout(()=>{ bot.allMats.forEach(mat=>{ if(mat.emissive) mat.emissive.set(0x000000); }); },80);
  if(bot.hp<=0) killBot(bot);
}

function killBot(bot){
  bot.alive=false;
  bot.hpBarGroup.visible=false;
  bot.eyeMatL.color.setHex(0x220000);
  bot.eyeMatR.color.setHex(0x220000);
  spawnSparks(bot.group.position.clone().setY(1.2));
  setTimeout(()=>{ bot.group.visible=false; },180);
  player.kills++;
  updateKillHUD();
  pushKillFeed('Robot destroyed');
  updateEnemyCountHUD();
  checkLevelComplete();
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

// ============================================================
//  INPUT
// ============================================================
const keys={};
document.addEventListener('keydown',e=>{
  keys[e.code]=true;
  if(e.code==='KeyR') reloadGun();
  if(e.code==='KeyT' && pointerLocked()) { deactivateScope(); document.exitPointerLock(); }
});
document.addEventListener('keyup', e=>{ keys[e.code]=false; });

document.addEventListener('mousedown', e=>{
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

playBtn.addEventListener('click',()=>canvas.requestPointerLock());

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
});

document.addEventListener('pointerlockchange',()=>{
  if(pointerLocked()){
    setupWeapon(selectedGunId);   // always re-setup in case gun was switched
    startScreen.style.display='none';
    hudEl.style.display='block';
    if(!gameStarted){
      gameStarted=true;
      startLevel(1);
      initSocket();
    }
  } else if(!player.dead && !levelTransitioning){
    deactivateScope();
    startScreen.style.display='flex';
    hudEl.style.display='none';
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
  if(pointerLocked()) hudEl.style.display='block';
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
  if(camera.position.y<=EYE_H){ camera.position.y=EYE_H; velY=0; grounded=true; }
  if(camera.position.y>=WH-.6){ camera.position.y=WH-.6; velY=Math.min(0,velY); }

  if(!pointerLocked()||player.dead) return;

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

  const moving=moveVec.lengthSq()>0;
  if(moving){
    moveVec.normalize().multiplyScalar(P_SPEED*dt);
    camera.position.add(moveVec);
    resolveCollision(camera.position,P_RADIUS);
  }

  // ── Auto fire ───────────────────────────────────────────
  if(mouseHeld && gun.def && gun.def.auto) shoot();

  // ── Shoot cooldown ──────────────────────────────────────
  if(!gun.canShoot){ gun.shootTimer-=dt; if(gun.shootTimer<=0) gun.canShoot=true; }

  // ── Minigun spin ────────────────────────────────────────
  if(gun.def && gun.def.spinUp){
    const spinning = mouseHeld && gun.ammo>0;
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

  // ── Weapon bob ──────────────────────────────────────────
  const bobRate=moving?9.0:2.2, bobAmp=moving?.014:.005;
  bobClock+=dt*bobRate;
  if(weaponRoot.userData.baseY !== undefined){
    weaponRoot.position.y = weaponRoot.userData.baseY + Math.sin(bobClock)*bobAmp;
    weaponRoot.position.x = weaponRoot.userData.baseX + Math.sin(bobClock*.5)*bobAmp*.55;
  }

  // ── Hurt cooldown ───────────────────────────────────────
  if(player.hurtTimer>0) player.hurtTimer-=dt;

  // ── Bot AI ──────────────────────────────────────────────
  const px=camera.position.x, pz=camera.position.z;
  bots.forEach(bot=>{
    if(!bot.alive) return;   // dead bots stay dead until next level

    const bp  = bot.group.position;
    const dx  = px-bp.x, dz=pz-bp.z;
    const dist= Math.sqrt(dx*dx+dz*dz);
    const spd = bot.speed, det=bot.detectR, dmg=bot.damage;

    if(dist < det){
      bot.group.rotation.y = Math.atan2(dx,dz);
      const mv = (dist<10 ? spd : spd*.55)*dt;
      bp.x += (dx/dist)*mv;  bp.z += (dz/dist)*mv;
      bot.walkClock += dt*spd;

      if(dist<BOT_MELEE && player.hurtTimer<=0){
        player.health -= dmg;  player.hurtTimer = BOT_DMG_INT;
        updateHealthHUD(); flashDmg();
        if(player.health<=0) killPlayer();
      }
    } else {
      bot.patrolTimer-=dt;
      if(bot.patrolTimer<=0){ bot.patrolTarget=rndPos(); bot.patrolTimer=2.5+Math.random()*3.5; }
      const pdx=bot.patrolTarget.x-bp.x, pdz=bot.patrolTarget.z-bp.z;
      const pd=Math.sqrt(pdx*pdx+pdz*pdz);
      if(pd>.6){
        const s=spd*.55*dt;
        bp.x+=(pdx/pd)*s; bp.z+=(pdz/pd)*s;
        bot.group.rotation.y=Math.atan2(pdx,pdz);
        bot.walkClock+=dt*spd*.55;
      } else { bot.patrolTimer=0; }
    }

    // Leg swing animation
    const legSwing = Math.sin(bot.walkClock*2.5)*.32;
    bot.legL.rotation.x =  legSwing;
    bot.legR.rotation.x = -legSwing;

    // Health bar: shrinks left-to-right, changes colour
    const f = bot.hp / bot.maxHp;
    bot.hpFill.scale.x        = Math.max(0.001, f);
    bot.hpFill.position.x     = (f-1)*0.34;
    bot.hpFillMat.color.setHex(f>.66 ? 0x22dd44 : f>.33 ? 0xffaa00 : 0xff2200);
    bot.hpBarGroup.lookAt(camera.position);

    bp.x=Math.max(-AW+1,Math.min(AW-1,bp.x));
    bp.z=Math.max(-AD+1,Math.min(AD-1,bp.z));
  });

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
  });
}

// ============================================================
//  RESIZE
// ============================================================
window.addEventListener('resize',()=>{
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
});

// ============================================================
//  RENDER LOOP
// ============================================================
const clock=new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),.05);
  update(dt);
  renderer.render(scene,camera);
}

// ============================================================
//  LEVEL SYSTEM
// ============================================================

let currentLevel     = 1;
let levelActive      = false;
let levelTransitioning = false;

// Visual themes — one changes every 5 levels, cycling through 10 palettes
const THEMES = [
  { bg:0x080810, wall:0x18243c, trim:0x3060a0, trimE:0x081828, lights:[0xff2200,0x0044ff,0x00ff88,0xff9900] },
  { bg:0x100808, wall:0x3c1a14, trim:0xa03020, trimE:0x280808, lights:[0xff4400,0xffaa00,0xff2200,0xaa4400] },
  { bg:0x081008, wall:0x183c18, trim:0x28882a, trimE:0x081808, lights:[0x00ff44,0x44ff00,0x00cc22,0x88ff00] },
  { bg:0x100010, wall:0x2a1838, trim:0x7028a0, trimE:0x180828, lights:[0xaa00ff,0xff00aa,0x6600ff,0xff0066] },
  { bg:0x000814, wall:0x182838, trim:0x1888c0, trimE:0x081828, lights:[0x00aaff,0x0066ff,0x00ffff,0x0044cc] },
  { bg:0x10100a, wall:0x38361a, trim:0x887820, trimE:0x282010, lights:[0xffee00,0xff8800,0xffcc00,0xddaa00] },
  { bg:0x0a0814, wall:0x201834, trim:0x504090, trimE:0x100828, lights:[0x8844ff,0x4488ff,0x44aaff,0x8800ff] },
  { bg:0x100808, wall:0x3c1820, trim:0xc02840, trimE:0x280810, lights:[0xff0044,0xff4488,0xff0022,0xcc0033] },
  { bg:0x08100a, wall:0x1a3820, trim:0x30b060, trimE:0x081c10, lights:[0x00ff88,0x00dd44,0x44ff88,0x00bb66] },
  { bg:0x101010, wall:0x303030, trim:0x888888, trimE:0x202020, lights:[0xffffff,0xccccff,0xffffff,0xccffff] },
];

function applyTheme(level) {
  const t = THEMES[Math.floor((level-1)/5) % THEMES.length];
  scene.background.setHex(t.bg);
  scene.fog.color.setHex(t.bg);
  ARENA_M.wall.color.setHex(t.wall);
  ARENA_M.trim.color.setHex(t.trim);
  ARENA_M.trim.emissive.setHex(t.trimE);
  ARENA_M.pillar.color.setHex(t.wall);
  accentLights.forEach((l,i) => l.color.setHex(t.lights[i % t.lights.length]));
}

// Difficulty formula for level n
function getLevelConfig(n) {
  return {
    botCount : Math.min(15, 1 + Math.floor(n/7)),
    botHP    : Math.min(15, Math.ceil((3 + Math.floor((n-1)/12)) * 1.5)),
    speed    : Math.min(7.5, 2.8 + (n-1)*0.042),
    damage   : Math.min(30, 8  + Math.floor(n/10)*2),
    detectR  : Math.min(30, 18 + Math.floor(n/20)*2),
  };
}

function clearBots() {
  bots.forEach(b => scene.remove(b.group));
  bots.length = 0;
}

function spawnBots(cfg) {
  for(let i=0; i<cfg.botCount; i++){
    const r = buildRobot();
    r.group.position.copy(rndPos());
    scene.add(r.group);
    bots.push({ ...r,
      hp:cfg.botHP, maxHp:cfg.botHP,
      alive:true,
      speed:cfg.speed, damage:cfg.damage, detectR:cfg.detectR,
      patrolTarget:rndPos(), patrolTimer:Math.random()*3, walkClock:0,
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
  clearBots();
  applyTheme(n);
  const cfg = getLevelConfig(n);
  spawnBots(cfg);
  levelActive        = true;
  levelTransitioning = false;
  updateLevelHUD();
  updateEnemyCountHUD();
}

function checkLevelComplete() {
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
        </div>`;
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
    socket.emit('join', { username });

    // Broadcast position every 50 ms
    if (moveInterval) clearInterval(moveInterval);
    moveInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('move', {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          rotationY: yaw,
        });
      }
    }, 50);
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
  });

  // A hit was registered by the server
  socket.on('playerHit', data => {
    if (data.targetId === socket.id) {
      // We were hit — apply damage locally
      player.health -= data.damage;
      updateHealthHUD();
      flashDmg();
      if (player.health <= 0) killPlayer();
    } else {
      // Someone else was hit — flash their robot
      const rp = remotePlayers.get(data.targetId);
      if (rp) {
        rp.allMats.forEach(m => { m.emissive.set(0xffffff); });
        setTimeout(() => rp.allMats.forEach(m => { if(m.emissive) m.emissive.set(0x000000); }), 80);
      }
    }
  });

  // A player disconnected
  socket.on('playerLeft', data => {
    const rp = remotePlayers.get(data.id);
    if (rp) pushKillFeed(`${rp.username || 'Player'} left`);
    removeRemotePlayer(data.id);
  });

  // Server went away — clean up all ghosts
  socket.on('disconnect', () => {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    remotePlayers.forEach((_, id) => removeRemotePlayer(id));
  });
}

// ─── Bootstrap ───────────────────────────────────────────────
updateHealthHUD(); updateAmmoHUD(); updateKillHUD();
animate();
