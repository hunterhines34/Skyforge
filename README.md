# SKYFORGE

A physically governed 6-DOF flight simulator that runs in the browser. Three airframes
(piston trainer, supersonic fighter, heavy jet), ISA atmosphere, 3D wind and turbulence,
spring-damper landing gear, stateful damage, a glass-cockpit HUD with ILS, and procedural audio.

Built from [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) (the v2.0 master build specification).

## Run it

No build step and no install are needed to play:

- **Double-click `index.html`**, or
- `npm start` and open <http://localhost:8080> (zero-dependency static server in `tools/serve.js`).

three.js r128 and simplex-noise 2.4.0 are vendored in `vendor/`, so the sim works offline.

## Test it

```bash
npm install                        # installs Playwright (the only dev dependency)
npx playwright install chromium    # one-time browser download
npm test                           # everything (~70 s)
npm run test:physics               # deterministic physics only (~10 s)
npm run test:ui                    # boot, controls, real-time loop
```

Tests open `index.html` from disk in headless Chromium, exactly as a player would.
CI runs the same suite on every push and pull request (`.github/workflows/test.yml`).

| File | What it covers |
| --- | --- |
| `tests/physics.test.js` | The blueprint's 15-point QA matrix (tests `01`-`15` map one-to-one), the anti-shortcut guardrails (no kinematic cheating, no energy gain, NaN fuzzing), and takeoff / cruise / autopilot / ILS for each airframe |
| `tests/ui.test.js` | Page boot, every slider and button, warning annunciators, audio, keyboard and mouse through the real `requestAnimationFrame` loop |
| `tests/helpers.js` | Harness and the in-page `T` helpers (`T.place`, `T.until`, `T.state`, ...) |

### Writing a physics test

The simulator exposes a deterministic clock so tests never depend on frame rate:

```js
sim.manualClock = true;   // detach physics from wall-clock time
sim.loadScenario('final'); // 'runway' | 'final' | 'crosswind' | 'engout' | 'cruise'
sim.setEnv({ wind: 26, windDir: 270, turb: 3 });
sim.input.pitch = 0.3;     // analog stick override, -1..1 (null = keyboard)
sim.advance(10);           // exactly 1200 fixed 1/120 s steps
sim.telemetry;             // aviation-unit readouts; sim.pos / vel / quat / angVel are SI
```

The same hooks work from the browser console while playing.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S`, `Up` / `Down` | Push / pull (pitch) |
| `A` / `D`, `Left` / `Right` | Roll |
| `Q` / `E` | Rudder, nosewheel steering |
| `Shift` / `Ctrl`, `1`-`0` | Throttle (smooth, or idle to full in steps) |
| `[` / `]` | Flaps 0 / 15 / 30 |
| `G` | Landing gear (locked on the ground) |
| `Space`, `B` | Wheel brakes, parking brake |
| `Home` / `End` | Pitch trim |
| `P` | Autopilot (altitude + heading hold) |
| `C` | Camera: chase, cockpit, orbit, tower |
| `R`, `Esc` | Reset to runway, pause |

Mouse drag looks around; scroll zooms.

## How the physics works

Everything lives in `index.html`, in SI units, in this order each 1/120 s step (`stepPhysics`):

1. Pilot input, autopilot / assist, actuator lag, engine spool and fuel burn
2. ISA atmosphere (temperature offset and QNH) and the 3D wind + gust field
3. Relative airflow, angle of attack and sideslip (guarded below 0.1 m/s)
4. Lift, drag, side force and thrust; aerodynamic moments about all three axes
5. Ground contact: three gear spring-dampers plus airframe skid points (nose/prop, belly, tail,
   wingtips), each applying force **and torque** at its contact point
6. Rigid-body integration: Euler's rotation equations and a quaternion attitude update

Nothing translates or rotates the aircraft directly; motion only comes from summed forces and torques.

## Where this differs from the blueprint's reference code

The blueprint embeds a reference `index.html`. Checked against the blueprint's own contract it had
defects, so the implementation keeps its UI, HUD and structure but replaces the physics core:

- **Rotation is torque-driven.** The reference steered angular velocity toward a commanded rate
  (so full stick rotated a parked aircraft) and computed gear torque without ever applying it.
  It now integrates inertia, stability derivatives and contact moments.
- **Sign and geometry fixes.** Lift was tilted aft instead of perpendicular to the airflow, the
  yaw and roll stability terms were destabilising, and the HUD horizon rolled the wrong way.
- **Lift is continuous at the stall.** The specified post-stall formula jumps *up* at the stall
  angle; the two branches are blended so lift peaks and then decays.
- **Prop thrust falls with airspeed** (constant shaft power), otherwise the trainer exceeded Vne
  in level flight.
- **Physics time is simulation time.** Gusts and stall buffet used `performance.now()`, which
  broke frame-rate independence (QA item 14).
- **Terrain is sampled from the rendered mesh**, the airport sits on a 30 m plateau instead of
  under the water plane, and airframes are drawn at true span (the heavy jet was 185 m wide).
- **Added:** sea-level pressure (QNH) slider required by the contract, runway/approach lights and
  PAPI, belly/wingtip/prop contact points, sparks, scenario auto-trim with crosswind crab,
  heading hold on the autopilot, and a load-limited elevator.
- **Two files instead of one.** The libraries are vendored next to `index.html` rather than
  loaded from a CDN, so the sim runs offline.

## Layout

```
index.html                 the simulator (markup, styles, all simulation code)
vendor/                    three.js r128, simplex-noise 2.4.0 (+ licences)
tests/                     Playwright-driven test suites
tools/serve.js             local static server
docs/BLUEPRINT.md          original specification
```
