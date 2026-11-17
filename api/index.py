import math
from pathlib import Path
import shutil
import sqlite3
from typing import Any

from fastapi import Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parent.parent
SRC_DB = ROOT_DIR / "nasa_fire.db"
TMP_DB = Path("/tmp/nasa_fire.db")


def _get_db_conn() -> sqlite3.Connection:
    if not TMP_DB.exists() and SRC_DB.exists():
        shutil.copy2(SRC_DB, TMP_DB)
    db_path = TMP_DB if TMP_DB.exists() else SRC_DB
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _evaluate_physics(
    base_flammability: float,
    oxygen_pct: float,
    pressure_psi: float,
    airflow_cms: float,
    category: str = "Solid",
) -> dict[str, Any]:
    std_o2, std_psi, blowoff_flow, min_o2, da_crit = 21.0, 14.7, 18.0, 12.0, 0.05
    diff_map = {"gas": 1.25, "liquid": 1.12, "solid": 1.0}
    diff_factor = diff_map.get(str(category).strip().lower(), 1.0)

    flow = max(0.0, float(airflow_cms))
    flow_term = math.log1p(flow)
    o2_ratio = max(0.0, (float(oxygen_pct) - min_o2) / (std_o2 - min_o2))
    psi_ratio = max(0.0, float(pressure_psi) / std_psi)
    convective_boost = (1.0 + 0.42 * flow_term) / (1.0 + 0.008 * flow)
    blowoff_penalty = 0.65 if flow >= blowoff_flow and oxygen_pct <= std_o2 else 1.0
    base_rate = round(max(0.0, (float(base_flammability) / 6.0) * o2_ratio * psi_ratio * convective_boost * blowoff_penalty), 4)

    da_num = (float(base_flammability) / 10.0) * (float(oxygen_pct) / std_o2) * (max(0.0, float(pressure_psi)) / std_psi)
    da_idx = round(max(0.0, da_num / (1.0 + 0.28 * flow_term + 0.035 * flow)), 4)

    o2_safe = max(float(oxygen_pct), 1.0)
    rad_loss = round(min(0.95, max(0.05, (0.42 / (1.0 + 0.15 * flow_term)) * ((std_o2 / o2_safe) ** 0.35))), 4)

    extinguished = float(oxygen_pct) < min_o2 or da_idx < da_crit or base_rate <= 0.0
    da_eff = 0.0 if extinguished else (da_idx ** 2) / (da_idx ** 2 + da_crit ** 2)
    burn_rate = 0.0 if extinguished else round(base_rate * diff_factor * da_eff, 4)
    raw_score = 0.0 if extinguished else (
        float(base_flammability) * 4.8 + (float(oxygen_pct) - 14.0) * 1.35 + burn_rate * 7.5 + da_idx * 14.0 - rad_loss * 18.0
    )
    risk_score = 0 if extinguished else max(0, min(100, int(round(raw_score))))
    regime = "rapid_spread" if risk_score >= 75 else "sustained" if risk_score >= 45 else "cool_flame_or_extinction"
    flame_hex = "#ef4444" if risk_score >= 75 else "#f59e0b" if risk_score >= 45 else "#38bdf8"
    radius_scale = 0.35 if extinguished else round(min(3.0, max(0.35, 0.55 + burn_rate * 0.25 + da_idx * 0.3)), 3)
    return {
        "burn_rate_mms": burn_rate,
        "damkohler_index": da_idx,
        "radiative_loss_fraction": rad_loss,
        "risk_score": risk_score,
        "regime_outcome": regime,
        "flame_color_hex": flame_hex,
        "sphere_radius_scale": radius_scale,
    }


class SimulationRequest(BaseModel):
    material_id: int = Field(..., ge=1)
    custom_oxygen_pct: float = Field(..., ge=0.0, le=100.0)
    custom_pressure_psi: float = Field(..., gt=0.0, le=50.0)
    custom_airflow: float = Field(..., ge=0.0, le=500.0)
    query_context: str = Field(default="", max_length=500)
    llm_model: str | None = None


