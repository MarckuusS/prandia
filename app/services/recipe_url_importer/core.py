"""Public API of the URL recipe importer.

`fetch_recipe(url)` is the single entry point. It implements the two-stage
strategy validated in the plan :

  1. **Primary** : recipe-scrapers (covers ~400 sites natively, parses
     Schema.org JSON-LD AND microdata, has site-specific quirks fixed).
  2. **Fallback** : our hand-rolled JSON-LD parser (catches WordPress +
     WP Recipe Maker blogs that recipe-scrapers doesn't enumerate but
     which expose perfectly valid JSON-LD).

Errors are mapped to `RecipeImportError` subclasses with French messages
the UI can display verbatim. The HTTP layer reuses the same conventions
as `app/services/openfoodfacts.py` (User-Agent, timeout, optional client
parameter for `httpx.MockTransport` testing).
"""

from __future__ import annotations

import logging

import httpx

from app.domain.url_recipe import ExtractedRecipe

from .jsonld_fallback import parse_jsonld_recipe
from .scrapers_adapter import try_recipe_scrapers

log = logging.getLogger(__name__)

_USER_AGENT = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
# Slightly more generous than OFF — recipe pages can be heavy (images,
# embedded ads). Connect kept short to fail fast on bad URLs.
_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


# ============================================================ Errors


class RecipeImportError(RuntimeError):
    """Base class for all import failures (network, parse, unsupported)."""


class UnsupportedSite(RecipeImportError):
    """The site is unknown to recipe-scrapers AND has no detectable JSON-LD."""


class NoRecipeFound(RecipeImportError):
    """Page fetched OK but contains no Schema.org Recipe."""


class ParseError(RecipeImportError):
    """Recipe data found but malformed (e.g. invalid JSON-LD)."""


class NetworkError(RecipeImportError):
    """HTTP / DNS / timeout error while fetching the page."""


def _friendly_http_error(exc: httpx.HTTPError) -> str:
    """Map raw httpx errors to a French user-facing message."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 404:
            return "Page introuvable (HTTP 404). Vérifie l'URL."
        if code in (401, 403):
            return (
                "Cette page nécessite une connexion ou un abonnement "
                f"(HTTP {code})."
            )
        if code in (502, 503, 504):
            return (
                f"Le serveur est temporairement indisponible (HTTP {code}). "
                "Réessaie dans quelques minutes."
            )
        if code == 429:
            return (
                "Trop de requêtes vers ce site (HTTP 429). "
                "Attends une minute avant de réessayer."
            )
        return f"Le serveur a renvoyé une erreur HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "Le serveur ne répond pas (timeout). Vérifie ta connexion."
    if isinstance(exc, httpx.ConnectError):
        return "Impossible de joindre ce site. Vérifie l'URL et ta connexion internet."
    return f"Erreur réseau : {exc}"


def _make_client() -> httpx.Client:
    return httpx.Client(
        timeout=_TIMEOUT,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "*/*;q=0.8"
            ),
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
        follow_redirects=True,
    )


# ============================================================ Public API


def fetch_recipe(url: str, *, client: httpx.Client | None = None) -> ExtractedRecipe:
    """Fetch and parse a recipe from `url`.

    Strategy :
      1. Fetch the HTML once via httpx.
      2. Try `try_recipe_scrapers(url, html)`. If non-None → return.
      3. Else fall back to `parse_jsonld_recipe(html, url)`. If non-None → return.
      4. Else raise `UnsupportedSite` (no native scraper AND no JSON-LD).

    Raises `NetworkError` on HTTP/DNS/timeout, `ParseError` on malformed
    page content, `NoRecipeFound` when the page parsed but has no Recipe,
    `UnsupportedSite` when neither path could extract anything.
    """
    if not url or not url.strip():
        raise NetworkError("URL vide.")
    url = url.strip()

    own_client = client is None
    client = client or _make_client()
    try:
        try:
            resp = client.get(url)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise NetworkError(_friendly_http_error(exc)) from exc

        html = resp.text or ""

        # 1) Try recipe-scrapers first (native scrapers are higher quality).
        # On lui laisse l'occasion de gérer même un HTML court — certains
        # scrapers chargent leurs données via une re-fetch interne.
        try:
            extracted = try_recipe_scrapers(url, html=html)
        except Exception as exc:  # noqa: BLE001 — adapter is tolerant but defensive
            log.warning("recipe-scrapers raised unexpectedly : %s", exc)
            extracted = None

        if extracted is not None and (extracted.name or extracted.ingredients):
            return extracted

        # 2) Si recipe-scrapers n'a rien donné, on regarde si la page a au
        # moins du contenu à parser. HTML vide = signal clair pour l'utilisateur.
        if not html or len(html) < 50:
            raise NoRecipeFound(
                "La page semble vide. Vérifie qu'elle s'affiche bien dans un navigateur."
            )

        # 3) Fallback : generic JSON-LD parser
        try:
            extracted = parse_jsonld_recipe(html, source_url=url)
        except Exception as exc:  # noqa: BLE001
            raise ParseError(
                "Les données de recette sur cette page sont mal formées."
            ) from exc

        if extracted is not None and (extracted.name or extracted.ingredients):
            return extracted

        raise UnsupportedSite(
            "Aucune recette trouvée sur cette page. Le site n'est pas supporté "
            "ou n'expose pas de données structurées (Schema.org)."
        )
    finally:
        if own_client:
            client.close()
