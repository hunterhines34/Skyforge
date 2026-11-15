# SKYFORGE

A flight simulator that runs in the browser and flies over the real Earth: streamed terrain,
satellite imagery and OpenStreetMap buildings around any of 9,264 airports, with a physically
governed 6-DOF flight model, three airframes, live weather, a glass-cockpit HUD with ILS and
procedural audio. An offline island world is built in for flying without a network.

The original brief is in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md).

## Run it

No build step and no install are needed to play:

- **Double-click `index.html`**, or
- `npm start` and open <http://localhost:8080> (zero-dependency static server in `tools/serve.js`).

It starts on runway 26 at Innsbruck (LOWI). Type an ICAO code or airport name in **AIRPORT**,
pick a runway and press **FLY** to go anywhere else; the choice is kept in the URL
(`?world=earth&apt=KSFO&rwy=28R`) so it can be bookmarked or shared.

### Worlds

| World | What you get | Needs network |
| --- | --- | --- |
| Earth - Esri imagery (default) | Real elevation, sharp satellite imagery (about 1 m), OSM buildings and water | yes |
| Earth - Sentinel-2 imagery | Same, with openly licensed 10 m imagery | yes |
| Offline island | Procedural island with forests, ocean and a full airport | no |

If the map services cannot be reached, the sim falls back to the island by itself.

### Data sources and attribution

Nothing is bundled except the airport list; map data is fetched by the browser while you fly,
and credits are shown at the bottom of the screen.

| Data | Source | Terms |
| --- | --- | --- |
| Elevation | Mapzen Terrarium tiles on AWS Open Data | Open; attribution to Mapzen and its sources |
| Imagery (default) | Esri World Imagery | Esri terms of use; attribution required. **Check these before any public or commercial deployment** |
| Imagery (alternative) | Sentinel-2 cloudless 2016 by EOX | CC BY 4.0 |
| Buildings, water | OpenStreetMap via OpenFreeMap vector tiles | ODbL |
| Airports, runways | OurAirports (`tools/build-airports.js` regenerates `js/airports-data.js`) | Public domain |
| Weather | Open-Meteo | CC BY 4.0 |

### Graphics

Quality is chosen automatically (and steps down if the frame rate is poor); the **GFX** button
or `?gfx=low|medium|high` overrides it. three.js r170 is bundled in `vendor/` together with its
post-processing passes (`tools/three-entry.js` is the bundle entry point).

## Test it

```bash
npm install                        # installs Playwright (the only dev dependency)
npx playwright install chromium    # one-time browser download
npm test                           # everything (~3 min on a software renderer)
npm run test:physics               # deterministic physics only (~10 s)
npm run test:ui                    # boot, controls, real-time loop
npm run test:earth                 # real-Earth world against mocked map services
```

Tests open `index.html` from disk in headless Chromium, exactly as a player would. They need no
network: the physics and UI suites run on the island world, and the Earth suite intercepts every
map and weather request and answers with synthetic tiles.
CI runs the same suite on every push and pull request (`.github/workflows/test.yml`).

| File | What it covers |
| --- | --- |
| `tests/physics.test.js` | The blueprint's 15-point QA matrix (tests `01`-`15` map one-to-one), the anti-shortcut guardrails (no kinematic cheating, no energy gain, NaN fuzzing), and takeoff / cruise / autopilot / ILS for each airframe |
| `tests/ui.test.js` | Page boot, every slider and button, warning annunciators, audio, keyboard and mouse through the real `requestAnimationFrame` loop |
| `tests/earth.test.js` | Earth world: runway frame and datum, runway grading, render/physics height agreement, projection, take-off, building and water collisions, live weather, airport picker, offline fallback |
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

## How it works

**Physics** (`index.html`, SI units, one fixed 1/120 s step in `stepPhysics`):

1. Pilot input, autopilot / assist, actuator lag, engine spool and fuel burn
2. ISA atmosphere (temperature offset and QNH) and the 3D wind + gust field
3. Relative airflow, angle of attack and sideslip (guarded below 0.1 m/s)
4. Lift, drag, side force and thrust; aerodynamic moments about all three axes
5. Ground contact: three gear spring-dampers plus airframe skid points (nose/prop, belly, tail,
   wingtips), each applying force **and torque** at its contact point
6. Rigid-body integration: Euler's rotation equations and a quaternion attitude update

Nothing translates or rotates the aircraft directly; motion only comes from summed forces and torques.

**Earth world** (`js/earth.js`): the local frame is a flat tangent plane centred on the chosen
runway and rotated so the runway heading is the simulator's -Z axis, which lets the scenarios,
ILS and tests work identically at every airport (the HUD converts back to true headings).
Elevation tiles are decoded into height grids that serve both the renderer and the physics
through one function, `heightAt`. Runways from the airport database are graded level in that
function, because raw elevation data is too rough to land on. Terrain is a quadtree of imagery
tiles refined by distance; buildings are extruded from OSM footprints and, with OSM water
polygons, kept in a spatial hash so the aircraft can collide with them.

**Rendering** (`js/gfx-*.js`): procedural sky with sun, twilight and stars, image-based lighting
re-baked from the sky, sprite clouds, rain, an animated ocean shader, shadows, bloom and ACES
tone mapping. Aircraft are generated in code (lofted wings, bodies of revolution, painted liveries).

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
  under the water plane, and airframes are modelled at true size (the heavy jet was 185 m wide).
- **Added:** sea-level pressure (QNH) slider required by the contract, runway/approach lights and
  PAPI, belly/wingtip/prop contact points, sparks, scenario auto-trim with crosswind crab,
  heading hold on the autopilot, and a load-limited elevator.
- **Several files instead of one.** Libraries are vendored and the graphics and Earth layers
  live in `js/`, all loaded as plain scripts so `index.html` still opens straight from disk.
- **A real-Earth world and a new renderer** were added on top of the blueprint's scope.

## Known limits

- The Earth is treated as flat around the departure runway; this is accurate for flights of a
  couple of hundred kilometres, not for crossing continents.
- Only the departure runway gets painted markings, lights and an ILS. Other runways are graded
  and visible in the imagery.
- Trees and roads appear only as imagery in the Earth world; buildings are simple extrusions.
- There is no 3D cockpit, air traffic or ATC.

## Layout

```
index.html                 the simulator (markup, styles, physics, HUD, world selection)
js/earth.js                real-Earth streaming world (elevation, imagery, OSM buildings/water)
js/gfx-env.js              sky, stars, clouds, ocean, rain, procedural textures
js/gfx-world.js            island terrain shading, forests, airport and runway
js/gfx-aircraft.js         procedural aircraft models
js/airports-data.js        generated airport / runway database
vendor/                    three.js r170 bundle, simplex-noise 2.4.0 (+ licences)
tests/                     Playwright-driven test suites
tools/                     local server, airport-database builder, three.js bundle entry
docs/BLUEPRINT.md          original specification
```
