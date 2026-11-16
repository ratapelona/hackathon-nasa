from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import urlparse
import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ingesto_chroma import DEFAULT_COLLECTION, push_sqlite_to_chroma
from backend.obtencion import get_raw_dir, run_sqlite_ingestion
from backend.rag_quality_and_maintenance import EmbeddingIndexManager

ALLOWED_HOSTS = {"psi.nasa.gov", "www.nasa.gov", "nasa.gov", "sma.nasa.gov", "spinoff.nasa.gov", "www.youtube.com"}
USER_AGENT = "NASA-CIR-0G-Simulator/1.0 (+https://www.nasa.gov)"

NASA_RESOURCES: tuple[dict[str, str], ...] = (
    {
        "slug": "psi_combustion_repo",
        "title": "PSI Data Repository: Combustion Science",
        "url": "https://psi.nasa.gov/physci/repo/search?q=combustion",
        "category": "psi_repository",
        "fallback": "Physical Sciences Informatics (PSI) repository containing NASA microgravity combustion investigation datasets (BASS-II, FLEX, Saffire, ACME).",
    },
    {
        "slug": "nasa_combustion_science",
        "title": "NASA Combustion Science",
        "url": "https://www.nasa.gov/glenn/glenn-expertise-space-exploration/physical-sciences-program/combustion-science/",
        "category": "nasa_program",
        "fallback": "Overview of NASA Glenn Physical Sciences combustion investigations archived in the PSI Data Repository.",
    },
    {
        "slug": "sciencecasts_iss_combustion",
        "title": "NASA ScienceCasts: The Power of Studying Combustion on the ISS",
        "url": "https://www.youtube.com/watch?v=W1oXykoz9zg",
        "category": "video_briefing",
        "fallback": "NASA ScienceCasts (2018) 3.6-minute introduction to combustion research aboard the International Space Station, including cool flames and microgravity fire behavior.",
    },
    {
        "slug": "iss_combustion_researchers_guide",
        "title": "A Researcher's Guide to International Space Station Combustion Science",
        "url": "https://www.nasa.gov/missions/station/a-researchers-guide-to-combustion-science/",
        "category": "researchers_guide",
        "fallback": "2015 NASA review (50+ pages) of combustion research conducted or planned on the ISS, linked to investigations in the PSI Data Repository.",
    },
    {
        "slug": "apollo_1_fire",
        "title": "Apollo 1 Fire Investigation and Lessons Learned",
        "url": "https://sma.nasa.gov/sma-disciplines/accllp/apollo-1",
        "category": "safety_case_study",
        "fallback": "Apollo 1 pre-launch cabin fire in pure oxygen atmosphere (~16.7 PSI), investigation findings, and spacecraft fire safety lessons learned.",
    },
    {
        "slug": "apollo_13_oxygen_tank",
        "title": "Apollo 13 Oxygen Tank Explosion and Lessons Learned",
        "url": "https://sma.nasa.gov/sma-disciplines/accllp/apollo-13",
        "category": "safety_case_study",
        "fallback": "Apollo 13 cryogenic oxygen tank explosion during lunar flight, root cause analysis, and spacecraft safety lessons learned.",
    },
    {
        "slug": "mir_fire_1997",
        "title": "25 Years Ago: Fire Aboard Space Station Mir (1997)",
        "url": "https://www.nasa.gov/history/25-years-ago-fire-aboard-space-station-mir/",
        "category": "safety_case_study",
        "fallback": "1997 oxygen generator (Vika/SFOG) fire aboard Space Station Mir during joint US-Russian operations prior to ISS habitation.",
    },
    {
        "slug": "spinoff_firemans_air_tanks",
        "title": "NASA Spinoff: Fireman's Air Tanks",
        "url": "https://spinoff.nasa.gov/node/9582",
        "category": "spinoff_tech",
        "fallback": "1970s NASA spacesuit composite pressure vessel technology adapted to lighten and improve firefighters' breathing air tanks.",
    },
    {
        "slug": "spinoff_fire_detector",
        "title": "NASA Spinoff: Fire Detector",
        "url": "https://spinoff.nasa.gov/node/9407",
        "category": "spinoff_tech",
        "fallback": "1970s Space Shuttle smoke detector designed to discriminate smoke from dust, reducing nuisance alarms in industrial and mining operations.",
    },
    {
        "slug": "spinoff_fire_attire",
        "title": "NASA Spinoff: New Technology for the Fire Attire",
        "url": "https://spinoff.nasa.gov/node/9918",
        "category": "spinoff_tech",
        "fallback": "1980s adaptation of NASA spacesuit flame-resistant materials (PBI/Nomex) to improve firefighter protective clothing.",
    },
)


