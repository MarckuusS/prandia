"""Client wrapper autour de la lib `lidl-plus` (Plan v3, Phase 5).

Sépare la logique métier (auth, fetch, refresh token) de l'implémentation
réelle de la lib `lidl-plus` — ce qui permet :

1. **Graceful degradation** : si la lib n'est pas installée (cas par défaut
   pour ne pas alourdir le bundle PyInstaller des phases 1-4), `is_available()`
   retourne False et le VM affiche "Feature non disponible — installer
   `lidl-plus` via pip".
2. **Sécurité** : le refresh token et le mot de passe ne touchent jamais la
   DB de l'app. Stockage exclusif via `keyring` (Windows Credential Manager
   sous Windows ; Keychain sur macOS ; libsecret/kwallet sous Linux).
3. **Testabilité** : les tests injectent un fake client qui renvoie des
   dicts JSON pré-calculés, sans hit réseau.

**ATTENTION — état Phase 5** : la lib `lidl-plus` (PyPI, communautaire) est
testée principalement pour Lidl DE/AT/UK. Le support Lidl FR n'est pas
garanti et peut nécessiter un patch upstream. Si l'auth échoue, on log avec
un message clair et on retombe sur la saisie manuelle (Phases 1-4 restent
fonctionnelles).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

log = logging.getLogger(__name__)

# Constantes pour le keyring : un service unique, deux clés (refresh_token + email).
# Le mot de passe n'est JAMAIS persisté — uniquement utilisé pour générer le
# refresh_token initial puis jeté.
_KEYRING_SERVICE = "prandia/lidl-plus"
_KEY_REFRESH_TOKEN = "refresh_token"
_KEY_EMAIL = "email"


class LidlPlusError(Exception):
    """Erreur métier remontée à l'utilisateur. Le message est affichable tel
    quel dans un toast (français, court, actionnable)."""


def is_available() -> bool:
    """True si la lib `lidl-plus` est installée et importable.

    On ne l'importe pas au top-level pour éviter de polluer le bundle quand
    elle n'est pas voulue — tester `is_available()` reste cheap (try/except
    sur l'import). Si la lib casse en runtime (changement d'API Lidl), cette
    fonction retournera quand même True ; c'est le `fetch_new_tickets` qui
    lèvera. C'est le comportement attendu — l'utilisateur sera averti via le
    `last_error` persisté.
    """
    try:
        import lidlplus  # noqa: F401
        return True
    except ImportError:
        return False


def is_keyring_available() -> bool:
    """True si `keyring` est installé. Conditionne le stockage sécurisé du
    refresh token. En cas d'absence, l'auto-fetch est désactivable (on refuse
    de stocker un secret en clair sur disque)."""
    try:
        import keyring  # noqa: F401
        return True
    except ImportError:
        return False


# ============================================================ Credentials


@dataclass
class StoredCreds:
    email: str | None
    has_refresh_token: bool


def store_credentials(email: str, refresh_token: str) -> None:
    """Persiste email + refresh_token dans le store OS sécurisé.

    Sur Windows : Windows Credential Manager. Sur macOS : Keychain. Sur Linux :
    libsecret ou kwallet selon le DE. Pas de fallback en clair — si keyring
    n'est pas disponible, lève `LidlPlusError`.
    """
    if not is_keyring_available():
        raise LidlPlusError(
            "Le module `keyring` n'est pas installé — refus de stocker les "
            "credentials en clair. Installer via `pip install keyring`.",
        )
    import keyring
    keyring.set_password(_KEYRING_SERVICE, _KEY_EMAIL, email)
    keyring.set_password(_KEYRING_SERVICE, _KEY_REFRESH_TOKEN, refresh_token)
    log.info("Lidl Plus credentials stored in OS credential manager.")


def get_stored_credentials() -> StoredCreds:
    """Lit l'état actuel sans révéler le refresh_token. Sert à l'UI pour
    afficher 'Connecté en tant que <email>' ou 'Non connecté'."""
    if not is_keyring_available():
        return StoredCreds(email=None, has_refresh_token=False)
    import keyring
    email = keyring.get_password(_KEYRING_SERVICE, _KEY_EMAIL)
    token = keyring.get_password(_KEYRING_SERVICE, _KEY_REFRESH_TOKEN)
    return StoredCreds(email=email, has_refresh_token=bool(token))


def purge_credentials() -> None:
    """Efface les credentials du store OS. Idempotent — safe à appeler même
    si rien n'est stocké."""
    if not is_keyring_available():
        return
    import keyring
    for key in (_KEY_EMAIL, _KEY_REFRESH_TOKEN):
        try:
            keyring.delete_password(_KEYRING_SERVICE, key)
        except Exception as exc:   # noqa: BLE001
            log.debug("Ignored keyring purge error (%s): %s", key, exc)


