"""OpenFoodFacts client. Sync, minimal, returns domain Ingredient instances.

API docs: https://world.openfoodfacts.org/api/v2/
We send a descriptive User-Agent — anonymous clients get rate-limited harder.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.domain.models import Ingredient, Source

log = logging.getLogger(__name__)

_BASE_URL = "https://world.openfoodfacts.org"
# Search-a-licious is OFF's dedicated search service. The legacy /cgi/search.pl and
# the /api/v2/search endpoint on world.openfoodfacts.org are both heavily rate-limited
# and frequently return 503 — Search-a-licious is the supported way to do free-text
# search now. See https://search.openfoodfacts.org/docs.
_SEARCH_BASE_URL = "https://search.openfoodfacts.org"
_USER_AGENT = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# Fields we ask for — keeps the response small.
_PRODUCT_FIELDS = ",".join(
    [
        "code",
        "product_name",
        "product_name_fr",
        "brands",
        "nutriments",
    ]
)


class OpenFoodFactsError(RuntimeError):
    """Network or API error talking to OpenFoodFacts."""


def _friendly_http_error(exc: httpx.HTTPError) -> str:
    """Turn raw httpx errors into something a user can act on."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (502, 503, 504):
            return (
                "OpenFoodFacts est temporairement indisponible "
                f"(HTTP {code}). Réessaie dans quelques minutes."
            )
        if code == 429:
            return (
                "Trop de requêtes vers OpenFoodFacts (HTTP 429). "
                "Attends une minute avant de réessayer."
            )
        return f"OpenFoodFacts a renvoyé une erreur HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "OpenFoodFacts ne répond pas (timeout). Vérifie ta connexion."
    if isinstance(exc, httpx.ConnectError):
        return "Impossible de joindre OpenFoodFacts. Vérifie ta connexion internet."
    return f"Erreur réseau OpenFoodFacts : {exc}"


def _make_client(base_url: str = _BASE_URL) -> httpx.Client:
    return httpx.Client(
        base_url=base_url,
        timeout=_TIMEOUT,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    )


_HEALTH_HOST = "https://search.openfoodfacts.org/"


def is_off_alive(timeout: float = 3.0) -> bool:
    """Lightweight reachability check for the OFF Search-a-licious host.

    Returns True if a GET on `search.openfoodfacts.org/` returns a 2xx/3xx
    within `timeout` seconds, False on timeout, network error or any
    non-success status. Designed to be called periodically (every 5 min)
    by `NetworkStatusViewModel` to drive the UI online/offline indicator (F10).

    Implementation note: we use **GET** (not HEAD) because the Search-a-licious
    backend rejects HEAD with `405 Method Not Allowed` on `/` and `/health`.
    `GET /` returns a 302 redirect (0-byte body) — same cost as a HEAD would
    have been, and now correctly classified as 'alive'. We disable redirect
    following to keep the probe a single round-trip.
    """
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as c:
            response = c.get(_HEALTH_HOST, headers={"User-Agent": _USER_AGENT})
            return 200 <= response.status_code < 400
    except (httpx.TimeoutException, httpx.HTTPError, OSError):
        return False


