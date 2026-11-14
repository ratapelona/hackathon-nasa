from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
import math
from typing import Any, final
import pandas as pd


@dataclass(frozen=True)
class MicrogravityThermoConstants:
    """Constantes termodinámicas inmutables para combustión en microgravedad (0g)."""

    std_o2_pct: float = 21.0
    std_pressure_psi: float = 14.7
    blowoff_airflow_cms: float = 18.0
    min_o2_pct: float = 12.0


class AbstractCombustionEquations(ABC):
    """Ecuaciones físicas 0g selladas con @final y validadas vía __init_subclass__."""

    _SEALED_METHODS = (
        "calc_spherical_diffusion_rate",
        "calc_damkohler_ignition_index",
        "calc_radiative_heat_loss",
        "evaluate_full_state",
    )
    _constants: MicrogravityThermoConstants = MicrogravityThermoConstants()

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        for name in AbstractCombustionEquations._SEALED_METHODS:
            if name in cls.__dict__:
                raise TypeError(f"Método sellado @final sobrescrito en {cls.__name__}: {name}")

    @abstractmethod
    def get_material_diffusivity_factor(self, category: str) -> float:
        """Factor de difusividad térmica específico según categoría del material."""

    @final
    def calc_spherical_diffusion_rate(
        self, base_flammability: float, oxygen_pct: float, pressure_psi: float, airflow_cms: float
    ) -> float:
        c = self._constants
        flow_term = math.log1p(max(0.0, float(airflow_cms)))
        o2_ratio = max(0.0, (float(oxygen_pct) - c.min_o2_pct) / (c.std_o2_pct - c.min_o2_pct))
        psi_ratio = max(0.1, float(pressure_psi) / c.std_pressure_psi)
        convective_boost = 1.0 + 0.42 * flow_term
        blowoff_penalty = 0.65 if airflow_cms >= c.blowoff_airflow_cms and oxygen_pct <= c.std_o2_pct else 1.0
        rate = (float(base_flammability) / 6.0) * o2_ratio * psi_ratio * convective_boost * blowoff_penalty
        return round(max(0.0, rate), 4)

    @final
    def calc_damkohler_ignition_index(
        self, base_flammability: float, oxygen_pct: float, pressure_psi: float, airflow_cms: float
    ) -> float:
        c = self._constants
        flow_term = math.log1p(max(0.0, float(airflow_cms)))
        num = (float(base_flammability) / 10.0) * (float(oxygen_pct) / c.std_o2_pct) * (float(pressure_psi) / c.std_pressure_psi)
        return round(max(0.0, num / (1.0 + 0.28 * flow_term)), 4)

    @final
    def calc_radiative_heat_loss(self, oxygen_pct: float, airflow_cms: float) -> float:
        c = self._constants
        flow_term = math.log1p(max(0.0, float(airflow_cms)))
        o2_safe = max(float(oxygen_pct), 1.0)
        loss = (0.42 / (1.0 + 0.15 * flow_term)) * ((c.std_o2_pct / o2_safe) ** 0.35)
        return round(min(0.95, max(0.05, loss)), 4)

    @final
    def evaluate_full_state(
        self, base_flammability: float, oxygen_pct: float,
        pressure_psi: float, airflow_cms: float, category: str = "Solid",
    ) -> dict[str, Any]:
        diff_factor = float(self.get_material_diffusivity_factor(category))
        base_rate = self.calc_spherical_diffusion_rate(base_flammability, oxygen_pct, pressure_psi, airflow_cms)
        burn_rate = round(base_rate * diff_factor, 4)
        da_idx = self.calc_damkohler_ignition_index(base_flammability, oxygen_pct, pressure_psi, airflow_cms)
        rad_loss = self.calc_radiative_heat_loss(oxygen_pct, airflow_cms)
        raw_score = (
            float(base_flammability) * 4.8 + (float(oxygen_pct) - 14.0) * 1.35
            + burn_rate * 7.5 + da_idx * 14.0 - rad_loss * 18.0
        )
        risk_score = max(0, min(100, int(round(raw_score))))
        regime = "rapid_spread" if risk_score >= 75 else "sustained" if risk_score >= 45 else "cool_flame_or_extinction"
        flame_color_hex = "#ef4444" if risk_score >= 75 else "#f59e0b" if risk_score >= 45 else "#38bdf8"
        sphere_radius_scale = round(min(3.0, max(0.35, 0.55 + burn_rate * 0.25 + da_idx * 0.3)), 3)
        return {
            "burn_rate_mms": burn_rate,
            "damkohler_index": da_idx,
            "radiative_loss_fraction": rad_loss,
            "risk_score": risk_score,
            "regime_outcome": regime,
            "flame_color_hex": flame_color_hex,
            "sphere_radius_scale": sphere_radius_scale,
        }


