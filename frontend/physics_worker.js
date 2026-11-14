"use strict";

const DT = 0.05, SIGMA_SB = 5.670374419e-8, T_AMB = 295.0, EMISSIVITY = 0.82;
const SMAC_LIMITS = { co2: [5000, 20000], hcn: [1.0, 5.0], hcl: [2.0, 10.0], nox: [3.0, 15.0], so2: [1.0, 5.0], hf: [0.5, 3.0] };
const GAS_PROFILES = {
  pmma: { co2: 1850, hcn: 0, hcl: 0, nox: 1.4, so2: 0, hf: 0 }, cotton: { co2: 2100, hcn: 0, hcl: 0, nox: 1.2, so2: 0, hf: 0 },
  nomex: { co2: 1400, hcn: 2.2, hcl: 1.8, nox: 2.6, so2: 0.85, hf: 0.9 }, heptane: { co2: 2400, hcn: 0, hcl: 0, nox: 2.1, so2: 0, hf: 0 },
  propane: { co2: 2250, hcn: 0, hcl: 0, nox: 2.3, so2: 0, hf: 0 },
};
const CAT_FALLBACK = { solid: { co2: 1750, hcn: 0, hcl: 0, nox: 1.4, so2: 0, hf: 0 }, liquid: { co2: 2300, hcn: 0, hcl: 0, nox: 2.0, so2: 0, hf: 0 }, gas: { co2: 2200, hcn: 0, hcl: 0, nox: 2.2, so2: 0, hf: 0 } };
const ECRIT_BASE = { gas: 35, liquid: 65, solid: 110 };

const COMPUTE_WGSL = `
struct SimParams { p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> state_buf : array<vec4<f32>, 256>;
@group(0) @binding(1) var<uniform> sim_params : SimParams;
@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x; if (idx >= 256u) { return; }
  let dt = sim_params.p0.x; let ignW = sim_params.p0.y; let o2 = sim_params.p0.z;
  let flow = sim_params.p1.x; let baseVf = sim_params.p1.y; let damp = sim_params.p1.w; let rad = f32(idx) / 255.0;
  let localIgn = state_buf[idx].x + ignW * dt * exp(-rad * 2.5);
  let vf = select(0.0, baseVf * (1.0 + 0.14 * log(1.0 + max(0.0, flow))) * damp, o2 >= 12.0 && sim_params.p1.z > 0.5);
  let tk = 295.0 + clamp(vf * 260.0 + o2 * 20.0, 0.0, 2150.0) * exp(-rad * 1.4);
  let radKw = 0.82 * 5.6703744e-8 * (pow(tk, 4.0) - pow(295.0, 4.0)) / 1000.0;
  state_buf[idx] = vec4<f32>(localIgn, vf, radKw, state_buf[idx].w + vf * dt * 0.18 * (1.0 + 0.35 * (1.0 - min(1.0, flow * 0.5))));
}`;

const state = {
  materialName: "Cotton Fabric", category: "Solid", oxygenPct: 21.0, pressurePsi: 14.7, airflowCms: 10.0,
  igniterPowerW: 120.0, burnRateBaseMms: 2.1, flameColorHex: "#f59e0b", sphereRadiusScale: 1.0, riskScore: 55,
  ignEnergyJ: 0.0, eCritJ: 110.0, isIgnited: false, tempK: T_AMB, burnRateMms: 0.0, radiativeLossKw: 0.0,
  co2Damping: 1.0, elapsedSec: 0.0, gases: { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 },
};
const particleBuf = new Float32Array(256 * 4);
let running = false, viewMode = "3d", lastTickMs = 0, off2dRef = null, ctx2d = null, dpr2d = 1;
let gpuDevice = null, computePipe = null, computeBG = null, stateBuf = null, simUniformBuf = null, initPromise = null;

function selectGasProfile(name, cat) {
  const low = String(name || "").toLowerCase();
  for (const [k, v] of Object.entries(GAS_PROFILES)) { if (low.includes(k)) return v; }
  return CAT_FALLBACK[String(cat || "solid").toLowerCase()] || CAT_FALLBACK.solid;
}
const classifyAlert = (v, [w, c]) => (v >= c ? "CRITICAL" : v >= w ? "WARNING" : "SAFE");
const worstAlert = (a) => (Object.values(a).includes("CRITICAL") ? "CRITICAL" : Object.values(a).includes("WARNING") ? "WARNING" : "SAFE");