class _HtmlTextExtractor(HTMLParser):
    """Extrae título, descripción meta y texto limpio de párrafos y encabezados HTML."""

    _SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "header"}
    _TEXT_TAGS = {"p", "h1", "h2", "h3", "h4", "li", "blockquote", "figcaption"}

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._in_title = False
        self._capture_depth = 0
        self.title = ""
        self.description = ""
        self.chunks: list[str] = []
        self.pdf_links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_l = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if tag_l in self._SKIP_TAGS:
            self._skip_depth += 1
        elif tag_l == "title":
            self._in_title = True
        elif tag_l == "meta" and attr_map.get("name", "").lower() == "description":
            if attr_map.get("content"):
                self.description = attr_map["content"].strip()
        elif tag_l == "a" and ".pdf" in attr_map.get("href", "").lower():
            self.pdf_links.append(attr_map["href"].strip())
        if self._skip_depth == 0 and tag_l in self._TEXT_TAGS:
            self._capture_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag_l = tag.lower()
        if tag_l in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag_l == "title":
            self._in_title = False
        if tag_l in self._TEXT_TAGS and self._capture_depth > 0:
            self._capture_depth -= 1

    def handle_data(self, data: str) -> None:
        text = re.sub(r"\s+", " ", data).strip()
        if not text:
            return
        if self._in_title and not self.title:
            self.title = text
        elif self._skip_depth == 0 and self._capture_depth > 0 and len(text) >= 15:
            self.chunks.append(text)


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_HOSTS:
        raise ValueError(f"URL no permitida fuera de dominios NASA/YouTube: {url}")


def _fetch_single_resource(client: httpx.Client, res: dict[str, str], out_dir: Path) -> dict[str, Any]:
    _validate_url(res["url"])
    status = "fallback"
    extracted_body = ""
    page_title = res["title"]
    pdf_downloaded = None

    try:
        if "youtube.com" in res["url"]:
            oembed_url = f"https://www.youtube.com/oembed?url={res['url']}&format=json"
            resp = client.get(oembed_url)
            if resp.status_code == 200:
                meta = resp.json()
                page_title = meta.get("title") or page_title
                author = meta.get("author_name", "NASA")
                extracted_body = f"Video title: {page_title}. Channel: {author}. {res['fallback']}"
                status = "ok_oembed"
        else:
            resp = client.get(res["url"])
            if resp.status_code == 200 and resp.text:
                parser = _HtmlTextExtractor()
                parser.feed(resp.text)
                if parser.title:
                    page_title = parser.title
                parts = [p for p in [parser.description, *parser.chunks] if p]
                joined = " ".join(dict.fromkeys(parts))
                if len(joined) >= 80:
                    extracted_body = joined[:11500]
                    status = "ok_html"
                for pdf_url in parser.pdf_links[:1]:
                    if pdf_url.startswith("https://") and (urlparse(pdf_url).hostname or "").endswith("nasa.gov"):
                        pdf_resp = client.get(pdf_url)
                        if pdf_resp.status_code == 200 and pdf_resp.content[:4] == b"%PDF":
                            pdf_path = out_dir / f"{res['slug']}.pdf"
                            pdf_path.write_bytes(pdf_resp.content)
                            pdf_downloaded = pdf_path.name
    except Exception as exc:
        status = f"fallback ({type(exc).__name__})"

    summary_text = extracted_body or res["fallback"]
    payload = {
        "title": page_title,
        "url": res["url"],
        "category": res["category"],
        "summary": f"Source: {res['url']} | {summary_text}"[:12000],
    }
    json_path = out_dir / f"{res['slug']}.json"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"slug": res["slug"], "status": status, "chars": len(payload["summary"]), "pdf": pdf_downloaded}


def fetch_and_sync_all() -> dict[str, Any]:
    out_dir = get_raw_dir() / "nasa_resources"
    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    with httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        for res in NASA_RESOURCES:
            results.append(_fetch_single_resource(client, res, out_dir))

    sqlite_summary = run_sqlite_ingestion()
    active_idx = EmbeddingIndexManager().get_active_index() or {}
    active_collection = active_idx.get("collection_name") or DEFAULT_COLLECTION
    chroma_summary = push_sqlite_to_chroma(collection_name=active_collection)
    return {"fetched": results, "sqlite": sqlite_summary, "chroma": chroma_summary}


if __name__ == "__main__":
    report = fetch_and_sync_all()
    print(json.dumps(report, ensure_ascii=False, indent=2))
