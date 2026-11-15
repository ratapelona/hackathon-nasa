"use strict";
if (typeof importScripts === "function") { try { importScripts("render_engines.js"); } catch (_e) { } }
const DT = 0.05, SIGMA_SB = 5.670374419e-8, T_AMB = 295.0, EMISSIVITY = 0.82, TUBE_R = 1.0, TUBE_HALF = 1.8;
const SMAC_LIMITS = { co2: [5000, 20000], hcn: [1.0, 5.0], hcl: [2.0, 10.0], nox: [3.0, 15.0], so2: [1.0, 5.0], hf: [0.5, 3.0] };
const GAS_PROFILES = {
  pmma: { co2: 1850, hcn: 0, hcl: 0, nox: 1.4, so2: 0, hf: 0 }, cotton: { co2: 2100, hcn: 0, hcl: 0, nox: 1.2, so2: 0, hf: 0 },
  nomex: { co2: 1400, hcn: 2.2, hcl: 1.8, nox: 2.6, so2: 0.85, hf: 0.9 }, heptane: { co2: 2400, hcn: 0, hcl: 0, nox: 2.1, so2: 0, hf: 0 },
  propane: { co2: 2250, hcn: 0, hcl: 0, nox: 2.3, so2: 0, hf: 0 },
};
const CAT_FALLBACK = { solid: { co2: 1750, hcn: 0, hcl: 0, nox: 1.4, so2: 0, hf: 0 }, liquid: { co2: 2300, hcn: 0, hcl: 0, nox: 2.0, so2: 0, hf: 0 }, gas: { co2: 2200, hcn: 0, hcl: 0, nox: 2.2, so2: 0, hf: 0 } };
const ECRIT_BASE = { gas: 35, liquid: 65, solid: 110 };
// Compute Shader: cinemática turbulenta estocástica de 256 partículas confinadas al tubo.
const COMPUTE_WGSL = `
struct SimParams { p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> state_buf : array<vec4<f32>, 256>;
@group(0) @binding(1) var<uniform> sim_params : SimParams;
fn hsh(n: f32) -> f32 { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x; if (idx >= 256u) { return; }
  let fi = f32(idx); let t = sim_params.p2.x; let gEff = sim_params.p2.y; let tubeR = sim_params.p2.z; let tubeH = sim_params.p2.w;
  let flow = sim_params.p1.x; let vf = sim_params.p1.y * sim_params.p1.w * select(0.0, 1.0, sim_params.p0.z >= 12.0 && sim_params.p1.z > 0.5);
  let ph = fract(t * (0.18 + vf * 0.02 + flow * 0.015) + hsh(fi * 1.73)); let phi = hsh(fi * 3.17 + 1.2) * 6.283185 + sin(t * 1.4 + fi) * 0.45;
  let cz = hsh(fi * 5.41 + 2.7) * 2.0 - 1.0; let sz = sqrt(max(0.0, 1.0 - cz * cz));
  let r = (0.12 + 0.85 * sqrt(hsh(fi * 7.13))) * (0.25 + ph * tubeR * 0.9);
  var p = vec3<f32>(sz * cos(phi) * r, cz * r * 0.65 + ph * (flow * 0.04 + 1.5 * sqrt(max(gEff, 0.0))), sz * sin(phi) * r);
  let rad = length(p.xz); let lim = tubeR * 0.92;
  if (rad > lim) { p.x = p.x * lim / rad; p.z = p.z * lim / rad; }
  if (abs(p.y) > tubeH * 0.96) { p = vec3<f32>(p.x * 0.25, cz * 0.12, p.z * 0.25); }
  state_buf[idx] = vec4<f32>(p, ph);
}`;
const state = {
  materialName: "Cotton Fabric", category: "Solid", oxygenPct: 21.0, pressurePsi: 14.7, airflowCms: 10.0,
  igniterPowerW: 120.0, burnRateBaseMms: 2.1, flameColorHex: "#f59e0b", sphereRadiusScale: 1.0, riskScore: 55,
  ignEnergyJ: 0.0, eCritJ: 110.0, isIgnited: false, tempK: T_AMB, burnRateMms: 0.0, radiativeLossKw: 0.0,
  co2Damping: 1.0, elapsedSec: 0.0, gases: { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 },
  gLevel: 0.0, gJitter: 0, gEff: 0.0, fuelConsumedMm: 0.0, filter: [true, true, true, true, true],
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
const fuelKindOf = (name, cat) => { const n = String(name || "").toLowerCase(), c = String(cat || "").toLowerCase(); return c === "gas" ? "gas" : c === "liquid" ? "droplet" : n.includes("cotton") || n.includes("fabric") ? "cotton" : "pmma"; };
// PMMA: r(t)=r0-kp·Vf·t (r0=20 mm) | Algodón: frente=Vf·t/40 mm | n-Heptano: D²(t)=D0²-K·t (K·t=0.12·Vf·t) | Gas: inyector continuo.
function fuelGeometry() {
  const kind = fuelKindOf(state.materialName, state.category), x = state.fuelConsumedMm;
  const remaining = kind === "pmma" ? Math.max(0.2, 1 - x / 20) : kind === "cotton" ? Math.max(0, 1 - x / 40) : kind === "droplet" ? Math.sqrt(Math.max(0.0225, 1 - 0.12 * x)) : 1;
  return { kind, remaining, flameY: kind === "cotton" ? -0.45 + (1 - remaining) * 0.9 : 0 };
}
function resetSimulation(keepIgnited = false) {
  state.ignEnergyJ = 0.0; state.isIgnited = keepIgnited && state.oxygenPct >= 12.0; state.tempK = T_AMB; state.fuelConsumedMm = 0.0;
  state.burnRateMms = 0.0; state.radiativeLossKw = 0.0; state.co2Damping = 1.0; state.elapsedSec = 0.0;
  state.gases = { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 }; particleBuf.fill(0);
}
function applyParams(p = {}) {
  if (p.materialName !== undefined && String(p.materialName) !== state.materialName) state.fuelConsumedMm = 0.0;
  for (const k of ["materialName", "category", "oxygenPct", "pressurePsi", "airflowCms", "igniterPowerW", "burnRateBaseMms", "flameColorHex", "sphereRadiusScale", "riskScore", "gLevel", "gJitter"]) {
    if (p[k] !== undefined) state[k] = typeof state[k] === "number" ? Number(p[k]) : String(p[k]);
  }
  state.igniterPowerW = Math.max(0, state.igniterPowerW); state.burnRateBaseMms = Math.max(0.05, state.burnRateBaseMms); state.gLevel = Math.max(0, state.gLevel || 0);
}
function resizeOffscreen2D(sz) {
  if (!off2dRef || !sz) return;
  dpr2d = Math.max(1, Number(sz.dpr) || 1); off2dRef.width = Math.max(1, Math.floor(Math.max(120, Number(sz.width) || 320) * dpr2d)); off2dRef.height = Math.max(1, Math.floor(Math.max(120, Number(sz.height) || 240) * dpr2d));
}
async function ensureGPUCompute() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const adapter = globalThis.navigator?.gpu ? await globalThis.navigator.gpu.requestAdapter() : null;
      if (adapter) {
        gpuDevice = await adapter.requestDevice();
        computePipe = gpuDevice.createComputePipeline({ layout: "auto", compute: { module: gpuDevice.createShaderModule({ code: COMPUTE_WGSL }), entryPoint: "cs_main" } });
        stateBuf = gpuDevice.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        simUniformBuf = gpuDevice.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        computeBG = gpuDevice.createBindGroup({ layout: computePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: stateBuf } }, { binding: 1, resource: { buffer: simUniformBuf } }] });
      }
    } catch (_e) { gpuDevice = null; computePipe = null; }
    if (typeof self.postMessage === "function") self.postMessage({ type: "RENDER_MODE", gpuComputeActive: Boolean(computePipe), mode2d: ctx2d ? "OffscreenCanvas 2D" : "Standby" });
  })();
  return initPromise;
}
function dispatchGPUCompute() {
  if (!gpuDevice || !computePipe || !computeBG) return;
  gpuDevice.queue.writeBuffer(simUniformBuf, 0, new Float32Array([DT, state.igniterPowerW, state.oxygenPct, state.pressurePsi, state.airflowCms, state.burnRateBaseMms, state.isIgnited ? 1 : 0, state.co2Damping, state.elapsedSec, state.gEff, TUBE_R, TUBE_HALF]));
  const enc = gpuDevice.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(computePipe); pass.setBindGroup(0, computeBG); pass.dispatchWorkgroups(1); pass.end(); gpuDevice.queue.submit([enc.finish()]);
}
// Especies: 0 Llama/Hollín | 1 CO2 | 2 NOx | 3 Tóxicos (HCN/HCl/SO2/HF; 0 ppm => 0 partículas) | 4 Flujo O2 | 9 inactiva. w = especie + intensidad.
function speciesCounts(g) {
  const tox = g.hcn / 5 + g.hcl / 10 + g.so2 / 5 + g.hf / 3;
  return [state.isIgnited ? 70 : 0, g.co2 > 450 ? Math.round(6 + 54 * Math.min(1, (g.co2 - 420) / 20000)) : 0, g.nox > 0.001 ? Math.round(8 + 32 * Math.min(1, g.nox / 15)) : 0,
  tox > 0.0001 ? Math.round(10 + 30 * Math.min(1, tox / 2)) : 0, state.oxygenPct > 0 && state.airflowCms > 0 ? Math.round(Math.min(50, 6 + state.airflowCms * 2.2)) : 0];
}
const hsh = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
function placeParticle(i, s, t, uBuoy, flameR, fy) {
  const phi = hsh(i * 3.17 + 1.2) * 6.283185 + Math.sin(t * 1.3 + i * 0.7) * 0.45, cz = hsh(i * 5.41 + 2.7) * 2 - 1;
  const sz = Math.sqrt(Math.max(0, 1 - cz * cz)), flow = state.airflowCms * 0.03, jit = Math.sin(t * 2.1 + i * 1.9) * 0.12;
  const ph = (t * (s === 4 ? 0.12 + flow : 0.16 + flow * 0.45 + uBuoy * 0.35 + state.burnRateMms * 0.015) + hsh(i * 1.73)) % 1;
  const radN = 0.25 + 0.75 * Math.sqrt(hsh(i * 7.13)); let x, y, z;
  if (s === 4) { const rr = TUBE_R * (0.2 + 0.72 * Math.sqrt(hsh(i * 2.31))); x = Math.cos(phi) * rr + jit; z = Math.sin(phi) * rr; y = -TUBE_HALF + ph * 2 * TUBE_HALF; }
  else if (s === 0) { const rr = flameR * radN * (0.65 + 0.55 * ph); x = sz * Math.cos(phi) * rr + jit * 0.5; z = sz * Math.sin(phi) * rr; y = fy + cz * rr * (0.9 + uBuoy * 1.4) + uBuoy * flameR * ph; }
  else { const rr = (flameR * 0.6 + ph * TUBE_R * 0.95) * radN; x = sz * Math.cos(phi) * rr + jit; z = sz * Math.sin(phi) * rr - jit * 0.6; y = fy + cz * rr * 0.65 + ph * (flow * 1.3 + uBuoy * 1.7); }
  const rad = Math.hypot(x, z), lim = TUBE_R * 0.92;
  if (rad > lim) { x *= lim / rad; z *= lim / rad; }
  if (Math.abs(y) > TUBE_HALF * 0.96) { x *= 0.25; z *= 0.25; y = fy + cz * flameR * 0.4; }
  return [x, y, z, ph];
}
function updateParticlesCPU(uBuoy, fy) {
  const counts = speciesCounts(state.gases), t = state.elapsedSec, flameR = 0.35 * Math.max(0.6, Math.min(1.6, state.sphereRadiusScale));
  let i = 0;
  counts.forEach((n, s) => { for (let k = 0; k < n && i < 256; k++, i++) { const [x, y, z, ph] = placeParticle(i, s, t, uBuoy, flameR, fy); particleBuf.set([x, y, z, s + Math.min(0.99, 0.25 + 0.7 * (1 - ph))], i * 4); } });
  for (; i < 256; i++) particleBuf.set([0, 0, 0, 9], i * 4);
  return counts;
}
function render2DOffscreen(s) { if (ctx2d && off2dRef && globalThis.NasaRenderers) globalThis.NasaRenderers.paintChamber2D(ctx2d, off2dRef.width, off2dRef.height, s, particleBuf, state.filter, dpr2d); }
function stepPhysics() {
  state.elapsedSec += DT;
  state.gEff = Math.max(0, state.gLevel * (1 + (state.gJitter ? 0.6 * Math.sin(state.elapsedSec * 9.0) : 0)));
  const uBuoy = 0.9 * Math.sqrt(state.gEff), baseCrit = ECRIT_BASE[String(state.category || "solid").toLowerCase()] || 110;
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
    state.fuelConsumedMm += state.burnRateMms * DT;
  }
  state.radiativeLossKw = Math.max(0.0, (EMISSIVITY * SIGMA_SB * (Math.pow(state.tempK, 4) - Math.pow(T_AMB, 4))) / 1000.0);
  dispatchGPUCompute();
  const fuel = fuelGeometry(), counts = updateParticlesCPU(uBuoy, fuel.flameY);
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
    gLevel: state.gLevel, gEff: Number(state.gEff.toFixed(4)), buoyancyStretch: Number((1 + uBuoy * 1.4).toFixed(3)),
    fuelKind: fuel.kind, fuelRemaining: Number(fuel.remaining.toFixed(3)), flameCenterY: Number(fuel.flameY.toFixed(3)), speciesCounts: counts,
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
    if (m.viewMode) viewMode = m.viewMode; if (Array.isArray(m.filter)) state.filter = m.filter.slice(0, 5).map(Boolean);
    resizeOffscreen2D(m.sizes?.s2d || m.sizes); applyParams(m.params || m.payload || {}); await ensureGPUCompute();
    if (!running) { running = true; lastTickMs = 0; scheduleTick(workerLoop); }
  } else if (m.type === "UPDATE_PARAMS") { applyParams(m.params || m.payload || {}); }
  else if (m.type === "SYNC_BACKEND_TRUTH") {
    const d = m.data || {}; state.baseAirflowCms = state.airflowCms;
    applyParams({ burnRateBaseMms: d.predicted_burn_rate_mms, flameColorHex: d.flame_color_hex, sphereRadiusScale: d.sphere_radius_scale, riskScore: d.calculated_risk_score });
  } else if (m.type === "RESIZE_CANVAS") { resizeOffscreen2D(m.s2d || m.sizes?.s2d); }
  else if (m.type === "SET_VIEW_MODE") { viewMode = m.viewMode || viewMode; }
  else if (m.type === "SET_SPECIES_FILTER" && Array.isArray(m.filter)) { state.filter = m.filter.slice(0, 5).map(Boolean); }
  else if (m.type === "RESET_CHAMBER" || m.type === "reset") { resetSimulation(Boolean(m.keepIgnited)); }
};