function resetSimulation(keepIgnited = false) {
  state.ignEnergyJ = 0.0; state.isIgnited = keepIgnited && state.oxygenPct >= 12.0; state.tempK = T_AMB;
  state.burnRateMms = 0.0; state.radiativeLossKw = 0.0; state.co2Damping = 1.0; state.elapsedSec = 0.0;
  state.gases = { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 }; particleBuf.fill(0);
}
function applyParams(p = {}) {
  for (const k of ["materialName", "category", "oxygenPct", "pressurePsi", "airflowCms", "igniterPowerW", "burnRateBaseMms", "flameColorHex", "sphereRadiusScale", "riskScore"]) {
    if (p[k] !== undefined) state[k] = typeof state[k] === "number" ? Number(p[k]) : String(p[k]);
  }
  state.igniterPowerW = Math.max(0, state.igniterPowerW); state.burnRateBaseMms = Math.max(0.05, state.burnRateBaseMms);
}
function resizeOffscreen2D(sz) {
  if (!off2dRef || !sz) return;
  dpr2d = Math.max(1, Number(sz.dpr) || 1);
  off2dRef.width = Math.max(1, Math.floor(Math.max(120, Number(sz.width) || 320) * dpr2d));
  off2dRef.height = Math.max(1, Math.floor(Math.max(120, Number(sz.height) || 240) * dpr2d));
}

async function ensureGPUCompute() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const adapter = globalThis.navigator?.gpu ? await globalThis.navigator.gpu.requestAdapter() : null;
      if (adapter) {
        gpuDevice = await adapter.requestDevice();
        const mod = gpuDevice.createShaderModule({ code: COMPUTE_WGSL });
        computePipe = gpuDevice.createComputePipeline({ layout: "auto", compute: { module: mod, entryPoint: "cs_main" } });
        stateBuf = gpuDevice.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        simUniformBuf = gpuDevice.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        computeBG = gpuDevice.createBindGroup({ layout: computePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: stateBuf } }, { binding: 1, resource: { buffer: simUniformBuf } }] });
      }
    } catch (_e) { gpuDevice = null; }
    if (typeof self.postMessage === "function") self.postMessage({ type: "RENDER_MODE", gpuComputeActive: Boolean(computePipe), mode2d: ctx2d ? "OffscreenCanvas 2D" : "Standby" });
  })();
  return initPromise;
}

function dispatchGPUCompute() {
  if (!gpuDevice || !computePipe || !computeBG) return;
  gpuDevice.queue.writeBuffer(simUniformBuf, 0, new Float32Array([DT, state.igniterPowerW, state.oxygenPct, state.pressurePsi, state.airflowCms, state.burnRateBaseMms, state.isIgnited ? 1 : 0, state.co2Damping]));
  const enc = gpuDevice.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(computePipe); pass.setBindGroup(0, computeBG); pass.dispatchWorkgroups(1); pass.end(); gpuDevice.queue.submit([enc.finish()]);
}
function updateParticlesCPU(toxRatio) {
  const spread = (state.isIgnited ? state.sphereRadiusScale : 0.45) * 0.65, drift = Math.min(1.1, state.airflowCms * 0.015), t = state.elapsedSec;
  for (let i = 0; i < 256; i++) {
    const phi = i * 2.399963, cost = 1 - (2 * (i + 0.5)) / 256, sint = Math.sqrt(Math.max(0, 1 - cost * cost));
    const radial = spread + ((t * (0.4 + state.burnRateMms * 0.08) + i * 0.017) % 1.15);
    particleBuf[i * 4] = sint * Math.cos(phi + t * 0.4) * radial + drift * (radial - spread * 0.4);
    particleBuf[i * 4 + 1] = cost * radial * 0.85; particleBuf[i * 4 + 2] = sint * Math.sin(phi + t * 0.4) * radial;
    particleBuf[i * 4 + 3] = Math.min(1.0, (state.isIgnited ? 0.35 : 0.08) + toxRatio * 0.65 * (1.0 - (i % 7) * 0.1));
  }
}

