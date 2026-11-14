from contextlib import closing
import difflib
import hashlib
import html
import json
import sqlite3
import sys
from functools import lru_cache
from pathlib import Path
import pdfplumber

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.os_platform_handlers import OSPlatformFactory

CORE_INVESTIGATIONS = [
    ("PSI-25", "BASS-II", "Microgravity Science Glovebox (MSG)", "Burning and Suppression of Solids II."),
    ("PSI-69", "FLEX", "Combustion Integrated Rack (CIR)", "Flame Extinguishment Experiment."),
    ("PSI-98", "Saffire-I", "Cygnus Spacecraft", "Spacecraft Fire Experiment I on large-scale textiles."),
    ("PSI-100", "Saffire-III", "Cygnus Spacecraft", "Spacecraft Fire Experiment III on PMMA and cotton."),
    ("PSI-159", "ACME-CFI-G", "Combustion Integrated Rack (CIR)", "Cool Flames Investigation with Gases."),
]

CORE_MATERIALS = [
    ("PMMA Acrylic", "Solid", 6.2),
    ("Cotton Fabric", "Solid", 8.5),
    ("Propane Gas", "Gas", 9.5),
    ("n-Heptane", "Liquid", 8.8),
]

CORE_BENCHMARKS = [
    ("PMMA Acrylic", "PSI-25", 21.0, 14.7, 10.0, 1.2, "sustained"),
    ("PMMA Acrylic", "PSI-100", 34.0, 14.7, 15.0, 3.8, "rapid_spread"),
    ("Cotton Fabric", "PSI-25", 21.0, 14.7, 18.0, 0.0, "extinguished_blowoff"),
    ("Cotton Fabric", "PSI-98", 21.0, 14.7, 20.0, 2.4, "sustained"),
    ("Propane Gas", "PSI-159", 15.0, 14.7, 2.0, 0.4, "cool_flame_sustained"),
    ("n-Heptane", "PSI-69", 21.0, 14.7, 0.0, 0.9, "spherical_extinction"),
]


@lru_cache(maxsize=32)
def get_db_path() -> Path:
    return OSPlatformFactory.get_handler().get_canonical_db_path(PROJECT_ROOT)

@lru_cache(maxsize=32)
def get_raw_dir() -> Path:
    return PROJECT_ROOT / "raw_data"

@lru_cache(maxsize=32)
def get_snapshot_path() -> Path:
    return PROJECT_ROOT / "last_sync_snapshot.txt"

def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()

def _sha256_file(path: Path) -> str:
    return OSPlatformFactory.get_handler().compute_portable_sha256(path)

