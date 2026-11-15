(() => {
  "use strict";
  const TUBE_R = 1.0, TUBE_HALF = 1.8;
  const SPECIES_RGB = [[1.0, 0.62, 0.2], [0.22, 0.74, 0.97], [0.98, 0.57, 0.24], [0.96, 0.25, 0.37], [0.65, 0.95, 0.8]];
  const SPECIES_CSS = SPECIES_RGB.map((c) => c.map((v) => Math.round(v * 255)).join(","));
  const decode = (w) => { const s = Math.floor(w); return [s, w - s]; };

  const GLSL_NOISE = `float h3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
  float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z);}`;
  const FIRE_VS = `uniform float uTime; uniform float uGLevel; varying vec3 vNormalW; varying vec3 vViewDir; varying vec3 vLocal;
  ${GLSL_NOISE}
  void main(){ vec3 p=position; float w=n3(p*3.1-vec3(0.0,uTime*(1.4+uGLevel*2.0),0.0))*0.22+n3(p*6.2+uTime*1.8)*0.1; p+=normal*(w-0.12); if(uGLevel>0.05)p.y*=1.0+min(0.9,uGLevel*0.7)*smoothstep(-0.3,0.4,p.y); vLocal=p; vec4 wp=modelMatrix*vec4(p,1.0); vNormalW=normalize(mat3(modelMatrix)*normal); vViewDir=normalize(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`;
  const FIRE_FS = `uniform float uTime; uniform float uTemp; uniform float uGLevel; uniform vec3 uBaseCol; varying vec3 vNormalW; varying vec3 vViewDir; varying vec3 vLocal;
  ${GLSL_NOISE}
  float fbm(vec3 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*n3(p);p=p*2.05+vec3(0.3);a*=0.5;}return v;}
  void main(){ float fres=clamp(abs(dot(normalize(vNormalW),normalize(vViewDir))),0.0,1.0), edge=pow(fres,2.5), turb=fbm(vLocal*3.2-vec3(0.0,uTime*(1.2+uGLevel*2.2),0.0)), heat=clamp(edge*(0.65+0.8*turb)*uTemp,0.0,1.5); vec3 col=mix(vec3(0.18,0.55,1.0),mix(uBaseCol,vec3(1.0,0.45,0.08),0.6),smoothstep(0.08,0.45,heat)); col=mix(col,vec3(1.45,1.3,0.98),smoothstep(0.55,1.15,heat)); float alpha=clamp(edge*(0.45+0.65*turb)*smoothstep(0.02,0.22,heat),0.0,0.95); gl_FragColor=vec4(col*alpha*1.35,alpha); }`;
  const VolumetricFireShader = { vertexShader: FIRE_VS, fragmentShader: FIRE_FS };

  function paintChamber2D(c, cw, ch, s, buf, filter, dpr = 1) {
    const cx = cw * 0.5, cy = ch * 0.42, k = Math.min((ch * 0.33) / TUBE_HALF, (cw * 0.42) / TUBE_R), rem = s.fuelRemaining ?? 1;
    const tx = cx - TUBE_R * k, ty = cy - TUBE_HALF * k, tw = 2 * TUBE_R * k, th = 2 * TUBE_HALF * k, fy = cy - (s.flameCenterY || 0) * k;
    c.clearRect(0, 0, cw, ch); c.fillStyle = "rgba(4,6,11,0.42)"; c.fillRect(0, 0, cw, ch);
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
    for (let i = 0; buf && i < 256; i++) {
      const [sp, inten] = decode(buf[i * 4 + 3]); if (sp > 4 || !filter[sp]) continue;
      c.fillStyle = `rgba(${SPECIES_CSS[sp]},${(0.25 + 0.75 * inten).toFixed(2)})`; c.fillRect(cx + buf[i * 4] * k - dpr, cy - buf[i * 4 + 1] * k - dpr, 2 * dpr, 2 * dpr);
    }
    c.restore(); c.strokeStyle = "rgba(40,139,255,0.65)"; c.lineWidth = Math.max(1.5, dpr * 2); c.strokeRect(tx, ty, tw, th);
    c.fillStyle = "#eaeaeb"; c.font = `${(0.62 * dpr).toFixed(2)}rem "DM Mono", monospace`;
    c.fillText(`Vf=${s.propagationSpeedMms} mm/s | Ign=${s.igniterPowerW} W (${s.isIgnited ? "ON" : "PRE"}) | g=${s.gEff ?? 0}`, cw * 0.03, ch * 0.055);
    [["CO2", s.co2_ppm, 20000], ["HCN", s.hcn_ppm, 5], ["HCl", s.hcl_ppm, 10], ["NOx", s.nox_ppm, 15], ["SO2", s.so2_ppm, 5], ["HF", s.hf_ppm, 3]].forEach(([lbl, val, max], i) => {
      const bx = cw * (0.04 + i * 0.155), bw = cw * 0.13, by = ch * 0.9, pct = Math.min(1, (val || 0) / max);
      c.fillStyle = "#17171b"; c.fillRect(bx, by, bw, ch * 0.045); c.fillStyle = pct > 0.7 ? "#f64137" : pct > 0.3 ? "#ea6f24" : "#288bff";
      c.fillRect(bx, by, bw * pct, ch * 0.045); c.fillStyle = "#d1d1d1"; c.fillText(`${lbl}:${Number(val || 0).toFixed(1)}`, bx, by - ch * 0.02);
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
    constructor(onFallback) { super(); this.onFallback = onFallback; this.fallback = false; this.modeLabel = "Inicializando Three.js..."; this.rafId = null; this.fbCanvas = null; this.fbCtx = null; this.t0 = performance.now(); }
    _tex(THREE, mode) {
      const cv = document.createElement("canvas"); cv.width = 64; cv.height = 64; const g = cv.getContext("2d");
      if (mode === "smoke") {
        for (const [ox, oy, r] of [[32, 32, 28], [24, 28, 18], [40, 36, 17], [30, 40, 16]]) {
          const gr = g.createRadialGradient(ox, oy, 1, ox, oy, r); gr.addColorStop(0, "rgba(255,255,255,0.42)"); gr.addColorStop(0.55, "rgba(255,255,255,0.14)"); gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr; g.beginPath(); g.arc(ox, oy, r, 0, Math.PI * 2); g.fill();
        }
        return new THREE.CanvasTexture(cv);
      }
      g.fillStyle = "#808080"; g.fillRect(0, 0, 64, 64); g.fillStyle = mode === "weave" ? "#d4d4d4" : "#3a3a3a";
      for (let i = 0; i < 64; i += mode === "weave" ? 4 : 6) { g.fillRect(i, 0, 2, 64); if (mode === "weave") g.fillRect(0, i, 64, 2); else g.fillRect((i * 7) % 60, (i * 11) % 60, 5, 5); }
      const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 10); return tex;
    }
    _buildScene(THREE) {
      const S = this.scene, HALF_PI = Math.PI / 2, mk = (geo, mat, pos = {}, rot = null) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.position, pos); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m; };
      S.add(new THREE.AmbientLight(0x94a3b8, 0.25)); this.flameLight = new THREE.PointLight(0xff9238, 0, 7.5, 1.5); S.add(this.flameLight);
      const quartz = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.10, roughness: 0.0, metalness: 0.05, clearcoat: 1.0, clearcoatRoughness: 0.0, depthWrite: false, side: THREE.DoubleSide });
      const steel = new THREE.MeshStandardMaterial({ color: 0x2a2f35, metalness: 0.9, roughness: 0.25 });
      this.tube = mk(new THREE.CylinderGeometry(TUBE_R, TUBE_R, TUBE_HALF * 2, 48, 1, true), quartz); this.tube.renderOrder = 10;
      const caps = [-TUBE_HALF - 0.06, TUBE_HALF + 0.06].map((y) => mk(new THREE.CylinderGeometry(TUBE_R * 1.08, TUBE_R * 1.08, 0.12, 48), steel, { y }));
      const rods = [0.785, 2.356, 3.927, 5.498].map((a) => mk(new THREE.CylinderGeometry(0.022, 0.022, TUBE_HALF * 2 + 0.12, 12), steel, { x: Math.cos(a) * TUBE_R * 1.05, z: Math.sin(a) * TUBE_R * 1.05 }));
      S.add(this.tube, ...caps, ...rods);
      this.pmmaMat = new THREE.MeshPhysicalMaterial({ color: 0xe8f4fc, transmission: 0.85, ior: 1.49, roughness: 0.08, bumpMap: this._tex(THREE, "char"), bumpScale: 0.0, thickness: 0.3, transparent: true });
      this.cottonMat = new THREE.MeshStandardMaterial({ color: 0xf5f0dc, bumpMap: this._tex(THREE, "weave"), bumpScale: 0.04, roughness: 0.88, emissive: 0xff4500, emissiveIntensity: 0, side: THREE.DoubleSide });
      this.fuels = { pmma: mk(new THREE.CylinderGeometry(0.22, 0.22, 0.55, 24), this.pmmaMat), cotton: new THREE.Group(), gas: new THREE.Group(), droplet: new THREE.Group() };
      this.charSheet = mk(new THREE.PlaneGeometry(0.5, 0.9), new THREE.MeshStandardMaterial({ color: 0x161412, roughness: 0.95, side: THREE.DoubleSide }), { z: 0.003 });
      this.fuels.cotton.add(mk(new THREE.PlaneGeometry(0.5, 0.9, 12, 18), this.cottonMat), this.charSheet);
      this.fuels.gas.add(mk(new THREE.CylinderGeometry(0.06, 0.08, TUBE_HALF - 0.05, 20), steel, { y: -(TUBE_HALF + 0.05) / 2 }), mk(new THREE.CylinderGeometry(0.085, 0.065, 0.08, 20), steel));
      const fiberMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.3, metalness: 0.4 });
      this.dropMesh = mk(new THREE.SphereGeometry(0.2, 32, 32), new THREE.MeshPhysicalMaterial({ color: 0xfffbeb, transmission: 0.95, ior: 1.39, thickness: 0.35, roughness: 0.03, transparent: true }));
      this.fuels.droplet.add(this.dropMesh, mk(new THREE.CylinderGeometry(0.005, 0.005, 1.1, 6), fiberMat, {}, [0, 0, 0.55]), mk(new THREE.CylinderGeometry(0.005, 0.005, 1.1, 6), fiberMat, {}, [0, 0, -0.55]));
      Object.values(this.fuels).forEach((f) => S.add(f));
      this.ignMat = new THREE.MeshStandardMaterial({ color: 0x57534e, emissive: 0xff5a1f, emissiveIntensity: 0 });
      this.igniter = new THREE.Group(); this.igniter.add(mk(new THREE.CylinderGeometry(0.016, 0.016, 0.72, 8), steel, { x: -0.36 }, [0, 0, HALF_PI]), mk(new THREE.SphereGeometry(0.032, 12, 12), this.ignMat));
      this.fireUniforms = { uTime: { value: 0 }, uTemp: { value: 1.0 }, uGLevel: { value: 0.0 }, uBaseCol: { value: new THREE.Color(0xf59e0b) } };
      this.fireMat = new THREE.ShaderMaterial({ ...VolumetricFireShader, uniforms: this.fireUniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      this.coreMesh = mk(new THREE.SphereGeometry(0.42, 48, 48), this.fireMat); this.coreMesh.renderOrder = 5;
      const geo = new THREE.BufferGeometry(); this.posArr = new Float32Array(768); this.colArr = new Float32Array(768);
      geo.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3)); geo.setAttribute("color", new THREE.BufferAttribute(this.colArr, 3));
      this.gasPoints = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.24, map: this._tex(THREE, "smoke"), vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false })); this.gasPoints.renderOrder = 5;
      S.add(this.igniter, this.coreMesh, this.gasPoints);
      if (globalThis.NasaEnvScenes) { this.envSys = globalThis.NasaEnvScenes.buildEnvScenes(THREE); if (this.pendingEnv) this.envSys.envId = this.pendingEnv; S.add(this.envSys.root); }
    }
    async init(container) {
      this.container = container; if (container) container.innerHTML = "";
      try {
        const THREE = globalThis.THREE || await import("three");
        const [{ OrbitControls }, { RoomEnvironment }, { EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
          import("three/addons/controls/OrbitControls.js"), import("three/addons/environments/RoomEnvironment.js"),
          import("three/addons/postprocessing/EffectComposer.js"), import("three/addons/postprocessing/RenderPass.js"), import("three/addons/postprocessing/UnrealBloomPass.js"),
        ]);
        this.THREE = THREE; this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, this.w / this.h, 0.1, 100); this.camera.position.set(0, 0.75, 5.4);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); this.renderer.setClearColor(0x000000, 0); this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
        Object.assign(this.renderer.domElement.style, { width: "100%", height: "100%", display: "block" }); container.appendChild(this.renderer.domElement);
        const pmrem = new THREE.PMREMGenerator(this.renderer); this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
        this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this._buildScene(THREE);
        this.composer = new EffectComposer(this.renderer); this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this.w, this.h), 0.48, 0.35, 0.55); this.composer.addPass(this.bloomPass);
        this.bindResize(container); this.modeLabel = "3D PBR + Volumetric GLSL + Bloom";
        let prevT = 0;
        const tick = () => {
          const t = (performance.now() - this.t0) * 0.001, dt = Math.min(0.05, Math.max(0.001, t - prevT)); prevT = t; this.fireUniforms.uTime.value = t;
          if (this.envSys && globalThis.NasaEnvScenes) globalThis.NasaEnvScenes.updateEnvScenes(this.envSys, t, dt, this.camera, this.controls);
          if (this.lastMetrics?.isIgnited) { this.flameLight.intensity = (2.2 + Math.min(3.5, (this.lastMetrics.radiationKwM2 || 0) / 300)) * (0.9 + 0.12 * Math.sin(t * 11.0)); this.flameLight.color.setHSL(0.07 + 0.015 * Math.sin(t * 7.3), 0.95, 0.55 + 0.05 * Math.sin(t * 13.1)); }
          this.controls.update(); this.composer.render(); this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
      } catch (err) {
        this.fallback = true; this.modeLabel = "3D Fallback Canvas (corte del tubo)";
        if (container && typeof document !== "undefined") { this.fbCanvas = document.createElement("canvas"); Object.assign(this.fbCanvas.style, { width: "100%", height: "100%", display: "block" }); container.appendChild(this.fbCanvas); this.fbCtx = this.fbCanvas.getContext("2d"); }
        this.bindResize(container); if (this.onFallback) this.onFallback(err.message);
      }
      return this.modeLabel;
    }
    resize(w, h, dpr = 1) { super.resize(w, h, dpr); if (this.renderer && this.camera) { this.camera.aspect = this.w / Math.max(1, this.h); this.camera.updateProjectionMatrix(); this.renderer.setPixelRatio(Math.min(this.dpr, 2)); this.renderer.setSize(this.w, this.h, false); this.composer?.setSize(this.w, this.h); this.bloomPass?.setSize(this.w, this.h); } if (this.fbCanvas) { this.fbCanvas.width = Math.max(1, Math.floor(this.w * this.dpr)); this.fbCanvas.height = Math.max(1, Math.floor(this.h * this.dpr)); } }
    resetCamera() { if (this.camera && this.controls) { this.camera.position.set(0, 0.75, 5.4); this.controls.target.set(0, 0, 0); this.controls.update(); } }
    setEnvironment(envId, zoom = false) { this.pendingEnv = envId; if (!this.envSys) return; this.envSys.envId = envId; if (zoom) { this.envSys.macroMode = false; this.envSys.zoomT = 0; this.envSys.zoomTarget = 1; } }
    toggleMacroView() { if (!this.envSys) return false; this.envSys.macroMode = !this.envSys.macroMode; return this.envSys.macroMode; }
    updateState(s, particles) {
      if (s) this.lastMetrics = s; if (particles && particles.length >= 1024) this.lastParticles = particles;
      const m = this.lastMetrics; if (!m || this.fallback || !this.coreMesh) return;
      const kind = m.fuelKind || "pmma", fr = m.fuelRemaining ?? 1, fy = m.flameCenterY || 0, st = m.buoyancyStretch || 1, charK = 1 - fr;
      Object.entries(this.fuels).forEach(([k, f]) => { f.visible = k === kind; });
      let edgeX = 0.1, edgeY = 0;
      if (kind === "pmma") { const r = Math.max(0.2, fr); this.fuels.pmma.scale.set(r, 1, r); this.pmmaMat.roughness = 0.08 + 0.78 * charK; this.pmmaMat.bumpScale = 0.035 * charK; this.pmmaMat.transmission = 0.85 * Math.max(0.05, fr); this.pmmaMat.color.setRGB(0.91 - 0.78 * charK, 0.96 - 0.84 * charK, 0.99 - 0.88 * charK); edgeX = 0.22 * r; }
      else if (kind === "cotton") { this.charSheet.scale.y = Math.max(0.001, charK); this.charSheet.position.y = -0.45 + charK * 0.45; this.cottonMat.emissiveIntensity = m.isIgnited ? 0.65 : 0; edgeX = 0.25; edgeY = -0.45; }
      else if (kind === "droplet") { const d = Math.max(0.15, fr); this.dropMesh.scale.set(d, d, d); edgeX = 0.2 * d; }
      this.igniter.position.set(-edgeX, edgeY, 0); this.ignMat.emissiveIntensity = Math.min(4.0, (m.igniterPowerW || 0) / 90);
      const sc = Math.max(0.6, Math.min(1.6, Number(m.sphereRadiusScale) || 0.7)), lift = ((st - 1) * 0.28 + Math.min(0.25, (m.airflowCms || 0) * 0.004)) * sc;
      this.coreMesh.visible = Boolean(m.isIgnited) && this.filter[0]; this.coreMesh.scale.set(sc, sc * st, sc); this.coreMesh.position.set(0, fy + lift, 0);
      this.fireUniforms.uGLevel.value = m.gEff || 0; this.fireUniforms.uTemp.value = Math.max(0.5, Math.min(1.5, ((m.tempK || 300) - 295) / 1400));
      this.fireUniforms.uBaseCol.value.set(m.flameColorHex || "#f59e0b"); this.flameLight.position.set(0, fy + lift, 0); if (!m.isIgnited) this.flameLight.intensity = 0;
      if (!this.lastParticles) return;
      for (let i = 0; i < 256; i++) {
        const [sp, inten] = decode(this.lastParticles[i * 4 + 3]), on = sp < 5 && this.filter[sp];
        for (let a = 0; a < 3; a++) { this.posArr[i * 3 + a] = on ? this.lastParticles[i * 4 + a] : 999; this.colArr[i * 3 + a] = on ? SPECIES_RGB[sp][a] * Math.max(0.2, inten) : 0; }
      }
      this.gasPoints.geometry.attributes.position.needsUpdate = true; this.gasPoints.geometry.attributes.color.needsUpdate = true;
    }
    render(s, particles) { this.updateState(s, particles); if (this.fallback && this.fbCtx && this.lastMetrics) paintChamber2D(this.fbCtx, this.fbCanvas.width, this.fbCanvas.height, this.lastMetrics, this.lastParticles, this.filter, this.dpr); }
  }

  globalThis.NasaRenderers = { TUBE_R, TUBE_HALF, VolumetricFireShader, paintChamber2D, AbstractFlameRenderer, ThreeJSFlameRenderer };
})();
