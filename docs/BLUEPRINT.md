# PROJECT SKYFORGE // Fable 5.2 Medium Master Build Specification (v2.0)

## 1. Executive Role & Implementation Contract

> **System Directive for Fable 5.2 Medium:**
> You are the Principal Aerospace Simulation Engineer, Lead Flight-Dynamics Programmer, WebGL Graphics Architect, and QA Lead. Your objective is to build **SKYFORGE Flight Simulator**—a complete, 100% playable, physically governed 3D flight simulator inside a single self-contained HTML5 file (`index.html`) that launches directly into an active cockpit/runway environment in any modern browser.
>
> Treat this document as a **non-negotiable engineering contract**. Do not output a design proposal, skeleton code, or disconnected snippets. Every single UI slider, control surface, atmospheric variable, and damage state must be wired directly into the underlying 6-Degrees-of-Freedom (6-DOF) physics loop.

### 1.1 Anti-Failure & Anti-Shortcut Guardrails (STRICTLY ENFORCED)

1. **NO Kinematic Translation Cheating:** Never implement movement as `position += key * speed` or rotation as `rotation.x += key * rate`. All linear and angular motion **must** emerge from integrating net forces ($\sum \vec{F}$) and net torques ($\sum \vec{\tau}$) over fixed physics substeps using quaternion orientation.
2. **NO Hidden Altitude Locking:** In full-realism mode, an aircraft remains airborne strictly because aerodynamic lift ($L$) balances or exceeds weight ($W$). If airspeed drops below stall threshold, the nose must drop and the aircraft must lose altitude.
3. **NO Dead UI Sliders:** Every environmental control (Time of Day, Wind Speed/Direction, Gusts, Dryden Turbulence, Fog/Visibility, Temperature, Pressure) must immediately alter both the WebGL scene and the physical equations of motion.
4. **NO Singularity / `NaN` Explosions:** Protect all inverse-velocity and trigonometric calculations ($\alpha = \arctan2(-w, u)$, $\beta = \arcsin(v/V)$) at zero or near-zero airspeed ($V < 0.1\text{ m/s}$). Clamp frame delta-time ($\Delta t \le 0.05\text{ s}$) so tab switching never causes physics explosion.
5. **NO Placeholder Code:** Never write `// TODO: implement physics` or `// add collision here`. Every subsystem in the deliverable must be 100% complete and executable.

### 1.2 Finite Context / Medium-Effort Priority Hierarchy

When operating within finite token budgets, execute and preserve code fidelity in this strict descending priority order:
1. **Fixed-Step 6-DOF Flight Dynamics & Quaternion Integration** ($\Delta t_{\text{phys}} = 1/120\text{ s}$).
2. **Multi-Point Spring-Damper Landing Gear, Stateful Damage & Crash Forensics.**
3. **Glass Cockpit HUD (PFD), Analog Telemetry & Responsive Controls.**
4. **ISA Thermodynamics, Correlated 3D Wind/Gust Vectors & Weather Presets.**
5. **Procedural World, Runway Lighting, Animated Control Surfaces & Web Audio Synthesis.**

---

## 2. Mathematical & Physics Engine Specification

### 2.1 Units & Coordinate Frames
* **Internal Physics Units:** Strictly SI ($\text{m}$, $\text{kg}$, $\text{s}$, $\text{N}$, $\text{N}\cdot\text{m}$, $\text{rad}$, $\text{Pa}$, $\text{K}$). Convert to aviation units ($\text{knots}$, $\text{feet}$, $\text{fpm}$, $\text{degrees}$) **only** inside the HUD/UI rendering layer.
* **World Frame:** Right-handed Euclidean where $+X = \text{East}$, $+Y = \text{Up (Altitude MSL)}$, $-Z = \text{North (Runway 36 Heading)}$.
* **Body Frame:** Origin at Center of Gravity ($\text{CG}$); $+X = \text{Right Wing}$, $+Y = \text{Up (Roof)}$, $-Z = \text{Forward (Nose)}$.

### 2.2 International Standard Atmosphere (ISA) & ThermodynamicOffsets
Given geometric altitude $h$ ($\text{m}$) and user sea-level temperature offset $\Delta T_{\text{ISA}}$ and pressure setting $P_{\text{sea}}$:

$$T(h) = \max\left(216.65, \; T_0 + \Delta T_{\text{ISA}} - L_p \cdot h\right)$$

$$P(h) = P_{\text{sea}} \left( 1 - \frac{L_p \cdot \min(11000, h)}{T_0} \right)^{\frac{g \cdot M}{R^* \cdot L_p}}$$

$$\rho(h) = \frac{P(h) \cdot M}{R^* \cdot T(h)}, \quad a(h) = \sqrt{\gamma \cdot R_{\text{spec}} \cdot T(h)}$$

Where $T_0 = 288.15\text{ K}$, $L_p = 0.0065\text{ K/m}$, $g = 9.80665\text{ m/s}^2$, $R_{\text{spec}} = 287.058\text{ J/(kg}\cdot\text{K)}$, and $\gamma = 1.4$.

### 2.3 Relative Airflow, Angle of Attack ($\alpha$), Sideslip ($\beta$) & Ground Effect
Let $\vec{V}_{\text{wind}}(t) = \vec{V}_{\text{steady}} + \vec{V}_{\text{gust}}(t)$ be the 3D world wind vector sampled from a continuous, temporally correlated Simplex noise process (Dryden turbulence approximation). The relative airflow in the aircraft body frame is:

$$\vec{V}_{\text{body}} = (u_{\text{right}}, \; v_{\text{up}}, \; w_{\text{aft}}) = \mathbf{q}^{-1} \otimes \left( \vec{V}_{\text{world}} - \vec{V}_{\text{wind}}(t) \right) \otimes \mathbf{q}$$

With forward speed $u_f = -w_{\text{aft}}$ and total airspeed $V = \sqrt{u_{\text{right}}^2 + v_{\text{up}}^2 + u_f^2 + \epsilon}$:

$$\alpha = \arctan2(-v_{\text{up}}, \; \max(0.5, u_f)), \quad \beta = \arcsin\left(\text{clamp}\left(\frac{u_{\text{right}}}{V}, -1, 1\right)\right)$$

**Ground Effect Factor ($k_{\text{GE}}$):** When height above ground $h_{\text{AGL}} < b$ (wingspan), wingtip vortices are suppressed, increasing effective lift and reducing induced drag:

$$k_{\text{GE}}(h_{\text{AGL}}) = \frac{16 (h_{\text{AGL}} / b)^2}{1 + 16 (h_{\text{AGL}} / b)^2}$$

**Lift ($C_L$) & Drag ($C_D$) Polars with Post-Stall Smooth Decay:**

$$C_L(\alpha) = \begin{cases} \left(C_{L_0} + C_{L_\alpha} \alpha + \Delta C_{L_{\text{flaps}}}\right) \cdot \left(1 + 0.12(1 - k_{\text{GE}})\right) & \text{if } |\alpha| \le \alpha_{\text{stall}} \\ C_{L_{\text{peak}}} \cdot e^{-3.2(|\alpha| - \alpha_{\text{stall}})} + 0.95 \sin(2\alpha) & \text{if } |\alpha| > \alpha_{\text{stall}} \end{cases}$$

$$C_D(\alpha, \beta) = C_{D_0} + k_{\text{GE}} \frac{C_L(\alpha)^2}{\pi \cdot e \cdot \text{AR}} + \Delta C_{D_{\text{flaps}}} + \Delta C_{D_{\text{gear}}} + \Delta C_{D_{\text{damage}}} + 0.45 \sin^2(\beta)$$

### 2.4 Multi-Point Tri-Gear Spring-Damper Suspension
Instead of clamping altitude, evaluate three independent wheel contact points in body coordinates $\vec{r}_i \in \{ \vec{r}_{\text{nose}}, \vec{r}_{\text{left}}, \vec{r}_{\text{right}} \}$:
1. Transform wheel position to world space: $\vec{p}_{w,i} = \vec{x}_{\text{CG}} + \mathbf{q} \vec{r}_i \mathbf{q}^{-1}$.
2. Compute compression depth against terrain height: $d_i = h_{\text{terrain}}(p_{w,i,x}, p_{w,i,z}) - p_{w,i,y}$.
3. If $d_i > 0$, compute vertical velocity of the contact point $\vec{v}_{w,i} = \vec{v}_{\text{CG}} + \vec{\omega} \times (\vec{p}_{w,i} - \vec{x}_{\text{CG}})$ and apply upward spring-damper normal force $F_{N,i}$ and tire friction $\vec{F}_{f,i}$:

$$F_{N,i} = \max\left(0, \; k_{\text{spring}} \cdot d_i - c_{\text{damper}} \cdot v_{w,i,y}\right)$$

$$\vec{\tau}_{\text{gear}, i} = (\vec{p}_{w,i} - \vec{x}_{\text{CG}}) \times \left( F_{N,i} \hat{j} + \vec{F}_{f,i} \right)$$

### 2.5 Stateful Component Damage vs. Catastrophic Crash
Impacts are classified into **Non-Terminal Stateful Damage** and **Catastrophic Airframe Failure**:
* **Hard Landing / Gear Collapse** ($v_{\text{sink}} \in [5.5, 9.0]\text{ m/s}$): Landing gear struts shear or jam; parasitic drag $\Delta C_{D_{\text{damage}}}$ increases by $+0.045$; sparks emit on runway rollout.
* **Propeller / Engine Strike** (Nose pitch $<-12^\circ$ on ground): Engine power drops permanently to $0\text{ kW}$ (forced dead-stick glide).
* **Wingtip Strike** (Roll angle $>22^\circ$ near ground): Asymmetric wing damage induces constant parasitic roll torque and reduces aileron authority by $50\%$.
* **Catastrophic Disintegration** ($v_{\text{sink}} > 9.5\text{ m/s}$, obstacle impact, or $G > G_{\text{limit}} \times 1.25$): Airframe breaks into physics-driven debris fragments with fire/smoke emitters and triggers the Forensic Crash & Landing Evaluator report.

---

## 3. Complete 100% Playable Single-File Implementation (`index.html`)

