from collections.abc import Sequence
from contextlib import closing
from functools import lru_cache
from pathlib import Path
import re
from typing import Any

from backend.combustion_equations import SmallGapImputerModel
from backend.ingesto_chroma import DEFAULT_COLLECTION, push_sqlite_to_chroma
from backend.os_platform_handlers import OSPlatformFactory
from backend.schemas_and_base import AbstractEmbeddingMaintenance, clean_plain_text, get_canonical_db_path

_OCR_NOISE_RE = re.compile(r"[\x00-\x1f\x7f]+")
_MULTI_SPACE_RE = re.compile(r"\s+")
_BURN_RATE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*mm/s", re.IGNORECASE)
_O2_PCT_RE = re.compile(r"O2\s*[=:]?\s*(\d+(?:\.\d+)?)\s*%", re.IGNORECASE)


@lru_cache(maxsize=32)
def get_registry_db_path() -> Path:
    return get_canonical_db_path()


def clean_noise_and_contradictions(
    raw_chunks: Sequence[str], sqlite_benchmarks: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Limpia ruido OCR y hace prevalecer los valores numéricos de SQLite ante contradicciones."""
    by_psi = {str(b.get("psi_id", "")).upper(): b for b in sqlite_benchmarks if b.get("psi_id")}
    cleaned_docs: list[dict[str, Any]] = []
    for chunk in raw_chunks:
        text = _MULTI_SPACE_RE.sub(" ", _OCR_NOISE_RE.sub(" ", str(chunk))).strip()
        enforced = False
        matched_bench = next((b for psi, b in by_psi.items() if psi in text.upper()), None)
        if matched_bench:
            sql_rate = float(matched_bench["burn_rate_mms"])
            sql_o2 = float(matched_bench["oxygen_pct"])
            rate_match = _BURN_RATE_RE.search(text)
            o2_match = _O2_PCT_RE.search(text)
            rate_conflict = rate_match and abs(float(rate_match.group(1)) - sql_rate) > 0.05
            o2_conflict = o2_match and abs(float(o2_match.group(1)) - sql_o2) > 0.25
            if rate_conflict or o2_conflict:
                enforced = True
                text = (
                    f"{text} [SQLite Truth Override {matched_bench['psi_id']}: "
                    f"O2={sql_o2}%, BurnRate={sql_rate} mm/s, Outcome={matched_bench['outcome']}]"
                )
        cleaned_docs.append({
            "cleaned_text": text,
            "sqlite_truth_enforced": enforced,
            "matched_psi_id": matched_bench["psi_id"] if matched_bench else None,
        })
    return cleaned_docs


class RAGQualityController:
    """Controlador de calidad RAG: limpieza de contradicciones y re-ranking Top-5 (65/35)."""

    def __init__(self, imputer: SmallGapImputerModel | None = None) -> None:
        self.imputer = imputer or SmallGapImputerModel()

    def clean_noise_and_contradictions(
        self, raw_chunks: Sequence[str], sqlite_benchmarks: Sequence[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        return clean_noise_and_contradictions(raw_chunks, sqlite_benchmarks)

    def rerank_top_5(
        self,
        candidates: Sequence[dict[str, Any]],
        target_o2: float,
        target_psi: float,
        target_airflow: float = 10.0,
        base_flammability: float = 7.5,
        category: str = "Solid",
        neighbor_benchmarks: Sequence[dict[str, Any]] = (),
        min_threshold: float = 0.45,
    ) -> dict[str, Any]:
        scored: list[dict[str, Any]] = []
        for cand in candidates:
            sem = max(0.0, min(1.0, float(cand.get("semantic_score", 0.5))))
            if "oxygen_pct" in cand and "pressure_psi" in cand:
                o2_prox = max(0.0, 1.0 - abs(float(cand["oxygen_pct"]) - float(target_o2)) / 25.0)
                psi_prox = max(0.0, 1.0 - abs(float(cand["pressure_psi"]) - float(target_psi)) / 15.0)
                phys = 0.5 * (o2_prox + psi_prox)
            else:
                phys = 0.5
            combined = round(0.65 * sem + 0.35 * phys, 4)
            if combined >= float(min_threshold):
                item = dict(cand)
                item["combined_score"] = combined
                item["is_imputed"] = False
                scored.append(item)
        scored.sort(key=lambda x: x["combined_score"], reverse=True)
        top_empirical = scored[:5]
        missing = 5 - len(top_empirical)
        imputed = (
            self.imputer.impute_missing_candidates(
                missing, neighbor_benchmarks, target_o2, target_psi, target_airflow, base_flammability, category
            )
            if missing > 0
            else []
        )
        top_5 = top_empirical + imputed
        return {
            "top_5": top_5,
            "empirical_count": len(top_empirical),
            "imputed_count": len(imputed),
            "coverage_summary": (
                f"Top-5: {len(top_empirical)} empíricos (>= {min_threshold}) + "
                f"{len(imputed)} imputados IDW+0g."
            ),
        }


class EmbeddingIndexManager(AbstractEmbeddingMaintenance):
    """Administra Embedding_Index_Registry y reindexado sin tiempo de inactividad."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or get_registry_db_path()
        self.ensure_registry_table()

    def _open_conn(self):
        return closing(OSPlatformFactory.get_handler().open_sqlite_connection(self.db_path))

    def ensure_registry_table(self) -> None:
        with self._open_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS Embedding_Index_Registry (
                    version_tag TEXT PRIMARY KEY,
                    model_name TEXT NOT NULL,
                    dimension INTEGER NOT NULL,
                    collection_name TEXT NOT NULL,
                    is_active INTEGER NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()

    def get_active_index(self) -> dict[str, Any] | None:
        with self._open_conn() as conn:
            row = conn.execute(
                "SELECT version_tag, model_name, dimension, collection_name, is_active, updated_at "
                "FROM Embedding_Index_Registry WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return dict(row) if row else None

    def reindex_zero_downtime(
        self, version_tag: str, model_name: str = "all-MiniLM-L6-v2", dimension: int = 384
    ) -> dict[str, Any]:
        safe_tag = clean_plain_text(version_tag) or "v1"
        safe_model = clean_plain_text(model_name) or "all-MiniLM-L6-v2"
        collection_name = DEFAULT_COLLECTION if safe_tag == "v1" else f"{DEFAULT_COLLECTION}_{safe_tag}"
        sync_res = push_sqlite_to_chroma(collection_name=collection_name)
        with self._open_conn() as conn:
            conn.execute("UPDATE Embedding_Index_Registry SET is_active = 0")
            conn.execute(
                """
                INSERT INTO Embedding_Index_Registry
                (version_tag, model_name, dimension, collection_name, is_active)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(version_tag) DO UPDATE SET
                    model_name = excluded.model_name,
                    dimension = excluded.dimension,
                    collection_name = excluded.collection_name,
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (safe_tag, safe_model, int(dimension), collection_name),
            )
            conn.commit()
        return {"active_version": safe_tag, "collection_name": collection_name, "chroma_sync": sync_res}
