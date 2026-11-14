(() => {
  "use strict";

  const hexToRgb = (hex) => {
    const clean = String(hex || "#38bdf8").replace("#", "");
    const n = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16) || 0x38bdf8;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  const WGSL_SHADER = `
struct U { a: vec4<f32>, c: vec4<f32>, f: vec4<f32>, v: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2<f32>, 6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  var o: VOut; o.pos = vec4<f32>(p[i], 0., 1.); o.uv = p[i]; return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
  var p = vec2<f32>(in.uv.x * u.a.x, in.uv.y);
  let cy = cos(u.v.x); let sy = sin(u.v.x); let cp = cos(u.v.y);
  let rot = vec2<f32>(p.x * cy - p.y * sy * 0.25, p.y * cp);
  let stretch = 1.0 + clamp(u.f.x, 0.0, 40.0) * 0.025;
  let q = vec2<f32>((rot.x - clamp(u.f.x * 0.008, 0.0, 0.35)) / stretch, rot.y * (1.0 + 0.1 * sy));
  let d = length(q);
  let r = clamp(u.a.z * 0.28, 0.12, 0.72);
  let pulse = 1.0 + 0.05 * sin(u.a.y * 5.0 + u.f.y * 0.1);
  let core = exp(-pow(d / (r * 0.55 * pulse), 2.2)) * (0.45 + 0.55 * u.c.w);
  let corona = exp(-abs(d - r * pulse) * (9.0 - min(5.0, u.f.y * 0.04))) * 0.85;
  let plume = exp(-pow(d / (r * 2.1), 1.6)) * (0.18 + 0.55 * u.f.z);
  let gasHue = vec3<f32>(0.58 * u.f.z + 0.12, 0.35 + 0.3 * (1.0 - u.f.z), 0.75 - 0.35 * u.f.z);
  var col = vec3<f32>(0.04, 0.06, 0.13);
  col += gasHue * plume + u.c.rgb * (corona + core * 0.85) + vec3<f32>(1.0, 0.96, 0.88) * pow(core, 2.5);
  col += vec3<f32>(0.98, 0.55, 0.15) * exp(-d * 18.0) * u.v.z * 0.8;
  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;

  class AbstractFlameRenderer {
    constructor() {
      if (new.target === AbstractFlameRenderer) throw new TypeError("AbstractFlameRenderer es abstracta.");
      this.canvas = null; this.ro = null; this.yaw = 0.2; this.pitch = 0.15; this.drag = false;
      this.modeLabel = "Abstract"; this.w = 320; this.h = 240; this.dpr = 1;
      this._onDown = (e) => { this.drag = true; this._lx = e.clientX; this._ly = e.clientY; };
      this._onMove = (e) => {
        if (!this.drag) return;
        this.orbitBy((e.clientX - this._lx) * 0.01, (e.clientY - this._ly) * 0.01);
        this._lx = e.clientX; this._ly = e.clientY;
      };
      this._onUp = () => { this.drag = false; };
    }
    orbitBy(dyaw, dpitch) {
      this.yaw += Number(dyaw) || 0;
      this.pitch = Math.max(-0.8, Math.min(0.8, this.pitch + (Number(dpitch) || 0)));
    }
    bindCanvas(canvas, initialSize) {
      this.canvas = canvas;
      if (initialSize) this.resize(initialSize.width, initialSize.height, initialSize.dpr);
      const isDom = typeof ResizeObserver === "function" && typeof canvas.getBoundingClientRect === "function";
      if (isDom) {
        const sync = () => {
          const rect = canvas.getBoundingClientRect();
          this.resize(Math.max(120, rect.width || 320), Math.max(120, rect.height || 240), globalThis.devicePixelRatio || 1);
        };
        this.ro = new ResizeObserver(sync); this.ro.observe(canvas); sync();
        canvas.addEventListener("pointerdown", this._onDown);
        globalThis.addEventListener("pointermove", this._onMove);
        globalThis.addEventListener("pointerup", this._onUp);
      }
    }
    resize(width, height, dpr) {
      this.w = Math.max(120, Number(width) || 320); this.h = Math.max(120, Number(height) || 240); this.dpr = Math.max(1, Number(dpr) || 1);
      if (this.canvas) { this.canvas.width = Math.max(1, Math.floor(this.w * this.dpr)); this.canvas.height = Math.max(1, Math.floor(this.h * this.dpr)); }
    }
    async init(_canvas, _sharedDevice) { throw new Error("init() debe implementarse."); }
    render(_state) { throw new Error("render() debe implementarse."); }
    destroy() {
      if (this.ro) this.ro.disconnect();
      if (this.canvas && typeof this.canvas.removeEventListener === "function") this.canvas.removeEventListener("pointerdown", this._onDown);
      if (typeof globalThis.removeEventListener === "function") {
        globalThis.removeEventListener("pointermove", this._onMove); globalThis.removeEventListener("pointerup", this._onUp);
      }
    }
  }

  class WebGPUFlame3DRenderer extends AbstractFlameRenderer {
    constructor(onFallback) { super(); this.onFallback = onFallback; this.fallback = false; this.modeLabel = "Inicializando..."; }
    async init(canvas, sharedDevice = null, initialSize = null) {
      this.bindCanvas(canvas, initialSize);
      try {
        if (!sharedDevice && (!globalThis.navigator || !globalThis.navigator.gpu)) throw new Error("WebGPU no soportado en este navegador.");
        this.device = sharedDevice || await (await globalThis.navigator.gpu.requestAdapter())?.requestDevice();
        if (!this.device) throw new Error("Sin adaptador GPU compatible.");
        const mod = this.device.createShaderModule({ code: WGSL_SHADER });
        this.format = globalThis.navigator.gpu.getPreferredCanvasFormat();
        this.pipe = this.device.createRenderPipeline({
          layout: "auto", vertex: { module: mod, entryPoint: "vs" },
          fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format }] },
        });
        this.uBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bg = this.device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uBuf } }] });
        this.gpuCtx = canvas.getContext("webgpu");
        if (!this.gpuCtx) throw new Error("Contexto webgpu nulo.");
        this.gpuCtx.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
        this.modeLabel = "3D WebGPU (WGSL)";
      } catch (err) {
        this.fallback = true; this.ctx2d = canvas.getContext("2d");
        this.modeLabel = "3D Fallback Canvas";
        if (this.onFallback) this.onFallback(err.message);
      }
      return this.modeLabel;
    }
    render(s) {
      if (!this.canvas || !s) return;
      const tox = Math.min(1, ((s.hcn_ppm || 0) / 5 + (s.hcl_ppm || 0) / 10 + (s.nox_ppm || 0) / 15 + (s.so2_ppm || 0) / 5 + (s.hf_ppm || 0) / 3) / 3);
      if (!this.fallback && this.gpuCtx) {
        const [r, g, b] = hexToRgb(s.flameColorHex);
        const arr = new Float32Array([
          this.canvas.width / Math.max(1, this.canvas.height), performance.now() * 0.001, s.sphereRadiusScale || 0.8, s.burnRateMms || 0,
          r, g, b, s.isIgnited ? 1 : 0, s.airflowCms || 0, s.radiativeLossKw || 0, tox, s.co2Damping || 1,
          this.yaw, this.pitch, (s.igniterPowerW || 0) / 500, (s.co2_ppm || 420) / 20000,
        ]);
        this.device.queue.writeBuffer(this.uBuf, 0, arr);
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.gpuCtx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0.04, g: 0.06, b: 0.13, a: 1 }, storeOp: "store" }] });
        pass.setPipeline(this.pipe); pass.setBindGroup(0, this.bg); pass.draw(6); pass.end();
        this.device.queue.submit([enc.finish()]);
      } else if (this.ctx2d) {
        const c = this.ctx2d, cw = this.canvas.width, ch = this.canvas.height, cx = cw * 0.48, cy = ch * 0.5;
        const rad = Math.min(cw, ch) * 0.22 * (s.sphereRadiusScale || 0.7), shift = Math.min(cw * 0.16, (s.airflowCms || 0) * cw * 0.005);
        c.clearRect(0, 0, cw, ch); c.fillStyle = "#0b1020"; c.fillRect(0, 0, cw, ch);
        const g = c.createRadialGradient(cx + shift, cy, rad * 0.1, cx + shift, cy, rad * 2.1);
        g.addColorStop(0, "#fffbeb"); g.addColorStop(0.35, s.flameColorHex || "#38bdf8"); g.addColorStop(0.75, `rgba(168,85,247,${0.15 + tox * 0.45})`); g.addColorStop(1, "rgba(11,16,32,0)");
        c.fillStyle = g; c.beginPath(); c.ellipse(cx + shift, cy, rad * (2.1 + (s.airflowCms || 0) * 0.025), rad * 2.0, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "rgba(148,163,184,0.35)"; c.lineWidth = Math.max(1, this.dpr);
        for (let i = -2; i <= 2; i++) { c.beginPath(); c.ellipse(cx, cy, rad * Math.max(0.25, Math.abs(Math.cos(this.yaw + i * 0.5))), rad, this.pitch * 0.4, 0, Math.PI * 2); c.stroke(); }
        c.fillStyle = "#94a3b8"; c.font = `${(0.72 * (this.dpr || 1)).toFixed(2)}rem system-ui`;
        c.fillText(`${this.modeLabel} | T=${s.tempK} K | q_rad=${s.radiationKwM2} kW/m2`, cw * 0.03, ch * 0.09);
      }
    }
  }

  class HeatmapFlame2DRenderer extends AbstractFlameRenderer {
    async init(canvas, _sharedDevice = null, initialSize = null) {
      this.bindCanvas(canvas, initialSize); this.ctx = canvas.getContext("2d"); this.modeLabel = "2D Thermal/Gas"; return this.modeLabel;
    }
    render(s) {
      if (!this.ctx || !this.canvas || !s) return;
      const c = this.ctx, cw = this.canvas.width, ch = this.canvas.height, cy = ch * 0.42, cx = cw * 0.45;
      const r = Math.min(cw, ch) * 0.18 * (s.sphereRadiusScale || 0.7), sx = Math.min(cw * 0.14, (s.airflowCms || 0) * cw * 0.004);
      c.clearRect(0, 0, cw, ch); c.fillStyle = "#090e1c"; c.fillRect(0, 0, cw, ch);
      const grad = c.createRadialGradient(cx + sx, cy, r * 0.08, cx + sx, cy, r * 2.2);
      grad.addColorStop(0, s.isIgnited ? "#ffffff" : "#64748b"); grad.addColorStop(0.25, s.flameColorHex || "#38bdf8");
      grad.addColorStop(0.65, "rgba(239,68,68,0.22)"); grad.addColorStop(1, "rgba(9,14,28,0)");
      c.fillStyle = grad; c.beginPath(); c.ellipse(cx + sx, cy, r * (2.2 + (s.airflowCms || 0) * 0.02), r * 2.0, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = s.igniterPowerW > 0 ? "#fb923c" : "#334155"; c.lineWidth = Math.max(1.5, this.dpr * 1.5);
      c.beginPath(); c.moveTo(cw * 0.08, cy); c.lineTo(cx - r * 0.3, cy); c.stroke();
      c.strokeStyle = "rgba(56,189,248,0.45)"; c.fillStyle = "#e2e8f0"; c.font = `${(0.7 * (this.dpr || 1)).toFixed(2)}rem system-ui`;
      for (let y = 0.2; y <= 0.65; y += 0.22) { c.beginPath(); c.moveTo(cw * 0.05, ch * y); c.lineTo(cw * 0.05 + cw * 0.08 * Math.min(2, (s.airflowCms || 1) / 10), ch * y); c.stroke(); }
      c.fillText(`Vf=${s.propagationSpeedMms} mm/s | Ign=${s.igniterPowerW} W (${s.isIgnited ? "ON" : "PRE"})`, cw * 0.03, ch * 0.09);
      const gases = [["CO2", s.co2_ppm, 20000], ["HCN", s.hcn_ppm, 5], ["HCl", s.hcl_ppm, 10], ["NOx", s.nox_ppm, 15], ["SO2", s.so2_ppm, 5], ["HF", s.hf_ppm, 3]];
      gases.forEach(([lbl, val, max], i) => {
        const bx = cw * (0.04 + i * 0.155), bw = cw * 0.13, by = ch * 0.85, pct = Math.min(1, (val || 0) / max);
        c.fillStyle = "#1e293b"; c.fillRect(bx, by, bw, ch * 0.05);
        c.fillStyle = pct > 0.7 ? "#ef4444" : pct > 0.3 ? "#f59e0b" : "#38bdf8"; c.fillRect(bx, by, bw * pct, ch * 0.05);
        c.fillStyle = "#cbd5e1"; c.fillText(`${lbl}:${Number(val || 0).toFixed(1)}`, bx, by - ch * 0.025);
      });
    }
  }

  globalThis.NasaRenderers = { AbstractFlameRenderer, WebGPUFlame3DRenderer, HeatmapFlame2DRenderer };
})();
