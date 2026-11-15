from abc import ABC, abstractmethod
from collections.abc import Sequence
import ipaddress, logging, os, re
from typing import Any
from urllib.parse import urlparse
import requests
from backend.os_platform_handlers import OSPlatformFactory
from backend.schemas_and_base import AbstractLLMProvider

try:
    import ollama  # type: ignore
except ImportError:  # pragma: no cover
    ollama = None

logger = logging.getLogger(__name__)
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", flags=re.DOTALL | re.IGNORECASE)
_THINK_UNCLOSED_RE = re.compile(r"<think>.*$", flags=re.DOTALL | re.IGNORECASE)
_SIZE_B_RE = re.compile(r"(\d+(?:\.\d+)?)b\b", flags=re.IGNORECASE)
_MICRO_MARKERS = ("0.5b", "1b", "1.5b", "jev")
WAKEUP_FAILURE_MSG = "No se pudieron registrar los modelos"

def _is_safe_endpoint(url: str) -> bool:
    p = urlparse(str(url or "").strip())
    host = (p.hostname or "").lower()
    if p.scheme not in {"http", "https"} or not host or host in {"metadata.google.internal", "169.254.169.254"}:
        return False
    try:
        ip = ipaddress.ip_address(host)
        return not (ip.is_link_local or ip.is_multicast or ip.is_unspecified)
    except ValueError:
        return True

def _get_json(url: str, timeout: float, headers: dict[str, str] | None = None) -> dict[str, Any]:
    resp = requests.get(url, headers=headers or {}, timeout=timeout); resp.raise_for_status(); return dict(resp.json())

class AbstractModelWakeUpHandler(ABC):
    """Eslabón Chain-of-Responsibility para descubrir modelos LLM (timeout=3.5s)."""
    provider_name: str = "abstract"

    def __init__(self, timeout: float = 3.5) -> None: self.timeout, self._next_handler = float(timeout), None
    def set_next(self, handler: "AbstractModelWakeUpHandler") -> "AbstractModelWakeUpHandler": self._next_handler = handler; return handler
    @abstractmethod
    def _discover(self, endpoint: str | None, api_key: str | None) -> tuple[str | None, list[str]]: ...

    def handle(self, endpoint: str | None = None, api_key: str | None = None) -> dict[str, Any]:
        try:
            used_ep, models = self._discover(endpoint, api_key)
            if models:
                return {"ok": True, "provider": self.provider_name, "endpoint": used_ep, "models": models, "message": "Modelos registrados"}
        except Exception as exc:
            logger.warning("WakeUp %s falló: %s", self.provider_name, exc)
        return self._next_handler.handle(endpoint, api_key) if self._next_handler else {"ok": False, "provider": None, "endpoint": endpoint, "models": [], "message": WAKEUP_FAILURE_MSG}