app = FastAPI(title="NASA CIR-0G Microgravity Fire Risk (Vercel API)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/materials")
def list_materials() -> list[dict[str, Any]]:
    with _get_db_conn() as conn:
        rows = conn.execute("SELECT id, name, category, base_flammability_index FROM Materials ORDER BY id").fetchall()
    return [dict(r) for r in rows]


@app.get("/api/benchmarks")
def list_benchmarks(q: str = Query(default="", max_length=100)) -> list[dict[str, Any]]:
    like_q = f"%{q.strip()}%"
    with _get_db_conn() as conn:
        rows = conn.execute(
            """
            SELECT b.id, m.name AS material_name, i.psi_id, i.code,
                   b.oxygen_pct, b.pressure_psi, b.airflow_cms, b.burn_rate_mms, b.outcome
            FROM Experiment_Benchmarks b
            JOIN Materials m ON b.material_id = m.id
            JOIN Nasa_Investigations i ON b.investigation_id = i.id
            WHERE (? = '%%' OR m.name LIKE ? OR i.psi_id LIKE ? OR i.code LIKE ? OR b.outcome LIKE ?)
            ORDER BY b.id
            """,
            (like_q, like_q, like_q, like_q, like_q),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/simulate")
def simulate_fire_risk(req: SimulationRequest) -> dict[str, Any]:
    with _get_db_conn() as conn:
        mat = conn.execute(
            "SELECT id, name, category, base_flammability_index FROM Materials WHERE id = ?",
            (req.material_id,),
        ).fetchone()
        if not mat:
            return {"detail": "Material not found"}
        benches = conn.execute(
            """
            SELECT b.id, i.psi_id, i.code, b.oxygen_pct, b.pressure_psi, b.burn_rate_mms, b.outcome
            FROM Experiment_Benchmarks b
            JOIN Nasa_Investigations i ON b.investigation_id = i.id
            WHERE b.material_id = ?
            ORDER BY b.id LIMIT 3
            """,
            (req.material_id,),
        ).fetchall()

    phys = _evaluate_physics(
        mat["base_flammability_index"], req.custom_oxygen_pct, req.custom_pressure_psi, req.custom_airflow, mat["category"]
    )
    deltas = []
    sqlite_ids = []
    for b in benches:
        sqlite_ids.append(int(b["id"]))
        do2 = req.custom_oxygen_pct - float(b["oxygen_pct"])
        dpsi = req.custom_pressure_psi - float(b["pressure_psi"])
        dbr = phys["burn_rate_mms"] - float(b["burn_rate_mms"])
        deltas.append(
            f"[{b['psi_id']}: ΔO2={do2:+.2f}%, ΔPSI={dpsi:+.2f}, ΔBurnRate={dbr:+.3f} mm/s vs {b['burn_rate_mms']} mm/s ({b['outcome']})]"
        )

    conclusion = (
        f"0g Physics State: predicted_burn_rate_mms={phys['burn_rate_mms']} mm/s with risk_score={phys['risk_score']}/100. "
        f"NASA Benchmark Deltas: {'; '.join(deltas) if deltas else 'Deterministic 0g calculation.'}"
    )
    return {
        "report_id": None,
        "material_name": mat["name"],
        "calculated_risk_score": phys["risk_score"],
        "predicted_burn_rate_mms": phys["burn_rate_mms"],
        "outcome_prediction": phys["regime_outcome"],
        "flame_color_hex": phys["flame_color_hex"],
        "sphere_radius_scale": phys["sphere_radius_scale"],
        "ai_conclusion_text": conclusion,
        "sqlite_pointer_ids": sqlite_ids,
        "chroma_pointer_ids": [],
        "cache_hit": False,
    }


@app.get("/api/llm-models")
def list_llm_models() -> dict[str, Any]:
    return {"active_model": "deterministic-0g-cloud", "models": ["deterministic-0g-cloud"]}


@app.post("/api/llm-models/wakeup")
def wakeup_llm_models(_: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    return {"provider": "cloud_deterministic", "models": ["deterministic-0g-cloud"]}


@app.post("/api/sync-diff")
def sync_data_and_diff() -> dict[str, Any]:
    return {"status": "synced", "mode": "vercel_serverless"}
