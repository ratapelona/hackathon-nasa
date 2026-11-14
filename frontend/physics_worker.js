"use strict";

if (typeof importScripts === "function") { try { importScripts("render_engines.js"); } catch (_e) {} }

const DT = 0.05, SIGMA_SB = 5.670374419e-8, T_AMB = 295.0, EMISSIVITY = 0.82;
const SMAC_LIMITS = { co2: [5000, 20000], hcn: [1.0, 5.0], hcl: [2.0, 10.0], nox: [3.0, 15.0], so2: [1.0, 5.0], hf: [0.5, 3.0] };
const GAS_PROFILES = {
  pmma: { co2: 1850, hcn: 0.0, hcl: 0.0, nox: 1.4, so2: 0.0, hf: 0.0 },
  cotton: { co2: 2100, hcn: 0.0, hcl: 0.0, nox: 1.2, so2: 0.0, hf: 0.0 },
  nomex: { co2: 1400, hcn: 2.2, hcl: 1.8, nox: 2.6, so2: 0.85, hf: 0.9 },
  heptane: { co2: 2400, hcn: 0.0, hcl: 0.0, nox: 2.1, so2: 0.0, hf: 0.0 },
  propane: { co2: 2250, hcn: 0.0, hcl: 0.0, nox: 2.3, so2: 0.0, hf: 0.0 },
};
const CAT_FALLBACK = {
  solid: { co2: 1750, hcn: 0.0, hcl: 0.0, nox: 1.4, so2: 0.0, hf: 0.0 },
  liquid: { co2: 2300, hcn: 0.0, hcl: 0.0, nox: 2.0, so2: 0.0, hf: 0.0 },
  gas: { co2: 2200, hcn: 0.0, hcl: 0.0, nox: 2.2, so2: 0.0, hf: 0.0 },
};
const ECRIT_BASE = { gas: 35, liquid: 65, solid: 110 };

const COMPUTE_WGSL = `
struct SimParams { p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> state_buf : array<vec4<f32>, 256>;
@group(0) @binding(1) var<uniform> sim_params : SimParams;

@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  if (idx >= 256u) { return; }
  let dt = sim_params.p0.x; let ignW = sim_params.p0.y; let o2 = sim_params.p0.z;
  let flow = sim_params.p1.x; let baseVf = sim_params.p1.y; let damp = sim_params.p1.w;
  let rad = f32(idx) / 255.0;
  let localIgn = state_buf[idx].x + ignW * dt * exp(-rad * 2.5);
  let vf = select(0.0, baseVf * (1.0 + 0.14 * log(1.0 + max(0.0, flow))) * damp, o2 >= 12.0 && sim_params.p1.z > 0.5);
  let tk = 295.0 + clamp(vf * 260.0 + o2 * 20.0, 0.0, 2150.0) * exp(-rad * 1.4);
  let radKw = 0.82 * 5.6703744e-8 * (pow(tk, 4.0) - pow(295.0, 4.0)) / 1000.0;
  let toxStep = vf * dt * 0.18 * (1.0 + 0.35 * (1.0 - min(1.0, flow * 0.5)));
  state_buf[idx] = vec4<f32>(localIgn, vf, radKw, state_buf[idx].w + toxStep);
}`;

const state = {
  materialName: "Cotton Fabric", category: "Solid", oxygenPct: 21.0, pressurePsi: 14.7, airflowCms: 10.0,
  igniterPowerW: 120.0, burnRateBaseMms: 2.1, flameColorHex: "#f59e0b", sphereRadiusScale: 1.0, riskScore: 55,
  ignEnergyJ: 0.0, eCritJ: 110.0, isIgnited: false, tempK: T_AMB, burnRateMms: 0.0, radiativeLossKw: 0.0,
  co2Damping: 1.0, elapsedSec: 0.0, gases: { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 },
};