class StandardV1ModelsHandler(AbstractModelWakeUpHandler):
    """Consulta endpoints compatibles /v1/models usando Bearer token."""
    provider_name, _env_var, _require_key = "standard_v1", "OPENAI_BASE_URL", False

    def _headers(self, api_key: str | None) -> dict[str, str]: return {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _discover(self, endpoint: str | None, api_key: str | None) -> tuple[str | None, list[str]]:
        base = (endpoint or os.getenv(self._env_var) or "").rstrip("/")
        if not base or not _is_safe_endpoint(base) or (self._require_key and not api_key): return None, []
        data = _get_json(f"{base}/v1/models", self.timeout, self._headers(api_key))
        return base, [str(m.get("id", "")) for m in data.get("data", []) if m.get("id")]

class AnthropicModelsHandler(StandardV1ModelsHandler):
    """Consulta endpoints /v1/models con cabeceras Anthropic."""
    provider_name, _env_var, _require_key = "anthropic_v1", "ANTHROPIC_API_BASE", True
    def _headers(self, api_key: str | None) -> dict[str, str]: return {"x-api-key": api_key or "", "anthropic-version": "2023-06-01"}

class GeminiV1BetaModelsHandler(AbstractModelWakeUpHandler):
    """Consulta endpoints /v1beta/models enviando la API key por cabecera HTTP."""
    provider_name = "gemini_v1beta"

    def _discover(self, endpoint: str | None, api_key: str | None) -> tuple[str | None, list[str]]:
        base = (endpoint or os.getenv("GEMINI_API_BASE") or "").rstrip("/")
        if not base or not api_key or not _is_safe_endpoint(base): return None, []
        data = _get_json(f"{base}/v1beta/models", self.timeout, headers={"x-goog-api-key": api_key})
        return base, [str(m.get("name", "")).split("/")[-1] for m in data.get("models", []) if m.get("name")]

class OllamaLocalTagsHandler(AbstractModelWakeUpHandler):
    """Descubre modelos locales en Ollama y prioriza capacidades 7B-14B sobre micro."""
    provider_name = "ollama_local"

    def __init__(self, base_url: str | None = None, timeout: float = 3.5) -> None:
        super().__init__(timeout=timeout)
        env_host = (os.getenv("OLLAMA_HOST") or "").strip().rstrip("/")
        raw = [base_url.rstrip("/")] if base_url else ([env_host] if env_host else []) + OSPlatformFactory.get_handler().get_local_llm_endpoints()
        self.endpoints = [ep for ep in dict.fromkeys(raw) if ep and _is_safe_endpoint(ep)]
        self.base_url = self.endpoints[0] if self.endpoints else ""

    @staticmethod
    def _model_priority(name: str) -> tuple[int, float]:
        low = str(name).lower()
        if any(marker in low for marker in _MICRO_MARKERS):
            return (0, 0.0)
        match = _SIZE_B_RE.search(low)
        if match:
            size_b = float(match.group(1))
            return (3 if size_b >= 7.0 else 1, size_b)
        return (2, 7.0) if ("llama3" in low or "qwen" in low) else (1, 3.0)

    def rank_models(self, models: Sequence[str]) -> list[str]:
        return sorted((str(m).strip() for m in models if str(m).strip()), key=self._model_priority, reverse=True)

    def _discover(self, endpoint: str | None, api_key: str | None = None) -> tuple[str | None, list[str]]:
        targets = ([endpoint.rstrip("/")] + self.endpoints) if endpoint else self.endpoints
        for ep in dict.fromkeys(ep for ep in targets if _is_safe_endpoint(ep)):
            try:
                data = _get_json(f"{ep}/api/tags", self.timeout)
                ranked = self.rank_models([m.get("name", "") for m in data.get("models", []) if m.get("name")])
                if ranked:
                    self.base_url = ep
                    return ep, ranked
            except Exception as exc:
                logger.debug("Ollama endpoint %s inaccesible: %s", ep, exc)
        return None, []

    def fetch_local_models(self) -> list[str]: return self._discover(None, None)[1]

    def select_best_model(self, models: Sequence[str] | None = None, default: str | None = None) -> str:
        fallback = default or os.getenv("DEFAULT_LLM_MODEL", "qwen3.5:9b")
        ranked = self.rank_models(models) if models is not None else self.fetch_local_models()
        return ranked[0] if ranked else fallback

def build_wakeup_chain(timeout: float = 3.5) -> AbstractModelWakeUpHandler:
    """Construye la cadena StandardV1 -> Gemini -> Anthropic -> OllamaLocalTags."""
    v1 = StandardV1ModelsHandler(timeout=timeout)
    v1.set_next(GeminiV1BetaModelsHandler(timeout=timeout)).set_next(AnthropicModelsHandler(timeout=timeout)).set_next(OllamaLocalTagsHandler(timeout=timeout))
    return v1

class OllamaLLMProvider(AbstractLLMProvider):
    """Proveedor LLM acotado: lazy discovery, num_predict=280, think=False, timeout=60s."""
    DEFAULT_OPTIONS: dict[str, Any] = {"num_predict": 280, "temperature": 0.2, "presence_penalty": 0.0, "top_p": 0.9}

    def __init__(self, model: str | None = None, base_url: str | None = None, timeout: int = 60, use_sdk: bool = True) -> None:
        self.tags_handler = OllamaLocalTagsHandler(base_url=base_url)
        self.base_url, self.timeout, self.use_sdk = (base_url or self.tags_handler.base_url).rstrip("/"), int(timeout), use_sdk
        self._explicit_model, self.model = bool(model), model or os.getenv("DEFAULT_LLM_MODEL", "qwen3.5:9b")

    @staticmethod
    def strip_think_tags(text: str) -> str: return _THINK_UNCLOSED_RE.sub("", _THINK_BLOCK_RE.sub("", str(text))).strip()

    def build_payload(self, prompt: str, context_chunks: Sequence[str] = (), model_override: str | None = None) -> dict[str, Any]:
        ctx = "\n".join(str(c) for c in context_chunks if str(c).strip())
        user_msg = f"{ctx}\n\n{prompt}".strip() if ctx else str(prompt)
        sys_msg = "You are a NASA microgravity fire safety engineer. Follow MANDATORY PHYSICS STATE numbers strictly and compare deltas against Experiment_Benchmarks."
        return {"model": model_override or self.model, "stream": False, "think": False, "options": dict(self.DEFAULT_OPTIONS), "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}]}

    def _call_sdk(self, payload: dict[str, Any]) -> str | None:
        if not self.use_sdk or ollama is None:
            return None
        client_cls = getattr(ollama, "Client", None)
        res = (client_cls(host=self.base_url, timeout=self.timeout) if client_cls else ollama).chat(model=payload["model"], messages=payload["messages"], options=payload["options"], think=False)
        msg = res.get("message", {}) if isinstance(res, dict) else getattr(res, "message", None)
        return msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")

    def _call_http(self, payload: dict[str, Any], api_key: str | None = None) -> str:
        base_v1 = (os.getenv("OPENAI_BASE_URL") or "").rstrip("/")
        if api_key and _is_safe_endpoint(base_v1):
            r = requests.post(f"{base_v1}/v1/chat/completions", json={"model": payload["model"], "messages": payload["messages"], "max_tokens": 280, "temperature": 0.2}, headers={"Authorization": f"Bearer {api_key}"}, timeout=self.timeout)
            r.raise_for_status()
            return str((((r.json().get("choices") or [{}])[0]).get("message") or {}).get("content", ""))
        resp = requests.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
        resp.raise_for_status()
        return str((resp.json().get("message") or {}).get("content", ""))

    @staticmethod
    def _anchored_fallback(prompt: str) -> str:
        rate_m, risk_m, delta_m = re.search(r"predicted_burn_rate_mms=([^\s|]+)\s*mm/s", prompt), re.search(r"risk_score=(\d+/100)", prompt), re.search(r"NASA Benchmark Deltas \(Δ\):\s*(.+)", prompt)
        return f"Estado fisico 0g: predicted_burn_rate_mms={rate_m.group(1) + ' mm/s' if rate_m else 'N/A'} con risk_score={risk_m.group(1) if risk_m else 'N/A'}. Comparativa Delta frente a benchmarks NASA: {delta_m.group(1).strip() if delta_m else 'sin comparativa previa.'}"

    def generate_conclusion(self, prompt: str, context_chunks: Sequence[str] = (), model_override: str | None = None, api_key: str | None = None) -> str:
        if not self._explicit_model and not model_override and not api_key:
            self.model, self._explicit_model = self.tags_handler.select_best_model(default=self.model), True
        payload, raw = self.build_payload(prompt, context_chunks, model_override=model_override), None
        for caller in ((() if api_key else (lambda: self._call_sdk(payload),)) + (lambda: self._call_http(payload, api_key=api_key),)):
            try:
                raw = caller()
                if raw: break
            except Exception as exc:
                logger.warning("LLM llamada falló: %s", exc)
        return self.strip_think_tags(raw) if raw else self._anchored_fallback(prompt)
