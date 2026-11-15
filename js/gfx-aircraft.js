/* SKYFORGE graphics: procedural aircraft models with painted liveries.
 * Built in metres around the centre of gravity (+X right, +Y up, -Z forward).
 * Visual only; ground-contact geometry lives in the simulator's catalogue. */
(function () {
  'use strict';

  const GFX = (window.GFX = window.GFX || {});

  /* ------------------------------------------------------------ primitives */
  // Half of a tapered, swept lifting surface along +X. Root leading edge at the origin, chord toward +Z.
  function surfaceGeometry(o) {
    const M = 9; // points per side of the aerofoil
    const ring = [];
    for (let i = 0; i <= M; i++) ring.push([i / M, 1]);
    for (let i = M - 1; i >= 1; i--) ring.push([i / M, -1]);
    const n = ring.length;
    const pos = [];
    const sections = [
      { x: 0, chord: o.rootChord, le: 0, y: 0 },
      { x: o.span, chord: o.tipChord, le: o.sweep, y: o.rise || 0 }
    ];
    for (const s of sections) {
      for (const [c, side] of ring) {
        const t = 5 * o.thick * (0.2969 * Math.sqrt(c) - 0.126 * c - 0.3516 * c * c + 0.2843 * c * c * c - 0.1015 * c * c * c * c);
        pos.push(s.x, s.y + side * t * s.chord, s.le + c * s.chord);
      }
    }
    const idx = [];
    for (let j = 0; j < n; j++) {
      const a = j, b = (j + 1) % n, c = n + j, d = n + ((j + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
    for (let j = 1; j < n - 1; j++) idx.push(n, n + j + 1, n + j); // tip cap
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    if (o.mirror) g.scale(-1, 1, 1);
    g.computeVertexNormals();
    return g;
  }

  // Body of revolution along Z from zNose to zTail; profile(t) -> [radiusFraction, yOffset].
  function fuselageGeometry(zNose, zTail, rx, ry, profile) {
    const N = 56;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push(new THREE.Vector2(Math.max(0.002, profile(t)[0]) * rx, zNose + (zTail - zNose) * t));
    }
    const g = new THREE.LatheGeometry(pts, 28);
    g.rotateX(Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (p.getZ(i) - zNose) / (zTail - zNose);
      p.setY(i, p.getY(i) * (ry / rx) + profile(THREE.MathUtils.clamp(t, 0, 1))[1]);
    }
    g.computeVertexNormals();
    return g;
  }

  // Livery painter: u runs around the fuselage (0 belly, .25 right, .5 top, .75 left), t nose -> tail.
  function livery(draw) {
    const W = 512, H = 1024;
    const c = GFX.canvas(W, H);
    const g = c.getContext('2d');
    const api = {
      g,
      band(u0, u1, t0, t1, color) {
        g.fillStyle = color;
        g.fillRect(u0 * W, (1 - t1) * H, (u1 - u0) * W, (t1 - t0) * H);
      },
      both(u0, u1, t0, t1, color) { // mirrored on the left and right sides
        api.band(u0, u1, t0, t1, color);
        api.band(1 - u1, 1 - u0, t0, t1, color);
      },
      pane(uc, tc, du, dt, color) {
        g.fillStyle = color;
        const x = (uc - du / 2) * W, y = (1 - tc - dt / 2) * H, w = du * W, h = dt * H, r = Math.min(w, h) * 0.3;
        g.beginPath();
        g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
        g.fill();
      }
    };
    draw(api, GFX.rng(31));
    return GFX.canvasTexture(c, { anisotropy: 8 });
  }

  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const GLASS = '#0d1a26';

  /* --------------------------------------------------------------- builder */
  GFX.buildAircraft = function (spec, key) {
    const [sx, sy, sz] = spec.scale;
    const R = 0.65 * sx;
    const Ry = 0.65 * sy;
    const zNose = -6.4 * sz;
    const zTail = 4.3 * sz;
    const half = spec.wingSpan / 2;
    const group = new THREE.Group();
    const out = { group, flaps: [], strobes: [], paints: [] };
    const add = (m, parent) => { m.castShadow = true; (parent || group).add(m); return m; };

    const paint = (map, extra) => {
      const m = new THREE.MeshStandardMaterial(Object.assign({ map, roughness: 0.38, metalness: 0.25, side: THREE.DoubleSide,
        emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0 }, extra));
      out.paints.push(m);
      return m;
    };
    const solid = (color, extra) => {
      const m = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.4, metalness: 0.25, side: THREE.DoubleSide,
        emissive: color, emissiveIntensity: 0 }, extra));
      out.paints.push(m);
      return m;
    };
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.75, metalness: 0.2 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xa9afb6, roughness: 0.35, metalness: 0.85 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2c3a, roughness: 0.06, metalness: 0.9, transparent: true, opacity: 0.78 });

    /* ---- per-type shapes ------------------------------------------------ */
    let profile, bodyTex, wing, hstab, vstab, allMovingTail = false;
    const accent = hex(spec.accent);
    const base = hex(spec.color);

    if (key === 'skyhawk') {
      profile = (t) => {
        let r;
        if (t < 0.06) r = 0.55 + 0.35 * Math.sqrt(t / 0.06);
        else if (t < 0.22) r = 0.90 + 0.10 * ((t - 0.06) / 0.16);
        else if (t < 0.48) r = 1.0;
        else r = 1.0 - 0.80 * Math.pow((t - 0.48) / 0.52, 0.85);
        return [r, t > 0.48 ? 0.22 * Ry * ((t - 0.48) / 0.52) : 0];
      };
      bodyTex = livery((L) => {
        L.band(0, 1, 0, 1, base);
        L.band(0, 0.10, 0, 1, '#d5d9dd'); L.band(0.90, 1, 0, 1, '#d5d9dd');
        L.both(0.215, 0.262, 0.03, 0.97, accent);
        L.both(0.272, 0.282, 0.03, 0.97, '#c8102e');
        L.band(0, 1, 0, 0.035, accent);
        L.band(0.36, 0.64, 0.225, 0.305, GLASS);          // windshield
        L.pane(0.335, 0.265, 0.045, 0.07, GLASS); L.pane(0.665, 0.265, 0.045, 0.07, GLASS);
        L.pane(0.325, 0.355, 0.075, 0.085, GLASS); L.pane(0.675, 0.355, 0.075, 0.085, GLASS);
        L.pane(0.325, 0.445, 0.065, 0.065, GLASS); L.pane(0.675, 0.445, 0.065, 0.065, GLASS);
        L.band(0.40, 0.60, 0.47, 0.50, GLASS);            // rear window
      });
      wing = { rootChord: 1.63, tipChord: 1.25, sweep: 0.12, thick: 0.13, y: spec.wingY + 0.12 };
      hstab = { span: 1.75, rootChord: 1.15, tipChord: 0.75, sweep: 0.25, thick: 0.09, y: 0.25 * sy };
      vstab = { span: 1.55, rootChord: 1.55, tipChord: 0.75, sweep: 0.95, thick: 0.08 };
    } else if (key === 'viper') {
      profile = (t) => {
        let r;
        if (t < 0.30) r = Math.pow(t / 0.30, 0.72);
        else if (t < 0.88) r = 1.0;
        else r = 1.0 - 0.22 * ((t - 0.88) / 0.12);
        return [r, t < 0.30 ? -0.18 * Ry * (1 - t / 0.30) : 0];
      };
      bodyTex = livery((L, rnd) => {
        L.band(0, 1, 0, 1, base);
        L.band(0.30, 0.70, 0, 1, '#5d6975');
        for (let i = 0; i < 26; i++) {
          L.g.fillStyle = rnd() > 0.5 ? 'rgba(60,70,82,0.5)' : 'rgba(140,150,160,0.35)';
          L.g.beginPath();
          L.g.ellipse(rnd() * 512, rnd() * 1024, 30 + rnd() * 60, 40 + rnd() * 90, rnd() * 3, 0, 7);
          L.g.fill();
        }
        L.band(0, 1, 0, 0.13, '#3b434c');                 // radome
        L.band(0, 1, 0.955, 1, '#2a2d31');                // nozzle shroud
        L.both(0.20, 0.30, 0.52, 0.56, 'rgba(20,24,28,0.55)');
      });
      wing = { rootChord: 5.0, tipChord: 1.1, sweep: half * Math.tan(0.70), thick: 0.045, y: spec.wingY };
      hstab = { span: 2.75, rootChord: 2.7, tipChord: 0.95, sweep: 1.75, thick: 0.045, y: -0.05 };
      vstab = { span: 3.1, rootChord: 3.3, tipChord: 1.15, sweep: 2.25, thick: 0.05 };
      allMovingTail = true;
    } else {
      profile = (t) => {
        let r;
        if (t < 0.085) r = Math.pow(t / 0.085, 0.55);
        else if (t < 0.70) r = 1.0;
        else r = 1.0 - 0.86 * Math.pow((t - 0.70) / 0.30, 1.15);
        let y = 0;
        if (t < 0.085) y = -0.22 * Ry * (1 - t / 0.085);
        if (t > 0.70) y = 0.55 * Ry * Math.pow((t - 0.70) / 0.30, 1.2);
        return [r, y];
      };
      bodyTex = livery((L) => {
        L.band(0, 1, 0, 1, base);
        L.band(0, 0.135, 0, 1, '#aeb4ba'); L.band(0.865, 1, 0, 1, '#aeb4ba');
        L.both(0.135, 0.165, 0.02, 0.98, '#12356e');
        L.both(0.165, 0.178, 0.02, 0.98, accent);
        L.band(0, 1, 0.80, 1.0, '#12356e');
        L.both(0.178, 0.5, 0.74, 0.80, '#12356e');
        L.g.fillStyle = accent;
        L.g.fillRect(0, (1 - 0.80) * 1024 - 5, 512, 5);
        for (let t = 0.115; t < 0.73; t += 0.0072) {      // main-deck windows
          L.pane(0.292, t, 0.012, 0.0036, GLASS); L.pane(0.708, t, 0.012, 0.0036, GLASS);
        }
        for (let t = 0.075; t < 0.27; t += 0.0072) {      // upper-deck windows
          L.pane(0.385, t, 0.011, 0.0034, GLASS); L.pane(0.615, t, 0.011, 0.0034, GLASS);
        }
        L.band(0.415, 0.585, 0.040, 0.058, GLASS);        // flight deck
        L.pane(0.385, 0.052, 0.035, 0.016, GLASS); L.pane(0.615, 0.052, 0.035, 0.016, GLASS);
      });
      wing = { rootChord: 14.5, tipChord: 3.6, sweep: half * Math.tan(0.66), thick: 0.11, y: spec.wingY };
      hstab = { span: 11.2, rootChord: 7.6, tipChord: 2.5, sweep: 8.0, thick: 0.09, y: 0.25 * sy, rise: 1.2 };
      vstab = { span: 11.0, rootChord: 11.5, tipChord: 4.2, sweep: 9.0, thick: 0.09 };
    }

    /* ---- fuselage --------------------------------------------------------- */
    const bodyMat = paint(bodyTex);
    add(new THREE.Mesh(fuselageGeometry(zNose, zTail, R, Ry, profile), bodyMat));
    const wingMat = solid(key === 'viper' ? 0x6c7783 : spec.color);
    const trimMat = solid(spec.accent);

    /* ---- wings, flaps and ailerons ------------------------------------------ */
    const rise = half * Math.tan(spec.dihedral);
    const leRootZ = spec.wingZ - 0.35 * wing.rootChord;
    const teSweep = wing.sweep + wing.tipChord - wing.rootChord;        // trailing-edge offset at the tip
    const teAngle = Math.atan2(teSweep, half);
    const chordAt = (f) => wing.rootChord + (wing.tipChord - wing.rootChord) * f;
    const teZ = (f) => leRootZ + wing.sweep * f + chordAt(f);
    const panel = (side, f0, f1, depthFrac, mat) => {
      const fm = (f0 + f1) / 2;
      const depth = chordAt(fm) * depthFrac;
      const len = (f1 - f0) * half / Math.cos(teAngle);
      const pivot = new THREE.Group();
      pivot.position.set(side * fm * half, wing.y + rise * fm, teZ(fm) - depth);
      pivot.rotation.set(0, -side * teAngle, side * Math.atan2(rise, half));
      const g = new THREE.BoxGeometry(len, Math.max(0.035, chordAt(fm) * wing.thick * 0.42), depth);
      g.translate(0, 0, depth / 2);
      const hinge = new THREE.Group();
      hinge.add(new THREE.Mesh(g, mat));
      hinge.children[0].castShadow = true;
      pivot.add(hinge);
      group.add(pivot);
      return hinge;
    };
    for (const side of [-1, 1]) {
      const w = add(new THREE.Mesh(surfaceGeometry({ span: half, rootChord: wing.rootChord, tipChord: wing.tipChord,
        sweep: wing.sweep, rise, thick: wing.thick, mirror: side < 0 }), wingMat));
      w.position.set(0, wing.y, leRootZ);
      const ail = panel(side, 0.58, 0.94, 0.24, trimMat);
      if (side < 0) out.leftAileron = ail; else out.rightAileron = ail;
      out.flaps.push(panel(side, key === 'viper' ? 0.22 : 0.16, 0.56, 0.26, wingMat));
    }

    /* ---- tail --------------------------------------------------------------- */
    const hRootZ = zTail - hstab.rootChord - 0.12 * sz;
    const elevator = new THREE.Group();
    if (allMovingTail) {
      elevator.position.set(0, hstab.y, hRootZ + hstab.rootChord * 0.45);
      for (const side of [-1, 1]) {
        const s = new THREE.Mesh(surfaceGeometry(Object.assign({ mirror: side < 0 }, hstab)), wingMat);
        s.position.set(side * R * 0.5, 0, -hstab.rootChord * 0.45);
        s.rotation.z = -side * 0.14;
        s.castShadow = true;
        elevator.add(s);
      }
    } else {
      for (const side of [-1, 1]) {
        const s = add(new THREE.Mesh(surfaceGeometry(Object.assign({ mirror: side < 0 }, hstab)), wingMat));
        s.position.set(0, hstab.y, hRootZ);
      }
      const eDepth = hstab.tipChord * 0.55;
      elevator.position.set(0, hstab.y + (hstab.rise || 0) * 0.5, hRootZ + hstab.sweep * 0.5 + (hstab.rootChord + hstab.tipChord) / 2 - eDepth);
      const eg = new THREE.BoxGeometry(hstab.span * 1.75, Math.max(0.04, hstab.rootChord * hstab.thick * 0.4), eDepth);
      eg.translate(0, 0, eDepth / 2);
      const em = new THREE.Mesh(eg, trimMat);
      em.castShadow = true;
      elevator.add(em);
    }
    group.add(elevator);
    out.elevator = elevator;

    const vRootZ = zTail - vstab.rootChord - 0.05 * sz;
    const finY = Ry * profile(0.88)[0] * 0.6 + profile(0.88)[1];
    const fin = add(new THREE.Mesh(surfaceGeometry(vstab), key === 'heavy' ? solid(0x12356e) : trimMat));
    fin.rotation.z = Math.PI / 2;
    fin.position.set(0, finY, vRootZ);
    const rDepth = vstab.tipChord * 0.5;
    const rudder = new THREE.Group();
    rudder.position.set(0, finY + vstab.span * 0.5, vRootZ + vstab.sweep * 0.5 + (vstab.rootChord + vstab.tipChord) / 2 - rDepth);
    const rg = new THREE.BoxGeometry(Math.max(0.05, vstab.rootChord * vstab.thick * 0.4), vstab.span * 0.78, rDepth);
    rg.translate(0, 0, rDepth / 2);
    const rm = new THREE.Mesh(rg, key === 'heavy' ? trimMat : wingMat);
    rm.castShadow = true;
    rudder.add(rm);
    rudder.rotation.x = -Math.atan2(vstab.sweep + vstab.tipChord - vstab.rootChord, vstab.span);
    const rudderPivot = new THREE.Group();
    rudderPivot.add(rudder);
    group.add(rudderPivot);
    // The simulator animates rotation.y on the inner hinge
    const rudderHinge = new THREE.Group();
    rudderHinge.position.copy(rudder.position);
    rudder.position.set(0, 0, 0);
    rudderPivot.remove(rudder);
    rudderHinge.add(rudder);
    group.add(rudderHinge);
    group.remove(rudderPivot);
    out.rudder = rudderHinge;

    /* ---- type-specific details ---------------------------------------------- */
    out.prop = null;
    out.propDisc = null;
    out.abMesh = null;
    if (key === 'skyhawk') {
      // Wing struts
      for (const side of [-1, 1]) {
        const a = new THREE.Vector3(side * R * 0.85, -Ry * 0.75, spec.wingZ - 0.1);
        const b = new THREE.Vector3(side * half * 0.42, wing.y + rise * 0.42 - 0.05, spec.wingZ + 0.05);
        const strut = add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, a.distanceTo(b), 6), metal));
        strut.position.copy(a).add(b).multiplyScalar(0.5);
        strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      }
      // Propeller: spinner, two blades and a motion-blur disc
      const hub = new THREE.Group();
      hub.position.set(0, 0, zNose - 0.12);
      const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 14), metal);
      spinner.rotation.x = -Math.PI / 2;
      spinner.position.z = -0.1;
      hub.add(spinner);
      const blades = new THREE.Group();
      for (let i = 0; i < 2; i++) {
        const bg = new THREE.BoxGeometry(0.15, spec.propRadius, 0.035);
        bg.translate(0, spec.propRadius / 2, 0);
        const blade = new THREE.Mesh(bg, dark);
        blade.rotation.set(0, 0.35, i * Math.PI);
        blade.castShadow = true;
        blades.add(blade);
      }
      hub.add(blades);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(spec.propRadius, 32),
        new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      disc.position.z = 0.01;
      hub.add(disc);
      group.add(hub);
      out.prop = blades;
      out.propDisc = disc;
    } else if (key === 'viper') {
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), glass);
      canopy.scale.set(R * 0.62, Ry * 0.72, 2.3);
      canopy.position.set(0, Ry * 0.62, zNose + (zTail - zNose) * 0.335);
      group.add(canopy);
      const intake = add(new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.7, 5.2, 16), wingMat));
      intake.rotation.x = Math.PI / 2;
      intake.scale.set(1, 1, 0.62);
      intake.position.set(0, -Ry * 0.82, zNose + (zTail - zNose) * 0.50);
      const lip = new THREE.Mesh(new THREE.CircleGeometry(R * 0.55, 16), new THREE.MeshBasicMaterial({ color: 0x050607 }));
      lip.scale.y = 0.62;
      lip.position.set(0, -Ry * 0.82, intake.position.z - 2.62);
      lip.rotation.y = Math.PI;
      group.add(lip);
      const nozzle = add(new THREE.Mesh(new THREE.CylinderGeometry(R * 0.80, R * 0.62, 1.1, 18, 1, true), dark));
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(0, 0, zTail + 0.45);
      const abGeo = new THREE.ConeGeometry(R * 0.58, 6.0, 14, 1, true);
      abGeo.rotateX(Math.PI / 2);
      abGeo.translate(0, 0, 3.0);
      const ab = new THREE.Mesh(abGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(6.0, 2.2, 0.6), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ab.position.set(0, 0, zTail + 0.7);
      group.add(ab);
      out.abMesh = ab;
    } else {
      // Upper-deck hump
      const hump = add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), paint(bodyTex, { map: null, emissiveMap: null, color: spec.color, emissive: spec.color })));
      hump.scale.set(R * 0.74, Ry * 0.55, 13.5);
      hump.position.set(0, Ry * 0.66, zNose + 14.5);
      // Engine nacelles on pylons
      for (const f of [-0.63, -0.37, 0.37, 0.63]) {
        const x = f * half;
        const af = Math.abs(f);
        const y = wing.y + rise * af - 2.35;
        const z = leRootZ + wing.sweep * af - 2.2;
        const nac = add(new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.2, 6.2, 20), wingMat));
        nac.rotation.x = Math.PI / 2;
        nac.position.set(x, y, z);
        const cowl = add(new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.16, 8, 22), metal));
        cowl.position.set(x, y, z - 3.1);
        const fan = new THREE.Mesh(new THREE.CircleGeometry(1.38, 20), new THREE.MeshBasicMaterial({ color: 0x08090b }));
        fan.rotation.y = Math.PI;
        fan.position.set(x, y, z - 3.05);
        group.add(fan);
        const pylon = add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.5, 5.0), wingMat));
        pylon.position.set(x, y + 1.6, z + 1.6);
      }
      // Winglets
      for (const side of [-1, 1]) {
        const wl = add(new THREE.Mesh(surfaceGeometry({ span: 2.6, rootChord: wing.tipChord, tipChord: 1.2, sweep: 2.4, thick: 0.08 }), trimMat));
        wl.rotation.z = side > 0 ? Math.PI / 2 - 0.25 : Math.PI / 2 + 0.25;
        wl.position.set(side * half, wing.y + rise, leRootZ + wing.sweep);
      }
    }

    /* ---- landing gear (wheel bottoms at y = -gearHeight) --------------------- */
    const gear = new THREE.Group();
    const wr = spec.wheelRadius;
    const tyreGeo = new THREE.CylinderGeometry(wr, wr, wr * 0.62, 18);
    tyreGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(wr * 0.5, wr * 0.5, wr * 0.66, 12);
    hubGeo.rotateZ(Math.PI / 2);
    const leg = (x, z, wheels) => {
      const g = new THREE.Group();
      const top = -Ry * 0.4;
      const len = spec.gearHeight - wr + top;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(wr * 0.2, wr * 0.26, len, 8), metal);
      strut.position.y = top - len / 2;
      strut.castShadow = true;
      g.add(strut);
      for (const [wx, wz] of wheels) {
        const tyre = new THREE.Mesh(tyreGeo, dark);
        tyre.position.set(wx, -spec.gearHeight + wr, wz);
        tyre.castShadow = true;
        const hubM = new THREE.Mesh(hubGeo, metal);
        hubM.position.copy(tyre.position);
        g.add(tyre, hubM);
      }
      g.position.set(x, 0, z);
      gear.add(g);
    };
    const pair = [[-wr * 0.55, 0], [wr * 0.55, 0]];
    const bogie = [[-wr * 0.75, -wr * 1.15], [wr * 0.75, -wr * 1.15], [-wr * 0.75, wr * 1.15], [wr * 0.75, wr * 1.15]];
    const single = [[0, 0]];
    leg(0, spec.noseGearZ, key === 'skyhawk' ? single : pair);
    leg(-spec.trackWidth / 2, spec.mainGearZ, key === 'heavy' ? bogie : single);
    leg(spec.trackWidth / 2, spec.mainGearZ, key === 'heavy' ? bogie : single);
    if (key === 'heavy') {
      leg(-spec.trackWidth / 2 + 3.2, spec.mainGearZ + 3.2, bogie);
      leg(spec.trackWidth / 2 - 3.2, spec.mainGearZ + 3.2, bogie);
    }
    group.add(gear);
    out.gear = gear;

    /* ---- lights ---------------------------------------------------------------- */
    const glow = GFX.glowTexture();
    const lamp = (x, y, z, color, size) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false }));
      s.position.set(x, y, z);
      s.scale.setScalar(size);
      group.add(s);
      return s;
    };
    const tipY = wing.y + rise;
    const tipZ = leRootZ + wing.sweep + wing.tipChord * 0.4;
    const ls = Math.max(0.7, spec.wingSpan * 0.035);
    out.navLights = [
      lamp(-half, tipY, tipZ, new THREE.Color(3.0, 0.15, 0.15), ls),
      lamp(half, tipY, tipZ, new THREE.Color(0.15, 3.0, 0.4), ls),
      lamp(0, finY * 0.4, zTail, new THREE.Color(2.2, 2.2, 2.2), ls * 0.8)
    ];
    out.strobes = [
      lamp(-half, tipY, tipZ + 0.2, new THREE.Color(4, 4, 4), ls * 1.3),
      lamp(half, tipY, tipZ + 0.2, new THREE.Color(4, 4, 4), ls * 1.3)
    ];
    out.beacon = lamp(0, finY + vstab.span + 0.1, vRootZ + vstab.sweep + vstab.tipChord * 0.5, new THREE.Color(4, 0.2, 0.2), ls * 1.2);
    out.landingLight = lamp(0, -spec.gearHeight * 0.45, spec.noseGearZ - 0.3, new THREE.Color(4, 3.8, 3.3), ls * 0.9);

    out.setNight = function (n) {
      for (const m of out.paints) m.emissiveIntensity = 0.035 * n;
    };
    return out;
  };
})();
