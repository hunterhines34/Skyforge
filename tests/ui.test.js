// Browser-level tests: the page boots from disk, every control is live, and the
// real-time loop (requestAnimationFrame + keyboard) actually flies the aircraft.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { launch, openSim } = require('./helpers');

let browser;

before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

describe('boot & UI wiring', () => {
  let page;
  let errors;
  before(async () => { ({ page, errors } = await openSim(browser, { manual: true })); });
  after(async () => { await page.close(); });

  test('launches straight into an active runway scene with WebGL and the HUD', async () => {
    const r = await page.evaluate(() => ({
      three: THREE.REVISION,
      world: sim.worldMode,
      canvas: !!document.querySelector('#canvas-container canvas'),
      gl: !!sim.renderer.getContext(),
      drawCalls: sim.renderer.info.render.calls,
      triangles: sim.renderer.info.render.triangles,
      hud: sim.hudCanvas.width > 0,
      scenario: { z: sim.pos.z, brake: sim.controls.parkingBrake, flaps: sim.controls.flaps },
      aircraft: [...document.querySelectorAll('#aircraft-select option')].map((o) => o.value)
    }));
    assert.equal(r.three, '170');
    assert.ok(r.canvas && r.gl && r.hud);
    assert.ok(r.drawCalls > 20 && r.triangles > 100000, `scene is rendering (${r.drawCalls} calls, ${r.triangles} tris)`);
    assert.equal(r.world, 'island');
    assert.deepEqual(r.aircraft, ['skyhawk', 'viper', 'heavy']);
    near(r.scenario.z, 1360, 1);
    assert.equal(r.scenario.brake, true);
  });

  test('no dead sliders: every environment control changes both the scene and the physics', async () => {
    const set = (id, value) => page.evaluate(([i, v]) => {
      const el = document.getElementById(i);
      el.value = v;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }, [id, value]);
    const probe = () => page.evaluate(() => {
      const w = sim.windAt(0, 300, 0, 1.5, new THREE.Vector3());
      const atm = sim.atmosphere(0);
      return {
        sky: sim.skyState.horizon, sun: sim.sunLight.intensity, fog: sim.scene.fog.density,
        lights: sim.runwayLights.material.opacity, wind: w.toArray(), rho: atm.rho, mu: sim.env.surfaceFrictionMult,
        labels: ['val-time', 'val-wind', 'val-wind-dir', 'val-turb', 'val-temp', 'val-qnh', 'val-fog'].map((i) => document.getElementById(i).innerText)
      };
    });
    await page.evaluate(() => T.reset('skyhawk'));
    const base = await probe();

    await set('env-time', 23);
    const night = await probe();
    assert.notEqual(night.sky, base.sky, 'time of day recolours the sky');
    assert.ok(night.sun < base.sun * 0.25, 'night swaps the sun for dim moonlight');
    assert.ok(night.lights > base.lights, 'runway lights come up at night');
    assert.equal(night.labels[0], '23:00');

    await set('env-wind', 30);
    await set('env-wind-dir', 90);
    const windy = await probe();
    near(windy.wind[0], -30 * 0.514444, 1e-6, 'wind from 090 blows toward -X');
    assert.equal(windy.labels[1], '30 KT');
    assert.equal(windy.labels[2], '090°');

    await set('env-turb', 8);
    const gusty = await probe();
    assert.ok(Math.hypot(gusty.wind[0] - windy.wind[0], gusty.wind[1], gusty.wind[2]) > 0.5, 'turbulence perturbs the wind vector');

    await set('env-temp', 30);
    const hot = await probe();
    assert.ok(hot.rho < base.rho * 0.92);
    assert.equal(hot.labels[4], '+30 °C');

    await set('env-temp', 0);
    await set('env-qnh', 960);
    const low = await probe();
    near(low.rho / base.rho, 960 / 1013, 1e-3, 'density scales with QNH');
    assert.equal(low.labels[5], '960 hPa');

    await set('env-fog', 0.0006);
    const foggy = await probe();
    near(foggy.fog, 0.0006, 1e-9, 'fog slider drives scene fog');
    assert.equal(foggy.labels[6], 'IMC FOG');

    await set('env-surface', '0.25');
    assert.equal((await probe()).mu, 0.25);
  });

  test('weather presets and scenario / airframe buttons work through real clicks', async () => {
    await page.evaluate(() => T.reset('skyhawk'));
    await page.click('text=IMC STORM');
    let r = await page.evaluate(() => ({ wind: sim.env.windSpeed, turb: sim.env.turbulence, fog: T.text('val-fog') }));
    near(r.wind, 42 * 0.514444, 1e-6);
    assert.equal(r.turb, 7.5);
    assert.equal(r.fog, 'IMC FOG');

    await page.click('text=SUNNY MIDDAY');
    await page.click('#top-left-panel >> text=ILS FINAL');
    r = await page.evaluate(() => ({ agl: sim.telemetry.altAGL, ils: sim.telemetry.ilsDistNM, gear: T.text('sys-gear') }));
    assert.ok(r.agl > 700 && r.ils > 2.4);
    assert.match(r.gear, /DOWN/);

    await page.click('text=X-WIND TEST');
    r = await page.evaluate(() => ({ wind: sim.env.windSpeed, hdg: sim.telemetry.headingDeg }));
    near(r.wind, 26 * 0.514444, 1e-6);
    assert.ok(r.hdg > 320 && r.hdg < 350, 'starts crabbed into the crosswind');

    await page.click('text=ENG OUT GLIDE');
    assert.match(await page.evaluate(() => T.text('dmg-eng')), /FAILED/);

    await page.click('text=REPAIR & REFUEL');
    assert.match(await page.evaluate(() => T.text('dmg-eng')), /OK/);

    await page.selectOption('#aircraft-select', 'heavy');
    r = await page.evaluate(() => ({ name: sim.spec.name, wheels: (sim.advance(3), sim.telemetry.wheelsOnGround), span: sim.spec.wingSpan }));
    assert.match(r.name, /748/);
    assert.equal(r.wheels, 3);

    for (const [label, id] of [['ASSIST: OFF', 'btn-assist'], ['AP HOLD: OFF', 'btn-ap']]) {
      await page.click(`text=${label}`);
      assert.match(await page.evaluate((i) => T.text(i), id), /ON/);
      await page.click(`#${id}`);
      assert.match(await page.evaluate((i) => T.text(i), id), /OFF/);
    }
    await page.click('text=CAM VIEW (C)');
    assert.equal(await page.evaluate(() => T.text('sys-cam')), 'COCKPIT VIEW');
    assert.equal(await page.evaluate(() => sim.aircraftGroup.visible), false);
    await page.evaluate(() => { while (sim.cameraMode !== 0) sim.cycleCamera(); });
  });

  test('Xbox controller: sticks, triggers and buttons fly the aircraft', async () => {
    const r = await page.evaluate(() => {
      // A virtual standard-mapping pad, as the browser reports an Xbox controller
      const mk = () => ({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), rumbles: 0,
        vibrationActuator: { playEffect() { pad.rumbles++; return Promise.resolve('complete'); } } });
      let pad = null;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
      const press = (i, v = 1) => { pad.buttons[i] = { pressed: v > 0.5, value: v }; };
      const release = (i) => { pad.buttons[i] = { pressed: false, value: 0 }; };
      const tap = (i) => { press(i); sim.pollGamepad(0.016); release(i); sim.pollGamepad(0.016); };
      const out = {};

      T.reset('skyhawk');
      sim.pollGamepad(0.016);
      out.before = { connected: sim.pad.connected, status: T.text('pad-status') };
      pad = mk();
      sim.pollGamepad(0.016);
      out.after = { connected: sim.pad.connected, status: T.text('pad-status') };

      // Dead zone, then stick -> surfaces through the physics step
      pad.axes = [0.08, -0.06, 0, 0];
      sim.pollGamepad(0.016);
      out.deadzone = [sim.pad.roll, sim.pad.pitch];
      sim.loadScenario('cruise');
      pad.axes = [1, 1, 0, 0];            // stick right and back
      press(7, 0.75);                     // RT: right rudder
      sim.pollGamepad(0.016);
      sim.advance(0.6);
      out.surfaces = { elevator: sim.controls.elevator, aileron: sim.controls.aileron, rudder: sim.controls.rudder, roll: sim.telemetry.rollDeg };
      pad.axes = [0, 0, 0, 0];
      release(7);

      // Throttle on the bumpers
      sim.loadScenario('runway');
      sim.controls.throttle = 0.2;
      press(5); sim.pollGamepad(0.016); sim.advance(1); release(5);
      out.throttleUp = sim.controls.throttle;
      press(4); sim.pollGamepad(0.016); sim.advance(0.5); release(4);
      sim.pollGamepad(0.016);
      out.throttleDown = sim.controls.throttle;
      sim.advance(0.5);
      out.throttleHeld = sim.controls.throttle;

      // Buttons
      sim.controls.throttle = 0;
      tap(1); out.parkOff = sim.controls.parkingBrake;
      tap(1); out.parkOn = sim.controls.parkingBrake;
      press(0); sim.pollGamepad(0.016); sim.advance(0.1); out.brakeHeld = sim.controls.wheelBrakes;
      release(0); sim.pollGamepad(0.016); sim.advance(0.1); out.brakeReleased = sim.controls.wheelBrakes;
      const flaps0 = sim.controls.flaps;
      tap(15); out.flapsDown = sim.controls.flaps - flaps0;
      tap(14); tap(14); out.flapsUp = sim.controls.flaps;
      const trim0 = sim.controls.trim;
      tap(13); out.trimUp = sim.controls.trim - trim0;
      tap(12); tap(12); out.trimDown = sim.controls.trim - trim0;
      tap(2); out.gearOnGround = sim.controls.gear;
      const cam0 = sim.cameraMode;
      tap(3); out.camera = sim.cameraMode - cam0;
      while (sim.cameraMode !== 0) sim.cycleCamera();
      tap(10); out.autopilot = sim.controls.autopilot;
      tap(10);
      tap(9); out.paused = sim.paused;
      tap(1); out.parkWhilePaused = sim.controls.parkingBrake;
      tap(9); out.resumed = sim.paused;

      // Gear works in the air; right stick looks around; View resets
      sim.loadScenario('cruise');
      sim.advance(0.1);
      tap(2); out.gearInFlight = sim.controls.gear;
      pad.axes = [0, 0, 1, 0];
      sim.pollGamepad(0.1);
      out.look = sim.camYaw;
      pad.axes = [0, 0, 0, 0];
      tap(11); out.lookReset = sim.camYaw;
      tap(8); out.reset = { z: sim.pos.z, brake: sim.controls.parkingBrake };

      // Rumble on a hard touchdown; unplugging zeroes the inputs
      T.place({ z: 900, h: 0.03, vz: -30, vy: -3, pitch: 3, flaps: 15 });
      sim.pollGamepad(0.016);
      T.until(() => sim.lastTouchdown !== null, 3);
      out.rumbles = pad.rumbles;
      pad.axes = [1, 1, 0, 0];
      sim.pollGamepad(0.016);
      pad = null;
      sim.pollGamepad(0.016);
      out.unplugged = { connected: sim.pad.connected, pitch: sim.pad.pitch, roll: sim.pad.roll, status: T.text('pad-status') };
      return out;
    });
    assert.equal(r.before.connected, false);
    assert.match(r.before.status, /NOT DETECTED/);
    assert.equal(r.after.connected, true);
    assert.match(r.after.status, /CONNECTED.*Xbox Wireless Controller/);
    assert.deepEqual(r.deadzone, [0, 0], 'stick noise inside the dead zone is ignored');
    assert.ok(r.surfaces.elevator > 0.5, `stick back pulls (${r.surfaces.elevator})`);
    assert.ok(r.surfaces.aileron < -0.5, `stick right rolls right (${r.surfaces.aileron})`);
    assert.ok(r.surfaces.rudder < -0.3 && r.surfaces.rudder > -0.9, `RT is analog right rudder (${r.surfaces.rudder})`);
    assert.ok(r.surfaces.roll > 5, `aircraft banks right (${r.surfaces.roll} deg)`);
    near(r.throttleUp, 0.7, 0.02, 'RB advances the throttle smoothly');
    near(r.throttleDown, 0.45, 0.02, 'LB retards the throttle');
    near(r.throttleHeld, r.throttleDown, 1e-9, 'throttle holds when the bumpers are released');
    assert.equal(r.parkOff, false);
    assert.equal(r.parkOn, true);
    assert.equal(r.brakeHeld, true);
    assert.equal(r.brakeReleased, false);
    assert.equal(r.flapsDown, 15);
    assert.equal(r.flapsUp, 0);
    near(r.trimUp, 0.01, 1e-9);
    near(r.trimDown, -0.01, 1e-9);
    assert.equal(r.gearOnGround, true, 'gear lever stays locked on the ground');
    assert.equal(r.camera, 1);
    assert.equal(r.autopilot, true);
    assert.equal(r.paused, true);
    assert.equal(r.parkWhilePaused, true, 'flight buttons are ignored while paused');
    assert.equal(r.resumed, false);
    assert.equal(r.gearInFlight, true, 'X lowers the gear in flight');
    assert.ok(r.look < -0.1, 'right stick pans the camera');
    assert.equal(r.lookReset, 0);
    assert.equal(r.reset.brake, true);
    assert.ok(r.rumbles >= 1, 'touchdown triggers controller rumble');
    assert.deepEqual({ ...r.unplugged, status: undefined }, { connected: false, pitch: 0, roll: 0, status: undefined });
    assert.match(r.unplugged.status, /NOT DETECTED/);
  });

  test('audio engine starts on demand and tracks the engine', async () => {
    await page.click('#btn-audio');
    const r = await page.evaluate(() => ({ label: T.text('btn-audio'), state: sim.sound.ctx && sim.sound.ctx.state, enabled: sim.sound.enabled }));
    assert.equal(r.label, 'AUDIO: ON');
    assert.equal(r.enabled, true);
    await page.click('#btn-audio');
    assert.equal(await page.evaluate(() => T.text('btn-audio')), 'AUDIO: OFF');
  });

  test('warning annunciators follow telemetry', async () => {
    const r = await page.evaluate(() => {
      T.reset('skyhawk');
      T.place({ h: 40, vz: -40, vy: -9, gear: false, throttle: 0 });
      T.step(2);
      sim.updateUI();
      const low = { gpws: T.visible('warn-gpws'), gear: T.visible('warn-gear'), stall: T.visible('warn-stall') };
      T.place({ h: 1500, vz: -100, pitch: 0 });
      T.step(1);
      sim.updateUI();
      return { low, overspeed: T.visible('warn-overspeed') };
    });
    assert.deepEqual(r.low, { gpws: true, gear: true, stall: false });
    assert.equal(r.overspeed, true);
  });

  test('no JavaScript errors were raised', () => assert.deepEqual(errors, []));
});

