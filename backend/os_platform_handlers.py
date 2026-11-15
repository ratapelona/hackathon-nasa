from abc import ABC, abstractmethod
from functools import lru_cache
import hashlib
from pathlib import Path
import platform
import sqlite3
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class AbstractOSPlatformHandler(ABC):
    """Jerarquía Abstract Factory + Template Method para portabilidad macOS/Linux/Windows."""

    @property
    @abstractmethod
    def os_name(self) -> str:
        """Nombre canónico del sistema operativo (Darwin, Linux, Windows)."""

    @abstractmethod
    def get_local_llm_endpoints(self) -> list[str]:
        """Lista priorizada de endpoints locales para Ollama según la red del OS."""

    @abstractmethod
    def get_virtual_python_executable(self, project_root: Path = PROJECT_ROOT) -> Path:
        """Ruta al intérprete Python del entorno virtual .venv según el OS."""

    @abstractmethod
    def get_hardware_acceleration_hint(self) -> str:
        """Sugerencia de aceleración por hardware para inferencia local."""

    def get_canonical_db_path(self, project_root: Path = PROJECT_ROOT) -> Path:
        return (project_root / "nasa_fire.db").resolve()

    def to_portable_relpath(self, path: Path, root: Path = PROJECT_ROOT) -> str:
        return path.resolve().relative_to(root.resolve()).as_posix()

    def compute_portable_sha256(self, path: Path) -> str:
        raw = path.read_bytes().replace(b"\r\n", b"\n")
        return hashlib.sha256(raw).hexdigest()

    def open_sqlite_connection(self, db_path: Path | None = None) -> sqlite3.Connection:
        target = (db_path or self.get_canonical_db_path()).resolve()
        conn = sqlite3.connect(target)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn


class MacOSPlatformHandler(AbstractOSPlatformHandler):
    @property
    def os_name(self) -> str:
        return "Darwin"

    def get_local_llm_endpoints(self) -> list[str]:
        return ["http://127.0.0.1:11434", "http://localhost:11434"]

    def get_virtual_python_executable(self, project_root: Path = PROJECT_ROOT) -> Path:
        return project_root / ".venv" / "bin" / "python"

    def get_hardware_acceleration_hint(self) -> str:
        return "Metal / Unified Memory"


class LinuxPlatformHandler(AbstractOSPlatformHandler):
    @property
    def os_name(self) -> str:
        return "Linux"

    def get_local_llm_endpoints(self) -> list[str]:
        return ["http://127.0.0.1:11434", "http://localhost:11434", "http://host.docker.internal:11434"]

    def get_virtual_python_executable(self, project_root: Path = PROJECT_ROOT) -> Path:
        return project_root / ".venv" / "bin" / "python"

    def get_hardware_acceleration_hint(self) -> str:
        return "CUDA / ROCm / Vulkan"


class WindowsPlatformHandler(AbstractOSPlatformHandler):
    @property
    def os_name(self) -> str:
        return "Windows"

    def get_local_llm_endpoints(self) -> list[str]:
        return ["http://127.0.0.1:11434", "http://localhost:11434"]

    def get_virtual_python_executable(self, project_root: Path = PROJECT_ROOT) -> Path:
        return project_root / ".venv" / "Scripts" / "python.exe"

    def get_hardware_acceleration_hint(self) -> str:
        return "CUDA / DirectML"


class OSPlatformFactory:
    """Fábrica única para resolver el handler del sistema operativo y auditar SQLite."""

    _REGISTRY: dict[str, type[AbstractOSPlatformHandler]] = {
        "darwin": MacOSPlatformHandler,
        "linux": LinuxPlatformHandler,
        "windows": WindowsPlatformHandler,
    }

    @staticmethod
    def create_handler(system_name: str) -> AbstractOSPlatformHandler:
        cls = OSPlatformFactory._REGISTRY.get(str(system_name).strip().lower(), LinuxPlatformHandler)
        return cls()

    @staticmethod
    @lru_cache(maxsize=1)
    def get_handler() -> AbstractOSPlatformHandler:
        return OSPlatformFactory.create_handler(platform.system())

    @staticmethod
    def _migrate_useful_rows(dup_path: Path, canonical_conn: sqlite3.Connection) -> int:
        if dup_path.stat().st_size == 0:
            return 0
        migrated = 0
        try:
            with sqlite3.connect(dup_path) as dup_conn:
                tables = {r[0] for r in dup_conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
                if "Sync_State" in tables:
                    for fh, fp, txt in dup_conn.execute("SELECT file_hash, file_path, extracted_text FROM Sync_State").fetchall():
                        cur = canonical_conn.execute(
                            "INSERT OR IGNORE INTO Sync_State (file_hash, file_path, extracted_text) VALUES (?, ?, ?)",
                            (fh, fp, txt),
                        )
                        migrated += max(0, cur.rowcount)
                if "Simulation_Reports" in tables:
                    for row in dup_conn.execute(
                        "SELECT material_id, custom_oxygen_pct, custom_pressure_psi, custom_airflow, calculated_risk_score, ai_conclusion_text FROM Simulation_Reports"
                    ).fetchall():
                        exists = canonical_conn.execute(
                            "SELECT 1 FROM Simulation_Reports WHERE material_id=? AND custom_oxygen_pct=? AND custom_pressure_psi=? AND custom_airflow=? AND ai_conclusion_text=?",
                            (row[0], row[1], row[2], row[3], row[5]),
                        ).fetchone()
                        if not exists:
                            canonical_conn.execute(
                                "INSERT INTO Simulation_Reports (material_id, custom_oxygen_pct, custom_pressure_psi, custom_airflow, calculated_risk_score, ai_conclusion_text) VALUES (?, ?, ?, ?, ?, ?)",
                                row,
                            )
                            migrated += 1
        except sqlite3.Error:
            return 0
        return migrated

    @staticmethod
    def audit_and_deduplicate_databases(project_root: Path = PROJECT_ROOT) -> dict[str, Any]:
        handler = OSPlatformFactory.get_handler()
        root_resolved = project_root.resolve()
        canonical = handler.get_canonical_db_path(root_resolved)
        found_dbs = [
            p.resolve()
            for p in sorted(root_resolved.rglob("*.db"))
            if not any(part in {".venv", "venv", "__pycache__"} for part in p.parts)
        ]
        removed: list[str] = []
        migrated_rows = 0
        if canonical.exists():
            with handler.open_sqlite_connection(canonical) as conn:
                for db_file in found_dbs:
                    if db_file != canonical:
                        migrated_rows += OSPlatformFactory._migrate_useful_rows(db_file, conn)
                        db_file.unlink(missing_ok=True)
                        removed.append(handler.to_portable_relpath(db_file, root_resolved))
                conn.commit()
                counts = {
                    t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    for t in ("Materials", "Nasa_Investigations", "Experiment_Benchmarks")
                    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
                }
        else:
            counts = {}
        return {
            "canonical_db": str(canonical),
            "found_count": len(found_dbs),
            "removed_duplicates": removed,
            "migrated_rows": migrated_rows,
            "table_counts": counts,
        }
