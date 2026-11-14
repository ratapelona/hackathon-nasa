from contextlib import closing
from functools import lru_cache
from pathlib import Path
import sqlite3
import sys
import chromadb

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.os_platform_handlers import OSPlatformFactory
DEFAULT_COLLECTION = "nasa_microgravity_fire"


@lru_cache(maxsize=32)
def get_db_path() -> Path:
    return OSPlatformFactory.get_handler().get_canonical_db_path(PROJECT_ROOT)


@lru_cache(maxsize=32)
def get_chroma_path() -> Path:
    return PROJECT_ROOT / "chroma_data"


def fetch_benchmarks_from_sqlite(conn: sqlite3.Connection) -> tuple[list[str], list[dict], list[str]]:
    query = """
        SELECT b.id, b.oxygen_pct, b.pressure_psi, b.airflow_cms,
               b.burn_rate_mms, b.outcome, m.name AS material_name,
               m.category AS material_category, i.psi_id, i.code, i.hardware_used
        FROM Experiment_Benchmarks b
        JOIN Materials m ON b.material_id = m.id
        JOIN Nasa_Investigations i ON b.investigation_id = i.id
        ORDER BY b.id
    """
    docs, metas, ids = [], [], []
    for row in conn.execute(query).fetchall():
        text = (
            f"[{row['psi_id']} - {row['code']}] Material: {row['material_name']} ({row['material_category']}). "
            f"Hardware: {row['hardware_used']}. Conditions: O2={row['oxygen_pct']}%, "
            f"Pressure={row['pressure_psi']} PSI, Airflow={row['airflow_cms']} cm/s. "
            f"Measured Burn Rate: {row['burn_rate_mms']} mm/s | Outcome: {row['outcome']}."
        )
        docs.append(text)
        metas.append({
            "source": "sqlite_benchmark",
            "material": str(row["material_name"]),
            "psi_id": str(row["psi_id"]),
            "oxygen_pct": float(row["oxygen_pct"]),
            "pressure_psi": float(row["pressure_psi"]),
            "outcome": str(row["outcome"]),
        })
        ids.append(f"bench_{row['id']}")
    return docs, metas, ids


def fetch_raw_docs_from_sqlite(conn: sqlite3.Connection) -> tuple[list[str], list[dict], list[str]]:
    query = "SELECT file_hash, file_path, extracted_text FROM Sync_State WHERE extracted_text IS NOT NULL AND extracted_text != ''"
    docs, metas, ids = [], [], []
    for row in conn.execute(query).fetchall():
        clean_text = row["extracted_text"].strip()
        if len(clean_text) < 25:
            continue
        file_name = Path(row["file_path"]).name
        docs.append(f"[NASA Document: {file_name}] {clean_text}")
        metas.append({
            "source": "raw_data_file",
            "file_name": file_name,
            "file_path": str(row["file_path"]),
        })
        ids.append(f"doc_{row['file_hash'][:16]}")
    return docs, metas, ids


def push_sqlite_to_chroma(collection_name: str = DEFAULT_COLLECTION) -> dict:
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError(f"No se encontró la base de datos en {db_path}. Ejecuta primero backend/obtencion.py")

    with closing(OSPlatformFactory.get_handler().open_sqlite_connection(db_path)) as conn:
        b_docs, b_metas, b_ids = fetch_benchmarks_from_sqlite(conn)
        r_docs, r_metas, r_ids = fetch_raw_docs_from_sqlite(conn)

    all_docs = b_docs + r_docs
    all_metas = b_metas + r_metas
    all_ids = b_ids + r_ids

    client = chromadb.PersistentClient(path=str(get_chroma_path()))
    collection = client.get_or_create_collection(name=collection_name)

    if all_docs:
        collection.upsert(documents=all_docs, metadatas=all_metas, ids=all_ids)

    return {
        "collection": collection_name,
        "benchmarks_upserted": len(b_docs),
        "raw_docs_upserted": len(r_docs),
        "total_in_chroma": collection.count(),
    }


if __name__ == "__main__":
    summary = push_sqlite_to_chroma()
    print(f"[ChromaDB Sync Completado] {summary}")