describe('real-time loop & keyboard', () => {
  let page;
  let errors;
  before(async () => { ({ page, errors } = await openSim(browser, { manual: false })); });
  after(async () => { await page.close(); });

  test('requestAnimationFrame drives fixed-step physics in real time', async () => {
    const a = await page.evaluate(() => ({ steps: sim.stepCount, frames: sim.frameCount, t: performance.now() }));
    await page.waitForFunction((f) => sim.frameCount >= f + 6, a.frames, { timeout: 60000 });
    const b = await page.evaluate(() => ({ steps: sim.stepCount, frames: sim.frameCount, t: performance.now(), fps: T.text('fps-counter') }));
    const seconds = (b.t - a.t) / 1000;
    const steps = b.steps - a.steps;
    assert.ok(steps > 0, 'physics advances with rendered frames');
    assert.ok(steps <= 120 * seconds + 8, `never faster than real time (${steps} steps in ${seconds.toFixed(2)} s)`);
    assert.ok(steps <= (b.frames - a.frames + 1) * 6, 'at most 0.05 s of physics per frame');
    assert.match(b.fps, /\d+ FPS/);
  });

  test('keyboard: brake release, throttle, flaps, trim, camera, pause, autopilot, reset', async () => {
    const st = () => page.evaluate(() => ({ ...sim.controls, cam: sim.cameraMode, paused: sim.paused, z: sim.pos.z, steps: sim.stepCount,
      gs: sim.telemetry.gs, pb: T.text('sys-pbrake'), flapsText: T.text('sys-flaps') }));
    await page.keyboard.press('KeyB');
    assert.equal((await st()).parkingBrake, false);
    assert.equal((await st()).pb, 'RELEASED');

    await page.keyboard.press('Digit0');
    assert.equal((await st()).throttle, 1);
    await page.keyboard.press('Digit1');
    assert.equal((await st()).throttle, 0);
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => sim.controls.throttle > 0.05, null, { timeout: 30000 });
    await page.keyboard.up('ShiftLeft');
    const thr = (await st()).throttle;
    assert.ok(thr > 0.05 && thr < 0.9, `smooth throttle ramps (${thr})`);

    await page.keyboard.press('BracketRight');
    assert.equal((await st()).flaps, 30);
    await page.keyboard.press('BracketLeft');
    await page.keyboard.press('BracketLeft');
    assert.equal((await st()).flaps, 0);
    assert.match((await st()).flapsText, /CLEAN/);

    const trim0 = (await st()).trim;
    await page.keyboard.press('Home');
    assert.ok((await st()).trim > trim0);
    await page.keyboard.press('End');

    await page.keyboard.press('KeyC');
    assert.equal((await st()).cam, 1);
    await page.keyboard.press('KeyC');
    await page.keyboard.press('KeyC');
    await page.keyboard.press('KeyC');
    assert.equal((await st()).cam, 0);

    await page.keyboard.press('KeyG');
    assert.equal((await st()).gear, true, 'gear lever is locked out on the ground');

    await page.keyboard.press('Escape');
    const p1 = await st();
    await page.waitForTimeout(300);
    const p2 = await st();
    assert.equal(p1.paused, true);
    assert.equal(p2.steps, p1.steps, 'physics is frozen while paused');
    await page.keyboard.press('Escape');

    await page.keyboard.press('KeyP');
    assert.equal((await st()).autopilot, true);
    await page.keyboard.press('KeyP');

    // Full power: the aircraft must accelerate down the runway under thrust alone
    await page.keyboard.press('Digit0');
    await page.waitForFunction(() => sim.telemetry.gs > 15 && sim.pos.z < 1350, null, { timeout: 30000 });
    // Wheel brakes on SPACE (and SPACE must not re-trigger a focused button)
    await page.keyboard.press('Digit1');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => sim.controls.wheelBrakes && sim.telemetry.gs < 2, null, { timeout: 30000 });
    await page.keyboard.up('Space');

    await page.keyboard.press('KeyR');
    const reset = await st();
    near(reset.z, 1360, 0.5);
    assert.equal(reset.parkingBrake, true);
    assert.equal(reset.throttle, 0);
  });

  test('mouse drag looks around and scroll zooms without touching the flight controls', async () => {
    const box = await page.locator('#canvas-container').boundingBox();
    const before = await page.evaluate(() => ({ yaw: sim.camYaw, fov: sim.camera.fov, ail: sim.controls.aileron }));
    await page.mouse.move(box.width / 2, box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.width / 2 + 120, box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await page.mouse.wheel(0, -300);
    await page.waitForFunction((fov) => sim.camera.fov < fov, before.fov, { timeout: 5000 });
    const afterLook = await page.evaluate(() => ({ yaw: sim.camYaw, fov: sim.camera.fov, ail: sim.controls.aileron }));
    assert.notEqual(afterLook.yaw, before.yaw);
    assert.ok(afterLook.fov < before.fov);
    assert.ok(Math.abs(afterLook.ail) < 1e-6);
  });

  test('window resize keeps the renderer and HUD in sync', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({ hud: [sim.hudCanvas.width, sim.hudCanvas.height], aspect: sim.camera.aspect }));
    assert.deepEqual(r.hud, [900, 600]);
    near(r.aspect, 1.5, 1e-6);
  });

  test('no JavaScript errors were raised', () => assert.deepEqual(errors, []));
});

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: expected ${expected} +/- ${tol}, got ${actual}`);
}
