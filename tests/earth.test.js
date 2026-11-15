// Real-Earth world tests. Every map / weather request is intercepted and answered with
// synthetic data, so the streaming pipeline is exercised deterministically and offline.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { launch, openSim } = require('./helpers');

/* ----------------------------------------------------------------- fixtures */
function png(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Rough terrain: 500 m plus up to 40 m of per-sample noise, Terrarium-encoded.
const roughness = (x, y) => ((x * 73 + y * 151 + ((x * y) % 17) * 29) % 41);
const ELEVATION = png(256, 256, (x, y) => {
  const v = 500 + roughness(x, y) + 32768;
  return [Math.floor(v / 256), Math.floor(v) % 256, 0];
});
const IMAGERY = png(16, 16, (x, y) => ((x + y) % 2 ? [70, 120, 60] : [60, 110, 55]));

// Minimal Mapbox Vector Tile writer
const varint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const field = (num, wire, payload) => Buffer.concat([varint(num * 8 + wire), wire === 2 ? varint(payload.length) : Buffer.alloc(0), payload]);
const zig = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
function square(x, y, size) {
  const g = [9, zig(x), zig(y), 26, zig(size), zig(0), zig(0), zig(size), zig(-size), zig(0), 15];
  return Buffer.concat(g.map(varint));
}
function layer(name, geometry, props) {
  const keys = Object.keys(props);
  const dbl = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return field(3, 1, b); };
  const tags = Buffer.concat(keys.flatMap((k, i) => [varint(i), varint(i)]));
  const feature = Buffer.concat([field(2, 2, tags), field(3, 0, varint(3)), field(4, 2, geometry)]);
  return field(3, 2, Buffer.concat([
    field(15, 0, varint(2)), field(1, 2, Buffer.from(name)), field(2, 2, feature),
    ...keys.map((k) => field(3, 2, Buffer.from(k))), ...keys.map((k) => field(4, 2, dbl(props[k]))), field(5, 0, varint(4096))
  ]));
}
// A 60 m tower and a lake, both placed well clear of the runway
const VECTOR_TILE = Buffer.concat([
  layer('building', square(1900, 1900, 300), { render_height: 60 }),
  layer('water', square(2900, 2900, 900), { rank: 1 })
]);

// LOWI runway 26: tile that holds a point about 3 km north of the runway midpoint
const HOME = { lat: 47.2602, lon: 11.34395 };
const mercY = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
const OBJ = { lat: HOME.lat + 0.027, lon: HOME.lon };
const OBJ_TILE = { x: Math.floor(((OBJ.lon + 180) / 360) * 16384), y: Math.floor(mercY(OBJ.lat) * 16384) };

const WEATHER = { current: { temperature_2m: 21.2, pressure_msl: 1004.3, cloud_cover: 40, visibility: 24000, precipitation: 0,
  wind_speed_10m: 12.4, wind_direction_10m: 240, wind_gusts_10m: 21.0 } };

