from functools import lru_cache
import os
from pathlib import Path
import threading
from typing import Any
import chromadb
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.combustion_equations import SyntheticMicrogravityEquations
from backend.ingesto_chroma import DEFAULT_COLLECTION, push_sqlite_to_chroma
from backend.llm_providers import OllamaLLMProvider, OllamaLocalTagsHandler, build_wakeup_chain
from backend.obtencion import run_sqlite_ingestion
from backend.rag_data_services import NasaFireRepository, RecentPointerCache, augment
from backend.rag_quality_and_maintenance import EmbeddingIndexManager, RAGQualityController
from backend.schemas_and_base import AbstractRAGEngine, MaterialDTO, ReindexRequestDTO, SimulationRequestDTO, SimulationResponseDTO, WakeUpRequestDTO, resolve_project_path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=32)
def get_frontend_dir() -> Path: return resolve_project_path("frontend")


@lru_cache(maxsize=32)
def get_chroma_dir() -> Path: return resolve_project_path("chroma_data")


class HybridFireRAGEngine(AbstractRAGEngine):
    """Motor RAG híbrido: caché LRU thread-safe + SQLite + ChromaDB + física 0g + Ollama."""

    def __init__(self) -> None:
        self.repo = NasaFireRepository()
        self.cache = RecentPointerCache(max_slots=32)
        self.chroma_client = chromadb.PersistentClient(path=str(get_chroma_dir()))
        self.physics = SyntheticMicrogravityEquations()
        self.quality = RAGQualityController()
        self.index_mgr = EmbeddingIndexManager()
        self.llm = OllamaLLMProvider()
        self._state_lock = threading.RLock()

    def _active_index(self) -> tuple[str, str]:
        active = self.index_mgr.get_active_index()
        return (str(active.get("version_tag") or "v1"), str(active.get("collection_name") or DEFAULT_COLLECTION)) if active else ("v1", DEFAULT_COLLECTION)

    @staticmethod
    def _format_chroma_rows(ids: list[Any], metas: list[Any], dists: list[Any], docs: list[Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for idx, cid in enumerate(ids):
            meta = metas[idx] if idx < len(metas) and metas[idx] else {}
            dist = float(dists[idx]) if idx < len(dists) and dists[idx] is not None else 0.25
            item: dict[str, Any] = {"id": str(cid), "semantic_score": round(1.0 / (1.0 + max(0.0, dist)), 4), "material": str(meta.get("material", "")), "source": str(meta.get("source", "")), "text": docs[idx] if idx < len(docs) else ""}
            if "oxygen_pct" in meta:
                item["oxygen_pct"] = float(meta["oxygen_pct"])
            if "pressure_psi" in meta:
                item["pressure_psi"] = float(meta["pressure_psi"])
            out.append(item)
        return out

    def _run_filtered_query(self, collection: Any, query_text: str, where_filter: dict[str, Any], limit: int) -> list[dict[str, Any]]:
        avail = len((collection.get(where=where_filter, include=[])).get("ids") or [])
        if avail == 0 or limit <= 0:
            return []
        res = collection.query(query_texts=[query_text], n_results=min(limit, avail), where=where_filter)
        return self._format_chroma_rows((res.get("ids") or [[]])[0], (res.get("metadatas") or [[]])[0], (res.get("distances") or [[]])[0], (res.get("documents") or [[]])[0])

    def _query_chroma_candidates(self, query_text: str, material_name: str, n_results: int = 5, collection: Any = None) -> list[dict[str, Any]]:
        col = collection or self.chroma_client.get_or_create_collection(name=self._active_index()[1])
        if col.count() == 0:
            return []
        mat_hits = self._run_filtered_query(col, query_text, {"material": material_name}, n_results)
        rem = n_results - len(mat_hits)
        doc_hits = self._run_filtered_query(col, query_text, {"source": "raw_data_file"}, rem) if rem > 0 else []
        return (mat_hits + doc_hits)[:n_results]

    def _hydrate_chroma_by_ids(self, collection: Any, chroma_ids: tuple[str, ...]) -> list[dict[str, Any]]:
        if not chroma_ids or collection.count() == 0:
            return []
        res = collection.get(ids=list(chroma_ids), include=["metadatas", "documents"])
        ids = res.get("ids") or []
        return self._format_chroma_rows(ids, res.get("metadatas") or [], [0.1] * len(ids), res.get("documents") or [])

    def evaluate_simulation(self, request: SimulationRequestDTO) -> SimulationResponseDTO:
        material = self.repo.get_material_by_id(request.material_id)
        if not material:
            raise HTTPException(status_code=404, detail="Material no encontrado en SQLite.")

        version_tag, col_name = self._active_index()
        collection = self.chroma_client.get_or_create_collection(name=col_name)
        cache_key = RecentPointerCache.build_cache_key(request, index_tag=version_tag)
        pointer = self.cache.get_pointer(cache_key)
        cache_hit = pointer is not None
        q_text = f"{material.name} O2={request.custom_oxygen_pct}% PSI={request.custom_pressure_psi} {request.query_context}"
        if pointer is not None:
            sqlite_ids, chroma_ids, _ = pointer
            chroma_candidates = self._hydrate_chroma_by_ids(collection, chroma_ids) or self._query_chroma_candidates(q_text, material.name, collection=collection)
        else:
            chroma_candidates = self._query_chroma_candidates(q_text, material.name, collection=collection)
            found_sql = self.repo.find_matching_benchmark_ids(request.material_id, request.custom_oxygen_pct, request.custom_pressure_psi)
            sqlite_ids, chroma_ids, _ = self.cache.put_pointer(cache_key, found_sql, [c["id"] for c in chroma_candidates[:3]])

        benchmarks = self.repo.get_benchmarks_by_ids(sqlite_ids)
        phys = self.physics.evaluate_full_state(material.base_flammability_index, request.custom_oxygen_pct, request.custom_pressure_psi, request.custom_airflow, material.category)
        rerank = self.quality.rerank_top_5(
            chroma_candidates, target_o2=request.custom_oxygen_pct, target_psi=request.custom_pressure_psi,
            target_airflow=request.custom_airflow, base_flammability=material.base_flammability_index,
            category=material.category, neighbor_benchmarks=benchmarks,
        )
        imputed_rates = [float(c["burn_rate_mms"]) for c in rerank["top_5"] if c.get("is_imputed")]
        base_phys_rate = float(phys["burn_rate_mms"])
        predicted_rate = 0.0 if base_phys_rate <= 0.0 else round(0.7 * base_phys_rate + 0.3 * (imputed_rates[0] if imputed_rates else base_phys_rate), 3)
        cleaned = self.quality.clean_noise_and_contradictions([c["text"] for c in rerank["top_5"] if not c.get("is_imputed")], benchmarks)
        context_chunks = [c["cleaned_text"] for c in cleaned]
        prompt = augment(request, material, dict(phys, burn_rate_mms=predicted_rate), benchmarks, context_chunks)
        with self._state_lock:
            conclusion = self.llm.generate_conclusion(prompt, context_chunks, model_override=request.llm_model, api_key=request.api_key)

        risk_score = int(phys["risk_score"])
        report_id = self.repo.save_simulation_report(request, risk_score, conclusion)
        return SimulationResponseDTO(
            report_id=report_id, material_name=material.name, calculated_risk_score=risk_score,
            predicted_burn_rate_mms=predicted_rate, outcome_prediction=str(phys["regime_outcome"]),
            flame_color_hex=str(phys["flame_color_hex"]), sphere_radius_scale=float(phys["sphere_radius_scale"]),
            ai_conclusion_text=conclusion, sqlite_pointer_ids=list(sqlite_ids),
            chroma_pointer_ids=list(chroma_ids), cache_hit=cache_hit,
        )


_cors_origins = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",") if o.strip()]
app = FastAPI(title="NASA Microgravity Fire Risk RAG API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=_cors_origins, allow_credentials=False, allow_methods=["*"], allow_headers=["*"])
rag_engine = HybridFireRAGEngine()


@app.get("/api/materials", response_model=list[MaterialDTO])
def list_materials(q: str = Query(default="", max_length=100)) -> list[MaterialDTO]:
    return rag_engine.repo.search_materials(q)


@app.get("/api/benchmarks")
def list_benchmarks(q: str = Query(default="", max_length=100)) -> list[dict[str, Any]]:
    return rag_engine.repo.search_benchmarks(q)


@app.post("/api/simulate", response_model=SimulationResponseDTO)
def simulate_fire_risk(request: SimulationRequestDTO) -> SimulationResponseDTO:
    return rag_engine.evaluate_simulation(request)


@app.post("/api/sync-diff")
def sync_data_and_diff() -> dict[str, Any]:
    sqlite_summary = run_sqlite_ingestion()
    chroma_summary = push_sqlite_to_chroma(collection_name=rag_engine._active_index()[1])
    rag_engine.cache.clear()
    return {"sqlite": sqlite_summary, "chroma": chroma_summary, "cache_cleared": True}


@app.get("/api/llm-models")
def list_llm_models() -> dict[str, Any]:
    return {"active_model": rag_engine.llm.model, "models": OllamaLocalTagsHandler().fetch_local_models()}


@app.post("/api/llm-models/wakeup")
def wakeup_llm_models(req: WakeUpRequestDTO | None = Body(default=None)) -> dict[str, Any]:
    res = build_wakeup_chain(timeout=3.5).handle(endpoint=req.endpoint if req else None, api_key=req.api_key if req else None)
    if res.get("provider") == "ollama_local" and res.get("models"):
        with rag_engine._state_lock:
            rag_engine.llm.model, rag_engine.llm._explicit_model = str(res["models"][0]), True
    return res


@app.post("/api/maintenance/reindex")
def maintenance_reindex(req: ReindexRequestDTO | None = Body(default=None)) -> dict[str, Any]:
    cfg = req or ReindexRequestDTO()
    res = rag_engine.index_mgr.reindex_zero_downtime(cfg.version_tag, cfg.model_name, cfg.dimension)
    rag_engine.cache.clear()
    return res


frontend_dir = get_frontend_dir()
app.mount("/frontend", StaticFiles(directory=str(frontend_dir), html=True), name="frontend_sub")
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend_root")