# ============================================================ Fetch (read tickets)


class _LidlClientProtocol(Protocol):
    """Contrat minimal qu'on attend de la lib `lidl-plus` (ou d'un fake test).
    On reste lâche : la lib réelle expose plus de méthodes."""

    def tickets(self) -> list[dict[str, Any]]:
        ...

    def ticket(self, ticket_id: str) -> dict[str, Any]:
        ...


def _build_real_client() -> _LidlClientProtocol:
    """Construit un client `lidl-plus` réel à partir du refresh_token stocké.
    Ne fait pas d'appel réseau dans cette fonction — l'objet client gère ça
    lui-même au premier `tickets()`.

    Lève `LidlPlusError` si la lib n'est pas dispo ou si pas de refresh_token.
    """
    if not is_available():
        raise LidlPlusError(
            "La lib `lidl-plus` n'est pas installée. "
            "Installer via `pip install lidl-plus`.",
        )
    creds = get_stored_credentials()
    if not creds.has_refresh_token:
        raise LidlPlusError(
            "Pas de connexion Lidl Plus enregistrée. "
            "Configure-la d'abord via le dialog de setup.",
        )
    import keyring
    refresh_token = keyring.get_password(_KEYRING_SERVICE, _KEY_REFRESH_TOKEN)

    # L'API exacte de la lib varie selon la version. On encapsule l'instanciation
    # pour pouvoir patcher dans les tests via `_inject_client_factory`.
    from lidlplus import LidlPlusApi   # type: ignore[import-not-found]
    return LidlPlusApi(refresh_token=refresh_token, language="fr", country="FR")


# Permet aux tests d'injecter un fake client.
_client_factory: callable = _build_real_client


def _inject_client_factory(factory) -> None:
    """Hook de test : remplace la factory de client par une fixture."""
    global _client_factory
    _client_factory = factory


def _reset_client_factory() -> None:
    """Restaure la factory réelle (à appeler en teardown de test)."""
    global _client_factory
    _client_factory = _build_real_client


def fetch_recent_tickets(limit: int = 10) -> list[dict[str, Any]]:
    """Récupère les `limit` derniers tickets connus côté Lidl.

    Pas de filtre `since` côté API (la lib renvoie toute la liste indexée par
    date) — c'est le caller qui doit filtrer en comparant les `id` à la table
    `imported_receipt` pour éviter les doublons.

    En cas d'erreur (auth expirée, API cassée, réseau down…) lève
    `LidlPlusError` avec un message en français. Le caller catch et persist
    en `last_error` côté settings.
    """
    try:
        client = _client_factory()
    except LidlPlusError:
        raise
    except Exception as exc:   # noqa: BLE001
        # Lib explose à l'instanciation : auth refusée, version cassée, etc.
        raise LidlPlusError(
            f"Connexion Lidl Plus impossible : {exc}. "
            f"Si l'API a changé, mets à jour la lib via "
            f"`pip install --upgrade lidl-plus`.",
        ) from exc

    try:
        tickets = client.tickets()
    except Exception as exc:   # noqa: BLE001
        raise LidlPlusError(
            f"Échec de récupération des tickets Lidl : {exc}",
        ) from exc

    # On garde les `limit` plus récents (la lib les renvoie typiquement triés
    # date desc, mais on ne se fie pas — re-tri par `date` desc côté Python).
    sorted_tickets = sorted(
        tickets, key=lambda t: t.get("date", ""), reverse=True,
    )
    return sorted_tickets[:limit]


def fetch_ticket_detail(ticket_id: str) -> dict[str, Any]:
    """Récupère le détail complet d'un ticket (items, prix, taxes…) à partir
    de son ID. C'est ce détail qu'on passe à `adapt_lidl_json` pour produire
    un `ParsedReceipt` complet."""
    try:
        client = _client_factory()
    except LidlPlusError:
        raise
    except Exception as exc:   # noqa: BLE001
        raise LidlPlusError(
            f"Connexion Lidl Plus impossible : {exc}",
        ) from exc

    try:
        return client.ticket(ticket_id)
    except Exception as exc:   # noqa: BLE001
        raise LidlPlusError(
            f"Échec de récupération du ticket {ticket_id} : {exc}",
        ) from exc


__all__ = [
    "LidlPlusError",
    "StoredCreds",
    "is_available",
    "is_keyring_available",
    "store_credentials",
    "get_stored_credentials",
    "purge_credentials",
    "fetch_recent_tickets",
    "fetch_ticket_detail",
    "_inject_client_factory",
    "_reset_client_factory",
]
