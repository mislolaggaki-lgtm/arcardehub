// Shared robot builder — loaded by both the FPS game and the hub shop preview
// Requires THREE.js to be loaded first.

function buildRobot() {
  const g = new THREE.Group();

  // ── Materials ─────────────────────────────────────────────
  // Organic white-plate armour (Garou-style)
  const HULL   = new THREE.MeshStandardMaterial({color:0xa8c2d4, roughness:0.30, metalness:0.18});
  const ARMOR  = new THREE.MeshStandardMaterial({color:0xc8dce8, roughness:0.24, metalness:0.12});
  const PANEL  = new THREE.MeshStandardMaterial({color:0x7898b0, roughness:0.42, metalness:0.32});
  const DARK   = new THREE.MeshStandardMaterial({color:0x060a0e, roughness:0.96, metalness:0.08});
  const STEEL  = new THREE.MeshStandardMaterial({color:0x182838, roughness:0.82, metalness:0.35});
  const SERVO  = new THREE.MeshStandardMaterial({color:0x0c1a26, roughness:0.88, metalness:0.22});
  const PIPE   = new THREE.MeshStandardMaterial({color:0x283c4e, roughness:0.68, metalness:0.52});
  const ACCENT = new THREE.MeshStandardMaterial({color:0xe0eef8, roughness:0.18, metalness:0.06});
  const WORN   = new THREE.MeshStandardMaterial({color:0x3c5268, roughness:0.60, metalness:0.40});
  const EYE_L  = new THREE.MeshBasicMaterial({color:0xffffff});
  const EYE_R  = new THREE.MeshBasicMaterial({color:0xffffff});
  // remap all legacy red/orange glows to icy blue-white
  const _GR = {0xff0800:0x88ccff,0xff2200:0x66aaee,0xff1800:0x77bbff,0xff3300:0x55aadd,
               0xff4400:0x4499cc,0xff0000:0xaaddff,0x0022cc:0x77bbff,0xff3300:0x55aadd};

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
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:_GR[col]??col}));
    m.position.set(x,y,z); g.add(m); return m;
  }
  function glowCyl(rt,rb,h,segs,x,y,z,col,rX=0,rZ=0){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,segs),new THREE.MeshBasicMaterial({color:_GR[col]??col}));
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
    function lglow(w,h,d,x,y,z,col){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:_GR[col]??col})); m.position.set(x,y,z); lg.add(m); }

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
  // HEAD  (Garou-style organic monster)
  // ════════════════════════════════════════════════════════
  // Main cranium — slightly narrower/taller for imposing look
  box(0.430,0.395,0.430, 0,1.984,0, HULL);
  box(0.385,0.158,0.375, 0,2.172,0, HULL);
  box(0.355,0.052,0.348, 0,2.246, 0, ARMOR);
  // Organic plate seams on skull
  box(0.005,0.345,0.400, 0,2.002,0, DARK);                          // center vertical seam
  for(let s=-1;s<=1;s+=2) box(0.005,0.240,0.365, s*0.138,2.010,0, DARK);  // side seams
  box(0.005,0.148,0.365, 0,2.168,0, DARK);                          // upper seam
  // Brow ridge — dramatic angular overhang
  box(0.468,0.095,0.118, 0,2.112,-0.195, DARK);
  box(0.428,0.058,0.096, 0,2.150,-0.212, ARMOR);
  box(0.006,0.072,0.090, 0,2.125,-0.212, DARK);                     // brow center notch
  for(let s=-1;s<=1;s+=2) box(0.034,0.068,0.090, s*0.198,2.120,-0.215, WORN);
  // Visor — single menacing white slit
  box(0.398,0.120,0.062, 0,1.985,-0.222, DARK);
  box(0.370,0.095,0.030, 0,1.985,-0.248, STEEL);
  glow(0.335,0.028,0.012, 0,1.985,-0.258, 0xffffff);               // white horizontal visor slit
  glow(0.295,0.014,0.010, 0,1.985,-0.262, 0xbbddff);               // inner blue edge
  // Eye sockets (housed in visor)
  for(let s=-1;s<=1;s+=2){
    cyl(0.052,0.052,0.018,10, s*0.098,1.985,-0.248, DARK, Math.PI/2);
  }
  const eyeL=new THREE.Mesh(new THREE.SphereGeometry(0.038,11,8),EYE_L); eyeL.position.set( 0.098,1.985,-0.244); g.add(eyeL);
  const eyeR=new THREE.Mesh(new THREE.SphereGeometry(0.038,11,8),EYE_R); eyeR.position.set(-0.098,1.985,-0.244); g.add(eyeR);
  glowCyl(0.042,0.042,0.010,10,  0.098,1.985,-0.248, 0xffffff, Math.PI/2);
  glowCyl(0.042,0.042,0.010,10, -0.098,1.985,-0.248, 0xffffff, Math.PI/2);
  // Cheeks — organic segmented plates
  for(let s=-1;s<=1;s+=2){
    box(0.062,0.242,0.308, s*0.258,1.984,0.002, HULL);
    box(0.056,0.212,0.272, s*0.264,1.984,0.002, ARMOR);
    box(0.005,0.198,0.258, s*0.235,1.984,0.002, DARK);             // cheek seam line
    box(0.060,0.038,0.098, s*0.258,1.855,-0.055, WORN);
  }
  // Chin/jaw — wide aggressive jaw plate
  box(0.368,0.118,0.105, 0,1.805,-0.188, DARK);
  box(0.330,0.080,0.068, 0,1.808,-0.222, HULL);
  box(0.288,0.038,0.055, 0,1.762,-0.240, ACCENT);                  // chin highlight plate
  // Grin slit — menacing teeth line
  glow(0.248,0.011,0.010, 0,1.818,-0.258, 0xffffff);
  glow(0.195,0.006,0.008, 0,1.818,-0.261, 0xbbddff);
  // Jaw seam
  box(0.005,0.100,0.095, 0,1.808,-0.195, DARK);
  for(let i=0;i<4;i++) box(0.042,0.008,0.012, -0.084+i*0.056,1.825,-0.268, DARK); // teeth gaps
  // Side sensor pods (sleek)
  for(let s=-1;s<=1;s+=2){
    cyl(0.038,0.032,0.078,10, s*0.284,2.032,-0.048, PANEL, 0,Math.PI/2);
    cyl(0.032,0.032,0.010,10, s*0.305,2.032,-0.048, DARK,  0,Math.PI/2);
    glowCyl(0.028,0.028,0.008,10, s*0.307,2.032,-0.048, 0xbbddff, 0,Math.PI/2);
    cyl(0.009,0.005,0.082,5, s*0.265,2.086,-0.038, STEEL);
    sph(0.014,8, s*0.265,2.136,-0.038, new THREE.MeshBasicMaterial({color:0xbbddff}));
  }
  // Back of head — plate lines
  box(0.372,0.242,0.030, 0,1.984,0.230, ARMOR);
  box(0.290,0.078,0.038, 0,1.948,0.230, DARK);
  for(let i=0;i<4;i++) box(0.250,0.012,0.030, 0,1.935+i*0.022,0.232, DARK);

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
    sph(0.020,8, s*0.620,2.086,-0.036, new THREE.MeshBasicMaterial({color:0xaaddff}));
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
    function agl(w,h,d,x,y,z,col){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:_GR[col]??col})); m.position.set(x,y,z); ag.add(m); }

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
    acy(0.009,0.009,0.26,6, sx+side*0.062,-0.862,0.058, new THREE.MeshBasicMaterial({color:0x55aadd}));
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
      if(f===0) agl(0.010,0.008,0.010, fx,-1.248,-0.200, 0xaaddff); // mid-finger LED
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
