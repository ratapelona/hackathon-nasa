from collections import OrderedDict
from collections.abc import Sequence
from contextlib import closing
from functools import lru_cache
import hashlib
from pathlib import Path
from typing import Any

from backend.os_platform_handlers import OSPlatformFactory
from backend.schemas_and_base import (
    AbstractDatabaseRepository,
    AbstractPointerCache,
    MaterialDTO,
    PointerTuple,
    SimulationRequestDTO,
    get_canonical_db_path,
)


def _escape_like(term: str) -> str:
    """Escapa comodines SQL LIKE (%, _, \\) para búsquedas literales."""
    return str(term or "").strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@lru_cache(maxsize=32)
def get_sqlite_db_path() -> Path:
    return get_canonical_db_path()


def augment(
    request: SimulationRequestDTO, material: MaterialDTO, physics_state: dict[str, Any],
    benchmarks: Sequence[dict[str, Any]], context_chunks: Sequence[str] = (),
) -> str:
    """Construye el prompt RAG con comparación Delta (Δ) y anclaje MANDATORY PHYSICS STATE al cierre."""
    burn_rate = float(physics_state.get("burn_rate_mms", 0.0))
    risk_score = int(physics_state.get("risk_score", 0))
    regime = str(physics_state.get("regime_outcome", "sustained"))
    delta_items = [
        f"[{b.get('psi_id', 'NASA')}: ΔO2={float(request.custom_oxygen_pct) - float(b['oxygen_pct']):+.2f}%, "
        f"ΔPSI={float(request.custom_pressure_psi) - float(b['pressure_psi']):+.2f}, "
        f"ΔBurnRate={burn_rate - float(b['burn_rate_mms']):+.3f} mm/s vs {b['burn_rate_mms']} mm/s ({b['outcome']})]"
        for b in benchmarks
    ]
    delta_text = "; ".join(delta_items) if delta_items else "No matching NASA Experiment_Benchmarks."
    ctx_block = "\n".join(f"- {str(c).strip()}" for c in context_chunks if str(c).strip()) or "- Sin fragmentos PDF adicionales."
    prohibition = (
        "PROHIBITED: risk_score >= 50. NEVER state low risk or slow spread (<1 cm/s)."
        if risk_score >= 50
        else "Report extinction/low-spread behavior consistently with risk_score < 50."
    )
    return (
        f"SIMULATION QUERY: Material={material.name} ({material.category}) | "
        f"O2={request.custom_oxygen_pct}%, Pressure={request.custom_pressure_psi} PSI, "
        f"Airflow={request.custom_airflow} cm/s | Context={request.query_context or 'N/A'}\n"
        f"RETRIEVED CONTEXT:\n{ctx_block}\n\n"
        f"=== MANDATORY PHYSICS STATE (DO NOT CONTRADICT) ===\n"
        f"predicted_burn_rate_mms={burn_rate} mm/s | risk_score={risk_score}/100 | regime={regime}\n"
        f"NASA Benchmark Deltas (Δ): {delta_text}\n"
        f"INSTRUCTION 1: In your very first sentence, state the exact predicted_burn_rate_mms={burn_rate} mm/s "
        f"and risk_score={risk_score}/100 calculated by SyntheticMicrogravityEquations.\n"
        f"INSTRUCTION 2: Explain the physical difference (Δ O2, Δ PSI, Δ BurnRate) strictly against NASA Benchmark Deltas (Δ); if O2 > 21%, describe the atmosphere as oxidizer-rich (never fuel-rich).\n"
        f"INSTRUCTION 3: {prohibition}"
    )

class RecentPointerCache(AbstractPointerCache):
    """Caché LRU estricta de hasta 32 slots que almacena solo tuplas de punteros."""

    def __init__(self, max_slots: int = 32) -> None:
        if max_slots < 1 or max_slots > 32:
            raise ValueError("max_slots debe estar entre 1 y 32.")
        self._max_slots, self._store, self._hits, self._misses = max_slots, OrderedDict(), 0, 0

    @staticmethod
    def build_cache_key(req: SimulationRequestDTO) -> str:
        raw = f"{req.material_id}|{req.custom_oxygen_pct:.2f}|{req.custom_pressure_psi:.2f}|{req.custom_airflow:.2f}|{req.query_context.lower()}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    def get_pointer(self, key: str) -> PointerTuple | None:
        if key not in self._store:
            self._misses += 1
            return None
        self._store.move_to_end(key)
        self._hits += 1
        return self._store[key]

    def put_pointer(self, key: str, sqlite_ids: Sequence[int], chroma_ids: Sequence[str]) -> PointerTuple:
        sqlite_tuple = tuple(int(i) for i in sqlite_ids)
        chroma_tuple = tuple(str(c) for c in chroma_ids)
        pointer: PointerTuple = (sqlite_tuple, chroma_tuple, hex(id(sqlite_tuple)))
        self._store[key] = pointer
        self._store.move_to_end(key)
        if len(self._store) > self._max_slots:
            self._store.popitem(last=False)
        return pointer

    def clear(self) -> None:
        self._store.clear()
        self._hits, self._misses = 0, 0

    def stats(self) -> dict[str, int]:
        return {"size": len(self._store), "max_slots": self._max_slots, "hits": self._hits, "misses": self._misses}