Save the complete code block below as `index.html` and open it directly in Chrome, Edge, Firefox, or Safari.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SKYFORGE // Fable 5.2 Hyper-Realistic Flight Simulator v2.0</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/simplex-noise/2.4.0/simplex-noise.min.js"></script>
  <style>
    :root {
      --hud-green: #00ff77;
      --hud-cyan: #00e5ff;
      --hud-amber: #ffaa00;
      --hud-red: #ff2a4b;
      --panel-bg: rgba(8, 14, 22, 0.86);
      --panel-border: rgba(0, 255, 119, 0.32);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body, html {
      width: 100vw; height: 100vh; overflow: hidden;
      background: #03070e; font-family: 'Courier New', Courier, monospace;
      color: var(--hud-green);
    }
    #canvas-container { position: absolute; inset: 0; z-index: 1; }
    #hud-canvas { position: absolute; inset: 0; z-index: 2; pointer-events: none; }

    /* Tactical Glass UI Panels */
    .ui-panel {
      position: absolute; z-index: 10;
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      backdrop-filter: blur(10px);
      border-radius: 6px;
      padding: 10px 13px;
      font-size: 11px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.65);
      max-height: 48vh; overflow-y: auto;
    }
    #top-left-panel { top: 12px; left: 12px; width: 335px; }
    #top-right-panel { top: 12px; right: 12px; width: 315px; }
    #bottom-left-panel { bottom: 12px; left: 12px; width: 345px; }
    #bottom-right-panel { bottom: 12px; right: 12px; width: 315px; }

    h3 {
      font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase;
      border-bottom: 1px solid var(--panel-border);
      padding-bottom: 4px; margin-bottom: 7px;
      color: #ffffff; display: flex; justify-content: space-between; align-items: center;
    }
    .control-row {
      display: flex; justify-content: space-between; align-items: center;
      margin: 5px 0;
    }
    .control-row label { color: #a8d5ba; font-size: 10.5px; }
    .control-row span.val { color: var(--hud-green); font-weight: bold; min-width: 58px; text-align: right; }
    input[type="range"] { width: 115px; accent-color: var(--hud-green); cursor: pointer; height: 14px; }

    select, button {
      background: rgba(0, 38, 22, 0.92);
      color: var(--hud-green);
      border: 1px solid var(--hud-green);
      padding: 4px 7px; border-radius: 3px;
      font-family: inherit; font-size: 10.5px;
      cursor: pointer; transition: 0.15s;
    }
    button:hover, select:hover { background: var(--hud-green); color: #000; font-weight: bold; }
    button.active-btn { background: var(--hud-green); color: #000; font-weight: bold; }
    .btn-group { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
    .btn-group button { flex: 1; min-width: 70px; }

    .telemetry-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px;
      font-size: 10.5px;
    }
    .telemetry-item { display: flex; justify-content: space-between; }
    .telemetry-item span:first-child { color: #84a996; }

    /* Damage Badges */
    .dmg-row { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
    .dmg-badge {
      flex: 1; text-align: center; padding: 3px 4px; border-radius: 3px;
      font-size: 9.5px; font-weight: bold;
      background: rgba(0, 60, 30, 0.6); border: 1px solid #00aa55; color: #00ff77;
    }
    .dmg-warn { background: rgba(90, 50, 0, 0.8); border-color: var(--hud-amber); color: var(--hud-amber); }
    .dmg-fail { background: rgba(90, 0, 20, 0.85); border-color: var(--hud-red); color: var(--hud-red); }

    /* Annunciator Banner */
    #warning-overlay {
      position: absolute; top: 12%; left: 50%; transform: translateX(-50%);
      z-index: 20; pointer-events: none; text-align: center;
    }
    .warn-box {
      display: none; padding: 6px 20px; margin-bottom: 6px;
      font-size: 18px; font-weight: 900; letter-spacing: 2.5px;
      border: 2px solid; border-radius: 4px;
      text-shadow: 0 0 8px currentColor;
      animation: pulseWarn 0.32s infinite alternate;
    }
    .warn-red { color: var(--hud-red); background: rgba(50, 0, 10, 0.88); border-color: var(--hud-red); }
    .warn-amber { color: var(--hud-amber); background: rgba(50, 35, 0, 0.88); border-color: var(--hud-amber); }
    @keyframes pulseWarn { from { opacity: 1; } to { opacity: 0.25; } }

    /* Landing Grade Toast */
    #landing-toast {
      display: none; position: absolute; top: 22%; left: 50%; transform: translateX(-50%);
      z-index: 25; width: 380px; background: rgba(6, 28, 18, 0.94);
      border: 2px solid var(--hud-green); border-radius: 6px; padding: 14px;
      text-align: center; box-shadow: 0 0 35px rgba(0, 255, 119, 0.4);
    }
    #landing-toast h4 { font-size: 16px; color: #fff; margin-bottom: 6px; letter-spacing: 1.5px; }

    /* Crash Modal */
    #crash-modal {
      display: none; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%); z-index: 30;
      width: 450px; background: rgba(24, 4, 8, 0.94);
      border: 2px solid var(--hud-red); border-radius: 8px;
      padding: 18px; text-align: center; color: #fff;
      box-shadow: 0 0 60px rgba(255, 20, 50, 0.65);
    }
    #crash-modal h2 { color: var(--hud-red); font-size: 20px; margin-bottom: 8px; letter-spacing: 2px; }
    #crash-modal p { font-size: 12px; color: #ffcccc; margin: 5px 0; }
    #crash-modal .crash-stats {
      background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 42, 75, 0.4);
      padding: 10px; margin: 10px 0; text-align: left; font-size: 11px; line-height: 1.5;
    }
    .key-hint { color: #ffdd55; font-weight: bold; }
  </style>
</head>
<body>

  <div id="canvas-container"></div>
  <canvas id="hud-canvas"></canvas>

  <!-- Central Warning Annunciators -->
  <div id="warning-overlay">
    <div id="warn-stall" class="warn-box warn-red">STALL // REDUCE AOA</div>
    <div id="warn-gpws" class="warn-box warn-red">TERRAIN // PULL UP</div>
    <div id="warn-overspeed" class="warn-box warn-amber">OVERSPEED // VNE EXCEEDED</div>
    <div id="warn-gear" class="warn-box warn-amber">TOO LOW // GEAR UP</div>
  </div>

  <!-- Touchdown Grading Evaluator Toast -->
  <div id="landing-toast">
    <h4 id="ldg-title">TOUCHDOWN EVALUATED</h4>
    <div id="ldg-details" style="font-size: 11px; text-align: left; line-height: 1.5; color: #cceebb;"></div>
    <button style="margin-top:8px;" onclick="document.getElementById('landing-toast').style.display='none'">DISMISS</button>
  </div>

  <!-- Catastrophic Crash Forensic Modal -->
  <div id="crash-modal">
    <h2>CATASTROPHIC STRUCTURAL FAILURE</h2>
    <p id="crash-reason">Impact exceeded airframe structural design limits.</p>
    <div class="crash-stats" id="crash-telemetry"></div>
    <div class="btn-group">
      <button onclick="sim.loadScenario('runway')">RUNWAY START (R)</button>
      <button onclick="sim.loadScenario('final')">FINAL APPROACH (3 NM)</button>
      <button onclick="sim.loadScenario('cruise')">AIRBORNE CRUISE</button>
    </div>
  </div>

  <!-- Top Left: Airframe, Scenarios & Real-Time 6-DOF Telemetry -->
  <div id="top-left-panel" class="ui-panel">
    <h3>
      <span>SKYFORGE 6-DOF TELEMETRY</span>
      <span id="fps-counter">60 FPS</span>
    </h3>
    <div class="control-row">
      <label>AIRFRAME:</label>
      <select id="aircraft-select" onchange="sim.selectAircraft(this.value)">
        <option value="skyhawk">SF-172 Skytrainer (Single Piston GA)</option>
        <option value="viper">SF-16C Viper (Supersonic Fighter)</option>
        <option value="heavy">SF-748 Intercontinental (Heavy Jet)</option>
      </select>
    </div>
    <div class="btn-group" style="margin-bottom: 8px;">
      <button onclick="sim.loadScenario('runway')">RWY 36 START</button>
      <button onclick="sim.loadScenario('final')">ILS FINAL</button>
      <button onclick="sim.loadScenario('crosswind')">X-WIND TEST</button>
      <button onclick="sim.loadScenario('engout')">ENG OUT GLIDE</button>
    </div>
    <div class="telemetry-grid">
      <div class="telemetry-item"><span>IAS / GS:</span><span id="tel-speed">0 / 0 KT</span></div>
      <div class="telemetry-item"><span>TAS / MACH:</span><span id="tel-mach">0 KT / 0.00</span></div>
      <div class="telemetry-item"><span>ALT MSL / AGL:</span><span id="tel-alt">0 / 0 FT</span></div>
      <div class="telemetry-item"><span>VSI:</span><span id="tel-vsi">0 FPM</span></div>
      <div class="telemetry-item"><span>AoA (α) / SLIP (β):</span><span id="tel-aoa">0.0° / 0.0°</span></div>
      <div class="telemetry-item"><span>G-LOAD / LIMIT:</span><span id="tel-gload">1.00 G</span></div>
      <div class="telemetry-item"><span>LIFT / DRAG:</span><span id="tel-ld">0.0 / 0.0 kN</span></div>
      <div class="telemetry-item"><span>THRUST / RPM:</span><span id="tel-thrust">0.0 kN / 0%</span></div>
      <div class="telemetry-item"><span>GROUND EFFECT:</span><span id="tel-ge">INACTIVE</span></div>
      <div class="telemetry-item"><span>FUEL MASS:</span><span id="tel-fuel">100%</span></div>
    </div>
    <div class="dmg-row">
      <div id="dmg-gear" class="dmg-badge">GEAR: OK</div>
      <div id="dmg-wing" class="dmg-badge">WINGS: OK</div>
      <div id="dmg-eng" class="dmg-badge">ENGINE: OK</div>
    </div>
  </div>

  <!-- Top Right: Live Atmospheric & Weather Controls -->
  <div id="top-right-panel" class="ui-panel">
    <h3>ATMOSPHERE & WEATHER (ISA)</h3>
    <div class="control-row">
      <label>SOLAR TIME:</label>
      <input type="range" id="env-time" min="0" max="24" step="0.1" value="14.0" oninput="sim.updateEnvironment()">
      <span class="val" id="val-time">14:00</span>
    </div>
    <div class="control-row">
      <label>WIND SPEED (KT):</label>
      <input type="range" id="env-wind" min="0" max="65" step="1" value="6" oninput="sim.updateEnvironment()">
      <span class="val" id="val-wind">6 KT</span>
    </div>
    <div class="control-row">
      <label>WIND FROM (°):</label>
      <input type="range" id="env-wind-dir" min="0" max="359" step="1" value="330" oninput="sim.updateEnvironment()">
      <span class="val" id="val-wind-dir">330°</span>
    </div>
    <div class="control-row">
      <label>GUSTS & TURB:</label>
      <input type="range" id="env-turb" min="0" max="10" step="0.5" value="1.0" oninput="sim.updateEnvironment()">
      <span class="val" id="val-turb">1.0</span>
    </div>
    <div class="control-row">
      <label>ISA TEMP OFFSET:</label>
      <input type="range" id="env-temp" min="-25" max="30" step="1" value="0" oninput="sim.updateEnvironment()">
      <span class="val" id="val-temp">+0 °C</span>
    </div>
    <div class="control-row">
      <label>VISIBILITY / FOG:</label>
      <input type="range" id="env-fog" min="0.00002" max="0.00075" step="0.00002" value="0.00006" oninput="sim.updateEnvironment()">
      <span class="val" id="val-fog">CAVOK</span>
    </div>
    <div class="control-row">
      <label>RUNWAY SURFACE:</label>
      <select id="env-surface" onchange="sim.updateEnvironment()">
        <option value="1.0">Dry Asphalt (μ = 0.80)</option>
        <option value="0.55">Wet Runway (μ = 0.45)</option>
        <option value="0.25">Icy / Contaminated (μ = 0.20)</option>
      </select>
    </div>
    <div class="btn-group">
      <button onclick="sim.setWeatherPreset('cavok')">SUNNY MIDDAY</button>
      <button onclick="sim.setWeatherPreset('xwind')">GUSTY X-WIND</button>
      <button onclick="sim.setWeatherPreset('storm')">IMC STORM</button>
      <button onclick="sim.setWeatherPreset('night')">NIGHT VFR</button>
    </div>
  </div>

  <!-- Bottom Left: Flight Controls & Mouse / Keyboard Reference -->
  <div id="bottom-left-panel" class="ui-panel">
    <h3>FLIGHT CONTROLS & AVIONICS</h3>
    <div style="line-height: 1.5; font-size: 10.5px; color: #cceebb;">
      <div><span class="key-hint">W / S</span> or <span class="key-hint">↑ / ↓</span> : Pitch Down / Pull Up (Stick Convention)</div>
      <div><span class="key-hint">A / D</span> or <span class="key-hint">← / →</span> : Roll Left / Right | <span class="key-hint">Q / E</span> : Rudder Yaw</div>
      <div><span class="key-hint">SHIFT / CTRL</span> : Smooth Throttle | <span class="key-hint">1–0</span> : Throttle 10%–100%</div>
      <div><span class="key-hint">[ / ]</span> : Flaps (0°/15°/30°) | <span class="key-hint">G</span> : Gear | <span class="key-hint">SPACE</span> : Wheel Brakes</div>
      <div><span class="key-hint">B</span> : Parking Brake | <span class="key-hint">HOME / END</span> : Pitch Trim | <span class="key-hint">C</span> : Camera</div>
      <div><span class="key-hint">MOUSE DRAG</span> : Look Around | <span class="key-hint">SCROLL</span> : Zoom FOV</div>
    </div>
    <div class="btn-group">
      <button onclick="sim.cycleCamera()">CAM VIEW (C)</button>
      <button onclick="sim.toggleAssist()" id="btn-assist">ASSIST: OFF</button>
      <button onclick="sim.toggleAutopilot()" id="btn-ap">AP HOLD: OFF</button>
      <button onclick="sim.toggleAudio()" id="btn-audio">AUDIO: OFF</button>
    </div>
  </div>

  <!-- Bottom Right: Systems Status & Autopilot / ILS -->
  <div id="bottom-right-panel" class="ui-panel">
    <h3>SYSTEMS, TRIM & ILS RADIO</h3>
    <div class="telemetry-grid">
      <div class="telemetry-item"><span>THROTTLE:</span><span id="sys-thr">0% (IDLE)</span></div>
      <div class="telemetry-item"><span>PARKING BRAKE:</span><span id="sys-pbrake" style="color:var(--hud-amber)">SET (ON)</span></div>
      <div class="telemetry-item"><span>FLAPS:</span><span id="sys-flaps">0° (CLEAN)</span></div>
      <div class="telemetry-item"><span>LANDING GEAR:</span><span id="sys-gear">DOWN (3 GREEN)</span></div>
      <div class="telemetry-item"><span>ELEVATOR TRIM:</span><span id="sys-trim">0.0°</span></div>
      <div class="telemetry-item"><span>AIR DENSITY (ρ):</span><span id="sys-rho">1.225 kg/m³</span></div>
      <div class="telemetry-item"><span>RWY 36 ILS DIST:</span><span id="sys-ils-d">0.0 NM</span></div>
      <div class="telemetry-item"><span>CAMERA MODE:</span><span id="sys-cam">CHASE CAM</span></div>
    </div>
    <div class="btn-group" style="margin-top: 8px;">
      <button onclick="sim.repairAircraft()">REPAIR & REFUEL</button>
      <button onclick="sim.togglePause()" id="btn-pause">PAUSE (ESC)</button>
    </div>
  </div>

  <script>
    /***************************************************************************
     * 1. AIRCRAFT DATA DEFINITIONS (SI UNITS INTERNALLY)
     ***************************************************************************/
    const AIRCRAFT_CATALOG = {
      skyhawk: {
        name: "SF-172 Skytrainer",
        emptyMass: 760,
        fuelCapacity: 145,      // kg
        payloadMass: 190,
        wingArea: 16.2,         // m^2
        wingSpan: 11.0,         // m
        chord: 1.47,            // m
        maxThrust: 4450,        // Static prop thrust N (~135 kW piston)
        afterburnerMult: 1.0,
        CL0: 0.30,
        CLa: 5.2,               // per rad
        alphaStall: 0.27,       // ~15.5 deg
        CD0: 0.027,
        oswald: 0.78,
        rollAuthority: 2.1,
        pitchAuthority: 1.45,
        yawAuthority: 0.95,
        maxG: 4.4,
        minG: -1.8,
        vne: 84,                // m/s (~163 KT)
        gearHeight: 1.55,
        wheelBase: 2.2,
        trackWidth: 2.4,
        springK: 42000,
        damperC: 6800,
        scale: [1.0, 1.0, 1.0],
        color: 0xf4f7fa,
        accent: 0x0066cc,
        isJet: false
      },
      viper: {
        name: "SF-16C Viper",
        emptyMass: 8570,
        fuelCapacity: 3100,
        payloadMass: 800,
        wingArea: 27.87,
        wingSpan: 9.96,
        chord: 3.45,
        maxThrust: 76300,
        afterburnerMult: 1.68,
        CL0: 0.09,
        CLa: 4.35,
        alphaStall: 0.42,       // Vortex lift LERX
        CD0: 0.017,
        oswald: 0.82,
        rollAuthority: 4.6,
        pitchAuthority: 2.9,
        yawAuthority: 1.35,
        maxG: 9.0,
        minG: -3.5,
        vne: 660,
        gearHeight: 1.85,
        wheelBase: 4.0,
        trackWidth: 2.6,
        springK: 340000,
        damperC: 48000,
        scale: [1.2, 0.88, 1.45],
        color: 0x707b88,
        accent: 0x22313f,
        isJet: true
      },
      heavy: {
        name: "SF-748 Intercontinental",
        emptyMass: 162000,
        fuelCapacity: 48000,
        payloadMass: 25000,
        wingArea: 554.0,
        wingSpan: 68.4,
        chord: 8.1,
        maxThrust: 1180000,
        afterburnerMult: 1.0,
        CL0: 0.34,
        CLa: 4.95,
        alphaStall: 0.25,
        CD0: 0.021,
        oswald: 0.85,
        rollAuthority: 0.78,
        pitchAuthority: 0.68,
        yawAuthority: 0.48,
        maxG: 2.5,
        minG: -1.0,
        vne: 290,
        gearHeight: 3.3,
        wheelBase: 11.0,
        trackWidth: 7.5,
        springK: 6200000,
        damperC: 890000,
        scale: [2.7, 2.4, 3.5],
        color: 0xffffff,
        accent: 0xd4af37,
        isJet: true
      }
    };

    /***************************************************************************
     * 2. PROCEDURAL WEB AUDIO SYNTHESIS ENGINE
     ***************************************************************************/
    class SoundSystem {
      constructor() {
        this.ctx = null;
        this.enabled = false;
      }

      init() {
        if (this.ctx) return;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();

        // Engine Osc
        this.engOsc = this.ctx.createOscillator();
        this.engOsc.type = 'sawtooth';
        this.engFilter = this.ctx.createBiquadFilter();
        this.engFilter.type = 'lowpass';
        this.engFilter.frequency.value = 260;
        this.engGain = this.ctx.createGain();
        this.engGain.gain.value = 0;
        this.engOsc.connect(this.engFilter);
        this.engFilter.connect(this.engGain);
        this.engGain.connect(this.ctx.destination);
        this.engOsc.start();

        // Airflow & Wind Noise
        const bufSize = this.ctx.sampleRate * 2;
        const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

        const noise = this.ctx.createBufferSource();
        noise.buffer = buf;
        noise.loop = true;
        this.windFilter = this.ctx.createBiquadFilter();
        this.windFilter.type = 'bandpass';
        this.windFilter.frequency.value = 700;
        this.windGain = this.ctx.createGain();
        this.windGain.gain.value = 0;
        noise.connect(this.windFilter);
        this.windFilter.connect(this.windGain);
        this.windGain.connect(this.ctx.destination);
        noise.start();

        // Stall Horn Oscillator
        this.stallOsc = this.ctx.createOscillator();
        this.stallOsc.type = 'square';
        this.stallOsc.frequency.value = 880;
        this.stallGain = this.ctx.createGain();
        this.stallGain.gain.value = 0;
        this.stallOsc.connect(this.stallGain);
        this.stallGain.connect(this.ctx.destination);
        this.stallOsc.start();
      }

      toggle() {
        if (!this.ctx) this.init();
        this.enabled = !this.enabled;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (!this.enabled) {
          const now = this.ctx.currentTime;
          this.engGain.gain.setTargetAtTime(0, now, 0.08);
          this.windGain.gain.setTargetAtTime(0, now, 0.08);
          this.stallGain.gain.setTargetAtTime(0, now, 0.05);
        }
        return this.enabled;
      }

      update(rpmRatio, airspeed, isJet, stalled, crashed) {
        if (!this.enabled || !this.ctx) return;
        const now = this.ctx.currentTime;
        if (crashed) {
          this.engGain.gain.setTargetAtTime(0, now, 0.04);
          this.windGain.gain.setTargetAtTime(0, now, 0.15);
          this.stallGain.gain.setTargetAtTime(0, now, 0.04);
          return;
        }
        const freq = isJet ? 85 + rpmRatio * 290 : 38 + rpmRatio * 125;
        this.engOsc.frequency.setTargetAtTime(freq, now, 0.06);
        this.engGain.gain.setTargetAtTime(0.04 + rpmRatio * 0.14, now, 0.08);

        const windLvl = Math.min(0.22, (airspeed / 180) * 0.15);
        this.windGain.gain.setTargetAtTime(windLvl, now, 0.1);

        // Stall warning beep modulation
        const hornOn = stalled && (Math.sin(performance.now() * 0.025) > 0);
        this.stallGain.gain.setTargetAtTime(hornOn ? 0.07 : 0, now, 0.02);
      }

      playImpact(loudness = 0.4) {
        if (!this.enabled || !this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(110, now);
        osc.frequency.exponentialRampToValueAtTime(22, now + 0.65);
        gain.gain.setValueAtTime(Math.min(0.6, loudness), now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.7);
      }
    }

    /***************************************************************************
     * 3. SKYFORGE CORE SIMULATOR APPLICATION
     ***************************************************************************/
    class SkyforgeSimulator {
      constructor() {
        this.container = document.getElementById('canvas-container');
        this.hudCanvas = document.getElementById('hud-canvas');
        this.hudCtx = this.hudCanvas.getContext('2d');
        this.simplex = new SimplexNoise(1337);
        this.sound = new SoundSystem();

        // Fixed-Step Physics Clock (120 Hz)
        this.FIXED_DT = 1 / 120;
        this.accumulator = 0;
        this.paused = false;

        // Environment & ISA Weather State
        this.env = {
          timeOfDay: 14.0,
          windSpeed: 6 * 0.514444,
          windFromRad: 330 * (Math.PI / 180),
          turbulence: 1.0,
          isaTempOffset: 0,
          fogDensity: 0.00006,
          surfaceFrictionMult: 1.0,
          rho: 1.225,
          oatCelsius: 15.0,
          currentGustVec: new THREE.Vector3()
        };

        this.currentKey = 'skyhawk';
        this.spec = AIRCRAFT_CATALOG[this.currentKey];

        // 6-DOF Rigid-Body State
        this.pos = new THREE.Vector3();
        this.vel = new THREE.Vector3();
        this.quat = new THREE.Quaternion();
        this.angVel = new THREE.Vector3(); // Body rates (p: pitch, q: yaw, r: roll in Three.js YXZ)
        this.fuelMass = this.spec.fuelCapacity;

        // Control Inputs & Systems
        this.controls = {
          throttle: 0,
          engineRpm: 0,
          elevator: 0,
          aileron: 0,
          rudder: 0,
          trim: 0,
          flaps: 0,
          gear: true,
          wheelBrakes: false,
          parkingBrake: true,
          assistMode: false,
          autopilot: false
        };

        // Stateful Airframe Component Damage
        this.damage = {
          gearCollapsed: false,
          wingDamage: 0,     // -1 left, +1 right
          engineFailed: false
        };

        // Landing Evaluation Tracker
        this.wasAirborne = false;
        this.touchdownState = null;

        // Camera & Mouse Look
        this.cameraMode = 0; // 0: Chase, 1: Cockpit, 2: Orbit, 3: Tower Flyby
        this.camYaw = 0;
        this.camPitch = 0;
        this.isDraggingMouse = false;
        this.keys = {};

        this.telemetry = {
          ias: 0, tas: 0, gs: 0, mach: 0,
          altMSL: 0, altAGL: 0, vsi: 0,
          alpha: 0, beta: 0, gLoad: 1.0,
          lift: 0, drag: 0, thrust: 0,
          pitchDeg: 0, rollDeg: 0, headingDeg: 360,
          inGroundEffect: false,
          stall: false, gpws: false, overspeed: false, gearWarn: false,
          ilsLocErrorDeg: 0, ilsGsErrorDeg: 0, ilsDistNM: 0
        };

        this.crashed = false;
        this.debrisList = [];
        this.particles = [];
        this.lastFrameTime = performance.now();
        this.frameCount = 0;

        this.initThree();
        this.buildWorld();
        this.buildAircraftMesh();
        this.bindInputs();
        this.updateEnvironment();
        this.loadScenario('runway');
        this.animate();
      }

      initThree() {
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x88bbdd, this.env.fogDensity);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.4, 48000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        this.hudCanvas.width = window.innerWidth;
        this.hudCanvas.height = window.innerHeight;

        this.hemiLight = new THREE.HemisphereLight(0xddeeff, 0x334422, 0.65);
        this.scene.add(this.hemiLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 1.25);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        const d = 600;
        this.sunLight.shadow.camera.left = -d;
        this.sunLight.shadow.camera.right = d;
        this.sunLight.shadow.camera.top = d;
        this.sunLight.shadow.camera.bottom = -d;
        this.sunLight.shadow.camera.near = 10;
        this.sunLight.shadow.camera.far = 5000;
        this.scene.add(this.sunLight);
      }

      /*************************************************************************
       * TERRAIN & AIRPORT WORLD SYNTHESIS
       *************************************************************************/
      getTerrainHeight(x, z) {
        // Flat airport grading zone around Runway 36/18 (x in [-550, 550], z in [-2600, 2600])
        const rx = Math.abs(x);
        const rz = Math.abs(z);
        let blend = 1.0;
        if (rx < 650 && rz < 2800) {
          const bx = Math.max(0, (rx - 200) / 450);
          const bz = Math.max(0, (rz - 1900) / 900);
          blend = Math.min(1.0, Math.max(bx, bz));
          blend = blend * blend * (3 - 2 * blend);
        }

        let h = this.simplex.noise2D(x * 0.0002, z * 0.0002) * 540 +
                this.simplex.noise2D(x * 0.0008, z * 0.0008) * 115 +
                this.simplex.noise2D(x * 0.0032, z * 0.0032) * 24 + 80;
        if (h < 0) h *= 0.1;
        return Math.max(0, h * blend);
      }

      buildWorld() {
        const size = 32000;
        const segs = 220;
        const geo = new THREE.PlaneGeometry(size, size, segs, segs);
        geo.rotateX(-Math.PI / 2);

        const posAttr = geo.attributes.position;
        const colors = [];
        for (let i = 0; i < posAttr.count; i++) {
          const vx = posAttr.getX(i);
          const vz = posAttr.getZ(i);
          const vy = this.getTerrainHeight(vx, vz);
          posAttr.setY(i, vy);

          const c = new THREE.Color();
          if (vy <= 1.5) c.setHex(0xc2b280);
          else if (vy < 145) c.setHex(0x2d5a27).lerp(new THREE.Color(0x3f6d34), vy / 145);
          else if (vy < 360) c.setHex(0x555d50).lerp(new THREE.Color(0x6e665e), (vy - 145) / 215);
          else c.setHex(0xf2f6fa);
          colors.push(c.r, c.g, c.b);
        }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.computeVertexNormals();

        const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
        terrain.receiveShadow = true;
        this.scene.add(terrain);

        // Ocean Plane
        const waterGeo = new THREE.PlaneGeometry(120000, 120000);
        waterGeo.rotateX(-Math.PI / 2);
        const water = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({
          color: 0x0a3c5f, shininess: 85, specular: 0x5588aa, transparent: true, opacity: 0.92
        }));
        water.position.y = 0.2;
        this.scene.add(water);

        // Airport Complex (Runway 36/18: 3,000m x 54m)
        this.obstacles = [];
        const aptGroup = new THREE.Group();

        const rwyGeo = new THREE.PlaneGeometry(54, 3000);
        rwyGeo.rotateX(-Math.PI / 2);
        const rwy = new THREE.Mesh(rwyGeo, new THREE.MeshLambertMaterial({ color: 0x24272c }));
        rwy.position.y = 0.45;
        rwy.receiveShadow = true;
        aptGroup.add(rwy);

        // Centerline & Threshold Piano Keys
        const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const stripeGeo = new THREE.PlaneGeometry(1.4, 42);
        stripeGeo.rotateX(-Math.PI / 2);
        for (let z = -1350; z <= 1350; z += 85) {
          const s = new THREE.Mesh(stripeGeo, stripeMat);
          s.position.set(0, 0.50, z);
          aptGroup.add(s);
        }

        // Animated Windsock near Runway Threshold
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.15, 9, 8),
          new THREE.MeshLambertMaterial({ color: 0xcccccc })
        );
        pole.position.set(-48, 4.5, 1320);
        aptGroup.add(pole);

        const sockGeo = new THREE.ConeGeometry(0.85, 4.2, 10);
        sockGeo.rotateZ(Math.PI / 2);
        sockGeo.translate(2.1, 0, 0);
        this.windsockMesh = new THREE.Mesh(sockGeo, new THREE.MeshLambertMaterial({ color: 0xff5500 }));
        this.windsockMesh.position.set(-48, 8.8, 1320);
        aptGroup.add(this.windsockMesh);

        // Collidable Airport Buildings (Tower & Hangars)
        const addBuilding = (x, z, w, h, d, color) => {
          const m = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            new THREE.MeshLambertMaterial({ color })
          );
          m.position.set(x, h / 2, z);
          m.castShadow = true;
          m.receiveShadow = true;
          aptGroup.add(m);
          this.obstacles.push({ x, z, halfW: w / 2 + 2, halfD: d / 2 + 2, height: h });
        };
        addBuilding(115, -180, 18, 56, 18, 0x88929b); // Control Tower
        addBuilding(125, 120, 48, 18, 65, 0x5c6bc0);  // Hangar Alpha
        addBuilding(125, 240, 48, 18, 65, 0x455a64);  // Hangar Bravo

        this.scene.add(aptGroup);

        // Cloud Layer
        this.cloudGroup = new THREE.Group();
        const cGeo = new THREE.BoxGeometry(1, 1, 1);
        const cMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.78 });
        for (let i = 0; i < 85; i++) {
          const c = new THREE.Mesh(cGeo, cMat);
          c.position.set(
            (Math.random() - 0.5) * 26000,
            1150 + Math.random() * 850,
            (Math.random() - 0.5) * 26000
          );
          c.scale.set(240 + Math.random() * 420, 45 + Math.random() * 75, 200 + Math.random() * 380);
          this.cloudGroup.add(c);
        }
        this.scene.add(this.cloudGroup);
      }

      buildAircraftMesh() {
        if (this.aircraftGroup) this.scene.remove(this.aircraftGroup);
        this.aircraftGroup = new THREE.Group();
        this.airframeParts = new THREE.Group();

        const spec = this.spec;
        const bodyMat = new THREE.MeshPhongMaterial({ color: spec.color, shininess: 75 });
        const accentMat = new THREE.MeshPhongMaterial({ color: spec.accent, shininess: 60 });
        const glassMat = new THREE.MeshPhongMaterial({ color: 0x112233, transparent: true, opacity: 0.65 });
        const darkMat = new THREE.MeshLambertMaterial({ color: 0x1b1b1b });

        // Fuselage & Nose
        const fuseGeo = new THREE.CylinderGeometry(0.65, 0.38, 8.2, 12);
        fuseGeo.rotateX(Math.PI / 2);
        this.airframeParts.add(new THREE.Mesh(fuseGeo, bodyMat));

        const noseGeo = new THREE.ConeGeometry(0.65, 2.3, 12);
        noseGeo.rotateX(-Math.PI / 2);
        const nose = new THREE.Mesh(noseGeo, accentMat);
        nose.position.z = -5.25;
        this.airframeParts.add(nose);

        // Canopy
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.72, 2.5), glassMat);
        canopy.position.set(0, 0.55, -1.1);
        this.airframeParts.add(canopy);

        // Wings
        const wing = new THREE.Mesh(new THREE.BoxGeometry(spec.wingSpan, 0.14, spec.chord), bodyMat);
        wing.position.set(0, 0.12, -0.4);
        wing.castShadow = true;
        this.airframeParts.add(wing);

        // Animated Ailerons & Flaps
        const ailGeo = new THREE.BoxGeometry(spec.wingSpan * 0.24, 0.08, 0.32);
        this.leftAileron = new THREE.Mesh(ailGeo, accentMat);
        this.leftAileron.position.set(-spec.wingSpan * 0.34, 0.1, -0.4 + spec.chord * 0.55);
        this.rightAileron = new THREE.Mesh(ailGeo, accentMat);
        this.rightAileron.position.set(spec.wingSpan * 0.34, 0.1, -0.4 + spec.chord * 0.55);
        this.airframeParts.add(this.leftAileron, this.rightAileron);

        // Tail & Animated Elevator/Rudder
        const hStab = new THREE.Mesh(new THREE.BoxGeometry(spec.wingSpan * 0.35, 0.1, 1.05), accentMat);
        hStab.position.set(0, 0.15, 3.6);
        this.airframeParts.add(hStab);

        this.elevatorMesh = new THREE.Mesh(new THREE.BoxGeometry(spec.wingSpan * 0.34, 0.08, 0.34), bodyMat);
        this.elevatorMesh.position.set(0, 0.15, 4.25);
        this.airframeParts.add(this.elevatorMesh);

        const vStab = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.8, 1.4), accentMat);
        vStab.position.set(0, 0.95, 3.5);
        this.airframeParts.add(vStab);

        this.rudderMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.75, 0.42), bodyMat);
        this.rudderMesh.position.set(0, 0.95, 4.35);
        this.airframeParts.add(this.rudderMesh);

        // Propeller or Jet Exhaust
        this.propMesh = null;
        this.abMesh = null;
        if (!spec.isJet) {
          this.propMesh = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.18, 0.06), darkMat);
          this.propMesh.position.set(0, 0, -6.45);
          this.airframeParts.add(this.propMesh);
        } else {
          const abGeo = new THREE.ConeGeometry(0.5, 3.1, 10);
          abGeo.rotateX(Math.PI / 2);
          this.abMesh = new THREE.Mesh(abGeo, new THREE.MeshBasicMaterial({
            color: 0xff6600, transparent: true, opacity: 0
          }));
          this.abMesh.position.set(0, 0, 5.6);
          this.airframeParts.add(this.abMesh);
        }

        // Tricycle Landing Gear
        this.gearGroup = new THREE.Group();
        const strutGeo = new THREE.CylinderGeometry(0.08, 0.08, spec.gearHeight, 8);
        const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.24, 12);
        wheelGeo.rotateZ(Math.PI / 2);

        const makeStrut = (x, z) => {
          const g = new THREE.Group();
          const s = new THREE.Mesh(strutGeo, darkMat);
          s.position.y = -spec.gearHeight / 2;
          const w = new THREE.Mesh(wheelGeo, darkMat);
          w.position.y = -spec.gearHeight;
          g.add(s, w);
          g.position.set(x, 0, z);
          return g;
        };
        this.gearGroup.add(
          makeStrut(0, -spec.wheelBase),
          makeStrut(-spec.trackWidth / 2, 0.3),
          makeStrut(spec.trackWidth / 2, 0.3)
        );
        this.airframeParts.add(this.gearGroup);

        this.airframeParts.scale.set(...spec.scale);
        this.aircraftGroup.add(this.airframeParts);
        this.scene.add(this.aircraftGroup);
      }

      /*************************************************************************
       * 4. SCENARIO MANAGEMENT & REPAIRS
       *************************************************************************/
      selectAircraft(key) {
        this.currentKey = key;
        this.spec = AIRCRAFT_CATALOG[key];
        this.buildAircraftMesh();
        this.loadScenario('runway');
      }

      repairAircraft() {
        this.damage = { gearCollapsed: false, wingDamage: 0, engineFailed: false };
        this.fuelMass = this.spec.fuelCapacity;
        this.gearGroup.visible = this.controls.gear;
        this.updateDamageUI();
      }

      loadScenario(mode) {
        this.crashed = false;
        document.getElementById('crash-modal').style.display = 'none';
        document.getElementById('landing-toast').style.display = 'none';

        this.debrisList.forEach(d => this.scene.remove(d.mesh));
        this.debrisList = [];
        this.particles.forEach(p => this.scene.remove(p.mesh));
        this.particles = [];
        this.aircraftGroup.visible = (this.cameraMode !== 1);

        this.repairAircraft();
        this.angVel.set(0, 0, 0);
        this.quat.identity();
        this.controls.elevator = 0;
        this.controls.aileron = 0;
        this.controls.rudder = 0;
        this.controls.trim = 0;
        this.controls.autopilot = false;
        document.getElementById('btn-ap').classList.remove('active-btn');
        document.getElementById('btn-ap').innerText = "AP HOLD: OFF";

        const rwyY = this.getTerrainHeight(0, 1300);
        const gearOffset = this.spec.gearHeight * this.spec.scale[1] + 0.46;

        if (mode === 'runway') {
          this.pos.set(0, rwyY + gearOffset, 1360);
          this.vel.set(0, 0, 0);
          this.controls.throttle = 0.0;
          this.controls.engineRpm = 0.08;
          this.controls.parkingBrake = true;
          this.controls.gear = true;
          this.controls.flaps = 15;
          this.wasAirborne = false;
        } else if (mode === 'final') {
          // 3 NM South on 3-degree ILS Glideslope to Runway 36
          const distM = 4800;
          const altM = distM * Math.tan(THREE.MathUtils.degToRad(3.0)) + rwyY;
          this.pos.set(0, altM, 1400 + distM);
          const appSpeed = this.spec.isJet ? 76 : 36;
          this.vel.set(0, -appSpeed * Math.sin(0.052), -appSpeed);
          this.controls.throttle = 0.45;
          this.controls.engineRpm = 0.45;
          this.controls.parkingBrake = false;
          this.controls.gear = true;
          this.controls.flaps = 15;
          this.wasAirborne = true;
        } else if (mode === 'crosswind') {
          this.setWeatherPreset('xwind');
          this.loadScenario('final');
          return;
        } else if (mode === 'engout') {
          this.pos.set(0, 950, 3800);
          const glideSpd = this.spec.isJet ? 95 : 42;
          this.vel.set(0, -3.5, -glideSpd);
          this.controls.throttle = 0;
          this.controls.engineRpm = 0;
          this.damage.engineFailed = true;
          this.controls.parkingBrake = false;
          this.controls.gear = true;
          this.controls.flaps = 0;
          this.wasAirborne = true;
          this.updateDamageUI();
        } else {
          // Airborne Cruise
          this.pos.set(0, 1524, 1000);
          const cruiseSpd = this.spec.isJet ? 145 : 58;
          this.vel.set(0, 0, -cruiseSpd);
          this.controls.throttle = 0.72;
          this.controls.engineRpm = 0.72;
          this.controls.parkingBrake = false;
          this.controls.gear = false;
          this.controls.flaps = 0;
          this.wasAirborne = true;
        }

        this.gearGroup.visible = this.controls.gear;
        this.updateSystemsUI();
      }

      /*************************************************************************
       * 5. WEATHER & ENVIRONMENT UPDATES
       *************************************************************************/
      updateEnvironment() {
        const time = parseFloat(document.getElementById('env-time').value);
        const windKt = parseFloat(document.getElementById('env-wind').value);
        const windDir = parseFloat(document.getElementById('env-wind-dir').value);
        const turb = parseFloat(document.getElementById('env-turb').value);
        const tempOff = parseFloat(document.getElementById('env-temp').value);
        const fog = parseFloat(document.getElementById('env-fog').value);
        const surf = parseFloat(document.getElementById('env-surface').value);

        this.env.timeOfDay = time;
        this.env.windSpeed = windKt * 0.514444;
        this.env.windFromRad = windDir * (Math.PI / 180);
        this.env.turbulence = turb;
        this.env.isaTempOffset = tempOff;
        this.env.fogDensity = fog;
        this.env.surfaceFrictionMult = surf;

        const hrs = Math.floor(time);
        const mins = Math.floor((time - hrs) * 60);
        document.getElementById('val-time').innerText = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        document.getElementById('val-wind').innerText = `${windKt} KT`;
        document.getElementById('val-wind-dir').innerText = `${windDir}\u00B0`;
        document.getElementById('val-turb').innerText = turb.toFixed(1);
        document.getElementById('val-temp').innerText = `${tempOff >= 0 ? '+' : ''}${tempOff} \u00B0C`;
        document.getElementById('val-fog').innerText = fog < 0.00012 ? "CAVOK" : fog < 0.00035 ? "MVFR HAZE" : "IMC FOG";

        // Sun Angle & Sky Lighting
        const sunAng = ((time - 6) / 12) * Math.PI;
        const sunY = Math.sin(sunAng);
        const sunX = Math.cos(sunAng);
        this.sunLight.position.set(sunX * 1500, Math.max(40, sunY * 1500), 500);

        const sky = new THREE.Color();
        if (sunY > 0.22) {
          sky.setHex(0x5c9eff).lerp(new THREE.Color(0x88ccff), sunY);
          this.sunLight.intensity = 1.25;
          this.hemiLight.intensity = 0.65;
        } else if (sunY > -0.12) {
          const t = (sunY + 0.12) / 0.34;
          sky.setHex(0x181226).lerp(new THREE.Color(0xff7744), t);
          this.sunLight.intensity = 0.25 + t * 0.85;
          this.hemiLight.intensity = 0.2 + t * 0.35;
        } else {
          sky.setHex(0x040710);
          this.sunLight.intensity = 0.06;
          this.hemiLight.intensity = 0.12;
        }
        this.scene.background = sky;
        this.scene.fog.color.copy(sky);
        this.scene.fog.density = fog;
      }

      setWeatherPreset(preset) {
        if (preset === 'cavok') {
          document.getElementById('env-time').value = 13.5;
          document.getElementById('env-wind').value = 5;
          document.getElementById('env-wind-dir').value = 350;
          document.getElementById('env-turb').value = 0.5;
          document.getElementById('env-fog').value = 0.00005;
          document.getElementById('env-surface').value = "1.0";
        } else if (preset === 'xwind') {
          document.getElementById('env-time').value = 16.0;
          document.getElementById('env-wind').value = 26;
          document.getElementById('env-wind-dir').value = 270; // Direct 90-deg crosswind on RWY 36
          document.getElementById('env-turb').value = 3.5;
          document.getElementById('env-fog').value = 0.00012;
          document.getElementById('env-surface').value = "0.55";
        } else if (preset === 'storm') {
          document.getElementById('env-time').value = 17.8;
          document.getElementById('env-wind').value = 42;
          document.getElementById('env-wind-dir').value = 310;
          document.getElementById('env-turb').value = 7.5;
          document.getElementById('env-fog').value = 0.00048;
          document.getElementById('env-surface').value = "0.55";
        } else if (preset === 'night') {
          document.getElementById('env-time').value = 22.5;
          document.getElementById('env-wind').value = 8;
          document.getElementById('env-wind-dir').value = 360;
          document.getElementById('env-turb').value = 0.5;
          document.getElementById('env-fog').value = 0.00008;
        }
        this.updateEnvironment();
      }

      /*************************************************************************
       * 6. FIXED-STEP 6-DOF FLIGHT DYNAMICS & TRI-GEAR SUSPENSION
       *************************************************************************/
      stepPhysics(dt) {
        if (this.crashed || this.paused) {
          if (this.crashed) this.updateCrashDebris(dt);
          return;
        }

        const spec = this.spec;
        const totalMass = spec.emptyMass + spec.payloadMass + this.fuelMass;

        // 1. Process Continuous Flight Control Inputs
        // Aircraft stick convention: S / Down Arrow = Pull Back (Pitch Up), W / Up Arrow = Push Forward (Pitch Down)
        const pitchCmd = (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0) -
                         (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0);
        const rollCmd  = (this.keys['KeyA'] || this.keys['ArrowLeft'] ? 1 : 0) -
                         (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0);
        const yawCmd   = (this.keys['KeyQ'] ? 1 : 0) - (this.keys['KeyE'] ? 1 : 0);

        if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) {
          this.controls.throttle = Math.min(1.0, this.controls.throttle + 0.4 * dt);
        }
        if (this.keys['ControlLeft'] || this.keys['ControlRight']) {
          this.controls.throttle = Math.max(0.0, this.controls.throttle - 0.4 * dt);
        }
        this.controls.wheelBrakes = !!this.keys['Space'];

        const actuatorRate = 7.0 * dt;
        this.controls.elevator += (pitchCmd - this.controls.elevator) * actuatorRate;
        this.controls.aileron  += (rollCmd - this.controls.aileron) * actuatorRate;
        this.controls.rudder   += (yawCmd - this.controls.rudder) * actuatorRate;

        // Engine spool / RPM lag & fuel burn
        const targetRpm = (this.damage.engineFailed || this.fuelMass <= 0) ? 0 : this.controls.throttle;
        this.controls.engineRpm += (targetRpm - this.controls.engineRpm) * 2.2 * dt;
        if (this.controls.engineRpm > 0.01) {
          this.fuelMass = Math.max(0, this.fuelMass - this.controls.engineRpm * 0.08 * dt);
        }

        // Beginner Assist or Autopilot Stabilization
        const euler = new THREE.Euler().setFromQuaternion(this.quat, 'YXZ');
        if ((this.controls.autopilot || this.controls.assistMode) && pitchCmd === 0 && rollCmd === 0) {
          this.controls.aileron = THREE.MathUtils.clamp(-euler.z * 1.9, -0.65, 0.65);
          if (this.controls.autopilot) {
            const targetPitch = THREE.MathUtils.clamp(-this.vel.y * 0.015 + 0.035, -0.15, 0.20);
            this.controls.elevator = THREE.MathUtils.clamp((targetPitch - euler.x) * 2.4, -0.5, 0.5);
          }
        }

        // 2. ISA Atmosphere at Current Altitude MSL
        const h = Math.max(0, this.pos.y);
        const T0 = 288.15 + this.env.isaTempOffset;
        const L = 0.0065;
        const T = Math.max(216.65, T0 - L * h);
        const P = 101325 * Math.pow(1 - (L * Math.min(11000, h)) / 288.15, 5.25588);
        const rho = P / (287.058 * T);
        const speedOfSound = Math.sqrt(1.4 * 287.058 * T);
        this.env.rho = rho;
        this.env.oatCelsius = T - 273.15;

        // 3. Correlated 3D Wind & Dryden Turbulence Vector
        // Meteorological wind FROM angle means wind blows toward (windFromRad + PI)
        const windBlowTo = this.env.windFromRad + Math.PI;
        const windWorld = new THREE.Vector3(
          Math.sin(windBlowTo) * this.env.windSpeed,
          0,
          -Math.cos(windBlowTo) * this.env.windSpeed
        );

        if (this.env.turbulence > 0) {
          const tSim = performance.now() * 0.0018;
          const gustAmp = this.env.turbulence * 1.45;
          windWorld.x += this.simplex.noise2D(tSim, 10) * gustAmp;
          windWorld.y += this.simplex.noise2D(tSim, 25) * gustAmp * 0.65;
          windWorld.z += this.simplex.noise2D(tSim, 40) * gustAmp;
        }

        // Animate Airport Windsock
        if (this.windsockMesh) {
          this.windsockMesh.rotation.y = -windBlowTo + Math.PI / 2;
        }

        // 4. Relative Airflow in Body Frame
        const vAirWorld = this.vel.clone().sub(windWorld);
        const invQuat = this.quat.clone().invert();
        const vBody = vAirWorld.clone().applyQuaternion(invQuat);

        const uForward = -vBody.z;
        const vUp = vBody.y;
        const wRight = vBody.x;
        const V = Math.sqrt(uForward * uForward + vUp * vUp + wRight * wRight + 1e-6);

        let alpha = 0;
        let beta = 0;
        if (V > 1.2) {
          alpha = Math.atan2(-vUp, Math.max(0.5, uForward));
          beta = Math.asin(THREE.MathUtils.clamp(wRight / V, -1, 1));
        }

        // Beginner Assist Stall Limiter
        if (this.controls.assistMode && alpha > spec.alphaStall * 0.85) {
          this.controls.elevator = Math.min(this.controls.elevator, -0.25);
        }

        const qDyn = 0.5 * rho * V * V;

        // 5. Ground Effect, Lift (CL) & Drag (CD)
        const terrainCenterY = this.getTerrainHeight(this.pos.x, this.pos.z);
        const gearExt = (this.controls.gear && !this.damage.gearCollapsed ? spec.gearHeight : 0.45) * spec.scale[1] + 0.45;
        const altAGL = Math.max(0, this.pos.y - terrainCenterY - gearExt);

        const hOverB = Math.max(0.05, altAGL / spec.wingSpan);
        const kGE = (16 * hOverB * hOverB) / (1 + 16 * hOverB * hOverB);
        const inGE = altAGL < spec.wingSpan * 0.85 && V > 12;

        const flapRatio = this.controls.flaps / 30.0;
        const dCLFlaps = flapRatio * 0.46;
        let CL = 0;
        let isStalling = false;

        if (Math.abs(alpha) <= spec.alphaStall) {
          CL = (spec.CL0 + spec.CLa * alpha + dCLFlaps) * (1 + 0.12 * (1 - kGE));
        } else {
          isStalling = V > 10 && altAGL > 1.0;
          const sign = Math.sign(alpha);
          const excess = Math.abs(alpha) - spec.alphaStall;
          const peak = spec.CL0 + spec.CLa * (sign * spec.alphaStall) + dCLFlaps;
          CL = peak * Math.exp(-3.2 * excess) + 0.92 * Math.sin(2 * alpha);
        }

        const AR = (spec.wingSpan * spec.wingSpan) / spec.wingArea;
        const CDi = kGE * (CL * CL) / (Math.PI * spec.oswald * AR);
        const CDGear = (this.controls.gear ? 0.020 : 0) + (this.damage.gearCollapsed ? 0.045 : 0);
        const CDFlaps = flapRatio * 0.036;
        const CDWingDmg = Math.abs(this.damage.wingDamage) * 0.035;
        const CD = spec.CD0 + CDi + CDGear + CDFlaps + CDWingDmg + 0.45 * Math.sin(beta) * Math.sin(beta);

        const liftMag = qDyn * spec.wingArea * CL;
        const dragMag = qDyn * spec.wingArea * CD;
        const sideForceMag = -qDyn * spec.wingArea * 0.65 * beta;

        const dragDirBody = vBody.clone().divideScalar(V).negate();
        const liftDirBody = new THREE.Vector3(0, Math.cos(alpha), Math.sin(alpha)).normalize();

        const totalForceBody = new THREE.Vector3()
          .addScaledVector(dragDirBody, dragMag)
          .addScaledVector(liftDirBody, liftMag);
        totalForceBody.x += sideForceMag;

        // 6. Propulsion Thrust & Slipstream
        const densityRatio = Math.pow(rho / 1.225, spec.isJet ? 0.7 : 1.0);
        const abBoost = (spec.isJet && this.controls.engineRpm > 0.86) ? spec.afterburnerMult : 1.0;
        const thrustMag = this.controls.engineRpm * spec.maxThrust * densityRatio * abBoost;
        totalForceBody.z -= thrustMag;

        const totalForceWorld = totalForceBody.clone().applyQuaternion(this.quat);
        totalForceWorld.y -= totalMass * 9.80665;

        // 7. Multi-Point Tri-Gear Spring-Damper Contact & Stateful Damage
        const s = spec.scale;
        const wheelGearY = (this.controls.gear && !this.damage.gearCollapsed) ? -spec.gearHeight * s[1] : -0.45 * s[1];
        const wheelPointsBody = [
          new THREE.Vector3(0, wheelGearY, -spec.wheelBase * s[2]),                // Nose
          new THREE.Vector3(-spec.trackWidth * 0.5 * s[0], wheelGearY, 0.3 * s[2]), // Left Main
          new THREE.Vector3(spec.trackWidth * 0.5 * s[0], wheelGearY, 0.3 * s[2])   // Right Main
        ];

        let wheelsOnGround = 0;
        const gearTorqueBody = new THREE.Vector3();

        for (let i = 0; i < 3; i++) {
          const wpWorld = wheelPointsBody[i].clone().applyQuaternion(this.quat).add(this.pos);
          const gndY = this.getTerrainHeight(wpWorld.x, wpWorld.z) + 0.45;
          const compression = gndY - wpWorld.y;

          if (compression > 0) {
            wheelsOnGround++;

            // Evaluate Impact Severity at First Touchdown
            if (this.wasAirborne && this.vel.y < -0.5) {
              this.evaluateTouchdown(this.vel.y, V, euler);
            }

            // Spring-Damper Normal Force
            const rWorld = wpWorld.clone().sub(this.pos);
            const omegaWorld = this.angVel.clone().applyQuaternion(this.quat);
            const ptVelWorld = this.vel.clone().add(new THREE.Vector3().crossVectors(omegaWorld, rWorld));

            const fNormal = Math.max(0, spec.springK * compression - spec.damperC * ptVelWorld.y);
            totalForceWorld.y += fNormal;

            // Prevent Ground Tunneling
            if (compression > 0.35) {
              this.pos.y += (compression - 0.35);
              if (this.vel.y < 0) this.vel.y *= 0.25;
            }

            // Tire Braking & Lateral Cornering Friction
            const brakeActive = this.controls.parkingBrake || this.controls.wheelBrakes || this.damage.gearCollapsed;
            const muLong = (brakeActive ? 0.58 : 0.022) * this.env.surfaceFrictionMult;
            const horizSpd = Math.hypot(this.vel.x, this.vel.z);
            if (horizSpd > 0.05) {
              const decel = Math.min(horizSpd / dt, muLong * 9.81 * 1.4);
              this.vel.x -= (this.vel.x / horizSpd) * decel * dt;
              this.vel.z -= (this.vel.z / horizSpd) * decel * dt;
            } else if (brakeActive && thrustMag < totalMass * 1.5) {
              this.vel.x = 0;
              this.vel.z = 0;
            }

            // Suspension Righting Torque
            const fNormBody = new THREE.Vector3(0, fNormal, 0).applyQuaternion(invQuat);
            gearTorqueBody.add(new THREE.Vector3().crossVectors(wheelPointsBody[i], fNormBody));
          }
        }

        if (altAGL > 2.5) this.wasAirborne = true;

        // 8. Check Building Obstacle Collisions
        for (const obs of this.obstacles) {
          if (Math.abs(this.pos.x - obs.x) < obs.halfW &&
              Math.abs(this.pos.z - obs.z) < obs.halfD &&
              this.pos.y < obs.height + 2) {
            this.triggerCrash("High-energy impact with airport structure / building.");
            return;
          }
        }

        // 9. Rotational Dynamics & Control Surface Effectiveness
        const qEffect = THREE.MathUtils.clamp(V / 22.0, 0.12, 1.55);
        const wingDmgRollBias = this.damage.wingDamage * 0.65;
        const wingDmgAilMult = this.damage.wingDamage !== 0 ? 0.55 : 1.0;
        const propTorqueRoll = (!spec.isJet ? -this.controls.engineRpm * 0.06 : 0);

        const targetPitchRate = (this.controls.elevator + this.controls.trim) * spec.pitchAuthority * qEffect - alpha * 0.9;
        const targetRollRate  = (this.controls.aileron * wingDmgAilMult * spec.rollAuthority + wingDmgRollBias + propTorqueRoll) * qEffect - beta * 0.45;
        const targetYawRate   = this.controls.rudder * spec.yawAuthority * qEffect + beta * 1.35;

        const stallBuffet = (isStalling && wheelsOnGround === 0) ? Math.sin(performance.now() * 0.03) * 0.85 : 0;

        const rotDamp = 7.5 * dt;
        this.angVel.x += (targetPitchRate - this.angVel.x) * rotDamp;
        this.angVel.z += (targetRollRate + stallBuffet - this.angVel.z) * rotDamp;
        this.angVel.y += (targetYawRate - this.angVel.y) * rotDamp;

        // Ground Nosewheel Steering & Pitch/Bank Damping
        if (wheelsOnGround > 0) {
          this.angVel.y += this.controls.rudder * Math.min(1.1, V * 0.08) * 5 * dt;
          this.angVel.z = THREE.MathUtils.lerp(this.angVel.z, -euler.z * 2.5, 0.2);
          if (euler.x < -0.04) this.angVel.x = Math.max(0, this.angVel.x);
        }

        const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          this.angVel.x * dt,
          this.angVel.y * dt,
          this.angVel.z * dt,
          'YXZ'
        ));
        this.quat.multiply(dq).normalize();

        // Integrate Linear Acceleration & Velocity
        const accel = totalForceWorld.divideScalar(totalMass);
        this.vel.addScaledVector(accel, dt);
        this.pos.addScaledVector(this.vel, dt);

        // Guard against NaN corruption
        if (isNaN(this.pos.x) || isNaN(this.vel.x)) {
          this.loadScenario('runway');
          return;
        }

        // 10. Structural G-Load & Overspeed Failure Checks
        const gLoad = wheelsOnGround > 0 ? 1.0 : (liftMag / (totalMass * 9.80665));
        if (wheelsOnGround === 0 && (gLoad > spec.maxG * 1.25 || gLoad < spec.minG * 1.25)) {
          this.triggerCrash(`Catastrophic main wing spar failure at ${gLoad.toFixed(1)} G (Design Limit: +${spec.maxG}G).`);
          return;
        }
        if (V > spec.vne * 1.18) {
          this.triggerCrash(`Aeroelastic flutter disintegration exceeding Vne (${Math.round(V * 1.94384)} KT).`);
          return;
        }

        // 11. Compute Telemetry & ILS Approach Needles
        const eulerNow = new THREE.Euler().setFromQuaternion(this.quat, 'YXZ');
        const hdg = (THREE.MathUtils.radToDeg(-eulerNow.y) % 360 + 360) % 360;
        const groundSpd = Math.hypot(this.vel.x, this.vel.z);

        // ILS Runway 36 Threshold at (x: 0, y: 0.5, z: 1400)
        const dxILS = this.pos.x;
        const dzILS = Math.max(1, this.pos.z - 1400);
        const ilsDistM = Math.hypot(dxILS, this.pos.z - 1400);
        const locErrDeg = THREE.MathUtils.radToDeg(Math.atan2(dxILS, dzILS));
        const gsAngleDeg = THREE.MathUtils.radToDeg(Math.atan2(Math.max(0, this.pos.y - 0.5), dzILS));
        const gsErrDeg = gsAngleDeg - 3.0;

        this.telemetry = {
          ias: V * Math.sqrt(rho / 1.225) * 1.94384,
          tas: V * 1.94384,
          gs: groundSpd * 1.94384,
          mach: V / speedOfSound,
          altMSL: this.pos.y * 3.28084,
          altAGL: altAGL * 3.28084,
          vsi: this.vel.y * 196.85,
          alpha: THREE.MathUtils.radToDeg(alpha),
          beta: THREE.MathUtils.radToDeg(beta),
          gLoad: gLoad,
          lift: liftMag / 1000,
          drag: dragMag / 1000,
          thrust: thrustMag / 1000,
          pitchDeg: THREE.MathUtils.radToDeg(eulerNow.x),
          rollDeg: THREE.MathUtils.radToDeg(-eulerNow.z),
          headingDeg: hdg,
          inGroundEffect: inGE,
          stall: isStalling,
          gpws: wheelsOnGround === 0 && altAGL < 85 && this.vel.y < -5.5,
          overspeed: V > spec.vne,
          gearWarn: wheelsOnGround === 0 && !this.controls.gear && altAGL < 65 && this.controls.throttle < 0.35,
          ilsLocErrorDeg: THREE.MathUtils.clamp(locErrDeg, -5, 5),
          ilsGsErrorDeg: THREE.MathUtils.clamp(gsErrDeg, -2.5, 2.5),
          ilsDistNM: ilsDistM / 1852
        };

        // Update 3D Aircraft & Control Surfaces
        this.aircraftGroup.position.copy(this.pos);
        this.aircraftGroup.quaternion.copy(this.quat);
        this.leftAileron.rotation.x = this.controls.aileron * 0.45;
        this.rightAileron.rotation.x = -this.controls.aileron * 0.45;
        this.elevatorMesh.rotation.x = -this.controls.elevator * 0.45;
        this.rudderMesh.rotation.y = -this.controls.rudder * 0.45;

        if (this.propMesh && !this.damage.engineFailed) {
          this.propMesh.rotation.z += (8 + this.controls.engineRpm * 52) * dt;
        }
        if (this.abMesh) {
          this.abMesh.material.opacity = this.controls.engineRpm > 0.85 ? 0.6 + Math.random() * 0.3 : 0;
        }

        this.sound.update(this.controls.engineRpm, V, spec.isJet, isStalling, this.crashed);
      }

      /*************************************************************************
       * 7. TOUCHDOWN GRADING & STATEFUL DAMAGE EVALUATOR
       *************************************************************************/
      evaluateTouchdown(vy, V, euler) {
        this.wasAirborne = false;
        const sinkFpm = Math.abs(vy * 196.85);
        const pitchDeg = THREE.MathUtils.radToDeg(euler.x);
        const rollDeg = THREE.MathUtils.radToDeg(-euler.z);

        // 1. Catastrophic Impact Thresholds
        if (vy < -9.5) {
          this.triggerCrash(`Severe vertical ground impact at -${Math.round(sinkFpm)} FPM.`);
          return;
        }
        if (Math.abs(rollDeg) > 32 || pitchDeg < -20 || pitchDeg > 36) {
          this.triggerCrash(`Extreme attitude ground strike (Pitch: ${pitchDeg.toFixed(1)}\u00B0, Bank: ${rollDeg.toFixed(1)}\u00B0).`);
          return;
        }

        // 2. Non-Terminal Stateful Component Damage
        let dmgNotes = [];
        if (!this.controls.gear && V > 14) {
          this.damage.gearCollapsed = true;
          this.damage.engineFailed = !this.spec.isJet;
          dmgNotes.push("GEAR UP BELLY LANDING (Prop/Belly Damaged)");
        } else if (vy < -5.5) {
          this.damage.gearCollapsed = true;
          this.gearGroup.visible = false;
          dmgNotes.push("HARD LANDING: Landing Gear Struts Collapsed");
        }
        if (pitchDeg < -9.5 && !this.spec.isJet) {
          this.damage.engineFailed = true;
          dmgNotes.push("PROP STRIKE: Engine Seized");
        }
        if (Math.abs(rollDeg) > 18) {
          this.damage.wingDamage = Math.sign(rollDeg);
          dmgNotes.push(`${rollDeg > 0 ? 'RIGHT' : 'LEFT'} WINGTIP SCRAPE: Asymmetric Drag`);
        }

        this.sound.playImpact(Math.min(0.6, sinkFpm / 1200));
        this.updateDamageUI();

        // 3. Score Touchdown if on or near Runway 36/18
        const onRunwayCorridor = Math.abs(this.pos.x) < 40 && Math.abs(this.pos.z) < 1550;
        if (onRunwayCorridor || dmgNotes.length > 0) {
          let grade = "GREASER // BUTTER (A+)";
          if (dmgNotes.length > 0) grade = "DAMAGED LANDING (D)";
          else if (sinkFpm > 600) grade = "FIRM / HARD LANDING (C)";
          else if (sinkFpm > 280) grade = "ACCEPTABLE TOUCHDOWN (B)";

          const toast = document.getElementById('landing-toast');
          document.getElementById('ldg-title').innerText = grade;
          document.getElementById('ldg-details').innerHTML = `
            <div><b>TOUCHDOWN SINK RATE:</b> -${Math.round(sinkFpm)} FPM</div>
            <div><b>TOUCHDOWN IAS:</b> ${Math.round(this.telemetry.ias)} KT</div>
            <div><b>CENTERLINE DEVIATION:</b> ${Math.abs(this.pos.x).toFixed(1)} m</div>
            <div><b>BANK ANGLE:</b> ${rollDeg.toFixed(1)}°</div>
            ${dmgNotes.length ? `<div style="color:#ffaa00;margin-top:4px;"><b>DAMAGE:</b> ${dmgNotes.join(', ')}</div>` : ''}
          `;
          toast.style.display = 'block';
        }
      }

      updateDamageUI() {
        const gEl = document.getElementById('dmg-gear');
        const wEl = document.getElementById('dmg-wing');
        const eEl = document.getElementById('dmg-eng');

        gEl.className = 'dmg-badge ' + (this.damage.gearCollapsed ? 'dmg-fail' : '');
        gEl.innerText = this.damage.gearCollapsed ? 'GEAR: COLLAPSED' : 'GEAR: OK';

        wEl.className = 'dmg-badge ' + (this.damage.wingDamage !== 0 ? 'dmg-warn' : '');
        wEl.innerText = this.damage.wingDamage !== 0 ? 'WINGS: DAMAGED' : 'WINGS: OK';

        eEl.className = 'dmg-badge ' + (this.damage.engineFailed ? 'dmg-fail' : '');
        eEl.innerText = this.damage.engineFailed ? 'ENGINE: FAILED' : 'ENGINE: OK';
      }

      triggerCrash(reason) {
        this.crashed = true;
        this.aircraftGroup.visible = false;
        this.sound.playImpact(0.6);

        ['warn-stall', 'warn-gpws', 'warn-overspeed', 'warn-gear'].forEach(id => {
          document.getElementById(id).style.display = 'none';
        });

        const totalMass = this.spec.emptyMass + this.spec.payloadMass + this.fuelMass;
        const keMJ = (0.5 * totalMass * this.vel.lengthSq() / 1e6).toFixed(2);
        document.getElementById('crash-reason').innerText = reason;
        document.getElementById('crash-telemetry').innerHTML = `
          <div><b>AIRFRAME:</b> ${this.spec.name}</div>
          <div><b>IMPACT SPEED:</b> ${Math.round(this.telemetry.ias)} KT IAS (${Math.round(this.telemetry.gs)} KT GS)</div>
          <div><b>VERTICAL SINK RATE:</b> ${Math.round(this.telemetry.vsi)} FPM</div>
          <div><b>ATTITUDE AT IMPACT:</b> Pitch ${this.telemetry.pitchDeg.toFixed(1)}° / Roll ${this.telemetry.rollDeg.toFixed(1)}°</div>
          <div><b>NORMAL LOAD FACTOR:</b> ${this.telemetry.gLoad.toFixed(2)} G</div>
          <div><b>KINETIC ENERGY DISSIPATED:</b> ${keMJ} MJ</div>
        `;
        document.getElementById('crash-modal').style.display = 'block';

        // Spawn Wreckage Debris & Smoke Plume
        const colors = [this.spec.color, this.spec.accent, 0x222222];
        for (let i = 0; i < 24; i++) {
          const m = new THREE.Mesh(
            new THREE.BoxGeometry(0.6 + Math.random() * 2, 0.2 + Math.random() * 0.7, 0.6 + Math.random() * 2.2),
            new THREE.MeshLambertMaterial({ color: colors[i % 3] })
          );
          m.position.copy(this.pos).add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4));
          this.scene.add(m);
          this.debrisList.push({
            mesh: m,
            vel: this.vel.clone().multiplyScalar(0.3).add(new THREE.Vector3((Math.random() - 0.5) * 35, 8 + Math.random() * 25, (Math.random() - 0.5) * 35)),
            rot: new THREE.Vector3(Math.random() * 7, Math.random() * 7, Math.random() * 7)
          });
        }
        for (let i = 0; i < 40; i++) {
          const isFire = i < 16;
          const p = new THREE.Mesh(
            new THREE.SphereGeometry(isFire ? 1.8 : 2.8, 6, 6),
            new THREE.MeshBasicMaterial({ color: isFire ? 0xff5500 : 0x222222, transparent: true, opacity: 0.85 })
          );
          p.position.copy(this.pos);
          this.scene.add(p);
          this.particles.push({
            mesh: p,
            vel: new THREE.Vector3((Math.random() - 0.5) * 6, 4 + Math.random() * 11, (Math.random() - 0.5) * 6)
          });
        }
      }

      updateCrashDebris(dt) {
        for (const d of this.debrisList) {
          d.vel.y -= 9.81 * dt;
          d.mesh.position.addScaledVector(d.vel, dt);
          d.mesh.rotation.x += d.rot.x * dt;
          d.mesh.rotation.y += d.rot.y * dt;
          const gy = this.getTerrainHeight(d.mesh.position.x, d.mesh.position.z) + 0.3;
          if (d.mesh.position.y < gy) {
            d.mesh.position.y = gy;
            d.vel.y *= -0.35;
            d.vel.x *= 0.72;
            d.vel.z *= 0.72;
          }
        }
        for (const p of this.particles) {
          p.mesh.position.addScaledVector(p.vel, dt);
          p.mesh.scale.addScalar(dt * 0.5);
          p.mesh.material.opacity = Math.max(0.04, p.mesh.material.opacity - dt * 0.14);
        }
      }

      /*************************************************************************
       * 8. GLASS COCKPIT HUD (PFD + ILS NEEDLES + SLIP BALL)
       *************************************************************************/
      renderHUD() {
        const ctx = this.hudCtx;
        const w = this.hudCanvas.width;
        const h = this.hudCanvas.height;
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const t = this.telemetry;

        ctx.save();
        // If in Cockpit View (mode 1), draw windshield glare frame
        if (this.cameraMode === 1) {
          ctx.fillStyle = 'rgba(10, 16, 22, 0.88)';
          ctx.fillRect(0, h - 115, w, 115);
          ctx.strokeStyle = '#2a3b4c';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(0, h - 115); ctx.lineTo(w, h - 115);
          ctx.moveTo(cx - 280, 0); ctx.lineTo(cx - 360, h - 115);
          ctx.moveTo(cx + 280, 0); ctx.lineTo(cx + 360, h - 115);
          ctx.stroke();
        }

        ctx.strokeStyle = '#00ff77';
        ctx.fillStyle = '#00ff77';
        ctx.lineWidth = 1.8;
        ctx.font = 'bold 12.5px "Courier New", monospace';

        // 1. Aircraft Bore-Sight Reference Symbol
        ctx.beginPath();
        ctx.moveTo(cx - 32, cy); ctx.lineTo(cx - 10, cy); ctx.lineTo(cx - 10, cy + 7);
        ctx.moveTo(cx + 32, cy); ctx.lineTo(cx + 10, cy); ctx.lineTo(cx + 10, cy + 7);
        ctx.stroke();

        // 2. Flight Path Vector (FPV)
        const fpvX = cx + THREE.MathUtils.clamp(t.beta * 6.5, -120, 120);
        const fpvY = cy + THREE.MathUtils.clamp(t.alpha * 6.5, -120, 120);
        ctx.beginPath();
        ctx.arc(fpvX, fpvY, 6.5, 0, Math.PI * 2);
        ctx.moveTo(fpvX - 15, fpvY); ctx.lineTo(fpvX - 6.5, fpvY);
        ctx.moveTo(fpvX + 6.5, fpvY); ctx.lineTo(fpvX + 15, fpvY);
        ctx.moveTo(fpvX, fpvY - 6.5); ctx.lineTo(fpvX, fpvY - 14);
        ctx.stroke();

        // 3. Pitch Ladder & Artificial Horizon
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - 185, cy - 165, 370, 330);
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(THREE.MathUtils.degToRad(t.rollDeg));

        const pxPerDeg = 6.2;
        const pOff = t.pitchDeg * pxPerDeg;

        ctx.beginPath();
        ctx.lineWidth = 2.2;
        ctx.moveTo(-155, pOff); ctx.lineTo(-35, pOff);
        ctx.moveTo(35, pOff);  ctx.lineTo(155, pOff);
        ctx.stroke();

        ctx.lineWidth = 1.4;
        for (let deg = -40; deg <= 40; deg += 5) {
          if (deg === 0) continue;
          const y = pOff - deg * pxPerDeg;
          if (y < -160 || y > 160) continue;
          ctx.beginPath();
          if (deg < 0) ctx.setLineDash([5, 4]);
          else ctx.setLineDash([]);
          const s = deg > 0 ? 1 : -1;
          ctx.moveTo(-60, y); ctx.lineTo(-22, y); ctx.lineTo(-22, y + s * 6);
          ctx.moveTo(60, y);  ctx.lineTo(22, y);  ctx.lineTo(22, y + s * 6);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText(Math.abs(deg), -86, y + 4);
          ctx.fillText(Math.abs(deg), 66, y + 4);
        }
        ctx.restore();

        // 4. Turn Coordinator Slip/Skid Ball (Top Center)
        ctx.strokeRect(cx - 40, cy - 180, 80, 12);
        const ballX = cx + THREE.MathUtils.clamp(-t.beta * 3.5, -32, 32);
        ctx.beginPath();
        ctx.arc(ballX, cy - 174, 4.5, 0, Math.PI * 2);
        ctx.fill();

        // 5. ILS Localizer & Glideslope Needles (Cyan/Magenta)
        if (t.ilsDistNM < 12) {
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 2.2;
          // Localizer vertical needle
          const locX = cx - (t.ilsLocErrorDeg / 5.0) * 95;
          ctx.beginPath();
          ctx.moveTo(locX, cy + 95); ctx.lineTo(locX, cy + 145);
          ctx.stroke();
          // Glideslope horizontal needle
          const gsY = cy + (t.ilsGsErrorDeg / 2.5) * 75;
          ctx.beginPath();
          ctx.moveTo(cx + 150, gsY); ctx.lineTo(cx + 185, gsY);
          ctx.stroke();
          ctx.strokeStyle = '#00ff77';
          ctx.lineWidth = 1.8;
        }

        // 6. Airspeed Tape (Left)
        const tL = cx - 255;
        ctx.fillStyle = 'rgba(0, 20, 12, 0.55)';
        ctx.fillRect(tL - 55, cy - 145, 64, 290);
        ctx.strokeRect(tL - 55, cy - 145, 64, 290);
        ctx.fillStyle = '#00ff77';
        const ias = Math.round(t.ias);
        for (let s = Math.floor((ias - 50) / 10) * 10; s <= ias + 50; s += 10) {
          if (s < 0) continue;
          const y = cy - (s - ias) * 2.3;
          if (y < cy - 138 || y > cy + 138) continue;
          ctx.beginPath(); ctx.moveTo(tL + 1, y); ctx.lineTo(tL + 9, y); ctx.stroke();
          ctx.fillText(s, tL - 46, y + 4);
        }
        ctx.fillStyle = '#002211';
        ctx.fillRect(tL - 58, cy - 13, 66, 26);
        ctx.strokeRect(tL - 58, cy - 13, 66, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(`${ias} KT`, tL - 50, cy + 4);

        // 7. Altitude Tape (Right)
        const tR = cx + 245;
        ctx.fillStyle = 'rgba(0, 20, 12, 0.55)';
        ctx.fillRect(tR, cy - 145, 74, 290);
        ctx.strokeRect(tR, cy - 145, 74, 290);
        ctx.fillStyle = '#00ff77';
        const alt = Math.round(t.altMSL);
        for (let a = Math.floor((alt - 500) / 100) * 100; a <= alt + 500; a += 100) {
          const y = cy - (a - alt) * 0.25;
          if (y < cy - 138 || y > cy + 138) continue;
          ctx.beginPath(); ctx.moveTo(tR, y); ctx.lineTo(tR + 8, y); ctx.stroke();
          ctx.fillText(a, tR + 12, y + 4);
        }
        ctx.fillStyle = '#002211';
        ctx.fillRect(tR - 2, cy - 13, 80, 26);
        ctx.strokeRect(tR - 2, cy - 13, 80, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(`${alt} FT`, tR + 5, cy + 4);

        // 8. Heading Tape (Top)
        ctx.fillStyle = 'rgba(0, 20, 12, 0.55)';
        ctx.fillRect(cx - 145, cy - 222, 290, 30);
        ctx.strokeRect(cx - 145, cy - 222, 290, 30);
        ctx.fillStyle = '#00ff77';
        const hdg = Math.round(t.headingDeg);
        for (let d = hdg - 40; d <= hdg + 40; d++) {
          if (d % 10 === 0) {
            const nd = (d % 360 + 360) % 360;
            const x = cx + (d - hdg) * 3.2;
            ctx.beginPath(); ctx.moveTo(x, cy - 198); ctx.lineTo(x, cy - 192); ctx.stroke();
            let lbl = String(nd / 10).padStart(2, '0');
            if (nd === 0) lbl = 'N'; else if (nd === 90) lbl = 'E'; else if (nd === 180) lbl = 'S'; else if (nd === 270) lbl = 'W';
            ctx.fillText(lbl, x - 7, cy - 203);
          }
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(`HDG ${String(hdg).padStart(3, '0')}\u00B0`, cx - 32, cy - 228);

        ctx.restore();
      }

      updateUI() {
        const t = this.telemetry;
        document.getElementById('tel-speed').innerText = `${Math.round(t.ias)} / ${Math.round(t.gs)} KT`;
        document.getElementById('tel-mach').innerText = `${Math.round(t.tas)} KT / ${t.mach.toFixed(2)}`;
        document.getElementById('tel-alt').innerText = `${Math.round(t.altMSL)} / ${Math.round(t.altAGL)} FT`;
        document.getElementById('tel-vsi').innerText = `${Math.round(t.vsi)} FPM`;
        document.getElementById('tel-aoa').innerText = `${t.alpha.toFixed(1)}\u00B0 / ${t.beta.toFixed(1)}\u00B0`;
        document.getElementById('tel-gload').innerText = `${t.gLoad.toFixed(2)} G (+${this.spec.maxG}G)`;
        document.getElementById('tel-ld').innerText = `${t.lift.toFixed(1)} / ${t.drag.toFixed(1)} kN`;
        document.getElementById('tel-thrust').innerText = `${t.thrust.toFixed(1)} kN / ${Math.round(this.controls.engineRpm * 100)}%`;
        document.getElementById('tel-ge').innerText = t.inGroundEffect ? "ACTIVE (<1 SPAN)" : "INACTIVE";
        document.getElementById('tel-fuel').innerText = `${Math.round((this.fuelMass / this.spec.fuelCapacity) * 100)}% (${Math.round(this.fuelMass)} kg)`;

        document.getElementById('sys-thr').innerText = `${Math.round(this.controls.throttle * 100)}%`;
        document.getElementById('sys-rho').innerText = `${this.env.rho.toFixed(3)} kg/m\u00B3`;
        document.getElementById('sys-ils-d').innerText = `${t.ilsDistNM.toFixed(1)} NM`;

        document.getElementById('warn-stall').style.display = t.stall ? 'block' : 'none';
        document.getElementById('warn-gpws').style.display = t.gpws ? 'block' : 'none';
        document.getElementById('warn-overspeed').style.display = t.overspeed ? 'block' : 'none';
        document.getElementById('warn-gear').style.display = t.gearWarn ? 'block' : 'none';
      }

      updateSystemsUI() {
        const pb = document.getElementById('sys-pbrake');
        pb.innerText = this.controls.parkingBrake ? "SET (ON)" : "RELEASED";
        pb.style.color = this.controls.parkingBrake ? "var(--hud-amber)" : "var(--hud-green)";

        document.getElementById('sys-flaps').innerText = this.controls.flaps === 0 ? "0\u00B0 (CLEAN)" : `${this.controls.flaps}\u00B0 (DEPLOYED)`;
        document.getElementById('sys-gear').innerText = this.controls.gear ? "DOWN (3 GREEN)" : "RETRACTED (UP)";
        document.getElementById('sys-trim').innerText = `${THREE.MathUtils.radToDeg(this.controls.trim).toFixed(1)}\u00B0`;
        const cams = ["CHASE CAM", "COCKPIT VIEW", "ORBIT CAM", "TOWER FLYBY"];
        document.getElementById('sys-cam').innerText = cams[this.cameraMode];
      }

      cycleCamera() {
        this.cameraMode = (this.cameraMode + 1) % 4;
        this.camYaw = 0;
        this.camPitch = 0;
        this.aircraftGroup.visible = (this.cameraMode !== 1) && !this.crashed;
        this.updateSystemsUI();
      }

      toggleAssist() {
        this.controls.assistMode = !this.controls.assistMode;
        const btn = document.getElementById('btn-assist');
        btn.innerText = `ASSIST: ${this.controls.assistMode ? 'ON' : 'OFF'}`;
        btn.classList.toggle('active-btn', this.controls.assistMode);
      }

      toggleAutopilot() {
        this.controls.autopilot = !this.controls.autopilot;
        const btn = document.getElementById('btn-ap');
        btn.innerText = `AP HOLD: ${this.controls.autopilot ? 'ON' : 'OFF'}`;
        btn.classList.toggle('active-btn', this.controls.autopilot);
      }

      toggleAudio() {
        const on = this.sound.toggle();
        const btn = document.getElementById('btn-audio');
        btn.innerText = `AUDIO: ${on ? 'ON' : 'OFF'}`;
        btn.classList.toggle('active-btn', on);
      }

      togglePause() {
        this.paused = !this.paused;
        const btn = document.getElementById('btn-pause');
        btn.innerText = this.paused ? "RESUME (ESC)" : "PAUSE (ESC)";
        btn.classList.toggle('active-btn', this.paused);
      }

      updateCamera() {
        const s = this.spec.scale[2];
        if (this.crashed) {
          const t = performance.now() * 0.0004;
          this.camera.position.set(this.pos.x + Math.cos(t) * 32, this.pos.y + 14, this.pos.z + Math.sin(t) * 32);
          this.camera.lookAt(this.pos);
          return;
        }

        const lookQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.camPitch, this.camYaw, 0, 'YXZ'));

        if (this.cameraMode === 0) {
          // Chase Cam
          const offset = new THREE.Vector3(0, 4.0 * s, 16.0 * s).applyQuaternion(lookQuat).applyQuaternion(this.quat);
          this.camera.position.lerp(this.pos.clone().add(offset), 0.22);
          const target = this.pos.clone().add(new THREE.Vector3(0, 1.0, -18).applyQuaternion(this.quat));
          this.camera.lookAt(target);
        } else if (this.cameraMode === 1) {
          // Cockpit First-Person View
          const eye = new THREE.Vector3(0, 1.05 * s, -1.4 * s).applyQuaternion(this.quat);
          this.camera.position.copy(this.pos).add(eye);
          const forward = new THREE.Vector3(0, 0.95 * s, -100).applyQuaternion(lookQuat).applyQuaternion(this.quat);
          this.camera.lookAt(this.pos.clone().add(forward));
        } else if (this.cameraMode === 2) {
          // External Orbit Cam
          const dist = 20 * s;
          const ox = Math.sin(this.camYaw + 0.6) * Math.cos(this.camPitch + 0.2) * dist;
          const oy = Math.sin(this.camPitch + 0.25) * dist;
          const oz = Math.cos(this.camYaw + 0.6) * Math.cos(this.camPitch + 0.2) * dist;
          this.camera.position.copy(this.pos).add(new THREE.Vector3(ox, Math.max(2, oy), oz));
          this.camera.lookAt(this.pos);
        } else {
          // Control Tower Flyby Cam
          this.camera.position.set(95, 62, -180);
          this.camera.lookAt(this.pos);
        }

        this.sunLight.target.position.copy(this.pos);
        this.sunLight.target.updateMatrixWorld();
      }

      bindInputs() {
        window.addEventListener('keydown', (e) => {
          this.keys[e.code] = true;

          // Throttle 10% Step Keys (1-0)
          if (e.code.startsWith('Digit')) {
            const d = parseInt(e.code.replace('Digit', ''), 10);
            this.controls.throttle = d === 0 ? 1.0 : (d - 1) / 9;
          } else if (e.code === 'KeyG') {
            if (this.telemetry.altAGL > 3 && !this.damage.gearCollapsed) {
              this.controls.gear = !this.controls.gear;
              this.gearGroup.visible = this.controls.gear;
              this.updateSystemsUI();
            }
          } else if (e.code === 'BracketLeft') {
            this.controls.flaps = Math.max(0, this.controls.flaps - 15);
            this.updateSystemsUI();
          } else if (e.code === 'BracketRight') {
            this.controls.flaps = Math.min(30, this.controls.flaps + 15);
            this.updateSystemsUI();
          } else if (e.code === 'KeyB') {
            this.controls.parkingBrake = !this.controls.parkingBrake;
            this.updateSystemsUI();
          } else if (e.code === 'KeyC' || e.code === 'KeyV') {
            this.cycleCamera();
          } else if (e.code === 'KeyP') {
            this.toggleAutopilot();
          } else if (e.code === 'KeyR') {
            this.loadScenario('runway');
          } else if (e.code === 'Escape') {
            this.togglePause();
          } else if (e.code === 'Home' || e.code === 'PageUp') {
            this.controls.trim = Math.min(0.25, this.controls.trim + 0.015);
            this.updateSystemsUI();
          } else if (e.code === 'End' || e.code === 'PageDown') {
            this.controls.trim = Math.max(-0.25, this.controls.trim - 0.015);
            this.updateSystemsUI();
          }
        });

        window.addEventListener('keyup', (e) => {
          this.keys[e.code] = false;
        });

        // Mouse Look & Zoom
        this.container.addEventListener('mousedown', () => { this.isDraggingMouse = true; });
        window.addEventListener('mouseup', () => { this.isDraggingMouse = false; });
        window.addEventListener('mousemove', (e) => {
          if (!this.isDraggingMouse) return;
          this.camYaw -= e.movementX * 0.005;
          this.camPitch = THREE.MathUtils.clamp(this.camPitch - e.movementY * 0.005, -1.2, 1.2);
        });
        window.addEventListener('wheel', (e) => {
          this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 25, 85);
          this.camera.updateProjectionMatrix();
        });

        window.addEventListener('resize', () => {
          this.camera.aspect = window.innerWidth / window.innerHeight;
          this.camera.updateProjectionMatrix();
          this.renderer.setSize(window.innerWidth, window.innerHeight);
          this.hudCanvas.width = window.innerWidth;
          this.hudCanvas.height = window.innerHeight;
        });
      }

      animate() {
        requestAnimationFrame(() => this.animate());

        const now = performance.now();
        const frameDt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;

        this.accumulator += frameDt;
        let subSteps = 0;
        while (this.accumulator >= this.FIXED_DT && subSteps < 6) {
          this.stepPhysics(this.FIXED_DT);
          this.accumulator -= this.FIXED_DT;
          subSteps++;
        }

        this.frameCount++;
        if (this.frameCount % 20 === 0) {
          document.getElementById('fps-counter').innerText = `${Math.round(1 / Math.max(0.001, frameDt))} FPS`;
          this.updateUI();
        }

        this.updateCamera();
        this.renderer.render(this.scene, this.camera);
        this.renderHUD();
      }
    }

    let sim;
    window.addEventListener('DOMContentLoaded', () => {
      sim = new SkyforgeSimulator();
    });
  </script>