let running = false, viewMode = "3d", lastTickMs = 0, r3d = null, r2d = null;
let gpuDevice = null, computePipe = null, computeBG = null, stateBuf = null, simUniformBuf = null;
let off3dRef = null, off2dRef = null, sizeCache = null, initPromise = null;

function selectGasProfile(name, cat) {
  const low = String(name || "").toLowerCase();
  for (const [k, v] of Object.entries(GAS_PROFILES)) { if (low.includes(k)) return v; }
  return CAT_FALLBACK[String(cat || "solid").toLowerCase()] || CAT_FALLBACK.solid;
}
const classifyAlert = (v, [w, c]) => (v >= c ? "CRITICAL" : v >= w ? "WARNING" : "SAFE");
const worstAlert = (a) => (Object.values(a).includes("CRITICAL") ? "CRITICAL" : Object.values(a).includes("WARNING") ? "WARNING" : "SAFE");

function resetSimulation(keepIgnited = false) {
  state.ignEnergyJ = 0.0; state.isIgnited = keepIgnited && state.oxygenPct >= 12.0;
  state.tempK = T_AMB; state.burnRateMms = 0.0; state.radiativeLossKw = 0.0; state.co2Damping = 1.0; state.elapsedSec = 0.0;
  state.gases = { co2: 420.0, hcn: 0.0, hcl: 0.0, nox: 0.0, so2: 0.0, hf: 0.0 };
}

function applyParams(p = {}) {
  for (const k of ["materialName", "category", "oxygenPct", "pressurePsi", "airflowCms", "igniterPowerW", "burnRateBaseMms", "flameColorHex", "sphereRadiusScale", "riskScore"]) {
    if (p[k] !== undefined) state[k] = typeof state[k] === "number" ? Number(p[k]) : String(p[k]);
  }
  state.igniterPowerW = Math.max(0, state.igniterPowerW); state.burnRateBaseMms = Math.max(0.05, state.burnRateBaseMms);
}

async function ensureGPUAndRenderers() {
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
    let mode3d = "Standby", mode2d = "Standby";
    if (globalThis.NasaRenderers) {
      if (off3dRef && !r3d) { r3d = new globalThis.NasaRenderers.WebGPUFlame3DRenderer(); mode3d = await r3d.init(off3dRef, gpuDevice, sizeCache?.s3d || null); }
      if (off2dRef && !r2d) { r2d = new globalThis.NasaRenderers.HeatmapFlame2DRenderer(); mode2d = await r2d.init(off2dRef, null, sizeCache?.s2d || null); }
    }
    self.postMessage({ type: "RENDER_MODE", gpuComputeActive: Boolean(computePipe), mode3d, mode2d });
  })();
  return initPromise;
}

