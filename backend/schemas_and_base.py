from abc import ABC, abstractmethod
from collections.abc import Sequence
from functools import lru_cache
import html
from pathlib import Path
from typing import Any
from pydantic import BaseModel, Field, field_validator

from backend.os_platform_handlers import OSPlatformFactory

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PointerTuple = tuple[tuple[int, ...], tuple[str, ...], str]


@lru_cache(maxsize=32)
def get_project_root() -> Path:
    """Retorna la raíz del proyecto resuelta de forma portable."""
    return PROJECT_ROOT


@lru_cache(maxsize=32)
def get_canonical_db_path() -> Path:
    """Devuelve la ruta canónica única PROJECT_ROOT/nasa_fire.db según el OS."""
    return OSPlatformFactory.get_handler().get_canonical_db_path(PROJECT_ROOT)


@lru_cache(maxsize=32)
def resolve_project_path(relative_path: str) -> Path:
    """Resuelve una ruta relativa dentro de PROJECT_ROOT bloqueando path traversal."""
    candidate = (PROJECT_ROOT / relative_path).resolve()
    candidate.relative_to(PROJECT_ROOT)
    return candidate


def sanitize_text(value: str) -> str:
    """Sanitiza texto contra XSS escapando HTML en una unica frontera de salida."""
    return html.escape(str(value).strip(), quote=True)


def clean_plain_text(value: Any) -> str:
    """Normaliza texto plano en el backend sin introducir doble escape HTML."""
    return "" if value is None else str(value).strip()


class MaterialDTO(BaseModel):
    id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=120)
    category: str = Field(..., min_length=1, max_length=60)
    base_flammability_index: float = Field(..., ge=0.0, le=10.0)

    @field_validator("name", "category", mode="before")
    @classmethod
    def _clean_fields(cls, v: Any) -> str:
        return clean_plain_text(v)


class SimulationRequestDTO(BaseModel):
    material_id: int = Field(..., ge=1)
    custom_oxygen_pct: float = Field(..., ge=0.0, le=100.0)
    custom_pressure_psi: float = Field(..., gt=0.0, le=50.0)
    custom_airflow: float = Field(..., ge=0.0, le=500.0)
    query_context: str = Field(default="", max_length=500)
    llm_model: str | None = Field(default=None, max_length=120)
    api_key: str | None = Field(default=None, max_length=256)

    @field_validator("query_context", mode="before")
    @classmethod
    def _clean_context(cls, v: Any) -> str:
        return clean_plain_text(v)


class SimulationResponseDTO(BaseModel):
    report_id: int | None = None
    material_name: str = Field(..., min_length=1, max_length=120)
    calculated_risk_score: int = Field(..., ge=0, le=100)
    predicted_burn_rate_mms: float = Field(..., ge=0.0)
    outcome_prediction: str = Field(..., min_length=1, max_length=120)
    flame_color_hex: str = Field(default="#38bdf8", min_length=4, max_length=16)
    sphere_radius_scale: float = Field(default=1.0, ge=0.0)
    ai_conclusion_text: str = Field(..., min_length=1, max_length=4000)
    sqlite_pointer_ids: list[int] = Field(default_factory=list)
    chroma_pointer_ids: list[str] = Field(default_factory=list)
    cache_hit: bool = False

    @field_validator("material_name", "outcome_prediction", "ai_conclusion_text", mode="before")
    @classmethod
    def _clean_text_outputs(cls, v: Any) -> str:
        return clean_plain_text(v)


class WakeUpRequestDTO(BaseModel):
    endpoint: str | None = Field(default=None, max_length=256)
    api_key: str | None = Field(default=None, max_length=256)


class ReindexRequestDTO(BaseModel):
    version_tag: str = Field(default="v1", min_length=1, max_length=32)
    model_name: str = Field(default="all-MiniLM-L6-v2", min_length=1, max_length=120)
    dimension: int = Field(default=384, ge=16, le=4096)


class AbstractPointerCache(ABC):
    @abstractmethod
    def get_pointer(self, key: str) -> PointerTuple | None:
        """Recupera punteros (sqlite_ids, chroma_ids, mem_addr) si existen en caché."""

    @abstractmethod
    def put_pointer(
        self, key: str, sqlite_ids: Sequence[int], chroma_ids: Sequence[str]
    ) -> PointerTuple:
        """Almacena únicamente tuplas de punteros bajo política LRU."""

    @abstractmethod
    def clear(self) -> None:
        """Limpia todos los punteros almacenados."""

    @abstractmethod
    def stats(self) -> dict[str, int]:
        """Devuelve métricas de uso (size, max_slots, hits, misses)."""


class AbstractDatabaseRepository(ABC):
    @abstractmethod
    def get_materials(self) -> list[MaterialDTO]:
        """Lista materiales disponibles desde SQLite."""

    @abstractmethod
    def get_material_by_id(self, material_id: int) -> MaterialDTO | None:
        """Obtiene un material específico por su clave primaria."""

    @abstractmethod
    def get_benchmarks_by_ids(self, benchmark_ids: Sequence[int]) -> list[dict[str, Any]]:
        """Hidrata únicamente los benchmarks indicados por sus IDs puntero."""

    @abstractmethod
    def find_matching_benchmark_ids(
        self, material_id: int, oxygen_pct: float, pressure_psi: float
    ) -> list[int]:
        """Localiza IDs puntero de benchmarks cercanos a las condiciones dadas."""

    @abstractmethod
    def search_materials(self, term: str = "") -> list[MaterialDTO]:
        """Busca materiales usando filtro SQL LIKE insensible a mayúsculas."""

    @abstractmethod
    def search_benchmarks(self, term: str = "") -> list[dict[str, Any]]:
        """Busca benchmarks con JOIN triple y filtro LIKE insensible a mayúsculas."""

    @abstractmethod
    def save_simulation_report(
        self, req: SimulationRequestDTO, risk_score: int, conclusion: str
    ) -> int:
        """Persiste el reporte sanitizado de simulación y retorna su ID."""


class AbstractLLMProvider(ABC):
    @abstractmethod
    def generate_conclusion(self, prompt: str, context_chunks: Sequence[str]) -> str:
        """Genera una conclusión técnica usando el contexto recuperado."""


class AbstractRAGEngine(ABC):
    @abstractmethod
    def evaluate_simulation(self, request: SimulationRequestDTO) -> SimulationResponseDTO:
        """Ejecuta el flujo completo RAG híbrido para evaluar riesgo de fuego."""


class AbstractEmbeddingMaintenance(ABC):
    @abstractmethod
    def ensure_registry_table(self) -> None:
        """Garantiza la existencia de la tabla Embedding_Index_Registry en SQLite."""

    @abstractmethod
    def get_active_index(self) -> dict[str, Any] | None:
        """Devuelve la versión activa del índice vectorial."""

    @abstractmethod
    def reindex_zero_downtime(
        self, version_tag: str, model_name: str = "all-MiniLM-L6-v2", dimension: int = 384
    ) -> dict[str, Any]:
        """Reindexa ChromaDB desde SQLite y conmuta la versión activa sin caída."""