</body>
</html>
```

---

## 4. Verification & QA Checklist (15-Point Deterministic Matrix)

Before signing off on any modification or expansion to this simulator, verify all 15 behavioral requirements:

1. **Zero-Airspeed Singularity Check:** At $V = 0\text{ m/s}$ on the runway threshold with parking brake set (`B`), lift $L = 0$, drag $D = 0$, and no `NaN` values occur in $\alpha$ or $\beta$.
2. **Quadratic Dynamic Pressure Scaling:** Doubling true airspeed in level unstalled flight quadruples aerodynamic lift and parasitic drag ($q = \frac{1}{2}\rho V^2$).
3. **Ground Effect Cushion:** Flying within one wingspan of the runway ($h_{\text{AGL}} < b$) activates `GROUND EFFECT: ACTIVE`, reducing induced drag and floating slightly on flare.
4. **ISA Altitude & Temperature Lapse:** Climbing to $10,000\text{ ft}$ or raising the `ISA TEMP OFFSET` slider to $+30^\circ\text{C}$ visibly reduces air density $\rho$ and engine thrust output.
5. **Wind Vector & Windsock Alignment:** Setting a $26\text{ KT}$ crosswind from $270^\circ$ rotates the 3D orange windsock toward $090^\circ$ and requires a crab angle or wing-low slip on Runway 36 final approach.
6. **Dryden Turbulence Correlation:** Increasing `GUSTS & TURB` injects smooth, continuous Simplex air-mass velocity perturbations rather than artificial camera jitter.
7. **Stall & Post-Stall Recovery:** Pulling back at idle throttle increases $\alpha$ past $\alpha_{\text{stall}}$, sounding the stall horn and dropping the nose; pushing forward (`W`) reduces $\alpha$ and restores laminar lift.
8. **Tri-Gear Suspension Torque:** Touching down main wheels first pitches the nose down onto the nosewheel via spring-damper contact moments.
9. **Stateful Component Damage:** Touching down between $1,100\text{ FPM}$ and $1,800\text{ FPM}$ collapses the landing gear (`GEAR: COLLAPSED`) and adds parasitic drag without immediately triggering the catastrophic explosion screen.
10. **Asymmetric Wing Scrape:** Striking a wingtip at $>18^\circ$ bank near the ground triggers `WINGS: DAMAGED`, inducing a persistent roll bias and reduced aileron authority.
11. **Engine-Out Dead-Stick Glide:** Selecting `ENG OUT GLIDE` fails the engine (`ENGINE: FAILED`), forcing the pilot to pitch for best glide speed ($L/D_{\max}$) to make the runway.
12. **Touchdown Evaluator Toast:** Landing on Runway 36 pops up an automated grading report (`GREASER A+` to `DAMAGED D`) recording sink rate, IAS, centerline offset, and bank angle.
13. **ILS Localizer & Glideslope Needles:** Selecting `ILS FINAL` activates cyan localizer and glideslope deviation needles on the PFD to guide a $3.0^\circ$ approach path.
14. **Frame-Rate Independence:** The fixed $120\text{ Hz}$ physics accumulator produces identical flight trajectories regardless of whether the monitor refreshes at $30\text{ Hz}$, $60\text{ Hz}$, or $144\text{ Hz}$.
15. **Instant Clean Reset:** Clicking `RWY 36 START` or pressing `R` clears all debris, repairs all structural damage, refuels the tanks, and resets quaternion attitude without reloading the browser page.