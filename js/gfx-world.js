/* SKYFORGE graphics: terrain shading, forests and the airport.
 * Visual only. Collision boxes and paved areas are returned to the simulator as plain data. */
(function () {
  'use strict';

  const GFX = (window.GFX = window.GFX || {});

  /* -------------------------------------------------------------- terrain */
  // Standard PBR material whose albedo is computed per pixel from height, slope and noise.
  GFX.terrainMaterial = function () {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.0 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTPos = position;\nvTNormal = normal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vTPos;
          varying vec3 vTNormal;
          vec3 tBump;
          float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float tNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
          }
          float tFbm(vec2 p) {
            float a = 0.5, s = 0.0;
            for (int i = 0; i < 4; i++) { s += a * tNoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
            return s;
          }`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
          vec2 tp = vTPos.xz;
          float th = vTPos.y;
          vec3 tN = normalize(vTNormal);
          float slope = 1.0 - tN.y;
          float dist = length(cameraPosition - vTPos);
          float nearK = 1.0 / (1.0 + dist * 0.0025);
          float n1 = tFbm(tp * 0.0011);
          float n2 = tFbm(tp * 0.012);
          float n3 = tFbm(tp * 0.16);
          float n4 = tNoise(tp * 1.3);
          float detail = mix(1.0, 0.72 + 0.4 * n3 + 0.16 * n4, nearK);

          vec3 grass = mix(vec3(0.050, 0.120, 0.022), vec3(0.120, 0.190, 0.040), n1);
          grass = mix(grass, vec3(0.200, 0.190, 0.070), smoothstep(0.52, 0.80, n2) * 0.55);
          grass = mix(grass, vec3(0.030, 0.075, 0.018), smoothstep(0.50, 0.30, n2) * smoothstep(0.35, 0.6, n1) * 0.7);
          vec3 rock = mix(vec3(0.105, 0.098, 0.090), vec3(0.230, 0.210, 0.185), n2);
          rock *= 0.8 + 0.4 * tNoise(vec2(th * 0.09 + n2 * 4.0, tp.x * 0.004)); // strata
          vec3 snow = vec3(0.80, 0.84, 0.92) * (0.86 + 0.14 * n2);
          vec3 sand = mix(vec3(0.56, 0.47, 0.29), vec3(0.42, 0.36, 0.24), n2);

          float rockW = smoothstep(0.10, 0.30, slope + max(th - 150.0, 0.0) / 1100.0 + (n2 - 0.5) * 0.14);
          float snowLine = 455.0 + (n1 - 0.5) * 170.0;
          float snowW = smoothstep(snowLine, snowLine + 70.0, th + (n3 - 0.5) * 40.0) * (1.0 - smoothstep(0.40, 0.72, slope));
          float sandW = 1.0 - smoothstep(1.2, 5.5, th + (n2 - 0.5) * 3.0);

          vec3 tc = mix(grass, rock, rockW) * detail;
          tc = mix(tc, snow * (0.92 + 0.08 * n3), snowW);
          tc = mix(tc, sand * detail, sandW);
          tc = mix(tc, vec3(0.03, 0.07, 0.07), smoothstep(-0.2, -6.0, th));

          // Mown airfield grass around the runway
          float field = (1.0 - smoothstep(380.0, 520.0, abs(tp.x))) * (1.0 - smoothstep(1900.0, 2150.0, abs(tp.y)));
          vec3 mown = vec3(0.095, 0.175, 0.040) * (0.90 + 0.10 * step(0.5, fract(tp.x / 14.0))) * mix(1.0, 0.85 + 0.3 * n3, nearK);
          tc = mix(tc, mown, field);

          float e = 0.7;
          vec2 bq = tp * 0.55;
          tBump = vec3(tNoise(bq + vec2(e, 0.0)) - tNoise(bq - vec2(e, 0.0)), 0.0, tNoise(bq + vec2(0.0, e)) - tNoise(bq - vec2(0.0, e)))
                  * nearK * (0.5 + 1.2 * rockW) * (1.0 - field);
          vec4 diffuseColor = vec4(tc, opacity);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = normalize(normal - (viewMatrix * vec4(tBump, 0.0)).xyz * 0.9);`);
    };
    return mat;
  };

  /* --------------------------------------------------------------- forest */
  // getHeight(x, z) is the simulator's terrain sampler; forestNoise(x, z) returns -1..1.
  GFX.createTrees = function (maxCount, getHeight, forestNoise) {
    const rnd = GFX.rng(2024);
    const tier1 = new THREE.ConeGeometry(1.0, 1.5, 6, 1, true);
    tier1.translate(0, 1.05, 0);
    const tier2 = new THREE.ConeGeometry(0.72, 1.3, 6, 1, true);
    tier2.translate(0, 1.85, 0);
    const trunk = new THREE.CylinderGeometry(0.11, 0.14, 0.5, 5, 1, true);
    trunk.translate(0, 0.25, 0);
    const paint = (g, fn) => {
      const p = g.attributes.position;
      const c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const col = fn(p.getY(i));
        c[i * 3] = col[0]; c[i * 3 + 1] = col[1]; c[i * 3 + 2] = col[2];
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    };
    const shade = (y) => { const k = 0.55 + 0.45 * THREE.MathUtils.clamp((y - 0.3) / 2.2, 0, 1); return [k, k, k]; };
    paint(tier1, shade);
    paint(tier2, shade);
    paint(trunk, () => [0.75, 0.5, 0.3]);
    const geo = THREE.mergeGeometries([tier1, tier2, trunk]);

    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), maxCount);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let placed = 0;
    let guard = 0;
    while (placed < maxCount && guard < maxCount * 40) {
      guard++;
      // Denser near the airport, thinning out toward the edge of the island
      const r = 600 + Math.pow(rnd(), 0.8) * 11000;
      const a = rnd() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 1.15;
      if (Math.abs(x) < 1050 && Math.abs(z) < 3300) continue;          // airfield
      if (Math.abs(x) < 330 && Math.abs(z) < 6200) continue;           // approach / departure corridors
      const f = forestNoise(x, z);
      if (f < 0.02 + rnd() * 0.35) continue;
      const h = getHeight(x, z);
      if (h < 4 || h > 300) continue;
      const slope = Math.abs(getHeight(x + 8, z) - h) + Math.abs(getHeight(x, z + 8) - h);
      if (slope > 5.5) continue;
      const s = 4.5 + rnd() * 4.5;
      pos.set(x, h - 0.3, z);
      q.setFromAxisAngle(up, rnd() * 6.283);
      scl.set(s * (0.8 + rnd() * 0.4), s * (0.85 + rnd() * 0.5), s * (0.8 + rnd() * 0.4));
      mesh.setMatrixAt(placed, m.compose(pos, q, scl));
      col.setRGB(0.05 + rnd() * 0.05, 0.13 + rnd() * 0.10, 0.03 + rnd() * 0.04);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    mesh.userData.placed = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  };

  /* ------------------------------------------------------- airport canvas */
  function asphaltCanvas(w, h, base, seed) {
    const rnd = GFX.rng(seed);
    const c = GFX.canvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < (w * h) / 28; i++) {
      const v = rnd();
      g.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.02 + rnd() * 0.05})` : `rgba(0,0,0,${0.04 + rnd() * 0.10})`;
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    return { c, g, rnd };
  }

  function runwayTexture(halfW, halfL, aimZ, names) {
    const W = 256, H = 8192;
    const { c, g, rnd } = asphaltCanvas(W, H, '#3b3d41', 11);
    const sx = W / (halfW * 2), sy = H / (halfL * 2);
    const X = (xm) => (xm + halfW) * sx;
    const Y = (zm) => (zm + halfL) * sy;
    const rect = (xm, zm, wm, lm) => g.fillRect(X(xm - wm / 2), Y(zm - lm / 2), wm * sx, lm * sy);

    // Resurfacing patches and expansion joints
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${0.025 + rnd() * 0.04})`;
      rect((rnd() - 0.5) * halfW * 1.6, (rnd() - 0.5) * halfL * 2, 6 + rnd() * 20, 20 + rnd() * 120);
    }
    g.fillStyle = 'rgba(0,0,0,0.16)';
    for (let z = -halfL; z < halfL; z += 37.5) rect(0, z, halfW * 2, 0.22);

    const white = 'rgba(236,236,230,0.94)';
    g.fillStyle = white;
    rect(-halfW + 1.6, 0, 0.9, halfL * 2 - 8);
    rect(halfW - 1.6, 0, 0.9, halfL * 2 - 8);
    for (let z = -halfL + 130; z <= halfL - 130; z += 50) rect(0, z, 0.9, 30);
    for (const end of [-1, 1]) {
      const zEdge = end * halfL;
      for (let i = 0; i < 12; i++) {                                   // piano keys
        const x = (i < 6 ? -1 : 1) * (3.2 + (i % 6) * 3.6);
        rect(x, zEdge - end * 24, 1.8, 30);
      }
      for (const k of [1, 2, 4, 5]) {                                  // touchdown-zone bars
        if (150 * k > halfL * 0.75 || Math.abs(halfL - 150 * k - aimZ) < 60) continue;
        const z = zEdge - end * (150 * k);
        const n = k <= 2 ? 3 : 2;
        for (let j = 0; j < n; j++) for (const s of [-1, 1]) rect(s * (9 + j * 2.6), z, 1.7, 22.5);
      }
      const zAim = end * aimZ;                                          // aiming point
      rect(-10.5, zAim, 8, 50);
      rect(10.5, zAim, 8, 50);
    }
    // Designators: "36" for the northbound landing direction (south end), "18" opposite
    g.font = `bold ${Math.round(24 * sy)}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = (txt, zm, flip) => {
      g.save();
      g.translate(X(0), Y(zm));
      g.scale(sx / sy * 1.05, 1);
      if (flip) g.rotate(Math.PI);
      g.fillText(txt, 0, 0);
      g.restore();
    };
    label(names[0], halfL - 62, false);
    label(names[1], -halfL + 62, true);

    // Tyre rubber in the touchdown zones
    for (const end of [-1, 1]) {
      for (let i = 0; i < 520; i++) {
        const x = (rnd() > 0.5 ? 1 : -1) * (2.4 + Math.abs(rnd() + rnd() - 1) * 6);
        const z = end * (halfL - 180 - Math.pow(rnd(), 1.6) * 620);
        g.fillStyle = `rgba(8,8,10,${0.05 + rnd() * 0.10})`;
        rect(x, z, 0.35 + rnd() * 0.5, 25 + rnd() * 90);
      }
    }
    const t = GFX.canvasTexture(c, { anisotropy: 16 });
    return t;
  }

  function taxiTexture() {
    const { c } = asphaltCanvas(256, 256, '#33363b', 23);
    const t = GFX.canvasTexture(c, { repeat: true, anisotropy: 8 });
    return t;
  }

  function claddingTexture(base, stripe) {
    const c = GFX.canvas(64, 64);
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = stripe;
    for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 2, 64);
    return GFX.canvasTexture(c, { repeat: true });
  }

  function windowTexture(lit) {
    const rnd = GFX.rng(5);
    const c = GFX.canvas(256, 64);
    const g = c.getContext('2d');
    g.fillStyle = lit ? '#000000' : '#c9cdd2';
    g.fillRect(0, 0, 256, 64);
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 16; i++) {
        const on = rnd() > 0.3;
        g.fillStyle = lit ? (on ? '#ffd9a0' : '#20160c') : '#22303c';
        g.fillRect(4 + i * 16, 8 + row * 30, 11, 16);
      }
    }
    return GFX.canvasTexture(c);
  }

  /* -------------------------------------------------------------- airport */
  GFX.buildAirport = function (cfg) {
    const E = cfg.elevation, halfW = cfg.halfWidth, halfL = cfg.halfLength, aimZ = cfg.aimZ;
    const group = new THREE.Group();
    const obstacles = [];
    const paved = [];   // axis-aligned rectangles { x0, x1, z0, z1 } with hard-surface friction
    const nightMats = [];

    // Runway
    const rwyGeo = new THREE.PlaneGeometry(halfW * 2, halfL * 2);
    rwyGeo.rotateX(-Math.PI / 2);
    const grain = taxiTexture();
    grain.colorSpace = THREE.NoColorSpace;
    grain.repeat.set(Math.round(halfW / 3), Math.round(halfL / 3));
    const runwayMat = new THREE.MeshStandardMaterial({ map: runwayTexture(halfW, halfL, aimZ, cfg.designators || ['36', '18']), roughness: 0.92, metalness: 0.0,
      aoMap: grain, aoMapIntensity: 0.9 });
    const rwy = new THREE.Mesh(rwyGeo, runwayMat);
    rwy.position.y = E + 0.05;
    rwy.receiveShadow = true;
    group.add(rwy);
    paved.push({ x0: -halfW, x1: halfW, z0: -halfL, z1: halfL });

    const taxiX = 78;
    if (!cfg.bare) {
    // Taxiways and apron
    const taxiTex = taxiTexture();
    const slabMat = new THREE.MeshStandardMaterial({ map: taxiTex, roughness: 0.95 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd9b400 });
    const slab = (x0, x1, z0, z1) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(-Math.PI / 2);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) / 24, uv.getY(i) * (z1 - z0) / 24);
      const m = new THREE.Mesh(g, slabMat);
      m.position.set((x0 + x1) / 2, E + 0.04, (z0 + z1) / 2);
      m.receiveShadow = true;
      group.add(m);
      paved.push({ x0, x1, z0, z1 });
    };
    const stripe = (x0, x1, z0, z1) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, lineMat);
      m.position.set((x0 + x1) / 2, E + 0.075, (z0 + z1) / 2);
      group.add(m);
    };
    slab(taxiX - 9, taxiX + 9, -halfL + 40, halfL - 40);
    stripe(taxiX - 0.15, taxiX + 0.15, -halfL + 40, halfL - 40);
    for (const z of [-halfL + 60, -600, 0, 600, halfL - 60]) {
      slab(halfW, taxiX - 9, z - 11, z + 11);
      stripe(halfW + 2, taxiX, z - 0.15, z + 0.15);
    }
    slab(taxiX + 9, 116, -290, 300);

    }

    // Lights: runway edge, thresholds, approach bars, taxiway edge
    const glow = GFX.glowTexture();
    const lp = [];
    const lc = [];
    const addLight = (x, z, r, g, b, y) => { lp.push(x, E + (y || 0.5), z); lc.push(r, g, b); };
    for (let z = -halfL; z <= halfL; z += 60) {
      const amber = Math.abs(z) > halfL - 600;
      addLight(-halfW - 1.5, z, 2.2, amber ? 1.5 : 2.0, amber ? 0.4 : 1.6);
      addLight(halfW + 1.5, z, 2.2, amber ? 1.5 : 2.0, amber ? 0.4 : 1.6);
    }
    for (let z = -halfL + 30; z <= halfL - 30; z += 30) addLight(0, z, 1.6, 1.6, 1.5, 0.12);
    for (let x = -halfW; x <= halfW; x += 3.4) {
      addLight(x, halfL + 2, 0.15, 2.4, 0.4);
      addLight(x, -halfL - 2, 2.4, 0.15, 0.1);
    }
    for (let z = halfL + 60; z <= halfL + 900; z += 60) {
      for (let x = -6; x <= 6; x += 3) addLight(x, z, 2.4, 2.4, 2.4, 1.5 + (z - halfL) * 0.012);
    }
    for (let x = -21; x <= 21; x += 3) addLight(x, halfL + 300, 2.4, 2.4, 2.4, 5);
    if (!cfg.bare) for (let z = -halfL + 40; z <= halfL - 40; z += 45) {
      addLight(taxiX - 9.5, z, 0.15, 0.4, 2.4, 0.35);
      addLight(taxiX + 9.5, z, 0.15, 0.4, 2.4, 0.35);
    }
    const lightGeo = new THREE.BufferGeometry();
    lightGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lightGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    const runwayLights = new THREE.Points(lightGeo, new THREE.PointsMaterial({
      size: 7, sizeAttenuation: false, vertexColors: true, map: glow, fog: false, transparent: true,
      opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    group.add(runwayLights);

    const papiGeo = new THREE.BufferGeometry();
    const pp = [];
    for (let i = 0; i < 4; i++) pp.push(-halfW - 15 - i * 9, E + 1.2, aimZ);
    papiGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    papiGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(12).fill(1), 3));
    const papiLights = new THREE.Points(papiGeo, new THREE.PointsMaterial({
      size: 11, sizeAttenuation: false, vertexColors: true, map: glow, fog: false, transparent: true,
      opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    group.add(papiLights);

    // Windsock (local +X points downwind)
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.5, metalness: 0.6 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 9, 8), metal);
    pole.position.set(-48, E + 4.5, aimZ + 120);
    pole.castShadow = true;
    group.add(pole);
    const sockC = GFX.canvas(64, 16);
    const sg = sockC.getContext('2d');
    for (let i = 0; i < 5; i++) { sg.fillStyle = i % 2 ? '#f4f4f4' : '#ff5a10'; sg.fillRect(i * 13, 0, 13, 16); }
    const sockTex = GFX.canvasTexture(sockC);
    sockTex.center.set(0.5, 0.5);
    sockTex.rotation = Math.PI / 2;
    const sockGeo = new THREE.CylinderGeometry(0.28, 0.8, 4.4, 12, 1, true);
    sockGeo.rotateZ(Math.PI / 2);
    sockGeo.translate(2.2, 0, 0);
    const windsock = new THREE.Mesh(sockGeo, new THREE.MeshStandardMaterial({ map: sockTex, side: THREE.DoubleSide, roughness: 0.9 }));
    windsock.position.set(-48, E + 8.8, aimZ + 120);
    windsock.castShadow = true;
    group.add(windsock);

    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
    let towerCam = new THREE.Vector3(-halfW - 110, E + 22, halfL * 0.35);
    if (!cfg.bare) {
    // Buildings (collision boxes match the visible volumes)
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb4b6b3, roughness: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1c3a4a, roughness: 0.12, metalness: 0.7, emissive: 0xffd28a, emissiveIntensity: 0 });
    nightMats.push({ mat: glassMat, max: 1.6 });
    const addBox = (x, z, w, h, d) => obstacles.push({ x, z, halfW: w / 2, halfD: d / 2, top: E + h });
    const shadow = (m) => { m.castShadow = true; m.receiveShadow = true; group.add(m); return m; };

    // Control tower
    const tx = 135, tz = -180;
    shadow(new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.6, 44, 12), concrete)).position.set(tx, E + 22, tz);
    shadow(new THREE.Mesh(new THREE.CylinderGeometry(8.6, 6.6, 3, 12), concrete)).position.set(tx, E + 45, tz);
    shadow(new THREE.Mesh(new THREE.CylinderGeometry(9.0, 7.6, 6, 12), glassMat)).position.set(tx, E + 49.5, tz);
    shadow(new THREE.Mesh(new THREE.CylinderGeometry(9.6, 9.6, 0.9, 12), concrete)).position.set(tx, E + 53, tz);
    shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 6), metal)).position.set(tx, E + 56.4, tz);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), beaconMat);
    beacon.position.set(tx, E + 59.5, tz);
    group.add(beacon);
    addBox(tx, tz, 18, 56, 18);

    // Hangars with barrel roofs
    const hangar = (x, z, base, stripeCol) => {
      const tex = claddingTexture(base, stripeCol);
      tex.repeat.set(10, 2);
      const wall = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.35 });
      shadow(new THREE.Mesh(new THREE.BoxGeometry(48, 11, 65), wall)).position.set(x, E + 5.5, z);
      const roofGeo = new THREE.CylinderGeometry(24, 24, 65, 20, 1, false, -Math.PI / 2, Math.PI);
      roofGeo.rotateX(Math.PI / 2);
      roofGeo.scale(1, 0.29, 1);
      const roofTex = claddingTexture('#8d949b', '#737a82');
      roofTex.repeat.set(12, 1);
      shadow(new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide }))).position.set(x, E + 11, z);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(50, 9.5), new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6, metalness: 0.4 }));
      door.rotation.y = -Math.PI / 2;
      door.position.set(x - 24.06, E + 4.75, z);
      group.add(door);
      addBox(x, z, 48, 18, 65);
    };
    hangar(140, 120, '#5c6bc0', '#4a58a8');
    hangar(140, 240, '#55656e', '#44525a');

    // Terminal
    const litTex = windowTexture(true);
    const dayTex = windowTexture(false);
    for (const t of [litTex, dayTex]) { t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1); }
    const termMat = new THREE.MeshStandardMaterial({ map: dayTex, emissiveMap: litTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6 });
    nightMats.push({ mat: termMat, max: 1.3 });
    shadow(new THREE.Mesh(new THREE.BoxGeometry(26, 9, 84), termMat)).position.set(140, E + 4.5, -50);
    shadow(new THREE.Mesh(new THREE.BoxGeometry(29, 0.8, 87), concrete)).position.set(140, E + 9.4, -50);
    addBox(140, -50, 26, 10, 84);

    towerCam = new THREE.Vector3(tx - 12, E + 50, tz);
    }

    return {
      group, obstacles, paved, runwayLights, papiLights, windsock, runwayMat, beaconMat,
      towerCamPos: towerCam,
      setNight(n) { for (const m of nightMats) m.mat.emissiveIntensity = m.max * n; }
    };
  };
})();
