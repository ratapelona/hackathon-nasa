(() => {
  "use strict";

  const escapeXSS = (val) =>
    String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  class AbstractDataFetcher {
    constructor(maxSlots = 16) {
      if (new.target === AbstractDataFetcher) throw new TypeError("AbstractDataFetcher no puede instanciarse directamente.");
      this.baseUrl = window.location.origin + "/api";
      this.maxSlots = Math.min(Math.max(Number(maxSlots) || 16, 1), 16);
      this.cache = new Map();
    }
    getCached(key) { if (!this.cache.has(key)) return null; const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v; }
    setCached(key, val) {
      if (this.cache.has(key)) this.cache.delete(key);
      this.cache.set(key, val);
      if (this.cache.size > this.maxSlots) this.cache.delete(this.cache.keys().next().value);
    }
    clearCache() { this.cache.clear(); }
    normalizeResponse(_payload) { throw new Error("El método abstracto normalizeResponse() debe implementarse."); }
    async request(path, options = {}) {
      const method = (options.method || "GET").toUpperCase(), cacheKey = `${method}:${path}`;
      if (method === "GET") { const hit = this.getCached(cacheKey); if (hit !== null) return hit; }
      const res = await fetch(`${this.baseUrl}${path}`, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
      if (!res.ok) throw new Error(`API ${res.status}: ${escapeXSS(await res.text())}`);
      const norm = this.normalizeResponse(await res.json());
      if (method === "GET") this.setCached(cacheKey, norm);
      return norm;
    }
  }

  class AbstractUICard {
    constructor(container) {
      if (new.target === AbstractUICard) throw new TypeError("AbstractUICard no puede instanciarse directamente.");
      this.container = container; this.lastData = null; this.layoutMode = "expanded";
      this.observer = new ResizeObserver((entries) => {
        for (const e of entries) {
          this.layoutMode = e.contentRect.width / Math.max(window.innerWidth, 1) < 0.45 ? "compact" : "expanded";
          this.container.dataset.layout = this.layoutMode;
          if (this.lastData !== null) this.renderCard(this.lastData, this.layoutMode);
        }
      });
      this.observer.observe(this.container);
    }
    update(data) { this.lastData = data; this.renderCard(data, this.layoutMode); }
    renderCard(_data, _layoutMode) { throw new Error("El método abstracto renderCard() debe implementarse."); }
  }

  class AbstractPDFExporter {
    constructor() { if (new.target === AbstractPDFExporter) throw new TypeError("AbstractPDFExporter no puede instanciarse directamente."); }
    formatReportContent(_reportData) { throw new Error("El método abstracto formatReportContent() debe implementarse."); }
    async saveDocument(reportData, filename = "nasa_fire_report.txt") {
      const blob = new Blob([this.formatReportContent(reportData)], { type: "text/plain;charset=utf-8" });
      if (typeof window.showSaveFilePicker === "function") {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "Reporte NASA", accept: { "text/plain": [".txt"] } }] });
          const w = await handle.createWritable(); await w.write(blob); await w.close(); return { method: "showSaveFilePicker" };
        } catch (err) { if (err && err.name === "AbortError") return { method: "cancelled" }; }
      }
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      return { method: "blobFallback" };
    }
  }

  class NasaApiFetcher extends AbstractDataFetcher { normalizeResponse(payload) { return payload; } }

  class SimulationResultCard extends AbstractUICard {
    renderCard(d, layoutMode) {
      const cell = (lbl, val) => `<div class="metric-cell"><span class="lbl">${lbl}</span><strong>${val}</strong></div>`;
      const hex = escapeXSS(d.flame_color_hex || "#f59e0b");
      this.container.innerHTML = `<div class="${layoutMode === "compact" ? "metrics-col" : "metrics-row"}">
        ${cell("Material", escapeXSS(d.material_name))}
        ${cell("Risk Score", `${escapeXSS(d.calculated_risk_score)} / 100`)}
        ${cell("Burn Rate Vf", `${escapeXSS(d.predicted_burn_rate_mms)} mm/s`)}
        ${cell("Regime", escapeXSS(d.outcome_prediction))}
        ${cell("3D Flame", `<span style="color:${hex}">●</span> ${hex} (${escapeXSS(d.sphere_radius_scale)}x)`)}
        ${cell("RAG Cache", d.cache_hit ? "LRU Hit" : "Fresh RAG")}</div>`;
    }
  }

  class ChemicalTelemetryCard extends AbstractUICard {
    renderCard(s, layoutMode) {
      const a = s.gasAlerts || {}, gases = [["CO2", s.co2_ppm, a.co2], ["HCN", s.hcn_ppm, a.hcn], ["HCl", s.hcl_ppm, a.hcl], ["NOx", s.nox_ppm, a.nox], ["SO2", s.so2_ppm, a.so2], ["HF", s.hf_ppm, a.hf]];
      const ignTxt = s.isIgnited ? "IGNITED" : s.igniterPowerW > 0 ? "PREHEAT" : "EXTINGUISHED";
      const ignCls = s.isIgnited ? "badge-critical" : s.igniterPowerW > 0 ? "badge-warning" : "badge-safe";
      this.container.innerHTML = `<div class="${layoutMode === "compact" ? "chem-grid chem-compact" : "chem-grid"}">
        <div class="chem-card ${ignCls}"><span class="lbl">Ignition State</span><strong>${escapeXSS(ignTxt)}</strong><small>${escapeXSS(s.ignEnergyJ)} / ${escapeXSS(s.eCritJ)} J</small></div>
        <div class="chem-card"><span class="lbl">Propagation Vf</span><strong>${escapeXSS(s.propagationSpeedMms ?? s.burnRateMms)} mm/s</strong><small>CO2 damp ${escapeXSS(s.co2Damping)}</small></div>
        <div class="chem-card"><span class="lbl">Radiation / Tf</span><strong>${escapeXSS(s.radiationKwM2 ?? s.radiativeLossKw)} kW/m²</strong><small>${escapeXSS(s.tempK)} K</small></div>
        ${gases.map(([n, v, st]) => `<div class="chem-card badge-${escapeXSS(String(st || "SAFE").toLowerCase())}"><span class="lbl">${escapeXSS(n)}</span><strong>${escapeXSS(v)} ppm</strong><small>${escapeXSS(st || "SAFE")}</small></div>`).join("")}</div>`;
    }
  }

  const ENV_PRESETS = {
    iss_0g: { o2: 21.0, psi: 14.7, flow: 10.0, gLevel: 0.0, gJitter: 0 }, saffire_exploration: { o2: 34.0, psi: 8.2, flow: 15.0, gLevel: 0.0, gJitter: 0 },
    drop_tower: { o2: 21.0, psi: 14.7, flow: 5.0, gLevel: 1e-5, gJitter: 0 }, parabolic_flight: { o2: 21.0, psi: 14.7, flow: 10.0, gLevel: 0.01, gJitter: 1 },
    troposphere: { o2: 21.0, psi: 14.7, flow: 25.0, gLevel: 1.0, gJitter: 0 }, stratosphere: { o2: 21.0, psi: 0.8, flow: 15.0, gLevel: 0.99, gJitter: 0 },
    mesosphere: { o2: 21.0, psi: 0.1, flow: 5.0, gLevel: 0.97, gJitter: 0 }, thermosphere: { o2: 0.0, psi: 0.1, flow: 0.0, gLevel: 0.0, gJitter: 0 },
    mars_038g: { o2: 0.13, psi: 0.09, flow: 12.0, gLevel: 0.38, gJitter: 0 },
  };

  class OffscreenSimulationController {
    constructor(cfg) {
      Object.assign(this, cfg);
      this.worker = null; this.r3d = null; this.r3dReady = null; this.transferred = false; this.viewMode = "3d";
      this.lastReport = null; this.lastTelemetry = null; this.lastEnvPreset = null; this.filter = [true, true, true, true, true];
    }
    _measureBox(box) { const r = box ? box.getBoundingClientRect() : { width: 320, height: 240 }; return { width: Math.max(120, r.width || 320), height: Math.max(120, r.height || 240), dpr: window.devicePixelRatio || 1 }; }
    _watchResizes() { if (typeof ResizeObserver === "function" && this.box2d) new ResizeObserver(() => { if (this.worker) this.worker.postMessage({ type: "RESIZE_CANVAS", s2d: this._measureBox(this.box2d) }); }).observe(this.box2d); }
    _onWorkerMsg(m) {
      if (!m) return;
      if (m.type === "TELEMETRY_TICK" && m.metrics) {
        const s = m.metrics; this.lastTelemetry = s; this.chemCard.update(s); if (this.r3d) this.r3d.render(s, m.particles);
        const risk = s.isIgnited ? Math.min(100, Math.round(25 + s.propagationSpeedMms * 9 + Math.max(0, s.oxygenPct - 21) * 0.7 + s.igniterPowerW * 0.04)) : 0;
        const reg = !s.isIgnited ? (s.igniterPowerW > 0 ? "PREHEATING" : "EXTINGUISHED") : s.oxygenPct >= 50 || s.propagationSpeedMms >= 6 ? "ACCELERATED_PLASMA" : "STEADY_PROPAGATION";
        this.simCard.update({ material_name: s.materialName, calculated_risk_score: risk, predicted_burn_rate_mms: s.propagationSpeedMms, outcome_prediction: reg, flame_color_hex: s.flameColorHex, sphere_radius_scale: s.sphereRadiusScale, cache_hit: Boolean(this.lastReport?.cache_hit) });
      }
      if (m.type === "RENDER_MODE") this.gpuStatus.textContent = `${m.gpuComputeActive ? "GPU Compute (@workgroup_size(256))" : "Worker CPU Fallback"} | ${this.r3d ? this.r3d.modeLabel : "3D Three.js"} | ${m.mode2d}`;
    }
    toggleSpecies(sp) {
      if (sp === "all") { const allOn = !this.filter.every(Boolean); this.filter = [allOn, allOn, allOn, allOn, allOn]; } else { const idx = Number(sp); if (idx >= 0 && idx < 5) this.filter[idx] = !this.filter[idx]; }
      if (typeof document.querySelectorAll === "function") document.querySelectorAll("#speciesFilterBar [data-sp]").forEach((el) => { const s = el.dataset.sp; el.classList.toggle("active", s === "all" ? this.filter.every(Boolean) : Boolean(this.filter[Number(s)])); });
      if (this.r3d) { this.r3d.setFilter(this.filter); if (this.lastTelemetry) this.r3d.render(this.lastTelemetry); }
      if (this.worker) this.worker.postMessage({ type: "SET_SPECIES_FILTER", filter: this.filter });
    }
    setViewMode(mode, activeId) {
      this.viewMode = mode; this.vpGrid.classList.toggle("dual", mode === "dual");
      this.viewport3d.classList.toggle("hidden", mode === "2d"); this.box2d.classList.toggle("hidden", mode === "3d");
      ["btn3d", "btn2d", "btnDual"].forEach((id) => document.getElementById(id)?.classList.toggle("active", id === activeId));
      if (this.worker) {
        this.worker.postMessage({ type: "SET_VIEW_MODE", viewMode: mode });
        const sendSize = () => this.worker.postMessage({ type: "RESIZE_CANVAS", s2d: this._measureBox(this.box2d) });
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(sendSize); else sendSize();
      }
    }
    async ensure3D(envPreset, zoom = false) {
      if (!this.r3d && window.NasaRenderers?.ThreeJSFlameRenderer) {
        if (!this.r3dReady) { const r = new window.NasaRenderers.ThreeJSFlameRenderer(); r.setFilter(this.filter); if (envPreset) r.setEnvironment(envPreset, false); this.r3dReady = r.init(this.viewport3d).then(() => { this.r3d = r; if (this.lastTelemetry) r.render(this.lastTelemetry); this.gpuStatus.textContent = `${r.modeLabel} | Standby`; return r; }); }
        await this.r3dReady;
      }
      if (this.r3d && envPreset) { const chg = envPreset !== this.lastEnvPreset; this.lastEnvPreset = envPreset; this.r3d.setEnvironment(envPreset, zoom || chg); }
      return this.r3d;
    }
    pushParamsIfActive(params) {
      if (params.envPreset) this.ensure3D(params.envPreset, Boolean(params.envChanged));
      if (this.worker) this.worker.postMessage({ type: "UPDATE_PARAMS", params, live: true }); else if (params.liveFire) this.runSimulation({ ...params, useLlm: false });
    }
    toggleMacroView() { return this.r3d ? this.r3d.toggleMacroView() : false; }
    resetChamber() { if (this.worker) this.worker.postMessage({ type: "RESET_CHAMBER" }); if (this.r3d) this.r3d.resetCamera(); }
    setModelSleepState(armed = false) {
      this.llmBadge.className = "badge-pill"; this.llmBadge.textContent = armed ? "Standby" : "💤 zzz";
      if (!armed) this.llmOutput.textContent = "Modelo LLM en reposo (zzz). La simulación física 3D/2D corre localmente sin enviar datos al modelo.";
    }
    async sendSimulationToModel(params) {
      this.llmBadge.className = "badge-pill badge-warning"; this.llmBadge.textContent = "⏳ Running Model..."; const t0 = performance.now();
      try {
        const data = await this.api.request("/simulate", { method: "POST", body: JSON.stringify({ material_id: params.materialId, custom_oxygen_pct: params.oxygenPct, custom_pressure_psi: params.pressurePsi, custom_airflow: params.airflowCms, query_context: params.queryContext || "", llm_model: params.llmModel || null }) });
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2), refs = `Benchmarks SQLite: [${(data.sqlite_pointer_ids || []).join(", ")}] | Citations Chroma: [${(data.chroma_pointer_ids || []).join(", ")}]`;
        this.lastReport = data; this.exportBtn.disabled = false; this.llmBadge.className = "badge-pill badge-safe"; this.llmBadge.textContent = `✅ Ready (${elapsed}s)`;
        this.llmOutput.textContent = `${data.ai_conclusion_text}\n\n---\nMaterial: ${data.material_name} | Risk: ${data.calculated_risk_score}/100 | Vf: ${data.predicted_burn_rate_mms} mm/s (${data.outcome_prediction})\n${refs}`;
        this.simCard.update(data); if (this.worker) this.worker.postMessage({ type: "SYNC_BACKEND_TRUTH", data });
      } catch (err) {
        this.llmBadge.className = "badge-pill badge-critical"; this.llmBadge.textContent = "⚠️ Deterministic Fallback";
        this.llmOutput.textContent = `Error conectando con /api/simulate (${err.message}). El Web Worker continúa la simulación 0g determinista.`;
      }
    }
    async runSimulation(params) {
      if (!this.worker) { this.worker = new Worker("physics_worker.js"); this.worker.onmessage = (e) => this._onWorkerMsg(e.data); }
      const sizes = { s2d: this._measureBox(this.box2d) }, msg = { type: "START_SIMULATION", params, viewMode: this.viewMode, filter: this.filter, sizes };
      if (!this.transferred) { this.transferred = true; const off2d = this.canvas2d.transferControlToOffscreen(); this.worker.postMessage({ ...msg, canvas2d: off2d }, [off2d]); this._watchResizes(); } else { this.worker.postMessage(msg); }
      await this.ensure3D(params.envPreset, true); if (this.r3d) this.gpuStatus.textContent = `${this.r3d.modeLabel} | Worker & GPU Compute`;
      if (params.useLlm === false) { this.setModelSleepState(false); return; } else { await this.sendSimulationToModel(params); }
    }
  }
  class NasaReportExporter extends AbstractPDFExporter {
    formatReportContent(r) {
      const t = r.telemetry || {};
      return ["NASA MICROGRAVITY FIRE RISK & GAS TELEMETRY REPORT", `Report ID: ${r.report_id ?? "N/A"} | Material: ${r.material_name} | Risk: ${r.calculated_risk_score}/100 | Vf: ${r.predicted_burn_rate_mms} mm/s (${r.outcome_prediction})`, `Igniter: ${t.igniterPowerW ?? "N/A"} W | Tf: ${t.tempK ?? "N/A"} K | Radiation: ${t.radiationKwM2 ?? "N/A"} kW/m2`, `Gases (ppm) [${t.overallGasStatus ?? "N/A"}]: CO2=${t.co2_ppm ?? 0}, HCN=${t.hcn_ppm ?? 0}, HCl=${t.hcl_ppm ?? 0}, NOx=${t.nox_ppm ?? 0}, SO2=${t.so2_ppm ?? 0}, HF=${t.hf_ppm ?? 0}`, `SQLite Pointers: ${(r.sqlite_pointer_ids || []).join(", ")} | Chroma Pointers: ${(r.chroma_pointer_ids || []).join(", ")}`, `Conclusion: ${r.ai_conclusion_text}`].join("\n");
    }
  }

  window.NasaCore = { escapeXSS, ENV_PRESETS, AbstractDataFetcher, AbstractUICard, AbstractPDFExporter, NasaApiFetcher, SimulationResultCard, ChemicalTelemetryCard, OffscreenSimulationController, NasaReportExporter };
})();
