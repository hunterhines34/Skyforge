/* SKYFORGE real-Earth world: streams elevation, satellite imagery and OpenStreetMap
 * buildings around the aircraft and exposes a synchronous height query for the physics.
 *
 * Data (all free, keyless, fetched at runtime with attribution shown on screen):
 *   elevation  Mapzen "Terrarium" tiles on AWS Open Data (s3.amazonaws.com/elevation-tiles-prod)
 *   imagery    Esri World Imagery, or EOX Sentinel-2 cloudless
 *   vectors    OpenFreeMap (OpenStreetMap contributors): buildings and water
 *
 * Local frame: flat tangent plane centred on the active runway, rotated so the runway
 * heading is -Z (the simulator's "north"). +X is right of the runway, +Y is metres MSL. */
(function () {
  'use strict';

  const GFX = (window.GFX = window.GFX || {});
  const R_EARTH = 6378137;
  const D2R = Math.PI / 180;
  const ELEV_HI = 13;       // ~15-19 m per sample: used near the aircraft and by the physics
  const ELEV_LO = 9;        // coarse backdrop for distant terrain
  const ROOT_Z = 7;
  const GRID = 16;          // quads per render-tile side
  const VEC_Z = 14;         // OpenFreeMap's deepest zoom

  const IMAGERY = {
    esri: {
      label: 'Esri World Imagery',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      maxZoom: 17,
      credit: 'Imagery © Esri, Maxar, Earthstar Geographics'
    },
    s2: {
      label: 'Sentinel-2 cloudless (EOX)',
      url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2016_3857/default/g/${z}/${y}/${x}.jpg`,
      maxZoom: 14,
      credit: 'Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2016), CC BY 4.0'
    }
  };
  GFX.IMAGERY = IMAGERY;

  const mercX = (lon) => (lon + 180) / 360;
  const mercY = (lat) => { const r = lat * D2R; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
  const invMercY = (my) => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / D2R;
  const tkey = (x, y) => x * 4194304 + y;

  /* ------------------------------------------------------- vector tiles (MVT) */
  function readMVT(buf, wanted) {
    const b = new Uint8Array(buf);
    let p = 0;
    const varint = () => { let r = 0, s = 1, c; do { c = b[p++]; r += (c & 127) * s; s *= 128; } while (c & 128); return r; };
    const skip = (wt) => { if (wt === 0) varint(); else if (wt === 2) p += varint(); else if (wt === 5) p += 4; else if (wt === 1) p += 8; };
    const td = new TextDecoder();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = {};
    while (p < b.length) {
      const tag = varint();
      if ((tag >> 3) !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
      const end = varint() + p;
      let name = '', extent = 4096;
      const keys = [], values = [], feats = [];
      while (p < end) {
        const t = varint(), f = t >> 3, wt = t & 7;
        if (f === 1) { const l = varint(); name = td.decode(b.subarray(p, p + l)); p += l; }
        else if (f === 3) { const l = varint(); keys.push(td.decode(b.subarray(p, p + l))); p += l; }
        else if (f === 5) extent = varint();
        else if (f === 4) {
          const vend = varint() + p;
          let v = null;
          while (p < vend) {
            const vt = varint(), vf = vt >> 3;
            if (vf === 1) { const l = varint(); v = td.decode(b.subarray(p, p + l)); p += l; }
            else if (vf === 2) { v = dv.getFloat32(p, true); p += 4; }
            else if (vf === 3) { v = dv.getFloat64(p, true); p += 8; }
            else if (vf === 6) { const n = varint(); v = (n % 2) ? -(n + 1) / 2 : n / 2; }
            else if (vf === 7) v = varint() !== 0;
            else v = varint();
          }
          values.push(v);
        } else if (f === 2) { const l = varint(); feats.push([p, p + l]); p += l; }
        else skip(wt);
      }
      p = end;
      if (!wanted.includes(name)) continue;
      const layer = (out[name] = { extent, features: [] });
      for (const [fs, fe] of feats) {
        let q = fs, type = 0, tags = null, geom = null;
        const save = p;
        p = q;
        while (p < fe) {
          const t = varint(), f = t >> 3;
          if (f === 3) type = varint();
          else if (f === 2) { const e = varint() + p; tags = []; while (p < e) tags.push(varint()); }
          else if (f === 4) { const e = varint() + p; geom = []; while (p < e) geom.push(varint()); }
          else skip(t & 7);
        }
        p = save;
        if (type !== 3 || !geom) continue;
        const props = {};
        if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
        // Decode rings
        const rings = [];
        let x = 0, y = 0, ring = null, i = 0;
        while (i < geom.length) {
          const cmd = geom[i] & 7, n = geom[i] >> 3;
          i++;
          if (cmd === 1 || cmd === 2) {
            for (let k = 0; k < n; k++) {
              const dx = geom[i++], dy = geom[i++];
              x += (dx >> 1) ^ -(dx & 1);
              y += (dy >> 1) ^ -(dy & 1);
              if (cmd === 1) { ring = []; rings.push(ring); }
              ring.push(x, y);
            }
          }
        }
        layer.features.push({ props, rings });
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- the world */
  class EarthWorld {
    constructor(opts) {
      this.scene = opts.scene;
      this.lat0 = opts.lat;
      this.lon0 = opts.lon;
      this.cosLat0 = Math.cos(opts.lat * D2R);
      const psi = opts.headingDeg * D2R;
      this.cosH = Math.cos(psi);
      this.sinH = Math.sin(psi);
      this.baseElev = opts.baseElev || 0;
      this.imagery = IMAGERY[opts.imagery] || IMAGERY.esri;
      this.setQuality(opts.quality || 'high');
      this.maxAniso = opts.maxAnisotropy || 8;

      this.elev = { [ELEV_HI]: new Map(), [ELEV_LO]: new Map() };
      this.elevLast = { [ELEV_HI]: null, [ELEV_LO]: null };
      this.elevCanvas = document.createElement('canvas');
      this.elevCanvas.width = this.elevCanvas.height = 256;
      this.elevCtx = this.elevCanvas.getContext('2d', { willReadFrequently: true });

      this.strips = [];             // flattened runway corridors
      this.tiles = new Map();       // render tiles by "z/x/y"
      this.shown = new Set();
      this.buildQueue = [];
      this.loadQueue = [];
      this.inFlight = 0;
      this.maxInFlight = 10;
      this.time = 0;
      this.lastSelect = -1;
      this.lastPrune = 0;
      this.failures = 0;
      this.loads = 0;
      this.group = new THREE.Group();
      this.scene.add(this.group);
      this.material = this.makeTerrainMaterial();

      // Vector data (buildings + water)
      this.vecTemplate = null;
      this.vecTiles = new Map();
      this.vecJobs = [];
      this.cells = new Map();       // spatial hash of building footprints and water polygons (64 m cells)
      this.buildingMats = this.makeBuildingMaterials();
      this.night = 0;
      fetch('https://tiles.openfreemap.org/planet').then((r) => r.json()).then((j) => { this.vecTemplate = j.tiles[0]; }).catch(() => {});
    }

    setQuality(level) {
      const q = { low: { k: 0.95, dz: 2, bld: 1500, bcap: 2500 }, medium: { k: 0.62, dz: 1, bld: 2600, bcap: 6000 }, high: { k: 0.46, dz: 0, bld: 4200, bcap: 12000 } }[level];
      this.splitK = q.k;
      this.maxZoom = Math.max(11, this.imagery.maxZoom - q.dz);
      this.buildingRange = q.bld;
      this.buildingCap = q.bcap;
    }

    credits() {
      return `${this.imagery.credit} · Terrain: Mapzen / AWS Terrain Tiles · © OpenStreetMap contributors, OpenFreeMap`;
    }

    /* ---- projection ------------------------------------------------------- */
    toLocal(lat, lon, out) {
      const e = R_EARTH * this.cosLat0 * (lon - this.lon0) * D2R;
      const n = R_EARTH * (lat - this.lat0) * D2R;
      out.x = e * this.cosH - n * this.sinH;
      out.z = -(e * this.sinH + n * this.cosH);
      return out;
    }

    toGeo(x, z) {
      const e = x * this.cosH - z * this.sinH;
      const n = -x * this.sinH - z * this.cosH;
      return { lat: this.lat0 + n / R_EARTH / D2R, lon: this.lon0 + e / (R_EARTH * this.cosLat0) / D2R };
    }

    /* ---- elevation ---------------------------------------------------------- */
    requestElev(z, x, y) {
      const n = 1 << z;
      x = ((x % n) + n) % n;
      if (y < 0 || y >= n) return;
      const map = this.elev[z];
      const key = tkey(x, y);
      if (map.has(key)) return;
      map.set(key, null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.elevCtx.drawImage(img, 0, 0);
        const px = this.elevCtx.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        map.set(key, { x, y, h });
        this.loads++;
        if (z === ELEV_HI) this.onHiElev(x, y);
      };
      img.onerror = () => { this.failures++; map.delete(key); };
      img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    }

    texel(z, px, py) {
      const tx = px >> 8, ty = py >> 8;
      let t = this.elevLast[z];
      if (!t || t.x !== tx || t.y !== ty) {
        t = this.elev[z].get(tkey(tx, ty));
        if (!t) return NaN;
        this.elevLast[z] = t;
      }
      return t.h[((py & 255) << 8) | (px & 255)];
    }

    sampleZoom(z, mx, my) {
      const s = (1 << z) * 256;
      const gx = mx * s - 0.5, gy = my * s - 0.5;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = gx - x0, fy = gy - y0;
      const a = this.texel(z, x0, y0), b = this.texel(z, x0 + 1, y0);
      const c = this.texel(z, x0, y0 + 1), d = this.texel(z, x0 + 1, y0 + 1);
      const v = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      return v; // NaN when any of the four samples is not loaded
    }

    // Raw terrain elevation (m MSL) before runway grading; null if nothing is loaded there yet.
    rawHeight(x, z) {
      const e = x * this.cosH - z * this.sinH;
      const n = -x * this.sinH - z * this.cosH;
      const mx = mercX(this.lon0 + e / (R_EARTH * this.cosLat0) / D2R);
      const my = mercY(this.lat0 + n / R_EARTH / D2R);
      let v = this.sampleZoom(ELEV_HI, mx, my);
      if (v !== v) v = this.sampleZoom(ELEV_LO, mx, my);
      return v !== v ? null : v;
    }

    hasHiElev(x, z) {
      const g = this.toGeo(x, z);
      const v = this.sampleZoom(ELEV_HI, mercX(g.lon), mercY(g.lat));
      return v === v;
    }

    // Terrain surface used by BOTH the renderer and the physics.
    heightAt(x, z) {
      let h = this.rawHeight(x, z);
      if (h === null) h = this.baseElev;
      for (let i = 0; i < this.strips.length; i++) {
        const s = this.strips[i];
        const dx = x - s.cx, dz = z - s.cz;
        if (dx * dx + dz * dz > s.reach2) continue;
        const along = Math.abs(dx * s.ux + dz * s.uz) - s.halfL - 120;
        const across = Math.abs(dx * s.uz - dz * s.ux) - s.halfW - 110;
        const d = Math.hypot(Math.max(0, along), Math.max(0, across));
        if (d >= 260) continue;
        const t = d / 260;
        const w = 1 - t * t * (3 - 2 * t);
        h += (s.elev - h) * w;
      }
      return h;
    }

    // Grade a runway (and its surroundings) to a level plane. Coordinates in the local frame.
    addStrip(ax, az, bx, bz, width, elev) {
      const len = Math.hypot(bx - ax, bz - az);
      const s = { cx: (ax + bx) / 2, cz: (az + bz) / 2, ux: (bx - ax) / len, uz: (bz - az) / len, halfL: len / 2, halfW: width / 2, elev };
      s.reach2 = Math.pow(s.halfL + 500, 2);
      this.strips.push(s);
      return s;
    }

    onHiElev(tx, ty) {
      // Finer elevation arrived: rebuild the render tiles that sit on it
      const n = 1 << ELEV_HI;
      for (const t of this.tiles.values()) {
        if (!t.mesh || t.z < 11) continue;
        const sc = n / (1 << t.z);
        const cx = (t.x + 0.5) * sc, cy = (t.y + 0.5) * sc;
        if (cx >= tx - 0.5 && cx <= tx + 1.5 && cy >= ty - 0.5 && cy <= ty + 1.5 && !t.queued) { t.queued = true; this.buildQueue.push(t); }
      }
    }

    ensureElevation(x, z) {
      const g = this.toGeo(x, z);
      const mx = mercX(g.lon), my = mercY(g.lat);
      const lo = 1 << ELEV_LO, hi = 1 << ELEV_HI;
      const lx = Math.floor(mx * lo), ly = Math.floor(my * lo);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.requestElev(ELEV_LO, lx + dx, ly + dy);
      const hx = Math.floor(mx * hi), hy = Math.floor(my * hi);
      for (let r = 0; r <= 3; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) this.requestElev(ELEV_HI, hx + dx, hy + dy);
        }
      }
      // Bound memory: forget fine tiles far from the aircraft
      const map = this.elev[ELEV_HI];
      if (map.size > 110) {
        for (const [k, t] of map) {
          if (t && (Math.abs(t.x - hx) > 5 || Math.abs(t.y - hy) > 5)) map.delete(k);
        }
        this.elevLast[ELEV_HI] = null;
      }
    }

    // True once the terrain under (x, z) is available at full resolution.
    readyAt(x, z) {
      for (const [dx, dz] of [[0, 0], [1800, 0], [-1800, 0], [0, 1800], [0, -1800], [0, -5000], [0, 5000]]) {
        if (!this.hasHiElev(x + dx, z + dz)) return false;
      }
      return true;
    }

    /* ---- terrain render tiles -------------------------------------------------- */
    makeTerrainMaterial() {
      const mat = new THREE.MeshStandardMaterial({ color: 0xc4c4c4, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.6 });
      mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vEPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEPos = (modelMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
            varying vec3 vEPos;
            float eHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float eNoise(vec2 p) {
              vec2 i = floor(p), f = fract(p);
              vec2 u = f * f * (3.0 - 2.0 * f);
              return mix(mix(eHash(i), eHash(i + vec2(1, 0)), u.x), mix(eHash(i + vec2(0, 1)), eHash(i + vec2(1, 1)), u.x), u.y);
            }`)
          .replace('#include <map_fragment>', `#include <map_fragment>
            // Photo imagery goes soft close to the ground: add fine grain that fades with distance
            float eDist = length(cameraPosition - vEPos);
            float eNear = 1.0 / (1.0 + eDist * 0.006);
            float eGrain = eNoise(vEPos.xz * 0.9) * 0.5 + eNoise(vEPos.xz * 0.21) * 0.3 + eNoise(vEPos.xz * 3.7) * 0.2;
            diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * eGrain, eNear);`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            // Satellite photos already contain their own shading: light the relief only gently
            normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.62));`);
      };
      mat.customProgramCacheKey = () => 'skyforge-earth-terrain';
      return mat;
    }

    getTile(z, x, y, parent) {
      const id = `${z}/${x}/${y}`;
      let t = this.tiles.get(id);
      if (t) return t;
      const n = 1 << z;
      const lat = invMercY((y + 0.5) / n), lon = ((x + 0.5) / n) * 360 - 180;
      const c = this.toLocal(lat, lon, { x: 0, z: 0 });
      const width = (40075016.7 / n) * Math.cos(lat * D2R);
      t = { id, z, x, y, parent, children: null, cx: c.x, cz: c.z, cy: this.heightAt(c.x, c.z), width, mesh: null, tex: null,
            ready: false, requested: false, queued: false, wanted: 0 };
      this.tiles.set(id, t);
      return t;
    }

    requestTile(t) {
      if (t.requested) return;
      t.requested = true;
      this.loadQueue.push(t);
    }

    pumpLoads(cam) {
      if (!this.loadQueue.length || this.inFlight >= this.maxInFlight) return;
      // Nearest first
      this.loadQueue.sort((a, b) => (Math.hypot(b.cx - cam.x, b.cz - cam.z) - b.width) - (Math.hypot(a.cx - cam.x, a.cz - cam.z) - a.width));
      while (this.loadQueue.length && this.inFlight < this.maxInFlight) {
        const t = this.loadQueue.pop();
        if (t.dead) continue;
        this.inFlight++;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          this.inFlight--;
          this.loads++;
          if (t.dead) return;
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.maxAniso;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.needsUpdate = true;
          t.tex = tex;
          if (!t.queued) { t.queued = true; this.buildQueue.push(t); }
        };
        img.onerror = () => { this.inFlight--; this.failures++; t.requested = false; t.failedAt = this.time; };
        img.src = this.imagery.url(t.z, t.x, t.y);
      }
    }

    buildTileMesh(t) {
      const n = 1 << t.z;
      const N = GRID, S = N + 3;
      const px = new Float32Array(S * S), py = new Float32Array(S * S), pz = new Float32Array(S * S);
      const tmp = { x: 0, z: 0 };
      for (let j = -1; j <= N + 1; j++) {
        const lat = invMercY((t.y + j / N) / n);
        for (let i = -1; i <= N + 1; i++) {
          const lon = ((t.x + i / N) / n) * 360 - 180;
          this.toLocal(lat, lon, tmp);
          const k = (j + 1) * S + (i + 1);
          px[k] = tmp.x; pz[k] = tmp.z; py[k] = this.heightAt(tmp.x, tmp.z);
        }
      }
      const cy = py[(N / 2 + 1) * S + N / 2 + 1];
      const V = (N + 1) * (N + 1);
      const ring = 4 * (N + 1);
      const pos = new Float32Array((V + ring) * 3), nor = new Float32Array((V + ring) * 3), uv = new Float32Array((V + ring) * 2);
      let o = 0;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const k = (j + 1) * S + (i + 1);
          pos[o * 3] = px[k] - t.cx; pos[o * 3 + 1] = py[k] - cy; pos[o * 3 + 2] = pz[k] - t.cz;
          // normal = (south - north) x (east - west)
          const ax = px[k + S] - px[k - S], ay = py[k + S] - py[k - S], az = pz[k + S] - pz[k - S];
          const bx = px[k + 1] - px[k - 1], by = py[k + 1] - py[k - 1], bz = pz[k + 1] - pz[k - 1];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const l = Math.hypot(nx, ny, nz) || 1;
          nor[o * 3] = nx / l; nor[o * 3 + 1] = ny / l; nor[o * 3 + 2] = nz / l;
          uv[o * 2] = i / N; uv[o * 2 + 1] = 1 - j / N;
          o++;
        }
      }
      const idx = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + N + 1, c = a + 1, d = b + 1;
        idx.push(a, b, c, c, b, d);
      }
      // Skirts hide cracks between neighbouring levels of detail
      const drop = t.width * 0.07 + 2;
      const edge = [];
      for (let i = 0; i <= N; i++) edge.push(i);                                 // north
      for (let j = 0; j <= N; j++) edge.push(j * (N + 1) + N);                   // east
      for (let i = N; i >= 0; i--) edge.push(N * (N + 1) + i);                   // south
      for (let j = N; j >= 0; j--) edge.push(j * (N + 1));                       // west
      for (let e = 0; e < edge.length; e++) {
        const s = edge[e];
        pos[o * 3] = pos[s * 3]; pos[o * 3 + 1] = pos[s * 3 + 1] - drop; pos[o * 3 + 2] = pos[s * 3 + 2];
        nor[o * 3] = nor[s * 3]; nor[o * 3 + 1] = nor[s * 3 + 1]; nor[o * 3 + 2] = nor[s * 3 + 2];
        uv[o * 2] = uv[s * 2]; uv[o * 2 + 1] = uv[s * 2 + 1];
        if (e > 0 && edge[e - 1] !== s) idx.push(edge[e - 1], o - 1, s, s, o - 1, o);
        o++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      if (t.mesh) {
        t.mesh.geometry.dispose();
        t.mesh.geometry = g;
      } else {
        const m = this.material.clone();
        m.onBeforeCompile = this.material.onBeforeCompile;
        m.customProgramCacheKey = this.material.customProgramCacheKey;
        m.map = t.tex;
        t.mesh = new THREE.Mesh(g, m);
        t.mesh.receiveShadow = true;
        t.mesh.visible = false;
        this.group.add(t.mesh);
      }
      t.mesh.position.set(t.cx, cy, t.cz);
      t.cy = cy;
      t.ready = true;
    }

    disposeTile(t) {
      if (t.children) { t.children.forEach((c) => this.disposeTile(c)); t.children = null; }
      t.dead = true;
      if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.dispose(); }
      if (t.tex) t.tex.dispose();
      this.shown.delete(t);
      this.tiles.delete(t.id);
    }

    visit(t, cam, next) {
      t.wanted = this.time;
      this.requestTile(t);
      if (t.z < this.maxZoom) {
        const d = Math.max(1, Math.hypot(t.cx - cam.x, t.cy - cam.y, t.cz - cam.z) - t.width * 0.75);
        if (t.width / d > this.splitK) {
          if (!t.children) {
            t.children = [0, 1, 2, 3].map((i) => this.getTile(t.z + 1, t.x * 2 + (i & 1), t.y * 2 + (i >> 1), t));
          }
          let all = true;
          for (const c of t.children) { c.wanted = this.time; this.requestTile(c); if (!c.ready) all = false; }
          if (all) { for (const c of t.children) this.visit(c, cam, next); return; }
        }
      }
      if (t.ready) next.add(t);
    }

    /* ---- buildings and water (OpenStreetMap via OpenFreeMap) ---------------------- */
    makeBuildingMaterials() {
      const c = GFX.canvas(128, 128), e = GFX.canvas(128, 128);
      const g = c.getContext('2d'), ge = e.getContext('2d');
      const rnd = GFX.rng(808);
      g.fillStyle = '#e2ddd3'; g.fillRect(0, 0, 128, 128);
      ge.fillStyle = '#000'; ge.fillRect(0, 0, 128, 128);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        g.fillStyle = `rgb(${70 + rnd() * 30},${78 + rnd() * 30},${86 + rnd() * 30})`;
        g.fillRect(x * 32 + 9, y * 32 + 7, 14, 15);
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x * 32, y * 32 + 29, 32, 3);
        if (rnd() > 0.55) { ge.fillStyle = rnd() > 0.3 ? '#ffd9a0' : '#cfe4ff'; ge.fillRect(x * 32 + 9, y * 32 + 7, 14, 15); }
      }
      const map = GFX.canvasTexture(c, { repeat: true });
      const em = GFX.canvasTexture(e, { repeat: true });
      return {
        wall: new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true, roughness: 0.9, envMapIntensity: 0.35 }),
        roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, envMapIntensity: 0.35 })
      };
    }

    setNight(n) {
      this.night = n;
      this.buildingMats.wall.emissiveIntensity = 1.5 * n;
    }

    loadVectorTile(x, y) {
      const id = tkey(x, y);
      if (this.vecTiles.has(id) || !this.vecTemplate) return;
      const rec = { x, y, meshes: [], cellKeys: [], state: 'loading' };
      this.vecTiles.set(id, rec);
      const url = this.vecTemplate.replace('{z}', VEC_Z).replace('{x}', x).replace('{y}', y);
      fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
        if (!buf || rec.state === 'dead') { rec.state = 'empty'; return; }
        rec.data = readMVT(buf, ['building', 'water']);
        rec.state = 'parsed';
        this.vecJobs.push(this.vectorJob(rec));
      }).catch(() => { rec.state = 'empty'; });
    }

    addToCells(rec, item) {
      const x0 = Math.floor(item.minx / 64), x1 = Math.floor(item.maxx / 64);
      const z0 = Math.floor(item.minz / 64), z1 = Math.floor(item.maxz / 64);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) return;
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100003 + cz;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
        rec.cellKeys.push(k);
      }
      item.rec = rec;
    }

    query(x, z, water) {
      const list = this.cells.get(Math.floor(x / 64) * 100003 + Math.floor(z / 64));
      if (!list) return null;
      for (const it of list) {
        if (it.water !== water || x < it.minx || x > it.maxx || z < it.minz || z > it.maxz) continue;
        const p = it.poly;
        let inside = false;
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          if ((p[i + 1] > z) !== (p[j + 1] > z) && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
        }
        if (inside) return it;
      }
      return null;
    }

    // Height (m MSL) of the roof of the building covering (x, z), or -Infinity.
    buildingTop(x, z) { const b = this.query(x, z, false); return b ? b.top : -Infinity; }
    isWater(x, z) { return !!this.query(x, z, true); }

    // Generator: turns one parsed vector tile into meshes, yielding so frames stay smooth.
    *vectorJob(rec) {
      const n = 1 << VEC_Z;
      const layers = rec.data;
      rec.data = null;
      const tmp = { x: 0, z: 0 };
      const project = (ring, extent) => {
        const out = new Float32Array(ring.length);
        for (let i = 0; i < ring.length; i += 2) {
          const lon = ((rec.x + ring[i] / extent) / n) * 360 - 180;
          const lat = invMercY((rec.y + ring[i + 1] / extent) / n);
          this.toLocal(lat, lon, tmp);
          out[i] = tmp.x; out[i + 1] = tmp.z;
        }
        return out;
      };
      const bounds = (poly, item) => {
        item.minx = item.minz = Infinity; item.maxx = item.maxz = -Infinity;
        for (let i = 0; i < poly.length; i += 2) {
          item.minx = Math.min(item.minx, poly[i]); item.maxx = Math.max(item.maxx, poly[i]);
          item.minz = Math.min(item.minz, poly[i + 1]); item.maxz = Math.max(item.maxz, poly[i + 1]);
        }
        return item;
      };
      const area = (p) => { let a = 0; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1]; return a / 2; };

      if (layers.water) {
        for (const f of layers.water.features) {
          for (const ring of f.rings) {
            if (ring.length < 8) continue;
            const poly = project(ring, layers.water.extent);
            if (Math.abs(area(poly)) < 4000) continue;
            this.addToCells(rec, bounds(poly, { water: true, poly }));
          }
        }
        yield;
      }
      if (!layers.building) { rec.state = 'done'; return; }

      const wp = [], wn = [], wu = [], wc = [], rp = [], rn = [], rc = [];
      const rnd = GFX.rng(rec.x * 7919 + rec.y);
      const col = new THREE.Color();
      let count = 0;
      const feats = layers.building.features;
      for (let fi = 0; fi < feats.length && count < this.buildingCap; fi++) {
        const f = feats[fi];
        const hTag = Number(f.props.render_height);
        const hMin = Number(f.props.render_min_height) || 0;
        for (const ring of f.rings) {
          if (ring.length < 8) continue;
          let poly = project(ring, layers.building.extent);
          // drop the closing duplicate
          const L = poly.length;
          if (Math.abs(poly[0] - poly[L - 2]) < 0.01 && Math.abs(poly[1] - poly[L - 1]) < 0.01) poly = poly.subarray(0, L - 2);
          const a = area(poly);
          if (Math.abs(a) < 30 || poly.length < 6) continue;      // holes are rare for footprints: every ring is a solid
          if (a < 0) {                                          // enforce one winding so wall normals point outward
            const rev = new Float32Array(poly.length);
            for (let i = 0; i < poly.length; i += 2) { rev[i] = poly[poly.length - 2 - i]; rev[i + 1] = poly[poly.length - 1 - i]; }
            poly = rev;
          }
          let base = Infinity, cxm = 0, czm = 0;
          for (let i = 0; i < poly.length; i += 2) { base = Math.min(base, this.heightAt(poly[i], poly[i + 1])); cxm += poly[i]; czm += poly[i + 1]; }
          const height = (hTag > 0 ? hTag : 5 + rnd() * 5) ;
          const y0 = base - 1.5 + hMin, y1 = base + Math.max(height, hMin + 2.5);
          const tone = 0.42 + rnd() * 0.30;
          col.setRGB(tone * (1.0 + rnd() * 0.10), tone * (0.95 + rnd() * 0.06), tone * (0.86 + rnd() * 0.08));
          const roofTone = 0.16 + rnd() * 0.22;
          const warm = rnd() < 0.3 ? 1.35 : 1.0;
          // walls
          let run = rnd() * 4;
          const m = poly.length / 2;
          for (let i = 0; i < m; i++) {
            const x0 = poly[i * 2], z0 = poly[i * 2 + 1], x1 = poly[((i + 1) % m) * 2], z1 = poly[((i + 1) % m) * 2 + 1];
            const len = Math.hypot(x1 - x0, z1 - z0);
            if (len < 0.05) continue;
            const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
            const u0 = run / 3.4, u1 = (run + len) / 3.4, v1 = (y1 - y0) / 3.2;
            run += len;
            wp.push(x0, y0, z0, x1, y1, z1, x1, y0, z1, x0, y0, z0, x0, y1, z0, x1, y1, z1);
            wu.push(u0, 0, u1, v1, u1, 0, u0, 0, u0, v1, u1, v1);
            for (let k = 0; k < 6; k++) { wn.push(nx, 0, nz); wc.push(col.r, col.g, col.b); }
          }
          // roof
          const contour = [];
          for (let i = 0; i < m; i++) contour.push(new THREE.Vector2(poly[i * 2], poly[i * 2 + 1]));
          const tris = THREE.ShapeUtils.triangulateShape(contour, []);
          for (const tr of tris) {
            const ax = poly[tr[0] * 2], az = poly[tr[0] * 2 + 1];
            const up = (poly[tr[1] * 2 + 1] - az) * (poly[tr[2] * 2] - ax) - (poly[tr[1] * 2] - ax) * (poly[tr[2] * 2 + 1] - az) > 0;
            for (const vi of (up ? [tr[0], tr[1], tr[2]] : [tr[0], tr[2], tr[1]])) {
              rp.push(poly[vi * 2], y1, poly[vi * 2 + 1]);
              rn.push(0, 1, 0);
              rc.push(roofTone * warm, roofTone * (warm > 1 ? 0.8 : 1), roofTone * (warm > 1 ? 0.7 : 1.03));
            }
          }
          this.addToCells(rec, bounds(poly, { water: false, poly, top: y1 }));
          count++;
        }
        if ((fi & 63) === 63) yield;
      }
      const mk = (p, nrm, c, u, mat) => {
        if (!p.length) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
        if (u) g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = mesh.receiveShadow = true;
        this.group.add(mesh);
        rec.meshes.push(mesh);
      };
      mk(wp, wn, wc, wu, this.buildingMats.wall);
      yield;
      mk(rp, rn, rc, null, this.buildingMats.roof);
      rec.state = 'done';
      rec.count = count;
    }

    updateVectors(ax, az) {
      if (!this.vecTemplate) return;
      const g = this.toGeo(ax, az);
      const n = 1 << VEC_Z;
      const fx = mercX(g.lon) * n, fy = mercY(g.lat) * n;
      const tileW = (40075016.7 / n) * Math.cos(g.lat * D2R);
      const r = Math.ceil(this.buildingRange / tileW);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(fx) + dx, ty = Math.floor(fy) + dy;
        const d = Math.hypot(tx + 0.5 - fx, ty + 0.5 - fy) * tileW;
        if (d > this.buildingRange + tileW * 0.5) continue;
        const lat = invMercY((ty + 0.5) / n), lon = ((tx + 0.5) / n) * 360 - 180;
        const c = this.toLocal(lat, lon, { x: 0, z: 0 });
        if (this.hasHiElev(c.x, c.z)) this.loadVectorTile(tx, ty);
      }
      // Unload tiles left well behind
      for (const [id, rec] of this.vecTiles) {
        const d = Math.hypot(rec.x + 0.5 - fx, rec.y + 0.5 - fy) * tileW;
        if (d > this.buildingRange + tileW * 2.5 && rec.state !== 'loading' && rec.state !== 'parsed') {
          for (const m of rec.meshes) { this.group.remove(m); m.geometry.dispose(); }
          for (const k of rec.cellKeys) {
            const list = this.cells.get(k);
            if (list) { const keep = list.filter((it) => it.rec !== rec); if (keep.length) this.cells.set(k, keep); else this.cells.delete(k); }
          }
          rec.state = 'dead';
          this.vecTiles.delete(id);
        }
      }
    }

    /* ---- per-frame update ------------------------------------------------------------ */
    update(cam, aircraft, dt) {
      this.time += dt;
      const budgetEnd = performance.now() + 7;

      if (this.time - this.lastSelect > 0.2) {
        this.lastSelect = this.time;
        this.ensureElevation(aircraft.x, aircraft.z);
        this.updateVectors(aircraft.x, aircraft.z);

        const g = this.toGeo(cam.x, cam.z);
        const n = 1 << ROOT_Z;
        const rx = Math.floor(mercX(g.lon) * n), ry = Math.floor(mercY(g.lat) * n);
        const next = new Set();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const y = ry + dy;
          if (y < 0 || y >= n) continue;
          this.visit(this.getTile(ROOT_Z, ((rx + dx) % n + n) % n, y, null), cam, next);
        }
        for (const t of this.shown) if (!next.has(t) && t.mesh) t.mesh.visible = false;
        for (const t of next) t.mesh.visible = true;
        this.shown = next;

        if (this.time - this.lastPrune > 4) {
          this.lastPrune = this.time;
          for (const t of [...this.tiles.values()]) {
            if (!t.dead && t.parent && this.time - t.wanted > 14 && this.time - t.parent.wanted > 0.5) {
              // drop whole sibling groups that nobody asked for recently
              if (t.parent.children && t.parent.children.every((c) => this.time - c.wanted > 14)) {
                t.parent.children.forEach((c) => this.disposeTile(c));
                t.parent.children = null;
              }
            }
          }
        }
      }

      this.pumpLoads(cam);
      while (this.buildQueue.length && performance.now() < budgetEnd) {
        const t = this.buildQueue.shift();
        t.queued = false;
        if (!t.dead && t.tex) this.buildTileMesh(t);
      }
      while (this.vecJobs.length && performance.now() < budgetEnd) {
        if (this.vecJobs[0].next().done) this.vecJobs.shift();
      }
    }

    stats() {
      let buildings = 0;
      for (const r of this.vecTiles.values()) buildings += r.count || 0;
      return { tiles: this.tiles.size, shown: this.shown.size, loads: this.loads, failures: this.failures, queue: this.loadQueue.length + this.inFlight,
               elevHi: this.elev[ELEV_HI].size, buildings, vecTiles: this.vecTiles.size };
    }
  }

  GFX.EarthWorld = EarthWorld;
  GFX.geo = { mercX, mercY, invMercY, R_EARTH };
})();
