/* SKYFORGE graphics: procedural textures, sky, stars, clouds, ocean and rain.
 * Everything here is generated in code - no image or model files are loaded.
 * Purely visual: nothing in this file feeds back into the flight physics. */
(function () {
  'use strict';

  const GFX = (window.GFX = window.GFX || {});

  /* ------------------------------------------------------------------ utils */
  // Small deterministic PRNG so the world looks the same on every load.
  GFX.rng = function (seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  GFX.canvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };

  GFX.canvasTexture = function (canvas, opts) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = (opts && opts.anisotropy) || 8;
    if (opts && opts.repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }
    return t;
  };

  // Soft round sprite used for lights, smoke, fire and sparks.
  GFX.glowTexture = function (inner, outer) {
    const c = GFX.canvas(64, 64);
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, inner || 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, outer || 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  // Billowy cloud / smoke puff.
  GFX.puffTexture = function (seed) {
    const rnd = GFX.rng(seed);
    const c = GFX.canvas(128, 128);
    const g = c.getContext('2d');
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 30;
      const x = 64 + Math.cos(a) * d;
      const y = 66 + Math.sin(a) * d * 0.7;
      const r = 16 + rnd() * 22;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.34)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  /* ---------------------------------------------------------- sky palette */
  // Keyframes over sin(sun elevation). Colours are authored in sRGB.
  const KEYS = [
    { e: -0.30, zen: 0x030816, hor: 0x0b1326, sun: 0x9db4ff, sunI: 0.55, hemi: 0.30 },
    { e: -0.10, zen: 0x081029, hor: 0x2c2440, sun: 0x9db4ff, sunI: 0.40, hemi: 0.30 },
    { e: -0.02, zen: 0x183060, hor: 0xe07a48, sun: 0xff6a30, sunI: 0.35, hemi: 0.30 },
    { e: 0.06, zen: 0x27539e, hor: 0xffb87a, sun: 0xff9a58, sunI: 1.6, hemi: 0.55 },
    { e: 0.22, zen: 0x2466c6, hor: 0xc4dcf2, sun: 0xffe6c4, sunI: 2.7, hemi: 0.85 },
    { e: 1.00, zen: 0x1a5abf, hor: 0xa9cdee, sun: 0xfff6ea, sunI: 3.1, hemi: 0.95 }
  ];
  const cA = new THREE.Color();
  const cB = new THREE.Color();

  // Returns linear-space lighting colours for a sun elevation and overcast amount (0..1).
  GFX.skyPalette = function (sunY, overcast) {
    let i = 0;
    while (i < KEYS.length - 2 && sunY > KEYS[i + 1].e) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((sunY - a.e) / (b.e - a.e), 0, 1);
    const mix = (ka, kb) => new THREE.Color().copy(cA.setHex(ka)).lerp(cB.setHex(kb), t);
    const p = {
      zenith: mix(a.zen, b.zen),
      horizon: mix(a.hor, b.hor),
      sunColor: mix(a.sun, b.sun),
      sunIntensity: a.sunI + (b.sunI - a.sunI) * t,
      hemiIntensity: a.hemi + (b.hemi - a.hemi) * t,
      night: THREE.MathUtils.clamp((0.10 - sunY) / 0.22, 0, 1),
      stars: THREE.MathUtils.clamp((-0.07 - sunY) / 0.12, 0, 1),
      day: THREE.MathUtils.clamp((sunY + 0.06) / 0.25, 0, 1)
    };
    if (overcast > 0) {
      const lum = (c) => 0.25 * c.r + 0.6 * c.g + 0.15 * c.b;
      const grey = (c, k) => c.lerp(new THREE.Color(lum(c) * k, lum(c) * k * 1.02, lum(c) * k * 1.06), overcast);
      grey(p.zenith, 1.5);
      grey(p.horizon, 0.85);
      p.sunIntensity *= 1 - 0.8 * overcast;
      p.hemiIntensity *= 1 - 0.25 * overcast;
    }
    return p;
  };

  /* ------------------------------------------------------------------ sky */
  const SKY_FN = `
    vec3 skyColor(vec3 d, vec3 zen, vec3 hor) {
      float t = pow(clamp(1.0 - max(d.y, 0.0), 0.0, 1.0), 3.2);
      return mix(zen, hor, t);
    }`;

  GFX.createSky = function () {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunGlow: { value: 1 },
        uDisc: { value: 1 }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pin to the far plane
        }`,
      fragmentShader: `
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
        uniform float uSunGlow, uDisc;
        varying vec3 vDir;
        ${SKY_FN}
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d, uZenith, uHorizon);
          if (d.y < 0.0) col = mix(uHorizon, uHorizon * 0.55, clamp(-d.y * 5.0, 0.0, 1.0));
          float sd = max(dot(d, uSunDir), 0.0);
          float low = pow(clamp(1.0 - abs(d.y), 0.0, 1.0), 4.0);
          col += uSunColor * uSunGlow * (pow(sd, 6.0) * 0.10 * (0.4 + low) + pow(sd, 60.0) * 0.22 + pow(sd, 700.0) * 0.9);
          col += uSunColor * uDisc * smoothstep(0.99962, 0.99982, sd) * 22.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  };

  GFX.createStars = function () {
    const rnd = GFX.rng(77);
    const n = 1800;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a) * 900;
      pos[i * 3 + 1] = Math.abs(u) * 900 + 8;
      pos[i * 3 + 2] = r * Math.sin(a) * 900;
      const b = 0.35 + Math.pow(rnd(), 4) * 2.2;
      const warm = rnd();
      col[i * 3] = b * (0.85 + 0.15 * warm);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (1.0 - 0.2 * warm);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0,
      depthWrite: false, depthTest: false, fog: false
    }));
    pts.frustumCulled = false;
    pts.renderOrder = -9;
    return pts;
  };

  /* --------------------------------------------------------------- clouds */
  GFX.createClouds = function (count) {
    const rnd = GFX.rng(4242);
    const group = new THREE.Group();
    const textures = [GFX.puffTexture(1), GFX.puffTexture(2), GFX.puffTexture(3)];
    const mats = textures.map((map) => new THREE.SpriteMaterial({
      map, transparent: true, opacity: 0.9, depthWrite: false, fog: true, color: 0xffffff
    }));
    const clouds = [];
    for (let i = 0; i < count; i++) {
      const cloud = new THREE.Group();
      cloud.position.set((rnd() - 0.5) * 30000, 1350 + rnd() * 1100, (rnd() - 0.5) * 30000);
      const w = 500 + rnd() * 900;
      const puffs = 5 + Math.floor(rnd() * 6);
      for (let j = 0; j < puffs; j++) {
        const s = new THREE.Sprite(mats[(i + j) % 3]);
        const sc = w * (0.45 + rnd() * 0.5);
        s.scale.set(sc, sc * (0.5 + rnd() * 0.2), 1);
        s.position.set((rnd() - 0.5) * w, (rnd() - 0.3) * w * 0.16, (rnd() - 0.5) * w * 0.7);
        cloud.add(s);
      }
      group.add(cloud);
      clouds.push(cloud);
    }
    // High overcast deck, faded in with poor visibility
    const deckMat = new THREE.MeshBasicMaterial({ color: 0x8a9099, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: true });
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), deckMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 2900;
    deck.visible = false;
    return { group, clouds, mats, deck };
  };

  /* ---------------------------------------------------------------- ocean */
  GFX.createOcean = function (depthTexture, worldHalf) {
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunInt: { value: 1 },
        uDeep: { value: new THREE.Color() },
        uShallow: { value: new THREE.Color() },
        uFoam: { value: new THREE.Color() },
        uDepth: { value: null },
        uWorldHalf: { value: worldHalf }
      }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform float uTime, uSunInt, uWorldHalf;
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor, uDeep, uShallow, uFoam;
        uniform sampler2D uDepth;
        varying vec3 vWorld;
        ${SKY_FN}
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        vec2 wave(vec2 p, vec2 dir, float len, float amp, float speed) {
          float k = 6.28318 / len;
          return dir * (amp * k * cos(dot(dir, p) * k + uTime * speed));
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vWorld.xz;
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 v = toCam / dist;

          vec2 g = vec2(0.0);
          g += wave(p, normalize(vec2(1.0, 0.35)), 95.0, 0.55, 0.9);
          g += wave(p, normalize(vec2(-0.6, 1.0)), 57.0, 0.32, 1.1);
          g += wave(p, normalize(vec2(0.3, -1.0)), 23.0, 0.14, 1.6);
          g += wave(p, normalize(vec2(-1.0, -0.2)), 9.0, 0.05, 2.3);
          float e = 0.6;
          vec2 q = p * 0.35 + vec2(uTime * 0.25, uTime * 0.17);
          g += 0.35 * vec2(vnoise(q + vec2(e, 0.0)) - vnoise(q - vec2(e, 0.0)), vnoise(q + vec2(0.0, e)) - vnoise(q - vec2(0.0, e)));
          float flatten = 1.0 / (1.0 + dist * 0.0022);
          vec3 n = normalize(vec3(-g.x * flatten, 1.0, -g.y * flatten));

          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          vec3 r = reflect(-v, n);
          r.y = abs(r.y);
          vec3 refl = skyColor(r, uZenith, uHorizon);

          vec2 uv = p / (2.0 * uWorldHalf) + 0.5;
          float depth = texture2D(uDepth, clamp(uv, 0.0, 1.0)).r;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) depth = 1.0;
          vec3 body = mix(uShallow, uDeep, smoothstep(0.02, 0.75, depth));
          vec3 col = mix(body, refl, fres);

          float spec = pow(max(dot(r, uSunDir), 0.0), 320.0) + 0.25 * pow(max(dot(r, uSunDir), 0.0), 40.0);
          col += uSunColor * spec * uSunInt * 1.6;

          float surf = vnoise(p * 0.22 + vec2(uTime * 0.6, 0.0)) * 0.6 + vnoise(p * 0.9 - vec2(0.0, uTime * 0.8)) * 0.4;
          float foam = smoothstep(0.11, 0.0, depth) * smoothstep(0.35, 0.7, surf + (0.11 - depth) * 3.0);
          col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.85);

          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
      fog: true
    });
    mat.uniforms.uDepth.value = depthTexture;
    const geo = new THREE.PlaneGeometry(160000, 160000);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  };

  /* ----------------------------------------------------------------- rain */
  GFX.createRain = function (count) {
    const rnd = GFX.rng(99);
    const pos = new Float32Array(count * 6);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) seeds[i] = rnd();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xaab8c8, transparent: true, opacity: 0.26, depthWrite: false, fog: false
    }));
    lines.frustumCulled = false;
    lines.visible = false;
    let fall = 0;
    // Rain is anchored to the air mass: streaks fall with the wind inside a box that follows the camera,
    // so flying through it produces the motion naturally.
    lines.userData.update = function (camPos, wind, dt) {
      fall += dt;
      const box = 70;
      const vx = wind.x, vy = -11, vz = wind.z;
      const len = 0.07;
      const wrap = (v) => ((v % box) + box) % box - box / 2;
      for (let i = 0; i < count; i++) {
        const x = wrap(seeds[i * 3] * box + vx * fall - camPos.x);
        const y = wrap(seeds[i * 3 + 1] * box + vy * fall - camPos.y);
        const z = wrap(seeds[i * 3 + 2] * box + vz * fall - camPos.z);
        const o = i * 6;
        pos[o] = camPos.x + x; pos[o + 1] = camPos.y + y; pos[o + 2] = camPos.z + z;
        pos[o + 3] = camPos.x + x - vx * len; pos[o + 4] = camPos.y + y - vy * len; pos[o + 5] = camPos.z + z - vz * len;
      }
      geo.attributes.position.needsUpdate = true;
    };
    return lines;
  };
})();