class NasaZeroGCombustionModel(AbstractCombustionEquations):
    """Implementación concreta para sólidos, líquidos y gases en microgravedad."""

    _DIFFUSIVITY_MAP = {"gas": 1.25, "liquid": 1.12, "solid": 1.0}

    def get_material_diffusivity_factor(self, category: str) -> float:
        return self._DIFFUSIVITY_MAP.get(str(category).strip().lower(), 1.0)


class SmallGapImputerModel:
    """Imputador IDW (pandas) + física 0g cuando el RAG no alcanza el Top-K."""

    def __init__(self, physics_model: NasaZeroGCombustionModel | None = None) -> None:
        self.physics = physics_model or NasaZeroGCombustionModel()

    def interpolate_idw_burn_rate(
        self, neighbors: Sequence[dict[str, Any]], target_o2: float, target_psi: float,
        target_airflow: float, base_flammability: float = 7.5, category: str = "Solid",
    ) -> float:
        phys_state = self.physics.evaluate_full_state(
            base_flammability, target_o2, target_psi, target_airflow, category
        )
        phys_rate = float(phys_state["burn_rate_mms"])
        if not neighbors:
            return phys_rate
        df = pd.DataFrame(neighbors)
        required = {"oxygen_pct", "pressure_psi", "airflow_cms", "burn_rate_mms"}
        if df.empty or not required.issubset(df.columns):
            return phys_rate
        dist = (
            ((df["oxygen_pct"].astype(float) - float(target_o2)) / 21.0) ** 2
            + ((df["pressure_psi"].astype(float) - float(target_psi)) / 14.7) ** 2
            + ((df["airflow_cms"].astype(float) - float(target_airflow)) / 20.0) ** 2
        ) ** 0.5
        weights = 1.0 / ((dist + 1e-4) ** 2)
        idw_rate = float((weights * df["burn_rate_mms"].astype(float)).sum() / weights.sum())
        return round(0.6 * idw_rate + 0.4 * phys_rate, 4)

    def impute_missing_candidates(
        self, needed: int, neighbors: Sequence[dict[str, Any]], target_o2: float, target_psi: float,
        target_airflow: float, base_flammability: float = 7.5, category: str = "Solid",
    ) -> list[dict[str, Any]]:
        if needed <= 0:
            return []
        synthesized: list[dict[str, Any]] = []
        offsets = ((0.0, 0.0, 0.0), (-2.0, 0.0, 2.0), (2.0, 0.0, -2.0), (0.0, -1.5, 4.0), (3.0, 1.0, 0.0))
        for idx in range(needed):
            do2, dpsi, dflow = offsets[idx % len(offsets)]
            o2_val = max(0.0, min(100.0, round(float(target_o2) + do2, 2)))
            psi_val = max(1.0, min(50.0, round(float(target_psi) + dpsi, 2)))
            flow_val = max(0.0, round(float(target_airflow) + dflow, 2))
            est_rate = self.interpolate_idw_burn_rate(
                neighbors, o2_val, psi_val, flow_val, base_flammability, category
            )
            state = self.physics.evaluate_full_state(base_flammability, o2_val, psi_val, flow_val, category)
            synthesized.append({
                "id": f"imputed_{idx + 1}", "psi_id": "SYNTH-0G-IDW",
                "oxygen_pct": o2_val, "pressure_psi": psi_val, "airflow_cms": flow_val,
                "burn_rate_mms": est_rate, "outcome": state["regime_outcome"],
                "combined_score": round(max(0.45, 0.62 - idx * 0.03), 4), "is_imputed": True,
                "text": (
                    f"[IDW+0g Imputed] O2={o2_val}%, PSI={psi_val}, Airflow={flow_val} cm/s -> "
                    f"Burn Rate={est_rate} mm/s ({state['regime_outcome']})."
                ),
            })
        return synthesized


SyntheticMicrogravityEquations = NasaZeroGCombustionModel
