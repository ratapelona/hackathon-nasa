(() => {
  "use strict";
  const TUBE_R = 1.0, TUBE_HALF = 1.8;
  const SPECIES_RGB = [[1.0, 0.62, 0.2], [0.22, 0.74, 0.97], [0.98, 0.57, 0.24], [0.96, 0.25, 0.37], [0.65, 0.95, 0.8]];
  const SPECIES_CSS = SPECIES_RGB.map((c) => c.map((v) => Math.round(v * 255)).join(","));
  const decode = (w) => { const s = Math.floor(w); return [s, w - s]; };

  // Corte longitudinal 2D del tubo (Worker OffscreenCanvas y fallback 3D). Todo se recorta (clip) al volumen del tubo.
  function paintChamber2D(c, cw, ch, s, buf, filter, dpr = 1) {
    const cx = cw * 0.5, cy = ch * 0.42, k = Math.min((ch * 0.33) / TUBE_HALF, (cw * 0.42) / TUBE_R), rem = s.fuelRemaining ?? 1;
    const tx = cx - TUBE_R * k, ty = cy - TUBE_HALF * k, tw = 2 * TUBE_R * k, th = 2 * TUBE_HALF * k, fy = cy - (s.flameCenterY || 0) * k;
    c.clearRect(0, 0, cw, ch); c.fillStyle = "#090e1c"; c.fillRect(0, 0, cw, ch);
    c.save(); c.beginPath(); c.rect(tx, ty, tw, th); c.clip(); c.fillStyle = "rgba(186,230,253,0.05)"; c.fillRect(tx, ty, tw, th);
    const fr = 0.35 * k * Math.max(0.6, Math.min(1.6, s.sphereRadiusScale || 0.7)), st = s.buoyancyStretch || 1, gy = fy - fr * (st - 1) * 0.5;
    if (s.isIgnited && filter[0]) {
      const g = c.createRadialGradient(cx, gy, fr * 0.1, cx, gy, fr * 1.8 * st);
      g.addColorStop(0, "#ffffff"); g.addColorStop(0.3, s.flameColorHex || "#f59e0b"); g.addColorStop(0.7, "rgba(239,68,68,0.25)"); g.addColorStop(1, "rgba(9,14,28,0)");
      c.fillStyle = g; c.beginPath(); c.ellipse(cx, gy, fr * 1.5, fr * 1.5 * st, 0, 0, Math.PI * 2); c.fill();
    }
    const kind = s.fuelKind || "pmma";
    c.fillStyle = kind === "droplet" ? "rgba(254,243,199,0.85)" : kind === "cotton" ? "#e7e5e4" : kind === "gas" ? "#94a3b8" : `rgba(${Math.round(60 + 164 * rem)},${Math.round(50 + 192 * rem)},${Math.round(45 + 209 * rem)},0.9)`;
    if (kind === "droplet") { c.beginPath(); c.arc(cx, cy, 0.2 * k * rem, 0, Math.PI * 2); c.fill(); }
    else if (kind === "cotton") { c.fillRect(cx - 0.25 * k, cy - 0.45 * k, 0.5 * k, 0.9 * k); c.fillStyle = "#1c1917"; c.fillRect(cx - 0.25 * k, cy + 0.45 * k - (1 - rem) * 0.9 * k, 0.5 * k, (1 - rem) * 0.9 * k); }
    else if (kind === "gas") { c.fillRect(cx - 0.05 * k, cy + 0.06 * k, 0.1 * k, (TUBE_HALF - 0.06) * k); c.beginPath(); c.arc(cx, cy, 0.08 * k, 0, Math.PI * 2); c.fill(); }
    else c.fillRect(cx - 0.22 * k * rem, cy - 0.275 * k, 0.44 * k * rem, 0.55 * k);
    const edge = { pmma: 0.22 * rem, cotton: 0.25, droplet: 0.2 * rem, gas: 0.1 }[kind], iy = kind === "cotton" ? cy + 0.45 * k : cy;
    c.strokeStyle = s.igniterPowerW > 0 ? "#fb923c" : "#475569"; c.lineWidth = Math.max(1.5, dpr * 2); c.beginPath(); c.moveTo(tx, iy); c.lineTo(cx - edge * k, iy); c.stroke();
    c.strokeStyle = "rgba(103,232,249,0.6)";
    for (const fx of [-0.6, 0, 0.6]) { const by = cy + TUBE_HALF * k * 0.95; c.beginPath(); c.moveTo(cx + fx * k, by); c.lineTo(cx + fx * k, by - Math.min(0.5, (s.airflowCms || 0) * 0.02) * k); c.stroke(); }
    for (let i = 0; buf && i < 256; i++) {
      const [sp, inten] = decode(buf[i * 4 + 3]); if (sp > 4 || !filter[sp]) continue;
      c.fillStyle = `rgba(${SPECIES_CSS[sp]},${(0.25 + 0.75 * inten).toFixed(2)})`; c.fillRect(cx + buf[i * 4] * k - dpr, cy - buf[i * 4 + 1] * k - dpr, 2 * dpr, 2 * dpr);
    }
    c.restore(); c.strokeStyle = "rgba(186,230,253,0.7)"; c.lineWidth = Math.max(1.5, dpr * 2); c.strokeRect(tx, ty, tw, th);
    c.fillStyle = "#e2e8f0"; c.font = `${(0.65 * dpr).toFixed(2)}rem system-ui`;
    c.fillText(`Vf=${s.propagationSpeedMms} mm/s | Ign=${s.igniterPowerW} W (${s.isIgnited ? "ON" : "PRE"}) | g=${s.gEff ?? 0}`, cw * 0.03, ch * 0.055);
    [["CO2", s.co2_ppm, 20000], ["HCN", s.hcn_ppm, 5], ["HCl", s.hcl_ppm, 10], ["NOx", s.nox_ppm, 15], ["SO2", s.so2_ppm, 5], ["HF", s.hf_ppm, 3]].forEach(([lbl, val, max], i) => {
      const bx = cw * (0.04 + i * 0.155), bw = cw * 0.13, by = ch * 0.9, pct = Math.min(1, (val || 0) / max);
      c.fillStyle = "#1e293b"; c.fillRect(bx, by, bw, ch * 0.045); c.fillStyle = pct > 0.7 ? "#ef4444" : pct > 0.3 ? "#f59e0b" : "#38bdf8";
      c.fillRect(bx, by, bw * pct, ch * 0.045); c.fillStyle = "#cbd5e1"; c.fillText(`${lbl}:${Number(val || 0).toFixed(1)}`, bx, by - ch * 0.02);
    });
  }

  class AbstractFlameRenderer {
    constructor() {
      if (new.target === AbstractFlameRenderer) throw new TypeError("AbstractFlameRenderer es abstracta.");
      this.container = null; this.ro = null; this.w = 320; this.h = 240; this.dpr = 1; this.modeLabel = "Abstract";
      this.lastMetrics = null; this.lastParticles = null; this.filter = [true, true, true, true, true];
    }
    bindResize(container) {
      this.container = container;
      if (typeof ResizeObserver !== "function" || typeof container?.getBoundingClientRect !== "function") return;
      const sync = () => { const r = container.getBoundingClientRect(); this.resize(Math.max(120, r.width || 320), Math.max(120, r.height || 240), globalThis.devicePixelRatio || 1); };
      this.ro = new ResizeObserver(sync); this.ro.observe(container); sync();
    }
    resize(w, h, dpr = 1) { this.w = Math.max(120, Number(w) || 320); this.h = Math.max(120, Number(h) || 240); this.dpr = Math.max(1, Number(dpr) || 1); }
    setFilter(f) { this.filter = Array.from({ length: 5 }, (_, i) => Boolean(f?.[i])); }
    async init(_container) { throw new Error("init() debe implementarse."); }
    updateState(_metrics, _particles) { throw new Error("updateState() debe implementarse."); }
    render(_metrics, _particles) { throw new Error("render() debe implementarse."); }
    destroy() { if (this.ro) this.ro.disconnect(); if (this.rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafId); }
  }

  class ThreeJSFlameRenderer extends AbstractFlameRenderer {
    constructor(onFallback) { super(); this.onFallback = onFallback; this.fallback = false; this.modeLabel = "Inicializando Three.js..."; this.rafId = null; this.fbCanvas = null; this.fbCtx = null; }
    _spriteTexture(THREE) {
      const cv = document.createElement("canvas"); cv.width = 32; cv.height = 32;
      const g2 = cv.getContext("2d"), grd = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.4, "rgba(255,255,255,0.55)"); grd.addColorStop(1, "rgba(255,255,255,0)");
      g2.fillStyle = grd; g2.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(cv);
    }
    _buildScene(THREE) {
      const S = this.scene, HALF_PI = Math.PI / 2;
      const mk = (geo, mat, pos = {}, rot = null) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.position, pos); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m; };
      S.add(new THREE.AmbientLight(0xffffff, 0.6)); this.flameLight = new THREE.PointLight(0xffa040, 0, 6); S.add(this.flameLight);
      const glass = new THREE.MeshPhysicalMaterial({ color: 0xbae6fd, transparent: true, opacity: 0.13, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false });
      const metal = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.3 }), tick = new THREE.MeshBasicMaterial({ color: 0x64748b });
      this.tube = mk(new THREE.CylinderGeometry(TUBE_R, TUBE_R, TUBE_HALF * 2, 48, 1, true), glass);
      const rings = [-TUBE_HALF, TUBE_HALF].map((y) => mk(new THREE.TorusGeometry(TUBE_R, 0.035, 10, 48), metal, { y }, [HALF_PI, 0, 0]));
      const ticks = [-1.2, -0.6, 0, 0.6, 1.2].map((y) => mk(new THREE.TorusGeometry(TUBE_R * 1.003, 0.004, 4, 48), tick, { y }, [HALF_PI, 0, 0]));
      this.bounds = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-TUBE_R, -TUBE_HALF, -TUBE_R), new THREE.Vector3(TUBE_R, TUBE_HALF, TUBE_R)), 0x38bdf8);
      const flowMat = new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.5 });
      this.flowRings = [-TUBE_HALF + 0.12, TUBE_HALF - 0.12].map((y) => mk(new THREE.TorusGeometry(TUBE_R * 0.7, 0.014, 6, 40), flowMat, { y }, [HALF_PI, 0, 0]));
      S.add(this.tube, this.bounds, ...rings, ...ticks, ...this.flowRings);
      this.fuels = {
        pmma: mk(new THREE.CylinderGeometry(0.22, 0.22, 0.55, 9), new THREE.MeshPhysicalMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.85, roughness: 0.12, clearcoat: 1, flatShading: true })),
        cotton: new THREE.Group(), gas: new THREE.Group(),
        droplet: mk(new THREE.SphereGeometry(0.2, 32, 32), new THREE.MeshPhysicalMaterial({ color: 0xfef3c7, transmission: 0.9, ior: 1.38, thickness: 0.35, roughness: 0.04, transparent: true })),
      };
      this.charSheet = mk(new THREE.PlaneGeometry(0.5, 0.9), new THREE.MeshBasicMaterial({ color: 0x1c1917, side: THREE.DoubleSide }), { z: 0.004 });
      this.fuels.cotton.add(mk(new THREE.PlaneGeometry(0.5, 0.9, 12, 18), new THREE.MeshStandardMaterial({ color: 0xf5f0dc, side: THREE.DoubleSide, roughness: 0.9 })),
        mk(new THREE.PlaneGeometry(0.5, 0.9, 12, 18), new THREE.MeshBasicMaterial({ color: 0xa8a29e, wireframe: true }), { z: 0.002 }), this.charSheet);
      this.fuels.gas.add(mk(new THREE.CylinderGeometry(0.05, 0.07, TUBE_HALF - 0.06, 16), metal, { y: -(TUBE_HALF + 0.06) / 2 }), mk(new THREE.SphereGeometry(0.08, 16, 16), metal));
      Object.values(this.fuels).forEach((f) => S.add(f));
      this.ignMat = new THREE.MeshStandardMaterial({ color: 0x78716c, emissive: 0xff5a1f, emissiveIntensity: 0 });
      this.igniter = new THREE.Group();
      this.igniter.add(mk(new THREE.CylinderGeometry(0.018, 0.018, 0.7, 8), metal, { x: -0.35 }, [0, 0, HALF_PI]), mk(new THREE.SphereGeometry(0.035, 12, 12), this.ignMat));
      const additive = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
      this.coreMesh = mk(new THREE.SphereGeometry(0.3, 32, 32), additive(0xf59e0b, 0.35));
      this.haloMesh = mk(new THREE.SphereGeometry(0.42, 24, 24), additive(0xef4444, 0.2));
      this.benchRing = mk(new THREE.RingGeometry(0.33, 0.35, 48), new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }), {}, [HALF_PI, 0, 0]);
      const geo = new THREE.BufferGeometry(); this.posArr = new Float32Array(768); this.colArr = new Float32Array(768);
      geo.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3)); geo.setAttribute("color", new THREE.BufferAttribute(this.colArr, 3));
      this.gasPoints = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.11, map: this._spriteTexture(THREE), vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      S.add(this.igniter, this.coreMesh, this.haloMesh, this.benchRing, this.gasPoints);
    }
    async init(container) {
      this.container = container; if (container) container.innerHTML = "";
      try {
        const THREE = globalThis.THREE || await import("three");
        const { OrbitControls } = globalThis.OrbitControls ? { OrbitControls: globalThis.OrbitControls } : await import("three/addons/controls/OrbitControls.js");
        this.THREE = THREE; this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(46, this.w / this.h, 0.1, 100); this.camera.position.set(0, 0.8, 5.4);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        Object.assign(this.renderer.domElement.style, { width: "100%", height: "100%", display: "block" }); container.appendChild(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true;
        this._buildScene(THREE); this.bindResize(container); this.modeLabel = "3D Three.js (Tubo de Confinamiento)";
        const tick = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.rafId = requestAnimationFrame(tick); };
        this.rafId = requestAnimationFrame(tick);
      } catch (err) {
        this.fallback = true; this.modeLabel = "3D Fallback Canvas (corte del tubo)";
        if (container && typeof document !== "undefined") {
          this.fbCanvas = document.createElement("canvas"); Object.assign(this.fbCanvas.style, { width: "100%", height: "100%", display: "block" });
          container.appendChild(this.fbCanvas); this.fbCtx = this.fbCanvas.getContext("2d");
        }
        this.bindResize(container); if (this.onFallback) this.onFallback(err.message);
      }
      return this.modeLabel;
    }
    resize(w, h, dpr = 1) {
      super.resize(w, h, dpr);
      if (this.renderer && this.camera) { this.camera.aspect = this.w / Math.max(1, this.h); this.camera.updateProjectionMatrix(); this.renderer.setPixelRatio(Math.min(this.dpr, 2)); this.renderer.setSize(this.w, this.h, false); }
      if (this.fbCanvas) { this.fbCanvas.width = Math.max(1, Math.floor(this.w * this.dpr)); this.fbCanvas.height = Math.max(1, Math.floor(this.h * this.dpr)); }
    }
    resetCamera() { if (this.camera && this.controls) { this.camera.position.set(0, 0.8, 5.4); this.controls.target.set(0, 0, 0); this.controls.update(); } }
    updateState(s, particles) {
      if (s) this.lastMetrics = s; if (particles && particles.length >= 1024) this.lastParticles = particles;
      const m = this.lastMetrics; if (!m || this.fallback || !this.coreMesh) return;
      const kind = m.fuelKind || "pmma", fr = m.fuelRemaining ?? 1, fy = m.flameCenterY || 0, st = m.buoyancyStretch || 1, charK = 1 - fr;
      Object.entries(this.fuels).forEach(([k, f]) => { f.visible = k === kind; });
      let edgeX = 0.1, edgeY = 0;
      if (kind === "pmma") { const r = Math.max(0.2, fr); this.fuels.pmma.scale.set(r, 1, r); this.fuels.pmma.material.color.setRGB(0.88 - 0.77 * charK, 0.95 - 0.85 * charK, 0.99 - 0.9 * charK); edgeX = 0.22 * r; }
      else if (kind === "cotton") { this.charSheet.scale.y = Math.max(0.001, charK); this.charSheet.position.y = -0.45 + charK * 0.45; edgeX = 0.25; edgeY = -0.45; }
      else if (kind === "droplet") { const d = Math.max(0.15, fr); this.fuels.droplet.scale.set(d, d, d); edgeX = 0.2 * d; }
      this.igniter.position.set(-edgeX, edgeY, 0); this.ignMat.emissiveIntensity = Math.min(3, (m.igniterPowerW || 0) / 120);
      const sc = Math.max(0.6, Math.min(1.6, Number(m.sphereRadiusScale) || 0.7)), lift = ((st - 1) * 0.3 + Math.min(0.3, (m.airflowCms || 0) * 0.004)) * sc;
      [this.coreMesh, this.haloMesh].forEach((mesh, j) => {
        mesh.visible = Boolean(m.isIgnited) && this.filter[0]; mesh.scale.set(sc, sc * st, sc); mesh.position.set(0, fy + lift, 0);
        mesh.material.color.set(j ? "#ef4444" : m.flameColorHex || "#f59e0b");
      });
      this.haloMesh.material.opacity = Math.min(0.5, 0.12 + (m.radiationKwM2 || 0) / 2000);
      this.flameLight.intensity = m.isIgnited ? 1.5 + Math.min(2, (m.radiationKwM2 || 0) / 400) : 0; this.flameLight.position.set(0, fy + lift, 0);
      this.benchRing.position.y = fy; this.benchRing.rotation.z += 0.01;
      this.flowRings.forEach((r) => { r.material.opacity = Math.min(0.85, 0.08 + (m.airflowCms || 0) / 40); });
      if (!this.lastParticles) return;
      for (let i = 0; i < 256; i++) {
        const [sp, inten] = decode(this.lastParticles[i * 4 + 3]), on = sp < 5 && this.filter[sp];
        for (let a = 0; a < 3; a++) { this.posArr[i * 3 + a] = on ? this.lastParticles[i * 4 + a] : 999; this.colArr[i * 3 + a] = on ? SPECIES_RGB[sp][a] * Math.max(0.2, inten) : 0; }
      }
      this.gasPoints.geometry.attributes.position.needsUpdate = true; this.gasPoints.geometry.attributes.color.needsUpdate = true;
    }
    render(s, particles) {
      this.updateState(s, particles);
      if (this.fallback && this.fbCtx && this.lastMetrics) paintChamber2D(this.fbCtx, this.fbCanvas.width, this.fbCanvas.height, this.lastMetrics, this.lastParticles, this.filter, this.dpr);
    }
  }

  globalThis.NasaRenderers = { TUBE_R, TUBE_HALF, paintChamber2D, AbstractFlameRenderer, ThreeJSFlameRenderer };
})();
