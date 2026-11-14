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
      this.container.innerHTML = `<div class="${layoutMode === "compact" ? "metrics-col" : "metrics-row"}">
        <div><strong>Material:</strong> ${escapeXSS(d.material_name)}</div><div><strong>Riesgo:</strong> ${escapeXSS(d.calculated_risk_score)} / 100</div>
        <div><strong>Tasa Base:</strong> ${escapeXSS(d.predicted_burn_rate_mms)} mm/s</div><div><strong>Régimen:</strong> ${escapeXSS(d.outcome_prediction)}</div>
        <div><strong>3D Flame:</strong> ${escapeXSS(d.flame_color_hex)} (${escapeXSS(d.sphere_radius_scale)}x)</div><div><strong>Caché:</strong> ${d.cache_hit ? "LRU Hit" : "Fresh RAG"}</div></div>`;
    }
  }

  class ChemicalTelemetryCard extends AbstractUICard {
    renderCard(s, layoutMode) {
      const a = s.gasAlerts || {}, gases = [["CO2", s.co2_ppm, a.co2], ["HCN", s.hcn_ppm, a.hcn], ["HCl", s.hcl_ppm, a.hcl], ["NOx", s.nox_ppm, a.nox], ["SO2", s.so2_ppm, a.so2], ["HF", s.hf_ppm, a.hf]];
      const ignTxt = s.isIgnited ? "IGNITED" : s.igniterPowerW > 0 ? "PREHEAT" : "EXTINGUISHED";
      this.container.innerHTML = `<div class="${layoutMode === "compact" ? "chem-grid chem-compact" : "chem-grid"}">
        <div class="chem-card"><span class="lbl">Ignition State</span><strong>${escapeXSS(ignTxt)}</strong><small>${escapeXSS(s.ignEnergyJ)}/${escapeXSS(s.eCritJ)} J</small></div>
        <div class="chem-card"><span class="lbl">Propagation Speed</span><strong>${escapeXSS(s.propagationSpeedMms ?? s.burnRateMms)} mm/s</strong><small>CO2 damp ${escapeXSS(s.co2Damping)}</small></div>
        <div class="chem-card"><span class="lbl">Radiation / Tf</span><strong>${escapeXSS(s.radiationKwM2 ?? s.radiativeLossKw)} kW/m²</strong><small>${escapeXSS(s.tempK)} K</small></div>
        ${gases.map(([n, v, st]) => `<div class="chem-card badge-${escapeXSS(String(st || "SAFE").toLowerCase())}"><span class="lbl">${escapeXSS(n)}</span><strong>${escapeXSS(v)} ppm</strong><small>${escapeXSS(st || "SAFE")}</small></div>`).join("")}</div>`;
    }
  }

  class OffscreenSimulationController {
    constructor(cfg) {
      Object.assign(this, cfg);
      this.worker = null; this.transferred = false; this.viewMode = "3d";
      this.lastReport = null; this.lastTelemetry = null; this.drag = false; this._bindDrag();
    }
    _measureBox(box) {
      const r = box.getBoundingClientRect();
      return { width: Math.max(120, r.width || 320), height: Math.max(120, r.height || 240), dpr: window.devicePixelRatio || 1 };
    }
    _measureSizes() { return { s3d: this._measureBox(this.box3d), s2d: this._measureBox(this.box2d) }; }
    _bindDrag() {
      let lx = 0, ly = 0;
      this.canvas3d.addEventListener("pointerdown", (e) => { this.drag = true; lx = e.clientX; ly = e.clientY; });
      window.addEventListener("pointermove", (e) => {
        if (!this.drag || !this.worker) return;
        this.worker.postMessage({ type: "ORBIT_DELTA", dyaw: (e.clientX - lx) * 0.01, dpitch: (e.clientY - ly) * 0.01 });
        lx = e.clientX; ly = e.clientY;
      });
      window.addEventListener("pointerup", () => { this.drag = false; });
    }
    _watchResizes() {
      const ro = new ResizeObserver(() => { if (this.worker) this.worker.postMessage({ type: "RESIZE_CANVAS", ...this._measureSizes() }); });
      ro.observe(this.box3d); ro.observe(this.box2d);
    }
    _onWorkerMsg(m) {
      if (!m) return;
      if (m.type === "TELEMETRY_TICK" && m.metrics) { this.lastTelemetry = m.metrics; this.chemCard.update(m.metrics); }
      if (m.type === "RENDER_MODE") this.gpuStatus.textContent = `${m.gpuComputeActive ? "GPU Compute (@workgroup_size(256))" : "Worker Sim"} | ${m.mode3d}`;
    }
    setViewMode(mode, activeId) {
      this.viewMode = mode; this.vpGrid.classList.toggle("dual", mode === "dual");
      this.box3d.classList.toggle("hidden", mode === "2d"); this.box2d.classList.toggle("hidden", mode === "3d");
      ["btn3d", "btn2d", "btnDual"].forEach((id) => document.getElementById(id)?.classList.toggle("active", id === activeId));
      if (this.worker) {
        this.worker.postMessage({ type: "SET_VIEW_MODE", viewMode: mode });
        requestAnimationFrame(() => this.worker.postMessage({ type: "RESIZE_CANVAS", ...this._measureSizes() }));
      }
    }
    pushParamsIfActive(params) { if (this.worker) this.worker.postMessage({ type: "UPDATE_PARAMS", params }); }
    resetChamber() { if (this.worker) this.worker.postMessage({ type: "RESET_CHAMBER" }); }
    async runSimulation(params) {
      if (!this.worker) { this.worker = new Worker("physics_worker.js"); this.worker.onmessage = (e) => this._onWorkerMsg(e.data); }
      if (!this.transferred) {
        this.transferred = true;
        const off3d = this.canvas3d.transferControlToOffscreen(), off2d = this.canvas2d.transferControlToOffscreen();
        this.worker.postMessage({ type: "INIT_CANVAS", off3d, off2d, viewMode: this.viewMode, sizes: this._measureSizes() }, [off3d, off2d]);
        this._watchResizes();
      }
      this.worker.postMessage({ type: "START_SIMULATION", params, viewMode: this.viewMode, sizes: this._measureSizes() });
      this.llmBadge.className = "badge-pill badge-warning";
      this.llmBadge.textContent = `⏳ Generating with ${params.llmModel || "default"}...`;
      const t0 = performance.now();
      try {
        const data = await this.api.request("/simulate", {
          method: "POST",
          body: JSON.stringify({ material_id: params.materialId, custom_oxygen_pct: params.oxygenPct, custom_pressure_psi: params.pressurePsi, custom_airflow: params.airflowCms, query_context: params.queryContext || "", llm_model: params.llmModel || null }),
        });
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        this.lastReport = data; this.exportBtn.disabled = false;
        this.llmBadge.className = "badge-pill badge-safe"; this.llmBadge.textContent = `✅ Response Ready (${elapsed}s)`;
        const refs = `Benchmarks SQLite: [${(data.sqlite_pointer_ids || []).join(", ")}] | Citations Chroma: [${(data.chroma_pointer_ids || []).join(", ")}]`;
        this.llmOutput.textContent = `${data.ai_conclusion_text}\n\n---\nMaterial: ${data.material_name} | Risk: ${data.calculated_risk_score}/100 | Vf: ${data.predicted_burn_rate_mms} mm/s (${data.outcome_prediction})\n${refs}`;
        this.simCard.update(data); this.worker.postMessage({ type: "SYNC_BACKEND_TRUTH", data });
      } catch (err) {
        this.llmBadge.className = "badge-pill badge-critical"; this.llmBadge.textContent = "⚠️ Deterministic Fallback";
        this.llmOutput.textContent = `Error conectando con /api/simulate (${err.message}). El Web Worker continúa la simulación 0g determinista.`;
      }
    }
  }

  class NasaReportExporter extends AbstractPDFExporter {
    formatReportContent(r) {
      const t = r.telemetry || {};
      return [
        "NASA MICROGRAVITY FIRE RISK & GAS TELEMETRY REPORT",
        `Report ID: ${r.report_id ?? "N/A"} | Material: ${r.material_name} | Risk: ${r.calculated_risk_score}/100 | Vf: ${r.predicted_burn_rate_mms} mm/s (${r.outcome_prediction})`,
        `Igniter: ${t.igniterPowerW ?? "N/A"} W | Tf: ${t.tempK ?? "N/A"} K | Radiation: ${t.radiationKwM2 ?? "N/A"} kW/m2`,
        `Gases (ppm) [${t.overallGasStatus ?? "N/A"}]: CO2=${t.co2_ppm ?? 0}, HCN=${t.hcn_ppm ?? 0}, HCl=${t.hcl_ppm ?? 0}, NOx=${t.nox_ppm ?? 0}, SO2=${t.so2_ppm ?? 0}, HF=${t.hf_ppm ?? 0}`,
        `SQLite Pointers: ${(r.sqlite_pointer_ids || []).join(", ")} | Chroma Pointers: ${(r.chroma_pointer_ids || []).join(", ")}`,
        `Conclusion: ${r.ai_conclusion_text}`,
      ].join("\n");
    }
  }

  window.NasaCore = { escapeXSS, AbstractDataFetcher, AbstractUICard, AbstractPDFExporter, NasaApiFetcher, SimulationResultCard, ChemicalTelemetryCard, OffscreenSimulationController, NasaReportExporter };
})();
