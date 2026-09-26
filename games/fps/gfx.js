'use strict';
// Graphics helpers for the FPS game: texture generation, baked floor lighting,
// per-biome reflection environments, colour grading and adaptive resolution.
// Loaded after three.js and before game.js. Everything here is pure setup code;
// game.js decides when to use it based on the quality setting.

const GFXH = (() => {

  // ── Colour management ─────────────────────────────────────────
  // The final grade pass now converts linear → sRGB correctly. The game's hex
  // colours were authored as sRGB, so convert them to linear when set (what
  // newer three.js does by default); otherwise everything would look washed out.
  // Canvas textures are likewise authored in sRGB.
  (function enableSRGBColors() {
    const C = THREE.Color.prototype;
    const setHex = C.setHex, setStyle = C.setStyle;
    let inStyle = false;
    C.setHex = function (hex) { setHex.call(this, hex); return inStyle ? this : this.convertSRGBToLinear(); };
    C.setStyle = function (style) {
      inStyle = true;
      try { setStyle.call(this, style); } finally { inStyle = false; }
      return this.convertSRGBToLinear();
    };
    const Base = THREE.CanvasTexture;
    THREE.CanvasTexture = class extends Base {
      constructor(...args) { super(...args); this.encoding = THREE.sRGBEncoding; }
    };
  })();

  // ── Box UVs in world units ────────────────────────────────────
  // BoxGeometry maps every face to 0..1, so one texture stretched differently
  // across every box. Re-map so 1 UV unit = 1 world unit and neighbouring boxes
  // line up. (ox, oy, oz) is the box's world position.
  function worldUV(geo, ox = 0, oy = 0, oz = 0) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + ox, y = pos.getY(i) + oy, z = pos.getZ(i) + oz;
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      if (ay >= ax && ay >= az)      uv.setXY(i, x, ny > 0 ? -z : z);
      else if (ax >= az)             uv.setXY(i, nx > 0 ? -z : z, y);
      else                           uv.setXY(i, nz > 0 ? x : -x, y);
    }
    uv.needsUpdate = true;
    return geo;
  }

  // Second UV set from world X/Z, normalised to a square region, for lightmaps.
  function xzUV2(geo, ox, oz, minX, minZ, size) {
    const pos = geo.attributes.position;
    const uv2 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv2[i * 2]     = (pos.getX(i) + ox - minX) / size;
      uv2[i * 2 + 1] = 1 - (pos.getZ(i) + oz - minZ) / size;
    }
    geo.setAttribute('uv2', new THREE.BufferAttribute(uv2, 2));
    return geo;
  }

  // ── Normal map from a canvas (height = luminance, Sobel filter) ─
  function normalMapFromCanvas(src, strength = 2.0, invert = false) {
    const w = src.width, h = src.height;
    const data = src.getContext('2d').getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const l = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      lum[i] = invert ? 1 - l : l;
    }
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h), o = img.data;
    const L = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];   // wrap: textures tile
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1)) - (L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1));
        const dy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1)) - (L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1));
        let nx = -dx * strength, ny = dy * strength, nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const k = (y * w + x) * 4;
        o[k] = (nx * inv * 0.5 + 0.5) * 255; o[k + 1] = (ny * inv * 0.5 + 0.5) * 255; o[k + 2] = (nz * inv * 0.5 + 0.5) * 255; o[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // ── Metal wall panels (greyscale; the biome colour tints it) ───
  function makePanelCanvases(size = 1024) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const hc = document.createElement('canvas'); hc.width = hc.height = size;   // height map for the normal map
    const hx = hc.getContext('2d');
    const rnd = mulberry(1337);
    const S = size / 1024;

    ctx.fillStyle = '#c9ccd2'; ctx.fillRect(0, 0, size, size);
    hx.fillStyle = '#808080'; hx.fillRect(0, 0, size, size);

    // Panel layout: 2 x 2 large panels, one split horizontally
    const panels = [[0, 0, 512, 512], [512, 0, 512, 256], [512, 256, 512, 256], [0, 512, 512, 512], [512, 512, 512, 512]];
    panels.forEach(([x, y, w, hh], i) => {
      x *= S; y *= S; w *= S; hh *= S;
      const shade = 190 + Math.floor(rnd() * 26);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
      ctx.fillRect(x + 6 * S, y + 6 * S, w - 12 * S, hh - 12 * S);
      // bevel: raised panel in the height map
      hx.fillStyle = '#a0a0a0'; hx.fillRect(x + 6 * S, y + 6 * S, w - 12 * S, hh - 12 * S);
      hx.fillStyle = '#b4b4b4'; hx.fillRect(x + 14 * S, y + 14 * S, w - 28 * S, hh - 28 * S);
      // seams
      ctx.strokeStyle = 'rgba(40,44,52,0.85)'; ctx.lineWidth = 5 * S; ctx.strokeRect(x + 3 * S, y + 3 * S, w - 6 * S, hh - 6 * S);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2 * S; ctx.strokeRect(x + 9 * S, y + 9 * S, w - 18 * S, hh - 18 * S);
      // bolts in the corners
      [[18, 18], [w / S - 18, 18], [18, hh / S - 18], [w / S - 18, hh / S - 18]].forEach(([bx, by]) => {
        const cx = x + bx * S, cy = y + by * S;
        ctx.fillStyle = '#7d828c'; ctx.beginPath(); ctx.arc(cx, cy, 5 * S, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(cx - 1.5 * S, cy - 1.5 * S, 2 * S, 0, Math.PI * 2); ctx.fill();
        hx.fillStyle = '#e0e0e0'; hx.beginPath(); hx.arc(cx, cy, 5 * S, 0, Math.PI * 2); hx.fill();
      });
      // vent slats on some panels
      if (i === 1 || i === 4) {
        for (let k = 0; k < 7; k++) {
          const vy = y + hh * 0.35 + k * 14 * S, vx = x + w * 0.2, vw = w * 0.6;
          ctx.fillStyle = 'rgba(30,33,40,0.9)'; ctx.fillRect(vx, vy, vw, 6 * S);
          hx.fillStyle = '#404040'; hx.fillRect(vx, vy, vw, 6 * S);
        }
      }
    });
    // Fine brushed-metal noise, scratches and grime at the bottom
    for (let k = 0; k < 2600; k++) {
      const x = rnd() * size, y = rnd() * size, a = rnd() * 0.08;
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      ctx.fillRect(x, y, (6 + rnd() * 30) * S, 1 * S);
    }
    ctx.strokeStyle = 'rgba(30,30,35,0.25)'; ctx.lineWidth = 1 * S;
    for (let k = 0; k < 40; k++) {
      const x = rnd() * size, y = rnd() * size;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 60 * S, y + (rnd() - 0.5) * 20 * S); ctx.stroke();
    }
    const grime = ctx.createLinearGradient(0, size * 0.72, 0, size);
    grime.addColorStop(0, 'rgba(20,18,16,0)'); grime.addColorStop(1, 'rgba(20,18,16,0.28)');
    ctx.fillStyle = grime; ctx.fillRect(0, 0, size, size);
    return { color: c, height: hc };
  }

  function mulberry(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  function texture(canvas, { srgb = false, repeat = 1, aniso = 1 } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    t.encoding = srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
    return t;
  }

  // ── Baked floor lighting ──────────────────────────────────────
  // Same maths as a three.js r128 PointLight on a flat Lambert surface:
  // irradiance = dotNL * colour * intensity * saturate(1 - d/cutoff)^decay.
  // Stored sRGB-encoded (for precision in the darks) at 1/scale; the material
  // sets lightMapIntensity = scale. (r128 multiplies lightmaps by PI and the
  // Lambert BRDF divides by PI, exactly as it does for direct point lights.)
  function bakeLightmap(lights, { minX, minZ, size, res = 512, planeY = 0, scale = 3 }) {
    const data = new Uint8Array(res * res * 4);
    const toSRGB = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    const cols = lights.map(l => { const c = new THREE.Color(l.color); return [c.r * l.intensity, c.g * l.intensity, c.b * l.intensity]; });
    for (let j = 0; j < res; j++) {
      const z = minZ + (j + 0.5) / res * size;
      for (let i = 0; i < res; i++) {
        const x = minX + (i + 0.5) / res * size;
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < lights.length; k++) {
          const L = lights[k];
          const dy = L.y - planeY;
          if (dy <= 0) continue;
          const dx = L.x - x, dz = L.z - z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d >= L.distance) continue;
          const att = Math.pow(1 - d / L.distance, L.decay ?? 1) * (dy / d);
          r += cols[k][0] * att; g += cols[k][1] * att; b += cols[k][2] * att;
        }
        const o = ((res - 1 - j) * res + i) * 4;
        data[o]     = Math.min(255, toSRGB(r / scale) * 255);
        data[o + 1] = Math.min(255, toSRGB(g / scale) * 255);
        data[o + 2] = Math.min(255, toSRGB(b / scale) * 255);
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    tex.encoding = THREE.sRGBEncoding;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // ── Reflection environment per biome ──────────────────────────
  // A small emissive stand-in of the arena (walls, ceiling light panels, accent
  // lights, trim strips) prefiltered with PMREM; metals and armour reflect it.
  function buildEnvironment(renderer, biome, ceilingLights) {
    const env = new THREE.Scene();
    const mk = (geo, color, k, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
      m.material.color.multiplyScalar(k);
      m.position.set(x, y, z); m.rotation.y = ry; env.add(m); return m;
    };
    const bg = new THREE.Color(biome.bg), wall = new THREE.Color(biome.wall);
    // Room shell (camera sits at the origin = eye height)
    const room = new THREE.Mesh(new THREE.BoxGeometry(160, 11, 160), [
      new THREE.MeshBasicMaterial({ color: wall.clone().multiplyScalar(0.55), side: THREE.BackSide }),
      new THREE.MeshBasicMaterial({ color: wall.clone().multiplyScalar(0.55), side: THREE.BackSide }),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(biome.ceil).multiplyScalar(0.6).add(bg.clone().multiplyScalar(0.2)), side: THREE.BackSide }),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(biome.floor ?? 0x101018).multiplyScalar(0.35), side: THREE.BackSide }),
      new THREE.MeshBasicMaterial({ color: wall.clone().multiplyScalar(0.55), side: THREE.BackSide }),
      new THREE.MeshBasicMaterial({ color: wall.clone().multiplyScalar(0.55), side: THREE.BackSide }),
    ]);
    room.position.y = 3.85; env.add(room);
    // Ceiling light panels
    const panel = new THREE.PlaneGeometry(6, 1.4);
    ceilingLights.forEach(([x, z]) => { const m = mk(panel, 0xcfe0ff, 5.0, x, 7.1, z); m.rotation.x = Math.PI / 2; m.material.side = THREE.DoubleSide; });
    // Accent lights as glowing orbs
    const orb = new THREE.SphereGeometry(2.4, 16, 12);
    [[-15, -15], [15, 15], [15, -15], [-15, 15]].forEach(([x, z], i) => mk(orb, biome.accentColors[i % biome.accentColors.length], 3.0, x, 2.4, z).material.side = THREE.FrontSide);
    // Trim strips around the walls
    const trim = new THREE.Color(biome.trimE);
    [[0, -79, 0], [0, 79, 0], [-79, 0, Math.PI / 2], [79, 0, Math.PI / 2]].forEach(([x, z, ry]) => {
      [-0.75, 7.2].forEach(y => { const m = mk(new THREE.BoxGeometry(158, 0.25, 0.25), trim, 3.0, x, y, z, ry); m.material.side = THREE.FrontSide; });
    });
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0.035, 0.1, 200);
    pmrem.dispose();
    env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
    return rt;
  }

  // ── Studio lighting for the first-person weapon ───────────────
  // FPS games light the viewmodel separately so it always reads well; this is a
  // dark room with soft boxes: a big overhead key, warm fill left, cool rim right.
  function buildStudioEnvironment(renderer) {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x0c0d10, side: THREE.BackSide })));
    const box = (w, h, color, k, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.material.color.multiplyScalar(k); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m);
    };
    box(9, 6, 0xffffff, 3.2, 0, 8, -1, Math.PI / 2, 0);       // overhead key
    box(4, 7, 0xffd9b0, 1.6, -9, 1, 0, 0, Math.PI / 2);        // warm fill, left
    box(3, 8, 0xa8d4ff, 2.6, 8, 2, 4, 0, -Math.PI / 2.4);      // cool rim, right-back
    box(10, 2, 0xffffff, 0.8, 0, -3, -9, 0, 0);                 // low front bounce
    // Soft light band all round the horizon: grazing reflections on the gun's top
    // faces catch it whichever way the player is facing.
    const band = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 3.2, 48, 1, true), new THREE.MeshBasicMaterial({ color: 0xe8eef8, side: THREE.BackSide }));
    band.material.color.multiplyScalar(1.5); band.position.y = 2.2; env.add(band);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0.02);
    pmrem.dispose();
    env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return rt;
  }

  // ── Final colour grade: linear → sRGB, contrast, saturation, vignette ─
  // (EffectComposer in r128 writes linear values to the screen, which made the
  // whole game look dark and crushed; this pass does the missing conversion.)
  const GradeShader = {
    uniforms: {
      tDiffuse:   { value: null },
      saturation: { value: 1.08 },
      contrast:   { value: 1.06 },
      vignette:   { value: 0.32 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float saturation, contrast, vignette; varying vec2 vUv;
      vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        c = c / (1.0 + max(c - 1.0, 0.0));                      // soft-clip bloom overshoot
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, saturation), 0.0);
        c = toSRGB(c);
        c = clamp((c - 0.5) * contrast + 0.5, 0.0, 1.0);
        vec2 d = vUv - 0.5;
        c *= 1.0 - vignette * dot(d, d) * 1.8;
        gl_FragColor = vec4(c, 1.0);
      }`,
  };

  // ── Adaptive resolution ───────────────────────────────────────
  // Render as sharp as the machine sustains at ~60 fps: drop resolution quickly
  // when frames are slow, creep back up when there's headroom.
  class AdaptiveResolution {
    constructor({ target, min, apply }) {
      this.target = target; this.min = Math.min(min, target); this.cur = target; this.apply = apply;
      this.t = 0; this.frames = 0; this.good = 0; this.cooldown = 3;   // settle after load
    }
    tick(dt) {
      this.t += dt; this.frames++; this.cooldown -= dt;
      if (this.t < 1) return;
      const fps = this.frames / this.t; this.t = 0; this.frames = 0;
      if (this.cooldown > 0) return;
      if (fps < 48 && this.cur > this.min) {
        this.set(Math.max(this.min, this.cur * (fps < 35 ? 0.8 : 0.9))); this.good = 0;
      } else if (fps > 57 && this.cur < this.target) {
        if (++this.good >= 4) { this.set(Math.min(this.target, this.cur + 0.1)); this.good = 0; }
      } else this.good = 0;
    }
    set(v) { this.cur = Math.round(v * 100) / 100; this.cooldown = 2; this.apply(this.cur); }
  }

  return { worldUV, xzUV2, normalMapFromCanvas, makePanelCanvases, texture, bakeLightmap, buildEnvironment, buildStudioEnvironment, GradeShader, AdaptiveResolution };
})();
