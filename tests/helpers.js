// Shared harness: launches headless Chromium, opens index.html straight from disk
// (the same way a player would) and installs deterministic test helpers on the page.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const INDEX_URL = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;

async function launch() {
  return chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
  });
}

// Opens the simulator. With manual = true the page's real-time clock is detached, so
// physics only moves when a test calls sim.advance() / sim.tick().
async function openSim(browser, { manual = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(INDEX_URL);
  await page.waitForFunction(() => window.sim && window.sim.telemetry);
  await page.evaluate((manualClock) => {
    sim.manualClock = manualClock;
    const E = 30; // airport elevation, m MSL

    window.T = {
      // Calm, standard-day atmosphere and a fresh aircraft.
      reset(ac = 'skyhawk') {
        sim.setEnv({ time: 14, wind: 0, windDir: 0, turb: 0, temp: 0, qnh: 1013, fog: 0.00006, surface: '1.0' });
        sim.input.pitch = sim.input.roll = sim.input.yaw = null;
        sim.keys = {};
        sim.paused = false;
        if (sim.controls.assistMode) sim.toggleAssist();
        sim.selectAircraft(ac); // also loads the runway scenario
      },
      // Put the aircraft in an arbitrary airborne state. h = wheel height above the runway (m),
      // angles in degrees (roll: right-wing-down positive), speeds in m/s (vz < 0 is northbound).
      place({ x = 0, z = 0, h = 100, y = null, vx = 0, vy = 0, vz = -40, pitch = 0, roll = 0, yaw = 0,
              throttle = 0, flaps = 0, gear = true, trim = 0 } = {}) {
        sim.loadScenario('cruise');
        const d = Math.PI / 180;
        sim.pos.set(x, y !== null ? y : E + sim.spec.gearHeight + h, z);
        sim.vel.set(vx, vy, vz);
        sim.quat.setFromEuler(new THREE.Euler(pitch * d, yaw * d, -roll * d, 'YXZ'));
        sim.angVel.set(0, 0, 0);
        sim.controls.throttle = throttle;
        sim.controls.engineRpm = throttle;
        sim.controls.flaps = flaps;
        sim.controls.gear = gear;
        sim.controls.trim = trim;
        sim.wasAirborne = true;
      },
      step(n = 1) { for (let i = 0; i < n; i++) sim.stepPhysics(sim.FIXED_DT); },
      // Advance until pred() is true or the time budget runs out. Returns elapsed seconds or -1.
      until(pred, maxSeconds) {
        const n = Math.round(maxSeconds / sim.FIXED_DT);
        for (let i = 0; i < n; i++) {
          sim.stepPhysics(sim.FIXED_DT);
          if (pred()) return (i + 1) * sim.FIXED_DT;
        }
        return -1;
      },
      state() {
        const t = sim.telemetry;
        return {
          pos: sim.pos.toArray(), vel: sim.vel.toArray(), quat: sim.quat.toArray(), angVel: sim.angVel.toArray(),
          telemetry: { ...t }, controls: { ...sim.controls }, damage: { ...sim.damage },
          crashed: sim.crashed, crashReason: sim.crashReason, lastTouchdown: sim.lastTouchdown,
          fuel: sim.fuelMass, simTime: sim.simTime, stepCount: sim.stepCount,
          debris: sim.debrisList.length, particles: sim.particles.length
        };
      },
      finite() {
        return [...sim.pos.toArray(), ...sim.vel.toArray(), ...sim.quat.toArray(), ...sim.angVel.toArray(),
          ...Object.values(sim.telemetry).filter((v) => typeof v === 'number')].every(Number.isFinite);
      },
      visible(id) { return getComputedStyle(document.getElementById(id)).display !== 'none'; },
      text(id) { return document.getElementById(id).innerText; }
    };
  }, manual);
  return { page, errors };
}

module.exports = { launch, openSim, INDEX_URL };