async function mockMaps(page, { offline = false } = {}) {
  const hits = { elevation: 0, imagery: 0, vector: 0, weather: 0 };
  await page.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (offline) return route.abort();
    const cors = { 'access-control-allow-origin': '*' };
    if (url.includes('elevation-tiles-prod')) { hits.elevation++; return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: ELEVATION }); }
    if (url.includes('arcgisonline') || url.includes('eox.at')) { hits.imagery++; return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: IMAGERY }); }
    if (url.endsWith('openfreemap.org/planet')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }) });
    }
    if (url.includes('openfreemap.org')) {
      hits.vector++;
      const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
      const mine = m && Number(m[2]) === OBJ_TILE.x && Number(m[3]) === OBJ_TILE.y;
      return route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: cors, body: mine ? VECTOR_TILE : Buffer.alloc(0) });
    }
    if (url.includes('open-meteo')) { hits.weather++; return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(WEATHER) }); }
    return route.abort();
  });
  return hits;
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: expected ${expected} +/- ${tol}, got ${actual}`);

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

describe('real-Earth world (mocked map services)', () => {
  let page, errors, hits;
  before(async () => {
    ({ page, errors } = await openSim(browser, {
      manual: true, query: 'world=earth&apt=LOWI&rwy=26&gfx=low',
      setup: async (p) => { hits = await mockMaps(p); }
    }));
  });
  after(async () => { await page.close(); });

  test('boots onto the real runway: frame, datum, credits and scenario all line up', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.advance(4);
      sim.updateUI();
      return { mode: sim.worldMode, frame: sim.frameHeading, ident: sim.rwyIdent, elev: AIRPORT_ELEV, halfL: RWY_HALF_LENGTH, halfW: RWY_HALF_WIDTH,
        state: T.state(), credit: T.text('map-credit'), button: T.text('btn-rwy-start'), loading: T.visible('loading-overlay'),
        origin: sim.earth.toGeo(0, 0), stats: sim.earth.stats() };
    });
    assert.equal(r.mode, 'earth');
    assert.equal(r.ident, '26');
    near(r.frame, 261, 1.5, 'runway 26 true heading');
    near(r.halfL * 2, 2000, 40, 'runway length from the airport database');
    near(r.halfW * 2, 45, 0.5, 'runway width');
    near(r.origin.lat, 47.2602, 0.001, 'origin latitude');
    near(r.origin.lon, 11.34395, 0.001, 'origin longitude');
    assert.ok(r.elev > 500 && r.elev < 541, `datum comes from the streamed terrain (${r.elev})`);
    assert.equal(r.state.crashed, false, r.state.crashReason || '');
    assert.equal(r.state.telemetry.wheelsOnGround, 3);
    near(r.state.pos[1], r.elev + 1.55, 0.25, 'aircraft sits on the graded runway');
    near(r.state.telemetry.headingDeg, 261, 1.5, 'HUD shows true heading');
    assert.match(r.credit, /Esri/);
    assert.match(r.credit, /OpenStreetMap/);
    assert.equal(r.button, 'RWY 26 START');
    assert.equal(r.loading, false);
    assert.ok(hits.elevation > 10 && hits.imagery > 5, `tiles were streamed (${JSON.stringify(hits)})`);
  });

  test('runway is graded level while the surrounding terrain keeps its relief', async () => {
    const r = await page.evaluate(() => {
      const on = [], off = [];
      for (let z = -RWY_HALF_LENGTH; z <= RWY_HALF_LENGTH; z += 50) for (const x of [-20, 0, 20]) on.push(sim.getTerrainHeight(x, z));
      for (let i = 0; i < 200; i++) off.push(sim.getTerrainHeight(4000 + i * 13, -3000 + i * 7));
      const spread = (a) => Math.max(...a) - Math.min(...a);
      return { on: spread(on), off: spread(off), mean: on.reduce((s, v) => s + v, 0) / on.length, elev: AIRPORT_ELEV,
        paved: sim.isPaved(0, 0), grass: sim.isPaved(300, 0) };
    });
    assert.ok(r.on < 1e-6, `runway surface is flat (${r.on} m spread)`);
    near(r.mean, r.elev, 1e-6, 'runway elevation equals the datum');
    assert.ok(r.off > 8, `open terrain is not flattened (${r.off} m spread)`);
    assert.equal(r.paved, true);
    assert.equal(r.grass, false);
  });

  test('rendered terrain and physics share one height function', async () => {
    await page.evaluate(() => { sim.manualClock = true; });
    await page.waitForFunction(() => sim.earth.stats().shown >= 4 && sim.earth.buildQueue.length === 0, null, { timeout: 60000 });
    const r = await page.evaluate(() => {
      let worst = 0, checked = 0;
      for (const t of sim.earth.shown) {
        const p = t.mesh.geometry.attributes.position;
        for (let i = 0; i < 289; i += 23) {
          const x = p.getX(i) + t.mesh.position.x, y = p.getY(i) + t.mesh.position.y, z = p.getZ(i) + t.mesh.position.z;
          worst = Math.max(worst, Math.abs(y - sim.getTerrainHeight(x, z)));
          checked++;
        }
      }
      return { worst, checked };
    });
    assert.ok(r.checked > 40);
    assert.ok(r.worst < 0.02, `mesh vertices sit on the physics surface (worst ${r.worst} m)`);
  });

  test('projection round-trips and preserves distances', async () => {
    const r = await page.evaluate(() => {
      const e = sim.earth;
      const g = e.toGeo(1234.5, -6789.0);
      const back = e.toLocal(g.lat, g.lon, { x: 0, z: 0 });
      const north = e.toLocal(e.lat0 + 0.01, e.lon0, { x: 0, z: 0 });
      return { back, north, hdg: sim.frameHeading };
    });
    near(r.back.x, 1234.5, 1e-6);
    near(r.back.z, -6789.0, 1e-6);
    near(Math.hypot(r.north.x, r.north.z), 0.01 * Math.PI / 180 * 6378137, 0.01, '0.01 deg of latitude');
    // True north in the runway-aligned frame: rotated by the runway heading
    const bearing = (Math.atan2(r.north.x, -r.north.z) * 180 / Math.PI + r.hdg + 360) % 360;
    near(Math.min(bearing, 360 - bearing), 0, 1e-6, 'north maps back to a true bearing of 000');
  });

  test('takes off from the real runway and climbs out', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.advance(3);
      sim.controls.parkingBrake = false;
      sim.controls.throttle = 1;
      const vr = sim.stallSpeed(15) * 1.1 * 1.94384;
      for (let i = 0; i < 120 * 70; i++) {
        const t = sim.telemetry;
        sim.input.pitch = (t.ias > vr && t.pitchDeg < 8) ? 0.5 : (t.pitchDeg > 12 ? -0.2 : 0);
        T.step(1);
        if (sim.crashed || sim.telemetry.altAGL > 400) break;
      }
      sim.input.pitch = null;
      return T.state();
    });
    assert.equal(r.crashed, false, r.crashReason || '');
    assert.ok(r.telemetry.altAGL > 400, `climbs away (${r.telemetry.altAGL} ft AGL)`);
    assert.ok(Math.abs(r.pos[0]) < 60, 'tracks the runway heading');
  });

  test('OpenStreetMap buildings and water are loaded and are solid for the physics', async () => {
    const loc = await page.evaluate(([lat, lon]) => {
      const p = sim.earth.toLocal(lat, lon, { x: 0, z: 0 });
      T.place({ x: p.x, z: p.z, h: 600, vz: 0 });
      sim.pos.set(p.x, AIRPORT_ELEV + 600, p.z);
      sim.vel.set(0, 0, 0);
      return p;
    }, [OBJ.lat, OBJ.lon]);
    await page.waitForFunction(() => sim.earth.stats().buildings >= 1, null, { timeout: 60000 });
    const r = await page.evaluate(() => {
      // Find the tower and the lake through the same queries the physics uses
      let b = null, w = null;
      for (const list of sim.earth.cells.values()) for (const it of list) { if (it.water) w = w || it; else b = b || it; }
      const bc = { x: (b.minx + b.maxx) / 2, z: (b.minz + b.maxz) / 2 };
      const wc = { x: (w.minx + w.maxx) / 2, z: (w.minz + w.maxz) / 2 };
      const top = sim.earth.buildingTop(bc.x, bc.z);
      const ground = sim.getTerrainHeight(bc.x, bc.z);
      const out = { top, ground, width: b.maxx - b.minx, outside: sim.earth.buildingTop(bc.x + 400, bc.z + 400),
        water: sim.earth.isWater(wc.x, wc.z), dry: sim.earth.isWater(bc.x, bc.z), meshes: sim.earth.group.children.length };
      // Fly into the tower below roof height
      T.place({ x: bc.x, z: bc.z + 150, vz: -45 });
      sim.pos.y = top - 20;
      T.until(() => sim.crashed, 8);
      out.building = sim.crashReason;
      // Descend onto the lake
      T.place({ x: wc.x, z: wc.z, vz: -30, vy: -3 });
      sim.pos.y = sim.getTerrainHeight(wc.x, wc.z) + 12;
      T.until(() => sim.crashed, 12);
      out.lake = sim.crashReason;
      return out;
    });
    assert.ok(loc);
    near(r.top - r.ground, 60, 14, 'tower height from render_height');
    assert.ok(r.width > 40 && r.width < 400, `footprint in metres (${r.width})`);
    assert.equal(r.outside, -Infinity);
    assert.equal(r.water, true);
    assert.equal(r.dry, false);
    assert.match(r.building || '', /building/i);
    assert.match(r.lake || '', /water/i);
  });

  test('live weather maps real conditions onto the atmosphere', async () => {
    const r = await page.evaluate(async () => {
      T.reset('skyhawk');
      await sim.loadLiveWeather();
      return { wind: sim.env.windSpeed, dir: T.text('val-wind-dir'), qnh: sim.env.seaLevelPressure, temp: sim.env.isaTempOffset,
        turb: sim.env.turbulence, label: T.text('btn-livewx'), time: sim.env.timeOfDay,
        local: sim.env.windFromRad, frame: sim.frameHeading };
    });
    assert.equal(hits.weather, 1);
    near(r.wind, 12 * 0.514444, 0.01, 'wind speed (rounded to whole knots)');
    assert.equal(r.dir, '240°');
    near(r.qnh, 100400, 1, 'QNH');
    assert.ok(r.temp > 5 && r.temp < 12, `ISA deviation for 21 C at ~520 m (${r.temp})`);
    assert.ok(r.turb >= 3 && r.turb <= 4, `gust spread sets turbulence (${r.turb})`);
    assert.equal(r.label, 'LIVE WEATHER');
    assert.ok(r.time >= 0 && r.time <= 24);
    // Wind direction is stored relative to the runway-aligned frame
    near(((r.local * 180 / Math.PI + r.frame) % 360 + 360) % 360, 240, 1e-6, 'true wind direction');
  });

  test('airport picker lists runways and builds a shareable URL', async () => {
    await page.fill('#apt-input', 'KSFO');
    await page.dispatchEvent('#apt-input', 'input');
    const r = await page.evaluate(() => ({
      runways: [...document.querySelectorAll('#rwy-select option')].map((o) => o.value),
      hits: document.querySelectorAll('#apt-list option').length,
      found: sim.findAirport('KSFO')[1]
    }));
    assert.ok(r.runways.includes('28R') && r.runways.includes('10L'));
    assert.ok(r.hits >= 1);
    assert.match(r.found, /San Francisco/);
    await page.selectOption('#rwy-select', '28R');
    await Promise.all([page.waitForURL(/apt=KSFO/), page.click('#apt-go')]);
    await page.waitForFunction(() => window.sim && !window.sim.booting, null, { timeout: 60000 });
    const k = await page.evaluate(() => ({ ident: sim.rwyIdent, frame: sim.frameHeading, url: location.search, mode: sim.worldMode }));
    assert.equal(k.mode, 'earth');
    assert.equal(k.ident, '28R');
    near(k.frame, 298, 3, 'KSFO 28R true heading');
    assert.match(k.url, /rwy=28R/);
  });

  test('no JavaScript errors were raised', () => assert.deepEqual(errors, []));
});

describe('offline behaviour', () => {
  test('falls back to the built-in island when the map services cannot be reached', async () => {
    const { page, errors } = await openSim(browser, {
      manual: true, query: 'world=earth&apt=LOWI&rwy=26&gfx=low',
      setup: async (p) => { await mockMaps(p, { offline: true }); }
    });
    const r = await page.evaluate(() => ({ mode: sim.worldMode, elev: AIRPORT_ELEV, wheels: (sim.advance(3), sim.telemetry.wheelsOnGround),
      credit: document.getElementById('map-credit').innerText, select: document.getElementById('world-select').value }));
    assert.equal(r.mode, 'island');
    assert.equal(r.elev, 30);
    assert.equal(r.wheels, 3);
    assert.equal(r.credit, '');
    assert.equal(r.select, 'island');
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
    await page.close();
  });
});