def _f(value: Any) -> float | None:
    """Best-effort float conversion. None / '' / non-numeric -> None."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _product_to_ingredient(product: dict[str, Any]) -> Ingredient | None:
    """Map an OFF /api/v2/product or /search hit to our Ingredient. Returns None if too sparse."""
    code = product.get("code")
    name = (
        product.get("product_name_fr")
        or product.get("product_name")
        or product.get("generic_name_fr")
        or product.get("generic_name")
    )
    if not code or not name:
        return None
    name = name.strip()
    # `brands` is a comma-separated string on /api/v2/product but a list on /search.
    # Refonte UX : on stocke la marque dans le champ dédié `brand` (au lieu
    # de la concaténer entre parenthèses dans le nom). L'UI affiche les deux
    # séparément — plus propre pour le tri / la recherche.
    brands = product.get("brands")
    first_brand: str | None = None
    if isinstance(brands, list) and brands:
        first_brand = str(brands[0]).strip() or None
    elif isinstance(brands, str) and brands.strip():
        first_brand = brands.split(",")[0].strip() or None

    nutr = product.get("nutriments") or {}

    # OFF exposes both 'energy-kcal_100g' and (older) 'energy_100g' (kJ).
    kcal = _f(nutr.get("energy-kcal_100g"))
    if kcal is None and nutr.get("energy_100g") is not None:
        # If only kJ is given, divide by 4.184.
        kj = _f(nutr.get("energy_100g"))
        if kj is not None:
            kcal = round(kj / 4.184, 1)

    return Ingredient(
        name=name,
        source=Source.OPENFOODFACTS,
        source_ref=str(code),
        brand=first_brand,
        kcal_per_100g=kcal,
        proteins_g=_f(nutr.get("proteins_100g")),
        carbs_g=_f(nutr.get("carbohydrates_100g")),
        sugars_g=_f(nutr.get("sugars_100g")),
        fats_g=_f(nutr.get("fat_100g")),
        saturated_fats_g=_f(nutr.get("saturated-fat_100g")),
        fiber_g=_f(nutr.get("fiber_100g")),
        salt_g=_f(nutr.get("salt_100g")),
    )


def lookup_barcode(ean: str, *, client: httpx.Client | None = None) -> Ingredient | None:
    """Fetch a single product by EAN. Returns None if not found.

    Caller is expected to persist the result (typically via IngredientRepo.upsert_by_source_ref).
    """
    ean = ean.strip()
    if not ean.isdigit():
        raise ValueError(f"barcode must be digits only, got {ean!r}")

    own_client = client is None
    client = client or _make_client()
    try:
        resp = client.get(f"/api/v2/product/{ean}", params={"fields": _PRODUCT_FIELDS})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as exc:
        raise OpenFoodFactsError(_friendly_http_error(exc)) from exc
    finally:
        if own_client:
            client.close()

    if data.get("status") != 1:  # OFF status: 1=found, 0=not found
        return None
    return _product_to_ingredient(data.get("product") or {})


# Mapping of internal sort codes to Search-a-licious `sort_by` values.
# Prefix '-' on the API side means descending order.
#
# IMPORTANT: Search-a-licious does NOT accept arbitrary nutriment fields as sort
# keys (it returns HTTP 400 with "must be a valid field name"). Only these are
# whitelisted server-side as of the API version we depend on:
#   - product_name (asc/desc)
#   - popularity_key, unique_scans_n, completeness, last_modified_t
# Sorting by macros server-side is therefore not possible. Codes mapped to None
# below cause us to send no `sort_by` (relevance ranking, the API default), and
# the import dialog surfaces a hint to the user.
_OFF_SORT_MAP: dict[str, str | None] = {
    "name_asc":  "product_name",
    "name_desc": "-product_name",
    # The macro sorts are intentionally None — we'd 400 if we sent them.
    "kcal_asc":      None,
    "kcal_desc":     None,
    "proteins_asc":  None,
    "proteins_desc": None,
    "carbs_asc":     None,
    "carbs_desc":    None,
    "fats_asc":      None,
    "fats_desc":     None,
}

# Sort codes that the API rejects — used by the dialog to display a hint.
OFF_UNSUPPORTED_SORTS = {
    code for code, mapped in _OFF_SORT_MAP.items() if mapped is None
}


def _build_lucene_query(text_query: str, filters: dict[str, float | str | None] | None) -> str:
    """Compose a Lucene-style query for Search-a-licious from a free-text search +
    optional numeric/category filters.

    Examples produced:
      - "tomate"
      - "tomate AND nutriments.proteins_100g:[10 TO *]"
      - "yaourt AND nutriments.proteins_100g:[5 TO 30] AND categories_tags:\"fr:yaourts\""
    """
    parts: list[str] = []
    if text_query.strip():
        parts.append(text_query.strip())

    f = filters or {}
    # Numeric ranges. Lucene range syntax: [lo TO hi], '*' is unbounded.
    range_specs = [
        ("nutriments.energy-kcal_100g", f.get("min_kcal"), f.get("max_kcal")),
        ("nutriments.proteins_100g",    f.get("min_proteins"), f.get("max_proteins")),
        ("nutriments.carbohydrates_100g", f.get("min_carbs"), f.get("max_carbs")),
        ("nutriments.fat_100g",         f.get("min_fats"), f.get("max_fats")),
    ]
    for field, lo, hi in range_specs:
        if lo is None and hi is None:
            continue
        lo_str = str(lo) if lo is not None else "*"
        hi_str = str(hi) if hi is not None else "*"
        parts.append(f"{field}:[{lo_str} TO {hi_str}]")

    cat = f.get("category_tag")
    if cat:
        # Lucene-quoted to allow ':' and other reserved chars inside the tag value.
        parts.append(f'categories_tags:"{cat}"')

    return " AND ".join(parts) if parts else "*:*"


def search_by_name(
    query: str,
    *,
    page: int = 1,
    page_size: int = 25,
    sort_by: str | None = None,
    filters: dict[str, float | str | None] | None = None,
    client: httpx.Client | None = None,
) -> tuple[list[Ingredient], int]:
    """Search OFF by product name via Search-a-licious.

    Returns `(matches, total_count)`. `total_count` is the API's `count` field
    (number of matching products across all pages) so the UI can build pagination.

    `sort_by` accepts the internal codes from `_OFF_SORT_MAP` (e.g. 'kcal_desc');
    None falls back to relevance-ranked default.
    `filters` mirrors `app.data.repositories.SearchFilters` as a plain dict.
    """
    q_text = query.strip()
    # Special case: empty text + no filters → nothing to search for, avoid hitting
    # the API with `*:*` which would page through the entire OFF dataset.
    if not q_text and not filters:
        return [], 0

    lucene_q = _build_lucene_query(q_text, filters)
    params: dict[str, object] = {
        "q": lucene_q,
        "page": max(1, page),
        "page_size": max(1, page_size),
        "fields": _PRODUCT_FIELDS,
        "langs": "fr,en",
    }
    if sort_by:
        mapped = _OFF_SORT_MAP.get(sort_by)
        if mapped:
            params["sort_by"] = mapped
        # If `mapped` is None, we silently fall back to relevance ranking —
        # the dialog shows a hint to the user when this happens.

    own_client = client is None
    client = client or _make_client(_SEARCH_BASE_URL)
    try:
        resp = client.get("/search", params=params)
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as exc:
        raise OpenFoodFactsError(_friendly_http_error(exc)) from exc
    finally:
        if own_client:
            client.close()

    out: list[Ingredient] = []
    for product in data.get("hits") or []:
        ing = _product_to_ingredient(product)
        if ing is not None:
            out.append(ing)
    total = int(data.get("count") or 0)
    return out, total