function dispatchGPUCompute() {
  if (!gpuDevice || !computePipe || !computeBG) return;
  gpuDevice.queue.writeBuffer(simUniformBuf, 0, new Float32Array([DT, state.igniterPowerW, state.oxygenPct, state.pressurePsi, state.airflowCms, state.burnRateBaseMms, state.isIgnited ? 1 : 0, state.co2Damping]));
  const enc = gpuDevice.createCommandEncoder(), computePass = enc.beginComputePass();
  computePass.setPipeline(computePipe); computePass.setBindGroup(0, computeBG); computePass.dispatchWorkgroups(1); computePass.end();
  gpuDevice.queue.submit([enc.finish()]);
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

  if (!state.isIgnited && state.igniterPowerW <= 0) {
    state.burnRateMms = 0.0; state.tempK = Math.max(T_AMB, state.tempK - 45.0 * DT);
  } else if (!state.isIgnited) {
    state.burnRateMms = 0.0;
    state.tempK += (T_AMB + Math.min(420.0, state.igniterPowerW * 0.85 * (state.ignEnergyJ / Math.max(1, state.eCritJ))) - state.tempK) * 0.25;
  } else {
    const convectRatio = (1.0 + 0.14 * Math.log1p(Math.max(0.0, state.airflowCms))) / (1.0 + 0.14 * Math.log1p(Math.max(0.0, state.baseAirflowCms ?? state.airflowCms)));
    const blowoff = state.airflowCms >= 18.0 && state.oxygenPct <= 21.0 ? 0.68 : 1.0;
    state.burnRateMms = Math.max(0.05, state.burnRateBaseMms * convectRatio * blowoff * state.co2Damping);
    state.tempK += (Math.min(2450.0, T_AMB + 760.0 + state.oxygenPct * 22.0 + state.burnRateMms * 38.0 * state.co2Damping) - state.tempK) * 0.2;
    const prof = selectGasProfile(state.materialName, state.category), massStep = state.burnRateMms * DT * 0.12;
    const co2Cap = Math.min(950000, state.oxygenPct * 9500), ventDecay = Math.max(0.0, 1.0 - state.airflowCms * 0.0015 * DT);
    state.gases.co2 = Math.min(co2Cap, state.gases.co2 * ventDecay + prof.co2 * massStep * Math.max(0.0, 1.0 - state.gases.co2 / co2Cap));
    for (const k of ["hcn", "hcl", "nox", "so2", "hf"]) state.gases[k] = Math.min(25000, state.gases[k] * ventDecay + prof[k] * massStep);
  }
  state.radiativeLossKw = Math.max(0.0, (EMISSIVITY * SIGMA_SB * (Math.pow(state.tempK, 4) - Math.pow(T_AMB, 4))) / 1000.0);
  dispatchGPUCompute();
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
  const metrics = stepPhysics();
  if (r3d && viewMode !== "2d") r3d.render(metrics);
  if (r2d && viewMode !== "3d") r2d.render(metrics);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - lastTickMs >= 120) { lastTickMs = now; self.postMessage({ type: "TELEMETRY_TICK", metrics }); }
  scheduleTick(workerLoop);
}

self.onmessage = async (event) => {
  const m = event.data || {};
  if (m.type === "INIT_CANVAS") {
    off3dRef = m.off3d || m.canvas3d || off3dRef; off2dRef = m.off2d || m.canvas2d || off2dRef;
    viewMode = m.viewMode || viewMode; sizeCache = m.sizes || sizeCache; await ensureGPUAndRenderers();
  } else if (m.type === "START_SIMULATION") {
    off3dRef = m.off3d || m.canvas3d || off3dRef; off2dRef = m.off2d || m.canvas2d || off2dRef;
    if (m.viewMode) viewMode = m.viewMode; if (m.sizes) sizeCache = m.sizes;
    applyParams(m.params || m.payload || {}); await ensureGPUAndRenderers();
    if (!running) { running = true; lastTickMs = 0; scheduleTick(workerLoop); }
  } else if (m.type === "UPDATE_PARAMS") { applyParams(m.params || m.payload || {}); }
  else if (m.type === "SYNC_BACKEND_TRUTH") {
    const d = m.data || {}; state.baseAirflowCms = state.airflowCms;
    applyParams({ burnRateBaseMms: d.predicted_burn_rate_mms, flameColorHex: d.flame_color_hex, sphereRadiusScale: d.sphere_radius_scale, riskScore: d.calculated_risk_score });
  } else if (m.type === "RESIZE_CANVAS") {
    if (r3d && m.s3d) r3d.resize(m.s3d.width, m.s3d.height, m.s3d.dpr);
    if (r2d && m.s2d) r2d.resize(m.s2d.width, m.s2d.height, m.s2d.dpr);
  } else if (m.type === "SET_VIEW_MODE") { viewMode = m.viewMode || viewMode; }
  else if (m.type === "ORBIT_DELTA" && r3d) { r3d.orbitBy(m.dyaw, m.dpitch); }
  else if (m.type === "RESET_CHAMBER" || m.type === "reset") { resetSimulation(Boolean(m.keepIgnited)); }
};