class NasaFireRepository(AbstractDatabaseRepository):
    """Repositorio SQLite multihilo con consultas 100% parametrizadas (cero f-strings)."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or get_sqlite_db_path()

    @staticmethod
    def augment(request: SimulationRequestDTO, material: MaterialDTO, physics_state: dict[str, Any], benchmarks: Sequence[dict[str, Any]], context_chunks: Sequence[str] = ()) -> str:
        return augment(request, material, physics_state, benchmarks, context_chunks)

    def _open_conn(self):
        return closing(OSPlatformFactory.get_handler().open_sqlite_connection(self.db_path))

    def get_materials(self) -> list[MaterialDTO]:
        with self._open_conn() as conn:
            rows = conn.execute("SELECT id, name, category, base_flammability_index FROM Materials ORDER BY id").fetchall()
        return [MaterialDTO(**dict(r)) for r in rows]

    def get_material_by_id(self, material_id: int) -> MaterialDTO | None:
        with self._open_conn() as conn:
            row = conn.execute("SELECT id, name, category, base_flammability_index FROM Materials WHERE id = ?", (int(material_id),)).fetchone()
        return MaterialDTO(**dict(row)) if row else None

    def search_materials(self, term: str = "") -> list[MaterialDTO]:
        pattern = f"%{_escape_like(term)}%"
        query = (
            "SELECT id, name, category, base_flammability_index FROM Materials "
            "WHERE LOWER(name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(category) LIKE LOWER(?) ESCAPE '\\' ORDER BY id"
        )
        with self._open_conn() as conn:
            rows = conn.execute(query, (pattern, pattern)).fetchall()
        return [MaterialDTO(**dict(r)) for r in rows]

    def search_benchmarks(self, term: str = "") -> list[dict[str, Any]]:
        pattern = f"%{_escape_like(term)}%"
        query = (
            "SELECT b.id, b.material_id, b.investigation_id, b.oxygen_pct, b.pressure_psi, "
            "b.airflow_cms, b.burn_rate_mms, b.outcome, m.name AS material_name, "
            "m.category AS material_category, i.psi_id, i.code, i.hardware_used "
            "FROM Experiment_Benchmarks b JOIN Materials m ON b.material_id = m.id "
            "JOIN Nasa_Investigations i ON b.investigation_id = i.id "
            "WHERE LOWER(m.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(i.code) LIKE LOWER(?) ESCAPE '\\' "
            "OR LOWER(b.outcome) LIKE LOWER(?) ESCAPE '\\' ORDER BY b.id"
        )
        with self._open_conn() as conn:
            rows = conn.execute(query, (pattern, pattern, pattern)).fetchall()
        return [dict(r) for r in rows]

    def get_benchmarks_by_ids(self, benchmark_ids: Sequence[int]) -> list[dict[str, Any]]:
        clean_ids = [int(bid) for bid in benchmark_ids]
        if not clean_ids:
            return []
        query = (
            "SELECT b.id, b.material_id, b.investigation_id, b.oxygen_pct, b.pressure_psi, "
            "b.airflow_cms, b.burn_rate_mms, b.outcome, m.name AS material_name, i.psi_id, i.code, i.hardware_used "
            "FROM Experiment_Benchmarks b JOIN Materials m ON b.material_id = m.id "
            "JOIN Nasa_Investigations i ON b.investigation_id = i.id WHERE b.id = ?"
        )
        results: list[dict[str, Any]] = []
        with self._open_conn() as conn:
            for bid in clean_ids:
                row = conn.execute(query, (bid,)).fetchone()
                if row:
                    results.append(dict(row))
        return sorted(results, key=lambda item: int(item["id"]))

    def find_matching_benchmark_ids(self, material_id: int, oxygen_pct: float, pressure_psi: float) -> list[int]:
        query = "SELECT id FROM Experiment_Benchmarks WHERE material_id = ? ORDER BY ABS(oxygen_pct - ?) + ABS(pressure_psi - ?) ASC, id ASC LIMIT 5"
        with self._open_conn() as conn:
            rows = conn.execute(query, (int(material_id), float(oxygen_pct), float(pressure_psi))).fetchall()
        return [int(r["id"]) for r in rows]

    def save_simulation_report(self, req: SimulationRequestDTO, risk_score: int, conclusion: str) -> int:
        clean_conclusion = str(conclusion).strip()
        query = (
            "INSERT INTO Simulation_Reports (material_id, custom_oxygen_pct, custom_pressure_psi, "
            "custom_airflow, calculated_risk_score, ai_conclusion_text) VALUES (?, ?, ?, ?, ?, ?)"
        )
        params = (int(req.material_id), float(req.custom_oxygen_pct), float(req.custom_pressure_psi), float(req.custom_airflow), int(risk_score), clean_conclusion)
        with self._open_conn() as conn:
            cur = conn.execute(query, params)
            conn.commit()
            return int(cur.lastrowid)


SQLiteFireRepository = NasaFireRepository