function render2DOffscreen(s) {
  if (!ctx2d || !off2dRef) return;
  const c = ctx2d, cw = off2dRef.width, ch = off2dRef.height, cy = ch * 0.42, cx = cw * 0.45;
  const r = Math.min(cw, ch) * 0.18 * (s.sphereRadiusScale || 0.7), sx = Math.min(cw * 0.14, (s.airflowCms || 0) * cw * 0.004);
  c.clearRect(0, 0, cw, ch); c.fillStyle = "#090e1c"; c.fillRect(0, 0, cw, ch);
  const grad = c.createRadialGradient(cx + sx, cy, r * 0.08, cx + sx, cy, r * 2.2);
  grad.addColorStop(0, s.isIgnited ? "#ffffff" : "#64748b"); grad.addColorStop(0.25, s.flameColorHex || "#38bdf8");
  grad.addColorStop(0.65, "rgba(239,68,68,0.22)"); grad.addColorStop(1, "rgba(9,14,28,0)");
  c.fillStyle = grad; c.beginPath(); c.ellipse(cx + sx, cy, r * (2.2 + (s.airflowCms || 0) * 0.02), r * 2.0, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = s.igniterPowerW > 0 ? "#fb923c" : "#334155"; c.lineWidth = Math.max(1.5, dpr2d * 1.5);
  c.beginPath(); c.moveTo(cw * 0.08, cy); c.lineTo(cx - r * 0.3, cy); c.stroke();
  c.strokeStyle = "rgba(56,189,248,0.45)"; c.fillStyle = "#e2e8f0"; c.font = `${(0.7 * dpr2d).toFixed(2)}rem system-ui`;
  for (let y = 0.2; y <= 0.65; y += 0.22) { c.beginPath(); c.moveTo(cw * 0.05, ch * y); c.lineTo(cw * 0.05 + cw * 0.08 * Math.min(2, (s.airflowCms || 1) / 10), ch * y); c.stroke(); }
  c.fillText(`Vf=${s.propagationSpeedMms} mm/s | Ign=${s.igniterPowerW} W (${s.isIgnited ? "ON" : "PRE"})`, cw * 0.03, ch * 0.09);
  [["CO2", s.co2_ppm, 20000], ["HCN", s.hcn_ppm, 5], ["HCl", s.hcl_ppm, 10], ["NOx", s.nox_ppm, 15], ["SO2", s.so2_ppm, 5], ["HF", s.hf_ppm, 3]].forEach(([lbl, val, max], i) => {
    const bx = cw * (0.04 + i * 0.155), bw = cw * 0.13, by = ch * 0.85, pct = Math.min(1, (val || 0) / max);
    c.fillStyle = "#1e293b"; c.fillRect(bx, by, bw, ch * 0.05); c.fillStyle = pct > 0.7 ? "#ef4444" : pct > 0.3 ? "#f59e0b" : "#38bdf8";
    c.fillRect(bx, by, bw * pct, ch * 0.05); c.fillStyle = "#cbd5e1"; c.fillText(`${lbl}:${Number(val || 0).toFixed(1)}`, bx, by - ch * 0.025);
  });
}

function stepPhysics() {
  state.elapsedSec += DT;
  const baseCrit = ECRIT_BASE[String(state.category || "solid").toLowerCase()] || 110;
  state.eCritJ = Number((baseCrit * (21.0 / Math.max(12.0, state.oxygenPct)) * Math.pow(14.7 / Math.max(2.0, state.pressurePsi), 0.25)).toFixed(2));
  if (state.oxygenPct < 12.0) state.isIgnited = false;
  else if (!state.isIgnited) {
    state.ignEnergyJ = state.igniterPowerW > 0 ? state.ignEnergyJ + state.igniterPowerW * DT : Math.max(0.0, state.ignEnergyJ - 18.0 * DT);
    if (state.ignEnergyJ >= state.eCritJ) state.isIgnited = true;
  }
  state.co2Damping = state.airflowCms < 2.0 ? Math.max(0.12, 1.0 - (state.gases.co2 / 42000.0) * (1.0 - state.airflowCms / 2.0)) : 1.0;
  if (state.isIgnited && state.gases.co2 >= 60000.0 && state.airflowCms < 0.8 && state.igniterPowerW < 50) state.isIgnited = false;
  if (!state.isIgnited && state.igniterPowerW <= 0) { state.burnRateMms = 0.0; state.tempK = Math.max(T_AMB, state.tempK - 45.0 * DT); }
  else if (!state.isIgnited) { state.burnRateMms = 0.0; state.tempK += (T_AMB + Math.min(420.0, state.igniterPowerW * 0.85 * (state.ignEnergyJ / Math.max(1, state.eCritJ))) - state.tempK) * 0.25; }
  else {
    const convectRatio = (1.0 + 0.14 * Math.log1p(Math.max(0.0, state.airflowCms))) / (1.0 + 0.14 * Math.log1p(Math.max(0.0, state.baseAirflowCms ?? state.airflowCms)));
    state.burnRateMms = Math.max(0.05, state.burnRateBaseMms * convectRatio * (state.airflowCms >= 18.0 && state.oxygenPct <= 21.0 ? 0.68 : 1.0) * state.co2Damping);
    state.tempK += (Math.min(2450.0, T_AMB + 760.0 + state.oxygenPct * 22.0 + state.burnRateMms * 38.0 * state.co2Damping) - state.tempK) * 0.2;
    const prof = selectGasProfile(state.materialName, state.category), massStep = state.burnRateMms * DT * 0.12;
    const co2Cap = Math.min(950000, state.oxygenPct * 9500), ventDecay = Math.max(0.0, 1.0 - state.airflowCms * 0.0015 * DT);
    state.gases.co2 = Math.min(co2Cap, state.gases.co2 * ventDecay + prof.co2 * massStep * Math.max(0.0, 1.0 - state.gases.co2 / co2Cap));
    for (const k of ["hcn", "hcl", "nox", "so2", "hf"]) state.gases[k] = Math.min(25000, state.gases[k] * ventDecay + prof[k] * massStep);
  }
  state.radiativeLossKw = Math.max(0.0, (EMISSIVITY * SIGMA_SB * (Math.pow(state.tempK, 4) - Math.pow(T_AMB, 4))) / 1000.0);
  dispatchGPUCompute();
  updateParticlesCPU(Math.min(1, (state.gases.hcn / 5 + state.gases.hcl / 10 + state.gases.nox / 15 + state.gases.so2 / 5 + state.gases.hf / 3 + state.gases.co2 / 20000) / 3));
  const gasAlerts = Object.fromEntries(Object.entries(SMAC_LIMITS).map(([g, lim]) => [g, classifyAlert(state.gases[g], lim)]));
  const radKw = Number(state.radiativeLossKw.toFixed(2)), vf = Number(state.burnRateMms.toFixed(3));
  return {
    materialName: state.materialName, category: state.category, oxygenPct: state.oxygenPct, pressurePsi: state.pressurePsi,
    airflowCms: state.airflowCms, igniterPowerW: state.igniterPowerW, ignEnergyJ: Number(state.ignEnergyJ.toFixed(1)),
    eCritJ: state.eCritJ, isIgnited: state.isIgnited, propagationSpeedMms: vf, burnRateMms: vf, tempK: Number(state.tempK.toFixed(1)),
    radiationKwM2: radKw, radiativeLossKw: radKw, co2Damping: Number(state.co2Damping.toFixed(3)),
    flameColorHex: state.isIgnited ? state.flameColorHex : "#38bdf8", sphereRadiusScale: state.isIgnited ? state.sphereRadiusScale : 0.42,
    co2_ppm: Number(state.gases.co2.toFixed(1)), hcn_ppm: Number(state.gases.hcn.toFixed(2)), hcl_ppm: Number(state.gases.hcl.toFixed(2)),
    nox_ppm: Number(state.gases.nox.toFixed(2)), so2_ppm: Number(state.gases.so2.toFixed(2)), hf_ppm: Number(state.gases.hf.toFixed(2)),
    gasAlerts, overallGasStatus: worstAlert(gasAlerts), gpuComputeActive: Boolean(computePipe),
  };
}

const scheduleTick = typeof self.requestAnimationFrame === "function" ? self.requestAnimationFrame.bind(self) : (fn) => setTimeout(fn, 50);
function workerLoop() {
  if (!running) return;
  const metrics = stepPhysics(); if (viewMode !== "3d") render2DOffscreen(metrics);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - lastTickMs >= 100) { lastTickMs = now; const snap = new Float32Array(particleBuf); self.postMessage({ type: "TELEMETRY_TICK", metrics, particles: snap }, [snap.buffer]); }
  scheduleTick(workerLoop);
}
self.onmessage = async (event) => {
  const m = event.data || {};
  if (m.type === "START_SIMULATION") {
    const c2d = m.canvas2d || m.off2d; if (c2d && !off2dRef) { off2dRef = c2d; ctx2d = off2dRef.getContext("2d"); }
    if (m.viewMode) viewMode = m.viewMode;
    resizeOffscreen2D(m.sizes?.s2d || m.sizes); applyParams(m.params || m.payload || {}); await ensureGPUCompute();
    if (!running) { running = true; lastTickMs = 0; scheduleTick(workerLoop); }
  } else if (m.type === "UPDATE_PARAMS") { applyParams(m.params || m.payload || {}); }
  else if (m.type === "SYNC_BACKEND_TRUTH") {
    const d = m.data || {}; state.baseAirflowCms = state.airflowCms;
    applyParams({ burnRateBaseMms: d.predicted_burn_rate_mms, flameColorHex: d.flame_color_hex, sphereRadiusScale: d.sphere_radius_scale, riskScore: d.calculated_risk_score });
  } else if (m.type === "RESIZE_CANVAS") { resizeOffscreen2D(m.s2d || m.sizes?.s2d); }
  else if (m.type === "SET_VIEW_MODE") { viewMode = m.viewMode || viewMode; }
  else if (m.type === "RESET_CHAMBER" || m.type === "reset") { resetSimulation(Boolean(m.keepIgnited)); }
};
