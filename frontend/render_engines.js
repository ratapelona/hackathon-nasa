(() => {
  "use strict";

  const GAS_COLORS = [[0.22, 0.74, 0.97], [0.75, 0.52, 0.99], [0.52, 0.9, 0.45], [0.98, 0.58, 0.18], [0.96, 0.82, 0.25], [0.96, 0.3, 0.45]];
  const GAS_KEYS = [["co2_ppm", 20000], ["hcn_ppm", 5], ["hcl_ppm", 10], ["nox_ppm", 15], ["so2_ppm", 5], ["hf_ppm", 3]];

  class AbstractFlameRenderer {
    constructor() {
      if (new.target === AbstractFlameRenderer) throw new TypeError("AbstractFlameRenderer es abstracta.");
      this.container = null; this.ro = null; this.w = 320; this.h = 240; this.dpr = 1;
      this.modeLabel = "Abstract"; this.lastMetrics = null; this.lastParticles = null; this.yaw = 0.25; this.pitch = 0.18;
    }
    bindResize(container) {
      this.container = container;
      if (typeof ResizeObserver !== "function" || typeof container?.getBoundingClientRect !== "function") return;
      const sync = () => {
        const r = container.getBoundingClientRect();
        this.resize(Math.max(120, r.width || 320), Math.max(120, r.height || 240), globalThis.devicePixelRatio || 1);
      };
      this.ro = new ResizeObserver(sync); this.ro.observe(container); sync();
    }
    resize(w, h, dpr = 1) {
      this.w = Math.max(120, Number(w) || 320); this.h = Math.max(120, Number(h) || 240); this.dpr = Math.max(1, Number(dpr) || 1);
    }
    async init(_container) { throw new Error("init() debe implementarse."); }
    updateState(_metrics, _particles) { throw new Error("updateState() debe implementarse."); }
    render(_metrics, _particles) { throw new Error("render() debe implementarse."); }
    destroy() { if (this.ro) this.ro.disconnect(); if (this.rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafId); }
  }

  class ThreeJSFlameRenderer extends AbstractFlameRenderer {
    constructor(onFallback) {
      super(); this.onFallback = onFallback; this.fallback = false; this.modeLabel = "Inicializando Three.js...";
      this.rafId = null; this.fbCanvas = null; this.fbCtx = null; this.drag = false;
    }
    async init(container) {
      this.container = container;
      if (container) container.innerHTML = "";
      try {
        const THREE = globalThis.THREE || await import("three");
        const ctrlMod = globalThis.OrbitControls ? { OrbitControls: globalThis.OrbitControls } : await import("three/addons/controls/OrbitControls.js");
        const OrbitControls = ctrlMod.OrbitControls;
        this.THREE = THREE; this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(48, this.w / this.h, 0.1, 100);
        this.camera.position.set(0, 0.4, 4.2);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.domElement.style.width = "100%"; this.renderer.domElement.style.height = "100%"; this.renderer.domElement.style.display = "block";
        container.appendChild(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 32), new THREE.MeshBasicMaterial({ color: 0xf59e0b }));
        this.haloMesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.95, 24, 24),
          new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        this.benchRing = new THREE.Mesh(
          new THREE.RingGeometry(0.54, 0.58, 48),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
        );
        const geo = new THREE.BufferGeometry();
        this.posArr = new Float32Array(256 * 3); this.colArr = new Float32Array(256 * 3);
        geo.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(this.colArr, 3));
        this.gasPoints = new THREE.Points(
          geo,
          new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        this.scene.add(this.haloMesh, this.coreMesh, this.gasPoints, this.benchRing);
        this.bindResize(container);
        this.modeLabel = "3D Three.js (OrbitControls)";
        const tick = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.rafId = requestAnimationFrame(tick); };
        this.rafId = requestAnimationFrame(tick);
      } catch (err) {
        this.fallback = true; this.modeLabel = "3D Fallback Canvas";
        if (container && typeof document !== "undefined") {
          this.fbCanvas = document.createElement("canvas");
          this.fbCanvas.style.width = "100%"; this.fbCanvas.style.height = "100%"; this.fbCanvas.style.display = "block";
          container.appendChild(this.fbCanvas); this.fbCtx = this.fbCanvas.getContext("2d");
          let lx = 0, ly = 0;
          this.fbCanvas.addEventListener("pointerdown", (e) => { this.drag = true; lx = e.clientX; ly = e.clientY; });
          globalThis.addEventListener("pointermove", (e) => {
            if (!this.drag) return; this.yaw += (e.clientX - lx) * 0.01;
            this.pitch = Math.max(-0.9, Math.min(0.9, this.pitch + (e.clientY - ly) * 0.01)); lx = e.clientX; ly = e.clientY;
          });
          globalThis.addEventListener("pointerup", () => { this.drag = false; });
        }
        this.bindResize(container);
        if (this.onFallback) this.onFallback(err.message);
      }
      return this.modeLabel;
    }
    resize(w, h, dpr = 1) {
      super.resize(w, h, dpr);
      if (this.renderer && this.camera) {
        this.camera.aspect = this.w / Math.max(1, this.h); this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(Math.min(this.dpr, 2)); this.renderer.setSize(this.w, this.h, false);
      }
      if (this.fbCanvas) { this.fbCanvas.width = Math.max(1, Math.floor(this.w * this.dpr)); this.fbCanvas.height = Math.max(1, Math.floor(this.h * this.dpr)); }
    }
    resetCamera() {
      this.yaw = 0.25; this.pitch = 0.18;
      if (this.camera && this.controls) { this.camera.position.set(0, 0.4, 4.2); this.controls.target.set(0, 0, 0); this.controls.update(); }
    }
    updateState(s, particles) {
      if (s) this.lastMetrics = s; if (particles && particles.length >= 1024) this.lastParticles = particles;
      const m = this.lastMetrics; if (!m || this.fallback || !this.coreMesh) return;
      const sc = Math.max(0.35, Number(m.sphereRadiusScale) || 0.7), stretch = 1.0 + Math.min(1.6, (m.airflowCms || 0) * 0.014);
      this.coreMesh.scale.set(sc * stretch, sc, sc);
      this.coreMesh.position.x = Math.min(0.6, (m.airflowCms || 0) * 0.006);
      this.coreMesh.material.color.set(m.flameColorHex || "#38bdf8");
      const radSc = sc * (1.05 + Math.min(1.1, ((m.radiationKwM2 || 0) / 800 + Math.max(0, (m.tempK || 295) - 295) / 2200) * 0.6));
      this.haloMesh.scale.set(radSc * stretch, radSc, radSc);
      this.haloMesh.position.x = this.coreMesh.position.x;
      this.haloMesh.material.opacity = m.isIgnited ? Math.min(0.55, 0.18 + (m.radiationKwM2 || 0) / 1800) : 0.08;
      this.benchRing.rotation.y += 0.015;
      if (this.lastParticles) {
        const activeRatios = GAS_KEYS.map(([k, lim]) => ((m[k] || 0) > 0.01 ? Math.min(1, 0.25 + (m[k] || 0) / lim) : 0));
        for (let i = 0; i < 256; i++) {
          this.posArr[i * 3] = this.lastParticles[i * 4]; this.posArr[i * 3 + 1] = this.lastParticles[i * 4 + 1]; this.posArr[i * 3 + 2] = this.lastParticles[i * 4 + 2];
          let gi = i % 6; if (activeRatios[gi] <= 0) gi = (m.nox_ppm || 0) > 0.05 && i % 5 === 0 ? 3 : 0;
          const inten = Math.max(0.15, this.lastParticles[i * 4 + 3]), rgb = GAS_COLORS[gi];
          this.colArr[i * 3] = rgb[0] * inten; this.colArr[i * 3 + 1] = rgb[1] * inten; this.colArr[i * 3 + 2] = rgb[2] * inten;
        }
        this.gasPoints.geometry.attributes.position.needsUpdate = true;
        this.gasPoints.geometry.attributes.color.needsUpdate = true;
      }
    }
    render(s, particles) {
      this.updateState(s, particles);
      if (!this.fallback || !this.fbCtx || !this.fbCanvas) return;
      const m = this.lastMetrics; if (!m) return;
      const c = this.fbCtx, cw = this.fbCanvas.width, ch = this.fbCanvas.height, cx = cw * 0.48, cy = ch * 0.5;
      const rad = Math.min(cw, ch) * 0.2 * (m.sphereRadiusScale || 0.7), sx = Math.min(cw * 0.15, (m.airflowCms || 0) * cw * 0.005);
      c.clearRect(0, 0, cw, ch); c.fillStyle = "#0b1020"; c.fillRect(0, 0, cw, ch);
      const g = c.createRadialGradient(cx + sx, cy, rad * 0.1, cx + sx, cy, rad * 2.1);
      g.addColorStop(0, "#fffbeb"); g.addColorStop(0.35, m.flameColorHex || "#38bdf8"); g.addColorStop(1, "rgba(11,16,32,0)");
      c.fillStyle = g; c.beginPath(); c.ellipse(cx + sx, cy, rad * (2.0 + (m.airflowCms || 0) * 0.015), rad * 1.9, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "rgba(56,189,248,0.55)"; c.lineWidth = Math.max(1.5, this.dpr);
      c.beginPath(); c.ellipse(cx, cy, rad * 1.35 * Math.max(0.25, Math.abs(Math.cos(this.yaw))), rad * 1.35, this.pitch * 0.4, 0, Math.PI * 2); c.stroke();
      if (this.lastParticles) {
        for (let i = 0; i < 256; i++) {
          const vx = this.lastParticles[i * 4], vy = this.lastParticles[i * 4 + 1], vz = this.lastParticles[i * 4 + 2];
          const rx = vx * Math.cos(this.yaw) - vz * Math.sin(this.yaw), ry = vy * Math.cos(this.pitch) - vz * Math.sin(this.pitch) * 0.4;
          c.fillStyle = `rgba(56,189,248,${(this.lastParticles[i * 4 + 3] * 0.7).toFixed(2)})`;
          c.fillRect(cx + rx * rad * 1.4, cy - ry * rad * 1.4, Math.max(2, this.dpr * 2), Math.max(2, this.dpr * 2));
        }
      }
      c.fillStyle = "#94a3b8"; c.font = `${(0.72 * this.dpr).toFixed(2)}rem system-ui`;
      c.fillText(`${this.modeLabel} | T=${m.tempK} K | q_rad=${m.radiationKwM2} kW/m2`, cw * 0.03, ch * 0.09);
    }
  }

  globalThis.NasaRenderers = { AbstractFlameRenderer, ThreeJSFlameRenderer };
})();
