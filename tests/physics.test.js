// Deterministic physics tests. Sections 1-15 mirror the blueprint's
// "Verification & QA Checklist (15-Point Deterministic Matrix)" one-to-one;
// the remaining tests cover the anti-shortcut guardrails and each airframe.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { launch, openSim } = require('./helpers');

let browser;
let page;
let errors;

before(async () => {
  browser = await launch();
  ({ page, errors } = await openSim(browser, { manual: true }));
});

after(async () => {
  await browser.close();
});

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: expected ${expected} +/- ${tol}, got ${actual}`);

describe('QA matrix', () => {
  test('01 zero-airspeed singularity: parked aircraft produces no lift, no drag, no NaN', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.advance(3); // let the gear settle under the aircraft's weight
      const settled = sim.pos.toArray();
      sim.advance(6);
      const calm = T.state();
      const calmFinite = T.finite();
      const drift = Math.hypot(calm.pos[0] - settled[0], calm.pos[1] - settled[1], calm.pos[2] - settled[2]);
      // A stiff crosswind on the parked aircraft must stay finite too
      sim.setEnv({ wind: 40, windDir: 270, turb: 10 });
      sim.advance(6);
      return { calm, calmFinite, drift, windyFinite: T.finite(), windy: T.state() };
    });
    assert.ok(r.calmFinite && r.windyFinite, 'state must stay finite');
    assert.equal(r.calm.telemetry.lift, 0);
    assert.equal(r.calm.telemetry.drag, 0);
    assert.equal(r.calm.telemetry.alpha, 0);
    assert.equal(r.calm.telemetry.beta, 0);
    assert.equal(r.calm.telemetry.wheelsOnGround, 3);
    assert.ok(Math.hypot(...r.calm.vel) < 1e-3, 'parking brake holds the aircraft still');
    assert.ok(r.drift < 1e-3, `no creep once settled (${r.drift} m in 6 s)`);
    near(r.calm.pos[2], 1360, 0.1, 'runway position');
    assert.equal(r.windy.crashed, false);
  });

  test('02 dynamic pressure: doubling TAS quadruples lift and drag at fixed AoA', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      const sample = (v) => {
        T.place({ h: 600, vz: -v, pitch: 2 });
        T.step(1);
        return T.state().telemetry;
      };
      return { slow: sample(35), fast: sample(70) };
    });
    near(r.fast.alpha, r.slow.alpha, 0.05, 'AoA unchanged');
    near(r.fast.lift / r.slow.lift, 4, 0.03, 'lift ratio');
    near(r.fast.drag / r.slow.drag, 4, 0.03, 'drag ratio');
    near(r.fast.CL, r.slow.CL, 1e-3, 'CL independent of speed');
  });

  test('03 ground effect: within one wingspan lift rises and induced drag falls', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      const sample = (h) => {
        T.place({ h, vz: -32, pitch: 6, flaps: 15 });
        T.step(1);
        return T.state().telemetry;
      };
      return { low: sample(1.0), high: sample(150) };
    });
    assert.equal(r.low.inGroundEffect, true);
    assert.equal(r.high.inGroundEffect, false);
    assert.ok(r.low.kGE < 0.5 && r.high.kGE > 0.99, `kGE low=${r.low.kGE} high=${r.high.kGE}`);
    assert.ok(r.low.CL > r.high.CL * 1.03, 'ground effect adds lift');
    assert.ok(r.low.CD < r.high.CD * 0.8, 'ground effect removes induced drag');
  });

  test('04 ISA: altitude, hot day and low QNH all thin the air and cut thrust', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      const thrust = (h) => {
        T.place({ y: h, vz: -45, throttle: 1 });
        T.step(1);
        return { thrust: sim.telemetry.thrust, rho: sim.env.rho, rhoText: T.text('sys-rho') };
      };
      const sl = sim.atmosphere(0);
      const std = thrust(300);
      const high = thrust(3048); // 10,000 ft
      sim.setEnv({ temp: 30 });
      const hot = thrust(300);
      sim.updateUI();
      const hotText = T.text('sys-rho');
      sim.setEnv({ temp: 0, qnh: 980 });
      const lowP = thrust(300);
      sim.setEnv({ qnh: 1013 });
      return { sl, std, high, hot, lowP, hotText };
    });
    near(r.sl.rho, 1.225, 0.001, 'sea-level density');
    near(r.sl.T, 288.15, 1e-9, 'sea-level temperature');
    near(r.sl.a, 340.3, 0.2, 'sea-level speed of sound');
    near(r.high.rho, 0.9046, 0.004, 'density at 10,000 ft');
    assert.ok(r.high.thrust < r.std.thrust * 0.8, 'thrust falls with altitude');
    assert.ok(r.hot.rho < r.std.rho * 0.92, 'ISA+30 lowers density');
    assert.ok(r.hot.thrust < r.std.thrust * 0.92, 'ISA+30 lowers thrust');
    assert.ok(r.lowP.rho < r.std.rho * 0.975, 'low QNH lowers density');
    assert.match(r.hotText, /^1\.0\d\d kg/, 'density readout follows the slider');
  });

  test('05 wind: 26 kt from 270 swings the windsock to 090 and demands a crab on final', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.setEnv({ wind: 26, windDir: 270, turb: 0 });
      const w = sim.windAt(0, 100, 0, 0, new THREE.Vector3()).toArray();
      sim.syncVisuals(0);
      sim.windsockMesh.updateMatrixWorld(true);
      const sock = new THREE.Vector3(1, 0, 0).transformDirection(sim.windsockMesh.matrixWorld).toArray();
      sim.loadScenario('final');
      const start = T.state();
      sim.advance(15);
      const later = T.state();
      // Same approach flown with the nose on the runway heading instead: it must drift downwind
      sim.loadScenario('final');
      const e = new THREE.Euler().setFromQuaternion(sim.quat, 'YXZ');
      sim.quat.setFromEuler(new THREE.Euler(e.x, 0, 0, 'YXZ'));
      sim.vel.x = 0;
      sim.advance(15);
      const drifted = T.state();
      return { w, sock, start, later, drifted };
    });
    near(r.w[0], 26 * 0.514444, 1e-6, 'wind blows toward +X (east)');
    near(r.w[2], 0, 1e-6, 'no north/south component');
    near(r.sock[0], 1, 0.02, 'windsock points east (090)');
    const hdg = r.start.telemetry.headingDeg;
    assert.ok(hdg > 325 && hdg < 345, `crabbed into the wind, heading ${hdg}`);
    assert.ok(Math.abs(r.later.pos[0]) < 60, `crabbed approach holds the centreline (x=${r.later.pos[0]})`);
    assert.ok(r.drifted.pos[0] > 40 && r.drifted.pos[0] > 3 * Math.abs(r.later.pos[0]),
      `uncrabbed approach is blown east (x=${r.drifted.pos[0]} vs crabbed ${r.later.pos[0]})`);
  });

  test('06 turbulence: gusts are smooth, time-correlated air-mass velocity, not jitter', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      const run = (turb) => {
        sim.setEnv({ wind: 10, windDir: 0, turb });
        const v = new THREE.Vector3();
        const out = [];
        for (let i = 0; i < 1200; i++) out.push(sim.windAt(100, 500, -200, i / 120, v).toArray());
        return out;
      };
      const calm = run(0);
      const rough = run(6);
      // Gusts must move the aircraft through the equations of motion, not the camera
      const fly = (turb) => {
        sim.setEnv({ wind: 0, turb });
        sim.loadScenario('cruise');
        let maxDev = 0;
        for (let i = 0; i < 1200; i++) { T.step(1); maxDev = Math.max(maxDev, Math.abs(sim.telemetry.gLoad - 1)); }
        return maxDev;
      };
      return { calm, rough, gCalm: fly(0), gRough: fly(6) };
    });
    const span = (arr, k) => Math.max(...arr.map((v) => v[k])) - Math.min(...arr.map((v) => v[k]));
    assert.ok(span(r.calm, 0) === 0 && span(r.calm, 1) === 0 && span(r.calm, 2) === 0, 'no gusts when turbulence is zero');
    let maxStep = 0;
    for (let i = 1; i < r.rough.length; i++) {
      for (let k = 0; k < 3; k++) maxStep = Math.max(maxStep, Math.abs(r.rough[i][k] - r.rough[i - 1][k]));
    }
    assert.ok(span(r.rough, 0) > 3 && span(r.rough, 1) > 1.5, 'gust field has real amplitude in 3D');
    assert.ok(maxStep < 0.25, `gusts are continuous step-to-step (max delta ${maxStep} m/s)`);
    assert.ok(r.gCalm < 0.02, `calm air is smooth (${r.gCalm} G)`);
    assert.ok(r.gRough > 0.08, `turbulence loads the airframe (${r.gRough} G)`);
  });

  test('07 stall: idle + full back stick stalls, drops the nose and sinks; pushing recovers', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.loadScenario('cruise');
      sim.controls.throttle = 0;
      // Ease the stick back so the aircraft decelerates into a 1-g stall
      const tStall = T.until(() => { sim.input.pitch = Math.min(1, sim.simTime * 0.06); return sim.telemetry.stall; }, 60);
      sim.input.pitch = 1;
      const atStall = T.state();
      let peakPitch = -99, minPitch = 99, minVsi = 0;
      for (let i = 0; i < 120 * 8; i++) {
        T.step(1);
        peakPitch = Math.max(peakPitch, sim.telemetry.pitchDeg);
        minPitch = Math.min(minPitch, sim.telemetry.pitchDeg);
        minVsi = Math.min(minVsi, sim.telemetry.vsi);
      }
      const held = T.state();
      sim.input.pitch = -0.6;
      const tRecover = T.until(() => !sim.telemetry.stall && sim.telemetry.alpha < 10, 10);
      sim.input.pitch = null;
      return { tStall, atStall, held, peakPitch, minPitch, minVsi, tRecover, crashed: sim.crashed };
    });
    assert.ok(r.tStall > 0, 'stall warning triggers');
    assert.ok(r.atStall.telemetry.alpha > 15, `AoA beyond stall (${r.atStall.telemetry.alpha})`);
    assert.ok(r.atStall.telemetry.ias < 60, `stalls near book speed (${r.atStall.telemetry.ias} kt)`);
    assert.ok(r.minPitch < r.peakPitch - 8, `nose drops in the stall (${r.peakPitch} -> ${r.minPitch})`);
    assert.ok(r.minVsi < -700, `aircraft sinks while stalled (${r.minVsi} fpm)`);
    assert.ok(r.held.pos[1] < r.atStall.pos[1] - 30, 'altitude is lost: no hidden altitude lock');
    assert.ok(r.tRecover > 0, 'forward stick recovers the stall');
    assert.equal(r.crashed, false);
  });

  test('08 tri-gear torque: mains-first touchdown pitches the nose onto the nosewheel', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ z: 1000, h: 0.12, vz: -26, vy: -1.0, pitch: 7, flaps: 15 });
      const tMains = T.until(() => sim.telemetry.wheelsOnGround >= 1, 5);
      const atMains = T.state();
      sim.controls.wheelBrakes = false;
      const tNose = T.until(() => sim.telemetry.wheelsOnGround === 3, 12);
      sim.advance(4);
      return { tMains, atMains, tNose, end: T.state() };
    });
    assert.ok(r.tMains > 0, 'main wheels touch down');
    assert.equal(r.atMains.telemetry.wheelsOnGround, 2, 'mains touch first');
    assert.ok(r.atMains.telemetry.pitchDeg > 4, 'nose still high at main-wheel contact');
    assert.ok(r.tNose > 0, 'nosewheel is lowered by contact moments');
    assert.ok(r.end.telemetry.pitchDeg < 3.5, `aircraft de-rotates (${r.end.telemetry.pitchDeg} deg)`);
    assert.equal(r.end.crashed, false);
    assert.equal(r.end.damage.gearCollapsed, false);
  });

  test('09 hard landing (1,100-1,800 fpm) collapses the gear without a catastrophic crash', async () => {
    const drop = (sink) => page.evaluate((s) => {
      T.reset('skyhawk');
      T.place({ z: 900, h: 0.03, vz: -30, vy: -s, pitch: 3, flaps: 15 });
      const before = sim.aeroCoefficients(0.05, 0, 1, 0.1, 0, true).CD;
      T.until(() => sim.lastTouchdown !== null || sim.crashed, 3);
      const first = T.state();
      sim.advance(3);
      const after = sim.aeroCoefficients(0.05, 0, 1, 0.1, 0, true).CD;
      return { first, end: T.state(), cdBefore: before, cdAfter: after, badge: T.text('dmg-gear'), toast: T.visible('landing-toast'),
               title: T.text('ldg-title'), modal: T.visible('crash-modal') };
    }, sink);

    for (const sink of [6.0, 8.9]) { // ~1,180 and ~1,750 fpm
      const r = await drop(sink);
      assert.equal(r.end.crashed, false, `sink ${sink} m/s must not be catastrophic (${r.end.crashReason})`);
      assert.equal(r.end.damage.gearCollapsed, true, `sink ${sink} m/s collapses the gear`);
      assert.match(r.badge, /COLLAPSED/);
      assert.equal(r.modal, false);
      assert.equal(r.toast, true);
      assert.match(r.title, /DAMAGED/);
      near(r.cdAfter - r.cdBefore, 0.045, 1e-9, 'collapsed gear adds parasitic drag');
    }

    const soft = await drop(1.0);
    assert.equal(soft.end.damage.gearCollapsed, false, 'normal touchdown leaves the gear intact');
    assert.equal(soft.end.crashed, false);

    const fatal = await drop(11.0);
    assert.equal(fatal.end.crashed, true, 'sink above 9.5 m/s is catastrophic');
    assert.equal(fatal.modal, true);
    assert.ok(fatal.end.debris > 0, 'airframe breaks into debris');
  });

  test('10 wingtip strike: damage persists as roll bias and reduced aileron authority', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ z: 900, h: 3.5, vz: -30, vy: -1.5, roll: 29, flaps: 15 });
      const tHit = T.until(() => sim.damage.wingDamage !== 0 || sim.crashed, 5);
      const hit = { ...T.state(), badge: T.text('dmg-wing') };

      // Flight behaviour with the damage carried forward
      const rollAfter = (dmg, stick) => {
        sim.loadScenario('cruise');
        sim.damage.wingDamage = dmg;
        sim.input.roll = stick;
        sim.advance(1.5);
        sim.input.roll = null;
        return sim.telemetry.rollDeg;
      };
      const clean = rollAfter(0, 0);
      const biased = rollAfter(1, 0);
      const fullAileronClean = rollAfter(0, -1);   // stick right
      const fullAileronDamagedLeft = rollAfter(-1, -1);
      return { tHit, hit, clean, biased, fullAileronClean, fullAileronDamagedLeft };
    });
    assert.ok(r.tHit > 0, 'wingtip reaches the ground');
    assert.equal(r.hit.crashed, false, `wingtip strike alone is not catastrophic (${r.hit.crashReason})`);
    assert.equal(r.hit.damage.wingDamage, 1, 'right wing damaged');
    assert.match(r.hit.badge, /DAMAGED/);
    assert.ok(Math.abs(r.clean) < 1.5, `undamaged aircraft stays level (${r.clean})`);
    assert.ok(r.biased > 4, `damaged right wing drops (${r.biased} deg)`);
    assert.ok(r.fullAileronClean > 40, `clean roll response (${r.fullAileronClean})`);
    assert.ok(r.fullAileronDamagedLeft < r.fullAileronClean * 0.55, 'aileron authority is roughly halved against the damage');
  });

  test('11 engine-out: dead-stick glide near best L/D, throttle has no effect', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.loadScenario('engout');
      sim.controls.throttle = 1;
      const start = T.state();
      sim.advance(30);
      sim.updateUI();
      return { start, end: T.state(), badge: T.text('dmg-eng'), thrustText: T.text('tel-thrust') };
    });
    assert.equal(r.start.damage.engineFailed, true);
    assert.match(r.badge, /FAILED/);
    assert.equal(r.end.telemetry.thrust, 0, 'failed engine produces no thrust at full throttle');
    assert.ok(r.end.controls.engineRpm < 0.01);
    const dist = Math.hypot(r.end.pos[0] - r.start.pos[0], r.end.pos[2] - r.start.pos[2]);
    const lost = r.start.pos[1] - r.end.pos[1];
    assert.ok(lost > 50, 'the aircraft descends');
    const ratio = dist / lost;
    assert.ok(ratio > 7 && ratio < 13, `glide ratio is plausible for the airframe (${ratio.toFixed(1)}:1)`);
    assert.equal(r.end.crashed, false);
  });

  test('12 touchdown evaluator: runway landing pops a graded report', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ x: 3, z: 1000, h: 0.3, vz: -27, vy: -0.6, pitch: 5, flaps: 30 });
      T.until(() => sim.lastTouchdown !== null, 5);
      return { td: sim.lastTouchdown, toast: T.visible('landing-toast'), title: T.text('ldg-title'),
               details: T.text('ldg-details'), crashed: sim.crashed };
    });
    assert.equal(r.crashed, false);
    assert.equal(r.toast, true);
    assert.ok(r.td.onRunway);
    assert.match(r.title, /GREASER|ACCEPTABLE/);
    assert.match(r.details, /SINK RATE:\s*-\d+ FPM/);
    assert.match(r.details, /TOUCHDOWN IAS:\s*\d+ KT/);
    assert.match(r.details, /CENTERLINE DEVIATION:\s*3\.\d m/);
    assert.match(r.details, /BANK ANGLE/);
    assert.ok(r.td.sinkFpm > 50 && r.td.sinkFpm < 400, `sink rate recorded (${r.td.sinkFpm})`);
  });

  test('13 ILS: needles centre on the 3-degree path and deflect the right way', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.loadScenario('final');
      const on = { ...sim.telemetry };
      sim.renderHUD();
      const ctx = sim.hudCanvas.getContext('2d');
      const img = ctx.getImageData(0, 0, sim.hudCanvas.width, sim.hudCanvas.height).data;
      let cyan = 0;
      for (let i = 0; i < img.length; i += 4) if (img[i] < 40 && img[i + 1] > 200 && img[i + 2] > 230 && img[i + 3] > 200) cyan++;
      sim.pos.x += 250; sim.pos.y += 120;
      sim.refreshTelemetry();
      const off = { ...sim.telemetry };
      return { on, off, cyan };
    });
    near(r.on.ilsLocErrorDeg, 0, 0.01, 'localizer centred');
    near(r.on.ilsGsErrorDeg, 0, 0.02, 'glideslope centred');
    near(r.on.ilsDistNM, 4800 / 1852, 0.05, 'DME distance');
    assert.ok(r.cyan > 150, `cyan ILS needles are drawn on the PFD (${r.cyan} px)`);
    assert.ok(r.off.ilsLocErrorDeg > 2, 'east of centreline deflects the localizer');
    assert.ok(r.off.ilsGsErrorDeg > 1, 'above the path deflects the glideslope');
  });

  test('14 frame-rate independence: 30 / 60 / 144 Hz frames give identical trajectories', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      const fly = (hz) => {
        sim.setEnv({ wind: 12, windDir: 300, turb: 4 });
        sim.loadScenario('final');
        sim.input.roll = 0.2;
        sim.input.pitch = 0.1;
        const target = 120 * 12; // 12 simulated seconds
        let frames = 0;
        while (sim.stepCount < target && frames < 100000) {
          sim.tick(1 / hz);
          frames++;
          if (sim.stepCount > target) throw new Error('overshot');
        }
        return { pos: sim.pos.toArray(), quat: sim.quat.toArray(), vel: sim.vel.toArray(), steps: sim.stepCount, frames };
      };
      // 144 Hz frames never overshoot a whole number of steps mid-frame beyond 1, so stop exactly on target
      const stepTo = (hz) => {
        sim.setEnv({ wind: 12, windDir: 300, turb: 4 });
        sim.loadScenario('final');
        sim.input.roll = 0.2;
        sim.input.pitch = 0.1;
        const target = 120 * 12;
        let frames = 0;
        while (sim.stepCount < target) {
          const before = sim.stepCount;
          sim.tick(1 / hz);
          frames++;
          if (sim.stepCount > target) {
            // rewind is impossible; instead report how far past we are so the caller can align
            return { over: sim.stepCount - target, before };
          }
        }
        return { pos: sim.pos.toArray(), quat: sim.quat.toArray(), vel: sim.vel.toArray(), steps: sim.stepCount, frames };
      };
      void fly;
      const out = { a: stepTo(30), b: stepTo(60), c: stepTo(144), d: stepTo(20) };
      // Tab-switch guard: a 5-second frame hitch may advance at most 0.05 s of physics
      sim.loadScenario('final');
      const hitch = sim.tick(5.0);
      sim.input.roll = sim.input.pitch = null;
      return { ...out, hitch };
    });
    for (const k of ['a', 'b', 'c', 'd']) assert.ok(r[k].pos, `run ${k} landed exactly on the target step`);
    assert.equal(r.a.steps, 1440);
    assert.ok(r.c.frames > r.b.frames && r.b.frames > r.a.frames, 'different frame counts were actually used');
    for (const k of ['b', 'c', 'd']) {
      assert.deepEqual(r[k].pos, r.a.pos, `position identical (${k})`);
      assert.deepEqual(r[k].quat, r.a.quat, `attitude identical (${k})`);
      assert.deepEqual(r[k].vel, r.a.vel, `velocity identical (${k})`);
    }
    assert.ok(r.hitch <= 6, `delta-time clamp limits a hitch to 0.05 s (${r.hitch} steps)`);
  });

  test('15 instant clean reset: R clears debris, repairs, refuels and re-levels', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ z: 500, h: 40, vz: -45, vy: -25, pitch: -30 });
      sim.fuelMass = 20;
      sim.damage.wingDamage = 1;
      T.until(() => sim.crashed, 10);
      sim.advance(0.5);
      const wreck = { ...T.state(), modal: T.visible('crash-modal'), reason: T.text('crash-reason'), stats: T.text('crash-telemetry') };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
      sim.advance(3);
      return { wreck, clean: { ...T.state(), modal: T.visible('crash-modal'), visible: sim.aircraftGroup.visible, fuelCap: sim.spec.fuelCapacity,
               badges: T.text('dmg-gear') + T.text('dmg-wing') + T.text('dmg-eng') } };
    });
    assert.equal(r.wreck.crashed, true);
    assert.equal(r.wreck.modal, true);
    assert.equal(r.wreck.debris, 24);
    assert.ok(r.wreck.particles > 0, 'fire / smoke emitters are active');
    assert.match(r.wreck.stats, /KINETIC ENERGY DISSIPATED/);
    assert.equal(r.clean.crashed, false);
    assert.equal(r.clean.modal, false);
    assert.equal(r.clean.debris, 0);
    assert.equal(r.clean.particles, 0);
    assert.deepEqual(r.clean.damage, { gearCollapsed: false, wingDamage: 0, engineFailed: false });
    assert.ok(r.clean.fuel > r.clean.fuelCap * 0.99, 'tanks refilled');
    assert.equal(r.clean.visible, true);
    assert.equal(r.clean.telemetry.wheelsOnGround, 3);
    near(r.clean.telemetry.rollDeg, 0, 0.5, 'wings level');
    near(r.clean.pos[2], 1360, 0.05, 'back on the RWY 36 threshold');
    assert.doesNotMatch(r.clean.badges, /COLLAPSED|DAMAGED|FAILED/);
  });
});

describe('guardrails', () => {
  test('no kinematic cheating: controls do nothing without airflow, and motion needs force', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.advance(3);
      const q0 = sim.quat.toArray();
      const p0 = sim.pos.toArray();
      sim.input.pitch = 1; sim.input.roll = 1; sim.input.yaw = 1;
      sim.advance(5);
      const stillAttitude = sim.quat.toArray().map((v, i) => Math.abs(v - q0[i]));
      const stillPos = sim.pos.toArray().map((v, i) => Math.abs(v - p0[i]));
      sim.input.pitch = sim.input.roll = sim.input.yaw = null;
      // In a vacuum-like state (no air density) the same aircraft simply falls ballistically
      T.place({ h: 2000, vz: -40 });
      sim.controls.throttle = 0; sim.controls.engineRpm = 0;
      const saved = sim.env.seaLevelPressure;
      sim.env.seaLevelPressure = 1e-6;
      const y0 = sim.pos.y, vy0 = sim.vel.y;
      sim.advance(2);
      const fall = { dy: sim.pos.y - y0, vy: sim.vel.y - vy0 };
      sim.env.seaLevelPressure = saved;
      return { stillAttitude, stillPos, fall };
    });
    assert.ok(Math.max(...r.stillAttitude) < 0.01, 'full stick at zero airspeed must not rotate the airframe');
    assert.ok(Math.max(...r.stillPos) < 0.05, 'full stick at zero airspeed must not move the airframe');
    near(r.fall.vy, -9.80665 * 2, 0.02, 'without air the aircraft is in free fall');
    near(r.fall.dy, -0.5 * 9.80665 * 4, 0.2, 'ballistic drop distance');
  });

  test('energy sanity: hands-off glide never gains total energy', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      sim.loadScenario('engout');
      const energy = () => 9.80665 * sim.pos.y + 0.5 * sim.vel.lengthSq();
      let prev = energy();
      let worst = 0;
      for (let i = 0; i < 120 * 40; i++) { T.step(1); const e = energy(); worst = Math.max(worst, e - prev); prev = e; }
      return { worst };
    });
    assert.ok(r.worst <= 1e-6, `specific energy must only decrease in a power-off glide (max gain ${r.worst})`);
  });

  test('fuzz: random control abuse never produces NaN in any airframe', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (const ac of ['skyhawk', 'viper', 'heavy']) {
        T.reset(ac);
        sim.setEnv({ wind: 35, windDir: 250, turb: 8 });
        let ok = true, crashes = 0;
        for (const sc of ['runway', 'final', 'cruise', 'engout']) {
          sim.loadScenario(sc);
          sim.controls.parkingBrake = false;
          for (let i = 0; i < 60 && ok; i++) {
            sim.input.pitch = rnd() * 2 - 1; sim.input.roll = rnd() * 2 - 1; sim.input.yaw = rnd() * 2 - 1;
            sim.controls.throttle = rnd();
            sim.controls.flaps = [0, 15, 30][Math.floor(rnd() * 3)];
            sim.advance(0.5);
            ok = T.finite();
            if (sim.crashed) { crashes++; break; }
          }
        }
        out[ac] = { ok, crashes };
      }
      sim.input.pitch = sim.input.roll = sim.input.yaw = null;
      return out;
    });
    for (const ac of Object.keys(r)) assert.ok(r[ac].ok, `${ac} state stayed finite`);
  });
});

describe('airframes', () => {
  for (const ac of ['skyhawk', 'viper', 'heavy']) {
    test(`${ac}: rests on its gear, takes off from RWY 36 and climbs`, async () => {
      const r = await page.evaluate((key) => {
        T.reset(key);
        sim.advance(5);
        const rest = T.state();
        sim.controls.parkingBrake = false;
        sim.controls.throttle = 1;
        const vr = sim.stallSpeed(15) * 1.1 * 1.94384;
        let liftoffZ = null;
        for (let i = 0; i < 120 * 70; i++) {
          const t = sim.telemetry;
          sim.input.pitch = (t.ias > vr && t.pitchDeg < 8) ? 0.5 : (t.pitchDeg > 12 ? -0.2 : 0);
          T.step(1);
          if (liftoffZ === null && t.wheelsOnGround === 0 && t.altAGL > 3) liftoffZ = sim.pos.z;
          if (sim.crashed || sim.telemetry.altAGL > 500) break;
        }
        sim.input.pitch = null;
        return { rest, end: T.state(), liftoffZ };
      }, ac);
      assert.equal(r.rest.telemetry.wheelsOnGround, 3);
      assert.ok(Math.hypot(...r.rest.vel) < 0.01, 'stationary at rest');
      assert.ok(Math.abs(r.rest.telemetry.pitchDeg) < 4 && Math.abs(r.rest.telemetry.rollDeg) < 0.5, 'sits level on the gear');
      assert.equal(r.end.crashed, false, r.end.crashReason || '');
      assert.ok(r.liftoffZ !== null && r.liftoffZ > -1500, `airborne before the far end of the runway (z=${r.liftoffZ})`);
      assert.ok(r.end.telemetry.altAGL > 500, `climbs away (${r.end.telemetry.altAGL} ft AGL)`);
    });

    test(`${ac}: trimmed cruise is steady and the autopilot holds altitude and heading in turbulence`, async () => {
      const r = await page.evaluate((key) => {
        T.reset(key);
        sim.loadScenario('cruise');
        const start = T.state();
        sim.advance(20);
        const handsOff = T.state();
        sim.setEnv({ turb: 3, wind: 15, windDir: 270 });
        sim.loadScenario('cruise');
        sim.toggleAutopilot();
        const hdg0 = sim.telemetry.headingDeg;
        let maxAlt = 0;
        for (let i = 0; i < 120 * 90; i++) { T.step(1); if (i > 120 * 20) maxAlt = Math.max(maxAlt, Math.abs(sim.pos.y - 1524)); }
        const ap = T.state();
        sim.toggleAutopilot();
        return { start, handsOff, ap, maxAlt, hdg0 };
      }, ac);
      assert.ok(Math.abs(r.handsOff.pos[1] - r.start.pos[1]) < 25, `hands-off altitude drift ${r.handsOff.pos[1] - r.start.pos[1]} m`);
      assert.ok(Math.abs(r.handsOff.telemetry.ias - r.start.telemetry.ias) < 4, 'airspeed holds in trim');
      assert.equal(r.ap.crashed, false);
      assert.ok(r.maxAlt < 20, `autopilot altitude error ${r.maxAlt} m`);
      const dh = ((r.ap.telemetry.headingDeg - r.hdg0 + 540) % 360) - 180;
      assert.ok(Math.abs(dh) < 4, `autopilot heading error ${dh} deg`);
      assert.ok(Math.abs(r.ap.telemetry.rollDeg) < 8);
    });

    test(`${ac}: ILS final is established on a stable 3-degree descent`, async () => {
      const r = await page.evaluate((key) => {
        T.reset(key);
        sim.loadScenario('final');
        const start = T.state();
        sim.advance(25);
        return { start, end: T.state() };
      }, ac);
      assert.equal(r.end.crashed, false);
      near(r.start.telemetry.ilsGsErrorDeg, 0, 0.05, 'starts on the glideslope');
      assert.ok(Math.abs(r.end.telemetry.ilsGsErrorDeg) < 0.6, `stays near the glideslope (${r.end.telemetry.ilsGsErrorDeg})`);
      assert.ok(r.end.telemetry.vsi < -150, 'descending');
      assert.ok(Math.abs(r.end.telemetry.ias - r.start.telemetry.ias) < 8, 'approach speed is stable');
      assert.equal(r.end.telemetry.stall, false);
    });
  }

  test('structural limits: over-G and flutter break the airframe; the elevator alone cannot', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      // Full aft stick at cruise: load-limited elevator must stay inside the 1.25x ultimate margin
      sim.loadScenario('cruise');
      sim.input.pitch = 1;
      let peakG = 0;
      for (let i = 0; i < 120 * 3 && !sim.crashed; i++) { T.step(1); peakG = Math.max(peakG, sim.telemetry.gLoad); }
      const pull = { crashed: sim.crashed, reason: sim.crashReason, peakG };
      sim.input.pitch = null;
      // A vertical dive past Vne * 1.18 must end in flutter
      T.place({ h: 4000, vz: -1, vy: -80, pitch: -85, throttle: 1 });
      // Hold the nose down: a stable airframe would otherwise pull itself out of the dive
      T.until(() => { sim.input.pitch = sim.telemetry.pitchDeg > -75 ? -0.7 : 0; return sim.crashed; }, 40);
      sim.input.pitch = null;
      const dive = { crashed: sim.crashed, reason: sim.crashReason };
      // An abrupt gust-like AoA at high speed overloads the spar
      T.place({ h: 1500, vz: -80, pitch: 14 });
      T.until(() => sim.crashed, 2);
      const overG = { crashed: sim.crashed, reason: sim.crashReason };
      return { pull, dive, overG, maxG: sim.spec.maxG };
    });
    assert.equal(r.pull.crashed, false, `full stick must not break the wing (${r.pull.reason})`);
    assert.ok(r.pull.peakG > 2.5 && r.pull.peakG < r.maxG * 1.25, `peak ${r.pull.peakG} G`);
    assert.equal(r.dive.crashed, true);
    assert.match(r.dive.reason, /flutter|Vne/i);
    assert.equal(r.overG.crashed, true);
    assert.match(r.overG.reason, /spar failure/i);
  });

  test('ground handling: brakes stop the aircraft, and a contaminated runway takes longer', async () => {
    const r = await page.evaluate(() => {
      const stopDistance = (surface) => {
        T.reset('skyhawk');
        sim.setEnv({ surface });
        T.place({ z: 1200, h: 0.02, vz: -30, vy: 0, pitch: 1 });
        sim.wasAirborne = false;
        sim.keys['Space'] = true;
        const z0 = sim.pos.z;
        const t = T.until(() => Math.hypot(sim.vel.x, sim.vel.z) < 0.2, 120);
        sim.keys = {};
        return { t, dist: z0 - sim.pos.z, x: sim.pos.x, crashed: sim.crashed };
      };
      const dry = stopDistance('1.0');
      const icy = stopDistance('0.25');
      // Nosewheel steering: rudder at taxi speed turns the aircraft on the ground
      T.reset('skyhawk');
      sim.controls.parkingBrake = false;
      sim.controls.throttle = 0.5;
      sim.advance(4);
      sim.input.yaw = -1; // right rudder
      sim.advance(3);
      sim.input.yaw = null;
      const taxi = T.state();
      // Building collision
      T.place({ x: 100, z: -180, h: 20, vx: 40, vz: 0, yaw: -90 });
      T.until(() => sim.crashed, 3);
      return { dry, icy, taxi, building: { crashed: sim.crashed, reason: sim.crashReason } };
    });
    assert.ok(r.dry.t > 0 && r.icy.t > 0, 'both runs come to a stop');
    assert.ok(r.dry.dist > 40 && r.dry.dist < 200, `dry stopping distance ${r.dry.dist} m`);
    assert.ok(r.icy.dist > r.dry.dist * 2, `ice at least doubles the stop (${r.icy.dist} vs ${r.dry.dist})`);
    assert.ok(Math.abs(r.dry.x) < 3, 'tracks straight under braking');
    assert.ok(r.taxi.telemetry.headingDeg > 5 && r.taxi.telemetry.headingDeg < 180, `right rudder steers right (${r.taxi.telemetry.headingDeg})`);
    assert.equal(r.taxi.telemetry.wheelsOnGround, 3);
    assert.equal(r.building.crashed, true);
    assert.match(r.building.reason, /structure|building/i);
  });

  test('belly landing: gear-up touchdown scrapes, sparks and fails the prop without exploding', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ z: 900, h: -0.6, vz: -30, vy: -0.8, pitch: 4, gear: false, flaps: 30 });
      T.until(() => sim.lastTouchdown !== null || sim.crashed, 5);
      let sparks = 0;
      for (let i = 0; i < 120 * 2; i++) { T.step(1); sparks = Math.max(sparks, sim.particles.length); }
      const t = T.until(() => Math.hypot(sim.vel.x, sim.vel.z) < 0.3, 60);
      return { end: T.state(), sparks, t, title: T.text('ldg-title'), details: T.text('ldg-details') };
    });
    assert.equal(r.end.crashed, false, r.end.crashReason || '');
    assert.equal(r.end.damage.gearCollapsed, true);
    assert.equal(r.end.damage.engineFailed, true, 'prop strike on a belly landing');
    assert.ok(r.sparks > 0, 'sparks on the runway');
    assert.ok(r.t > 0, 'slides to a stop');
    assert.match(r.title, /DAMAGED/);
    assert.match(r.details, /BELLY LANDING/);
  });

  test('the page raised no JavaScript errors during the whole physics run', () => {
    assert.deepEqual(errors, []);
  });
});