def init_sqlite(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS Materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
            category TEXT NOT NULL, base_flammability_index REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS Nasa_Investigations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, psi_id TEXT UNIQUE NOT NULL,
            code TEXT NOT NULL, hardware_used TEXT NOT NULL, summary_clean TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS Experiment_Benchmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER NOT NULL,
            investigation_id INTEGER NOT NULL, oxygen_pct REAL NOT NULL,
            pressure_psi REAL NOT NULL, airflow_cms REAL NOT NULL,
            burn_rate_mms REAL NOT NULL, outcome TEXT NOT NULL, row_hash TEXT UNIQUE NOT NULL,
            FOREIGN KEY (material_id) REFERENCES Materials(id),
            FOREIGN KEY (investigation_id) REFERENCES Nasa_Investigations(id)
        );
        CREATE TABLE IF NOT EXISTS Simulation_Reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER NOT NULL,
            custom_oxygen_pct REAL NOT NULL, custom_pressure_psi REAL NOT NULL,
            custom_airflow REAL NOT NULL, calculated_risk_score INTEGER NOT NULL,
            ai_conclusion_text TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (material_id) REFERENCES Materials(id)
        );
        CREATE TABLE IF NOT EXISTS Sync_State (
            file_hash TEXT PRIMARY KEY, file_path TEXT NOT NULL,
            extracted_text TEXT, synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

def seed_core_tables(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.executemany(
        "INSERT OR IGNORE INTO Materials (name, category, base_flammability_index) VALUES (?, ?, ?)",
        CORE_MATERIALS,
    )
    cur.executemany(
        "INSERT OR IGNORE INTO Nasa_Investigations (psi_id, code, hardware_used, summary_clean) VALUES (?, ?, ?, ?)",
        CORE_INVESTIGATIONS,
    )
    for mat_name, psi_id, o2, psi, flow, rate, outcome in CORE_BENCHMARKS:
        mat_row = cur.execute("SELECT id FROM Materials WHERE name = ?", (mat_name,)).fetchone()
        inv_row = cur.execute("SELECT id FROM Nasa_Investigations WHERE psi_id = ?", (psi_id,)).fetchone()
        if mat_row and inv_row:
            r_hash = _sha256_text(f"{mat_name}|{psi_id}|{o2}|{psi}|{flow}|{rate}|{outcome}")
            cur.execute(
                "INSERT OR IGNORE INTO Experiment_Benchmarks "
                "(material_id, investigation_id, oxygen_pct, pressure_psi, airflow_cms, burn_rate_mms, outcome, row_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (mat_row[0], inv_row[0], o2, psi, flow, rate, outcome, r_hash),
            )


def _compute_and_save_snapshot_diff(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT file_hash, file_path FROM Sync_State ORDER BY file_path, file_hash").fetchall()
    current_lines = [f"{r[0]} | {r[1]}" for r in rows]
    snap_path = get_snapshot_path()
    prev_lines = snap_path.read_text(encoding="utf-8").splitlines() if snap_path.exists() else []
    diff_lines = list(
        difflib.unified_diff(prev_lines, current_lines, fromfile="last_sync_snapshot.txt", tofile="current_sync", lineterm="")
    )
    snap_path.write_text("\n".join(current_lines) + ("\n" if current_lines else ""), encoding="utf-8")
    return len(diff_lines)


def ingest_raw_files(conn: sqlite3.Connection) -> tuple[int, int]:
    raw_dir = get_raw_dir()
    if not raw_dir.exists():
        raw_dir.mkdir(parents=True, exist_ok=True)
    cur = conn.cursor()
    added = 0
    for file_path in sorted(raw_dir.rglob("*")):
        if not file_path.is_file() or file_path.suffix.lower() not in {".pdf", ".json"}:
            continue
        f_hash = _sha256_file(file_path)
        if cur.execute("SELECT 1 FROM Sync_State WHERE file_hash = ?", (f_hash,)).fetchone():
            continue
        extracted = ""
        if file_path.suffix.lower() == ".json":
            data = json.loads(file_path.read_text(encoding="utf-8", errors="ignore"))
            extracted = f"{data.get('title', '')} | {data.get('abstract', data.get('summary', ''))}"[:3000]
        elif file_path.suffix.lower() == ".pdf":
            with pdfplumber.open(file_path) as pdf:
                pages_text = [p.extract_text() or "" for p in pdf.pages[:5]]
                extracted = "\n".join(pages_text)[:3000]
        clean_extracted = html.escape(extracted.strip(), quote=True)
        rel_path = OSPlatformFactory.get_handler().to_portable_relpath(file_path, PROJECT_ROOT)
        cur.execute(
            "INSERT INTO Sync_State (file_hash, file_path, extracted_text) VALUES (?, ?, ?)",
            (f_hash, rel_path, clean_extracted),
        )
        added += 1
    diff_lines_count = _compute_and_save_snapshot_diff(conn)
    return added, diff_lines_count


def run_sqlite_ingestion() -> dict:
    handler = OSPlatformFactory.get_handler()
    db_path = get_db_path()
    with closing(handler.open_sqlite_connection(db_path)) as conn:
        init_sqlite(conn)
        seed_core_tables(conn)
        added, diff_lines_count = ingest_raw_files(conn)
        conn.commit()
    dedup = OSPlatformFactory.audit_and_deduplicate_databases(PROJECT_ROOT)
    return {
        "db_path": str(db_path),
        "new_raw_files_ingested": added,
        "diff_lines_count": diff_lines_count,
        "removed_duplicates": dedup["removed_duplicates"],
    }


if __name__ == "__main__":
    result = run_sqlite_ingestion()
    print(f"[SQLite Ingest Completado] {result}")
