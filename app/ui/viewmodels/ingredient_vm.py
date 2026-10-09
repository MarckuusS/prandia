"""ViewModel for the ingredients library.

Phase 2 of QML migration: exposes a `QAbstractListModel` for the ListView,
plus typed @Slot wrappers callable from QML. The legacy Python-only methods
(`refresh()`, `get(id) -> Ingredient`, etc.) are kept for tests and scripts —
QML uses the slot variants which take/return primitive types or `QVariantMap`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from PySide6.QtCore import Property, QObject, QSettings, Signal, Slot
from PySide6.QtQml import QmlElement

from app.data.repositories import (
    IngredientRepo,
    PriceHistoryRepo,
    SearchFilters,
    SearchOptions,
)
from app.domain.models import Ingredient, PriceHistoryEntry, Source
from app.services import ingredient_search
from app.services.openfoodfacts import OpenFoodFactsError
from app.services.pricing_history_service import recompute_current_price
from app.ui.app_context import AppContext
from app.ui.models import IngredientListModel
from app.ui.models.ingredient_list_model import _compute_group_key

QML_IMPORT_NAME = "App.ViewModels"
QML_IMPORT_MAJOR_VERSION = 1

log = logging.getLogger(__name__)


def _ing_to_dict(ing: Ingredient | None) -> dict[str, Any]:
    """Convert an Ingredient to a dict QML can consume (no Decimal, no Pydantic)."""
    if ing is None:
        return {}
    # C3 : compute "in season this month" once on the Python side so QML doesn't
    # have to parse the CSV per ListView delegate refresh.
    months = _parse_season_months(ing.season_months)
    current_month = datetime.now().month
    in_season_now = current_month in months if months else False
    return {
        "id":                       ing.id,
        "name":                     ing.name,
        "source":                   ing.source.value,
        "sourceRef":                ing.source_ref,
        "brand":                    ing.brand or "",
        "cookedWeightPer100gRaw":   ing.cooked_weight_per_100g_raw,
        "kcal":                     ing.kcal_per_100g,
        "proteins":            ing.proteins_g,
        "carbs":               ing.carbs_g,
        "sugars":              ing.sugars_g,
        "fats":                ing.fats_g,
        "saturatedFats":       ing.saturated_fats_g,
        "fiber":               ing.fiber_g,
        "salt":                ing.salt_g,
        # Decimals are passed as strings (QML formats with toLocaleString as needed).
        "priceEur":            str(ing.price_eur) if ing.price_eur is not None else "",
        "priceQuantityG":      ing.price_quantity_g,
        "pieceWeightG":        ing.piece_weight_g,
        "inLibrary":           ing.in_personal_library,
        "categoryL1":          ing.category_l1,
        "categoryL2":          ing.category_l2,
        "seasonMonths":        ing.season_months or "",
        "hasSeasonality":      bool(months),
        "inSeasonNow":         in_season_now,
    }


def _is_in_season_now(ing: Ingredient) -> bool:
    """True ssi le mois courant est listé dans `ing.season_months` (CSV)."""
    if not ing.season_months:
        return False
    months = _parse_season_months(ing.season_months)
    return datetime.now().month in months


def _parse_season_months(csv: str | None) -> set[int]:
    """Parse a "6,7,8,9" CSV into a set of int months. Empty / None → empty set."""
    if not csv:
        return set()
    out: set[int] = set()
    for part in csv.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            m = int(part)
            if 1 <= m <= 12:
                out.add(m)
        except ValueError:
            continue
    return out


def _price_entry_to_dict(e: PriceHistoryEntry | None) -> dict[str, Any]:
    """Convert a PriceHistoryEntry to a dict QML can consume.
    `recordedAtIso` is ISO-8601 (round-trips trivially through Date.fromIsoString
    on QML side). Decimals are stringified ; `pricePer100g` is precomputed so the
    QML chart can plot directly without arithmetic."""
    if e is None:
        return {}
    return {
        "id":              e.id,
        "ingredientId":    e.ingredient_id,
        "priceEur":        str(e.price_eur),
        "quantityG":       e.quantity_g,
        "store":           e.store or "",
        "recordedAtIso":   e.recorded_at.isoformat(),
        "notes":           e.notes or "",
        "pricePer100g":    str(e.price_per_100g),
    }


def _dict_to_price_entry(d: dict[str, Any]) -> PriceHistoryEntry:
    """Build a PriceHistoryEntry from a QML-supplied dict. Permissive parsing
    of price (accepts French comma decimal) and date (ISO-8601 or `YYYY-MM-DD`)."""
    raw_price = d.get("priceEur")
    if isinstance(raw_price, str):
        raw_price = raw_price.strip().replace(",", ".")
    price = Decimal(str(raw_price))

    qty = float(d.get("quantityG") or 0)
    store_raw = d.get("store") or None
    store = store_raw.strip() if isinstance(store_raw, str) and store_raw.strip() else None

    raw_date = d.get("recordedAtIso") or ""
    if isinstance(raw_date, str):
        # Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS[.ffffff]"
        recorded = datetime.fromisoformat(raw_date.replace("Z", "+00:00").rstrip("Z"))
        if recorded.tzinfo is not None:
            recorded = recorded.replace(tzinfo=None)
    else:
        recorded = datetime.now()

    notes_raw = d.get("notes") or None
    notes = notes_raw.strip() if isinstance(notes_raw, str) and notes_raw.strip() else None

    return PriceHistoryEntry(
        id=d.get("id"),
        ingredient_id=int(d["ingredientId"]),
        price_eur=price,
        quantity_g=qty,
        store=store,
        recorded_at=recorded,
        notes=notes,
    )


def _dict_to_ing(d: dict[str, Any], existing: Ingredient | None = None) -> Ingredient:
    """Build an Ingredient from a QML-supplied dict. Preserves source/source_ref of an
    existing row (manuel/CIQUAL/OFF) — the form never edits these directly.

    Note: `price_eur` and `price_quantity_g` are auto-derived from the
    most recent entry in `ingredient_price_history` (see
    `services.pricing_history_service`). The form is read-only on those
    fields ; the dict still carries them only so that an existing record's
    price is preserved on save (we read from `existing` rather than `d`).
    A new ingredient with no history starts at NULL price."""
    source = existing.source if existing is not None else Source.MANUAL
    source_ref = existing.source_ref if existing is not None else d.get("sourceRef") or None

    # Price + price_quantity_g are derived from history — never sourced from
    # the form payload. We carry them through from `existing` when editing,
    # so saving an unrelated edit (e.g. renaming) doesn't blank the cached
    # price. New rows start NULL until the user records their first observation.
    price: Decimal | None = existing.price_eur if existing is not None else None
    price_qty: float | None = existing.price_quantity_g if existing is not None else None

    # Brand : prend la valeur du payload si présente (l'utilisateur peut
    # ajouter / éditer la marque manuellement) ; sinon préserve l'existant.
    if "brand" in d:
        brand = (d.get("brand") or "").strip() or None
    else:
        brand = existing.brand if existing is not None else None

    return Ingredient(
        id=d.get("id") or (existing.id if existing else None),
        name=d.get("name", "").strip(),
        source=source,
        source_ref=source_ref,
        brand=brand,
        kcal_per_100g=_or_none(d.get("kcal")),
        proteins_g=_or_none(d.get("proteins")),
        carbs_g=_or_none(d.get("carbs")),
        sugars_g=_or_none(d.get("sugars")),
        fats_g=_or_none(d.get("fats")),
        saturated_fats_g=_or_none(d.get("saturatedFats")),
        fiber_g=_or_none(d.get("fiber")),
        salt_g=_or_none(d.get("salt")),
        price_eur=price,
        price_quantity_g=price_qty,
        piece_weight_g=_or_none(d.get("pieceWeightG")),
        cooked_weight_per_100g_raw=_or_none(d.get("cookedWeightPer100gRaw")),
        in_personal_library=True,
        # Refonte UX (Phase F) : si la clé est PRÉSENTE dans le payload (même
        # à "" ou None), on prend cette valeur — l'utilisateur peut maintenant
        # éditer ces champs via le formulaire. Sinon (clé absente), on
        # préserve l'existant côté DB.
        category_l1=(d.get("categoryL1") if "categoryL1" in d
                     else (existing.category_l1 if existing else None)),
        category_l2=(d.get("categoryL2") if "categoryL2" in d
                     else (existing.category_l2 if existing else None)),
        season_months=(_normalize_season_csv(d.get("seasonMonths"))
                       if "seasonMonths" in d
                       else (existing.season_months if existing else None)),
    )


def _normalize_season_csv(raw: Any) -> str | None:
    """Phase F : normalise une saisie de mois CSV ("1,2,3" ou "" ou liste).
    Retourne None si rien de cochés (pas de saisonnalité = pas de badge).
    Trie + dédoublonne pour avoir une représentation canonique."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",") if p.strip()]
    elif isinstance(raw, (list, tuple)):
        parts = [str(p).strip() for p in raw if str(p).strip()]
    else:
        return None
    months: set[int] = set()
    for p in parts:
        try:
            n = int(p)
            if 1 <= n <= 12:
                months.add(n)
        except ValueError:
            continue
    if not months:
        return None
    return ",".join(str(n) for n in sorted(months))


def _or_none(v: Any) -> float | None:
    """0 / None / '' → None; otherwise return float(v)."""
    if v in (None, "", 0):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _pos_or_none(v: Any) -> float | None:
    """Like `_or_none` but accepts 0 — used for filter ranges where 0 is a
    legitimate "no constraint" sentinel. Negative values become None."""
    if v in (None, ""):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


@QmlElement
class IngredientViewModel(QObject):
    """Reads/writes against the DB through `AppContext.session()`. Holds an
    `IngredientListModel` for the ListView and exposes mutations as @Slot."""

    items_changed = Signal()
    error_emitted = Signal(str)
    deletion_pending_undo = Signal(str)  # label for the UndoToast
    # Emitted whenever an ingredient's reference price was auto-recomputed
    # from its price history (after add/delete in the price-history dialog).
    # The IngredientsPage form listens to this to refresh its read-only
    # price + quantity-of-reference display.
    current_price_recomputed = Signal(int)  # ingredient_id
    # B4 : `saveFromDict` was called to CREATE a new manual ingredient whose
    # name collides with an existing one (case-insensitive, same source).
    # The page reacts by showing a confirmation dialog with two actions :
    # "Éditer l'existant" (load `existing_id`) or "Annuler".
    name_collision_detected = Signal(int, str)  # existing_id, name

    # ---- Constantes des options de tri / groupement ----
    SORT_FIELDS = (
        "name_asc", "name_desc",
        "kcal_asc", "kcal_desc",
        "proteins_asc", "proteins_desc",
        "carbs_asc", "carbs_desc",
        "fats_asc", "fats_desc",
        "fiber_asc", "fiber_desc",
        "salt_asc", "salt_desc",
        "price_asc", "price_desc",
        "created_desc", "created_asc",
    )
    GROUP_FIELDS = ("none", "source", "rayon", "season", "kcal_range")

    # Préfixe QSettings pour persister les options de vue (tri / groupement /
    # filtres) entre sessions. QSettings utilise org=`prandia`,
    # app=`Prandia` (cf. `app/main.py`) → registre Windows ou ~/.config.
    _QS_PREFIX = "view_options/ingredients"
    _MACRO_NAMES = ("kcal", "proteins", "carbs", "fats", "fiber", "salt")

    def __init__(self, ctx: AppContext | None = None, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.ctx = ctx
        self._model = IngredientListModel(self)
        # Filtre texte (FTS). Vide = pas de filtre texte.
        self._filter: str = ""
        # Refonte UX — bibliothèque enrichie de filtres / tri / groupement
        # Sources : sous-ensemble de {"ciqual","openfoodfacts","manual"}.
        # Vide = toutes les sources affichées.
        self._filter_sources: set[str] = set()
        # Rayons : sous-ensemble des noms de category_l1. Vide = tous.
        self._filter_rayons: set[str] = set()
        # Toggles binaires — True signifie "n'afficher QUE ceux qui ont X".
        self._filter_in_season: bool = False
        self._filter_with_brand: bool = False
        self._filter_with_piece_weight: bool = False
        self._filter_with_price: bool = False
        # Plages min/max sur les macros par 100 g. 0 = pas de borne.
        self._filter_kcal_min: float = 0.0
        self._filter_kcal_max: float = 0.0
        self._filter_proteins_min: float = 0.0
        self._filter_proteins_max: float = 0.0
        self._filter_carbs_min: float = 0.0
        self._filter_carbs_max: float = 0.0
        self._filter_fats_min: float = 0.0
        self._filter_fats_max: float = 0.0
        self._filter_fiber_min: float = 0.0
        self._filter_fiber_max: float = 0.0
        self._filter_salt_min: float = 0.0
        self._filter_salt_max: float = 0.0
        # Tri : valeur dans SORT_FIELDS
        self._sort_by: str = "name_asc"
        # Groupement : valeur dans GROUP_FIELDS
        self._group_by: str = "none"
        # Buffer for U3 undo. Stores the just-deleted ingredient and whether the
        # deletion was hard (manual rows) or soft (CIQUAL/OFF flag flip), so
        # `undoLastDelete` knows which path to invert.
        self._last_deleted: Ingredient | None = None
        self._last_deleted_was_unflagged: bool = False
        # Charge les options de vue persistées AVANT le premier refresh, pour
        # que la liste s'affiche directement filtrée/triée/groupée comme à la
        # session précédente. Les setters ne sont pas appelés (pas de signal),
        # donc cette phase est silencieuse côté QML.
        self._load_view_options()
        # Toute modif ultérieure (via les @Slot setSortBy / setGroupBy / etc.)
        # émet `view_options_changed` → on persiste à ce moment-là.
        self.view_options_changed.connect(self._save_view_options)
        if ctx is not None:
            self.refresh()

    # ============================================================ QML-facing API

    @Property(QObject, constant=True)
    def items(self) -> IngredientListModel:
        """Exposed to QML as the ListView model. Constant property — the inner
        QAbstractListModel reuses its same instance and just resets its rows."""
        return self._model

    # Signal émis quand un filtre / tri / groupement change (le QML rebind
    # son état pour mettre à jour la barre de contrôles).
    view_options_changed = Signal()

    @Slot(str)
    def setFilter(self, query: str) -> None:  # noqa: N802 (Qt naming)
        self.set_filter(query)

    @Slot()
    def refreshList(self) -> None:  # noqa: N802
        self.refresh()

    # ============================================================ Slots filtres / tri / groupement

    @Slot(str)
    def setSortBy(self, field: str) -> None:  # noqa: N802
        if field in self.SORT_FIELDS and field != self._sort_by:
            self._sort_by = field
            self.view_options_changed.emit()
            self.refresh()

    @Slot(str)
    def setGroupBy(self, field: str) -> None:  # noqa: N802
        if field in self.GROUP_FIELDS and field != self._group_by:
            self._group_by = field
            # Propage la stratégie au model pour qu'il calcule `groupKey`
            # correctement sans nécessiter un reset.
            self._model.set_group_by(field)
            self.view_options_changed.emit()
            self.refresh()

    @Slot("QVariantList")
    def setFilterSources(self, sources: list) -> None:  # noqa: N802
        """Liste de sources (str) à afficher. Liste vide = toutes."""
        new_set = {str(s) for s in sources if str(s)}
        if new_set != self._filter_sources:
            self._filter_sources = new_set
            self.view_options_changed.emit()
            self.refresh()

    @Slot("QVariantList")
    def setFilterRayons(self, rayons: list) -> None:  # noqa: N802
        """Liste de rayons (str = category_l1) à afficher. Liste vide = tous."""
        new_set = {str(r) for r in rayons if str(r)}
        if new_set != self._filter_rayons:
            self._filter_rayons = new_set
            self.view_options_changed.emit()
            self.refresh()

    @Slot(bool)
    def setFilterInSeason(self, value: bool) -> None:  # noqa: N802
        if value != self._filter_in_season:
            self._filter_in_season = value
            self.view_options_changed.emit()
            self.refresh()

    @Slot(bool)
    def setFilterWithBrand(self, value: bool) -> None:  # noqa: N802
        if value != self._filter_with_brand:
            self._filter_with_brand = value
            self.view_options_changed.emit()
            self.refresh()

    @Slot(bool)
    def setFilterWithPieceWeight(self, value: bool) -> None:  # noqa: N802
        if value != self._filter_with_piece_weight:
            self._filter_with_piece_weight = value
            self.view_options_changed.emit()
            self.refresh()

    @Slot(bool)
    def setFilterWithPrice(self, value: bool) -> None:  # noqa: N802
        if value != self._filter_with_price:
            self._filter_with_price = value
            self.view_options_changed.emit()
            self.refresh()

    @Slot(str, float, float)
    def setMacroRange(self, macro: str, vmin: float, vmax: float) -> None:  # noqa: N802
        """Définit les bornes min/max d'une macro. 0 = pas de borne sur ce
        côté. `macro` ∈ {"kcal", "proteins", "carbs", "fats", "fiber", "salt"}."""
        attr_min = f"_filter_{macro}_min"
        attr_max = f"_filter_{macro}_max"
        if not hasattr(self, attr_min) or not hasattr(self, attr_max):
            return
        cur_min = getattr(self, attr_min)
        cur_max = getattr(self, attr_max)
        if cur_min == vmin and cur_max == vmax:
            return
        setattr(self, attr_min, max(0.0, float(vmin)))
        setattr(self, attr_max, max(0.0, float(vmax)))
        self.view_options_changed.emit()
        self.refresh()

    @Slot()
    def resetFilters(self) -> None:  # noqa: N802
        """Remet tous les filtres à zéro (sauf le tri et le groupement)."""
        self._filter_sources = set()
        self._filter_rayons = set()
        self._filter_in_season = False
        self._filter_with_brand = False
        self._filter_with_piece_weight = False
        self._filter_with_price = False
        for macro in ("kcal", "proteins", "carbs", "fats", "fiber", "salt"):
            setattr(self, f"_filter_{macro}_min", 0.0)
            setattr(self, f"_filter_{macro}_max", 0.0)
        self.view_options_changed.emit()
        self.refresh()

    # ============================================================ Properties (lecture)

    @Property(str, notify=view_options_changed)
    def sortBy(self) -> str:  # noqa: N802
        return self._sort_by

    @Property(str, notify=view_options_changed)
    def groupBy(self) -> str:  # noqa: N802
        return self._group_by

    @Property("QVariantList", notify=view_options_changed)
    def filterSources(self) -> list[str]:  # noqa: N802
        return sorted(self._filter_sources)

    @Property("QVariantList", notify=view_options_changed)
    def filterRayons(self) -> list[str]:  # noqa: N802
        return sorted(self._filter_rayons)

    @Property(bool, notify=view_options_changed)
    def filterInSeason(self) -> bool:  # noqa: N802
        return self._filter_in_season

    @Property(bool, notify=view_options_changed)
    def filterWithBrand(self) -> bool:  # noqa: N802
        return self._filter_with_brand

    @Property(bool, notify=view_options_changed)
    def filterWithPieceWeight(self) -> bool:  # noqa: N802
        return self._filter_with_piece_weight

    @Property(bool, notify=view_options_changed)
    def filterWithPrice(self) -> bool:  # noqa: N802
        return self._filter_with_price

    @Slot(str, result="QVariantMap")
    def macroRange(self, macro: str) -> dict:  # noqa: N802
        """Renvoie {min, max} pour une macro. 0 = pas de borne."""
        attr_min = f"_filter_{macro}_min"
        attr_max = f"_filter_{macro}_max"
        return {
            "min": getattr(self, attr_min, 0.0),
            "max": getattr(self, attr_max, 0.0),
        }

    @Property(int, notify=view_options_changed)
    def activeFilterCount(self) -> int:  # noqa: N802
        """Nombre de filtres actuellement actifs (utilisé pour le badge dans
        la barre de contrôles)."""
        n = 0
        if self._filter_sources:           n += 1
        if self._filter_rayons:            n += 1
        if self._filter_in_season:         n += 1
        if self._filter_with_brand:        n += 1
        if self._filter_with_piece_weight: n += 1
        if self._filter_with_price:        n += 1
        for macro in ("kcal", "proteins", "carbs", "fats", "fiber", "salt"):
            if getattr(self, f"_filter_{macro}_min") > 0 or getattr(self, f"_filter_{macro}_max") > 0:
                n += 1
        return n

    @Slot(int, result="QVariantMap")
    def getAsDict(self, ingredient_id: int) -> dict[str, Any]:  # noqa: N802
        return _ing_to_dict(self.get(ingredient_id))

    @Slot("QVariantMap", result="QVariantMap")
    def saveFromDict(self, payload: dict[str, Any]) -> dict[str, Any]:  # noqa: N802
        existing: Ingredient | None = None
        ing_id = payload.get("id")
        if ing_id is not None:
            existing = self.get(int(ing_id))
        try:
            ing = _dict_to_ing(payload, existing=existing)
        except Exception as exc:  # validation Pydantic
            self.error_emitted.emit(str(exc))
            return {}
        if not ing.name:
            self.error_emitted.emit("Le nom de l'ingrédient est obligatoire.")
            return {}
        # B4 : on CREATE only (no `existing`), block & signal if a manual
        # ingredient with the same name already exists. The page can then
        # offer "Éditer l'existant" or "Annuler". Skip the check on UPDATE
        # (renaming an existing entry to itself would otherwise self-trigger).
        if existing is None and self.ctx is not None:
            with self.ctx.session() as s:
                duplicate = IngredientRepo(s).find_by_name(ing.name, Source.MANUAL)
            if duplicate is not None and duplicate.id is not None:
                self.name_collision_detected.emit(duplicate.id, ing.name)
                return {}
        saved = self.save(ing)
        return _ing_to_dict(saved)

    @Slot(int)
    def deleteIngredient(self, ingredient_id: int) -> None:  # noqa: N802
        self.delete(ingredient_id)

    @Slot(int, result="QVariantMap")
    def importExisting(self, ingredient_id: int) -> dict[str, Any]:  # noqa: N802
        return _ing_to_dict(self.import_existing(ingredient_id))

    @Slot("QVariantList", result=int)
    def importMany(self, ingredient_ids: list) -> int:  # noqa: N802
        """B1 : flip `in_personal_library = True` on N ingredients in a single
        session. Returns the number of rows actually flipped (some may have
        been deleted between selection and submit, or already imported).

        QML calls this from the import dialog footer after the user has ticked
        multiple results. The VM refreshes its list once at the end (single
        `set_items` reset) so the Ingredients tab updates in one frame."""
        if self.ctx is None:
            return 0
        ids = [int(i) for i in ingredient_ids if i]
        if not ids:
            return 0
        promoted = 0
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            for ing_id in ids:
                row = repo.mark_in_personal_library(ing_id, value=True)
                if row is not None:
                    promoted += 1
            s.commit()
        if promoted:
            self.refresh()
        return promoted

    @Slot(str, result=int)
    def fetchOnline(self, query: str) -> int:  # noqa: N802
        """Returns the number of cached results so QML can show feedback."""
        cached = self.fetch_online(query)
        return len(cached)

    @Slot(str, str, int, result="QVariantList")
    def searchOnce(self, query: str, scope: str = "personal", limit: int = 25) -> list[dict]:  # noqa: N802
        """One-shot search returning a list of dicts. Used by autocomplete popups
        (IngredientSearch widget) without disturbing the main filtered list."""
        if self.ctx is None or not query.strip():
            return []
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            results = repo.search_fts(query, limit=limit, scope=scope)
        return [_ing_to_dict(r) for r in results]

    @Slot(str, str, int, result="QVariantList")
    def searchBySource(self, query: str, source: str, limit: int = 50) -> list[dict]:  # noqa: N802
        """Search restricted to a specific source catalog (CIQUAL or OFF). Used by
        the Import dialog tabs."""
        if self.ctx is None or not query.strip():
            return []
        try:
            src_enum = Source(source)
        except ValueError:
            return []
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            results = repo.search_fts(query, limit=limit, scope="all", source=src_enum)
        return [_ing_to_dict(r) for r in results]

    @Slot(str, int, result="QVariantList")
    def fetchOnlineAndList(self, query: str, limit: int = 30) -> list[dict]:  # noqa: N802
        """Hit OpenFoodFacts, cache results locally, return them as dicts.
        Combines `fetch_online` (HTTP+cache) with a dict-conversion convenient
        for the OFF tab of the Import dialog."""
        cached = self.fetch_online(query)
        return [_ing_to_dict(c) for c in cached[:limit]]

    @Slot(str, result="QVariantMap")
    def lookupBarcodeAsDict(self, ean: str) -> dict[str, Any]:  # noqa: N802
        """Plan v3 Phase 4 — lookup OFF par EAN pour pré-remplir le mini-form
        de création d'ingrédient depuis le dialog d'import de ticket.

        Retourne un dict (vide si pas trouvé / pas en ligne / EAN invalide).
        Ne touche pas la DB locale — c'est juste une lecture indicative que le
        QML projette dans les champs (nom, kcal, catégorie…). L'utilisateur
        peut tout garder ou tout effacer avant de valider."""
        from app.services.openfoodfacts import lookup_barcode

        ean = (ean or "").strip()
        if not ean or not ean.isdigit() or len(ean) < 8:
            return {}
        try:
            ing = lookup_barcode(ean)
        except OpenFoodFactsError as exc:
            log.warning("EAN lookup failed for %s: %s", ean, exc)
            self.error_emitted.emit(str(exc))
            return {}
        if ing is None:
            return {}
        return _ing_to_dict(ing)

    @Slot("QVariantMap", result="QVariantMap")
    def searchCatalogPaged(self, opts_qml: dict) -> dict:  # noqa: N802
        """Rich search for the Import dialog : filters + sort + pagination.

        QML supplies a dict with keys (all optional except `source`):
          - source: 'ciqual' | 'openfoodfacts'
          - query: str
          - categoryL1: str | ""
          - minKcal/maxKcal/minProteins/maxProteins/minCarbs/maxCarbs/minFats/maxFats: float
              (0 or undefined = no constraint)
          - sortBy: 'rank' | 'name' | 'kcal' | 'proteins' | 'carbs' | 'fats'
          - sortDesc: bool
          - page: int (1-indexed)
          - pageSize: int (default 25)

        Returns:
          {matches: [dict, ...], totalCount: int, page: int, pageSize: int, pageCount: int}
        """
        if self.ctx is None:
            return {"matches": [], "totalCount": 0, "page": 1, "pageSize": 25, "pageCount": 1}

        try:
            source_enum = Source(opts_qml.get("source", "ciqual"))
        except ValueError:
            source_enum = Source.CIQUAL

        filters = SearchFilters(
            min_kcal=_pos_or_none(opts_qml.get("minKcal")),
            max_kcal=_pos_or_none(opts_qml.get("maxKcal")),
            min_proteins=_pos_or_none(opts_qml.get("minProteins")),
            max_proteins=_pos_or_none(opts_qml.get("maxProteins")),
            min_carbs=_pos_or_none(opts_qml.get("minCarbs")),
            max_carbs=_pos_or_none(opts_qml.get("maxCarbs")),
            min_fats=_pos_or_none(opts_qml.get("minFats")),
            max_fats=_pos_or_none(opts_qml.get("maxFats")),
            category_l1=(opts_qml.get("categoryL1") or None) or None,
        )

        opts = SearchOptions(
            query=opts_qml.get("query", "") or "",
            scope="all",
            source=source_enum,
            filters=filters,
            sort_by=opts_qml.get("sortBy", "rank") or "rank",
            sort_desc=bool(opts_qml.get("sortDesc", False)),
            page=int(opts_qml.get("page", 1) or 1),
            page_size=int(opts_qml.get("pageSize", 25) or 25),
        )

        with self.ctx.session() as s:
            page = IngredientRepo(s).search_fts(opts=opts)

        # `search_fts` with `opts` returns SearchPage (dataclass), not list.
        return {
            "matches":    [_ing_to_dict(m) for m in page.matches],
            "totalCount": page.total_count,
            "page":       page.page,
            "pageSize":   page.page_size,
            "pageCount":  page.page_count,
        }

    # ============================================================ Price history (per-ingredient)
    # The "📊" button next to the price field on IngredientsPage opens
    # PriceHistoryDialog which calls these slots. The dialog keeps its own
    # local state (the list of dicts) — we don't expose a QAbstractListModel
    # for the history to keep the surface minimal.

    @Slot(int, result="QVariantList")
    def priceHistoryFor(self, ingredient_id: int) -> list[dict[str, Any]]:  # noqa: N802
        """Return the full chronological list of recorded prices for one
        ingredient. Empty list when the ingredient has no history yet
        (or the id is invalid). Each dict carries `pricePer100g` already
        computed so QML can plot the line chart without arithmetic."""
        if self.ctx is None or ingredient_id <= 0:
            return []
        with self.ctx.session() as s:
            entries = PriceHistoryRepo(s).list_for_ingredient(ingredient_id)
        return [_price_entry_to_dict(e) for e in entries]

    @Slot("QVariantMap", result="QVariantMap")
    def addPriceHistory(self, payload: dict[str, Any]) -> dict[str, Any]:  # noqa: N802
        """Append a price observation and auto-update the ingredient's
        reference price (`price_eur` + `price_quantity_g`) from the most
        recent history entry. `payload` keys :
        `ingredientId` (int, required), `priceEur` (str/float, > 0),
        `quantityG` (float, > 0), `store` (str | None), `recordedAtIso`
        (ISO-8601 datetime str), `notes` (str | None).

        Returns the saved entry as a dict, or `{}` on validation error.
        Emits `current_price_recomputed(ingredient_id)` after the add so
        the IngredientsPage form can refresh its read-only price display."""
        try:
            entry = _dict_to_price_entry(payload)
        except Exception as exc:  # pydantic.ValidationError or parsing
            log.warning("addPriceHistory: invalid payload %r: %s", payload, exc)
            self.error_emitted.emit(str(exc))
            return {}
        if self.ctx is None:
            return {}
        with self.ctx.session() as s:
            saved = PriceHistoryRepo(s).add(entry)
            recompute_current_price(s, entry.ingredient_id)
            s.commit()
        # Refresh list so the card on the left re-renders with the new price,
        # then notify the form so the read-only price cell updates in place.
        self.refresh()
        self.current_price_recomputed.emit(entry.ingredient_id)
        return _price_entry_to_dict(saved)

    @Slot(int, result=bool)
    def deletePriceHistory(self, entry_id: int) -> bool:  # noqa: N802
        """Remove one observation and auto-recompute the ingredient's
        reference price from the remaining history (or clear it to NULL
        if no history is left). Returns True on success."""
        if self.ctx is None or entry_id <= 0:
            return False
        with self.ctx.session() as s:
            entry = PriceHistoryRepo(s).get(entry_id)
            ingredient_id = entry.ingredient_id if entry else None
            ok = PriceHistoryRepo(s).delete(entry_id)
            if ok and ingredient_id is not None:
                recompute_current_price(s, ingredient_id)
                s.commit()
        if ok and ingredient_id is not None:
            self.refresh()
            self.current_price_recomputed.emit(ingredient_id)
        return ok

    @Slot(result="QVariantList")
    def knownStores(self) -> list[str]:  # noqa: N802
        """Distinct store names from existing history. Powers the autocomplete
        of the store combobox in the price-history dialog."""
        if self.ctx is None:
            return []
        with self.ctx.session() as s:
            return PriceHistoryRepo(s).list_known_stores()

    @Slot(str, result="QVariantList")
    def categoriesL1(self, source: str) -> list[str]:  # noqa: N802
        """List of distinct CIQUAL category-L1 names for the given source.
        Used to populate the filter dropdown of the Import dialog."""
        if self.ctx is None:
            return []
        try:
            src = Source(source)
        except ValueError:
            return []
        with self.ctx.session() as s:
            return IngredientRepo(s).list_categories_l1(source=src)

    # ============================================================ Python-side API
    # (Kept for scripts and future tests. The QML side goes through @Slot wrappers.)

    @property
    def filter(self) -> str:  # noqa: A003
        return self._filter

    def set_filter(self, query: str) -> None:
        self._filter = query.strip()
        self.refresh()

    def refresh(self) -> None:
        if self.ctx is None:
            return
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            if self._filter:
                items = repo.search_fts(self._filter, limit=500, scope="personal")
            else:
                items = repo.list_personal(limit=2000)

        # Application des filtres custom (Python-side — la liste est petite,
        # généralement < 200 ingrédients perso).
        items = [ing for ing in items if self._matches_filters(ing)]
        # Tri primaire selon le choix utilisateur (nom, kcal, etc.).
        items = self._apply_sort(items)
        # Quand un groupement est actif, on regroupe physiquement les items
        # par groupKey via un tri stable secondaire — sans ça, "Fruits et
        # légumes" peut apparaître plusieurs fois dans la liste car la
        # ListView affiche un section header chaque fois que la valeur
        # change entre deux rows consécutives. Le tri stable préserve
        # l'ordre primaire (nom A→Z, etc.) à l'intérieur de chaque groupe.
        if self._group_by != "none":
            items = sorted(items, key=lambda i: _compute_group_key(i, self._group_by))

        self._model.set_items(items)
        self.items_changed.emit()
        # Le signal view_options_changed sert au QML (badge actifs etc.)
        self.view_options_changed.emit()

    # ============================================================ Filtres (interne)

    def _matches_filters(self, ing: Ingredient) -> bool:
        """Vrai si l'ingrédient passe tous les filtres actifs."""
        # Source
        if self._filter_sources and ing.source.value not in self._filter_sources:
            return False
        # Rayon (category_l1)
        if self._filter_rayons and (ing.category_l1 or "") not in self._filter_rayons:
            return False
        # En saison aujourd'hui
        if self._filter_in_season and not _is_in_season_now(ing):
            return False
        # Avec marque
        if self._filter_with_brand and not (ing.brand and ing.brand.strip()):
            return False
        # Avec poids unitaire
        if self._filter_with_piece_weight and not (ing.piece_weight_g and ing.piece_weight_g > 0):
            return False
        # Avec prix
        if self._filter_with_price and not (ing.price_eur and ing.price_eur > 0):
            return False
        # Plages macros
        macro_attrs = (
            ("kcal",     ing.kcal_per_100g),
            ("proteins", ing.proteins_g),
            ("carbs",    ing.carbs_g),
            ("fats",     ing.fats_g),
            ("fiber",    ing.fiber_g),
            ("salt",     ing.salt_g),
        )
        for name, value in macro_attrs:
            vmin = getattr(self, f"_filter_{name}_min")
            vmax = getattr(self, f"_filter_{name}_max")
            if vmin > 0 or vmax > 0:
                if value is None:
                    return False  # filtre actif → exclure les valeurs inconnues
                if vmin > 0 and value < vmin:
                    return False
                if vmax > 0 and value > vmax:
                    return False
        return True

    # ============================================================ Persistance QSettings

    def _load_view_options(self) -> None:
        """Restaure tri / groupement / filtres depuis QSettings. Les valeurs
        invalides (ex : un sort_by retiré entre 2 versions) sont silencieusement
        ignorées et le défaut s'applique."""
        s = QSettings()
        sort_val = str(s.value(f"{self._QS_PREFIX}/sort_by", "name_asc"))
        if sort_val in self.SORT_FIELDS:
            self._sort_by = sort_val
        group_val = str(s.value(f"{self._QS_PREFIX}/group_by", "none"))
        if group_val in self.GROUP_FIELDS:
            self._group_by = group_val
            self._model.set_group_by(group_val)

        def _read_str_list(key: str) -> set[str]:
            raw = s.value(f"{self._QS_PREFIX}/{key}", "")
            # QSettings peut renvoyer str OU QStringList selon la plateforme ;
            # on normalise en `set[str]` via une convention CSV en écriture.
            if isinstance(raw, list):
                return {str(x) for x in raw if str(x)}
            txt = str(raw or "")
            return {p for p in (s.strip() for s in txt.split(",")) if p}

        def _read_bool(key: str) -> bool:
            v = s.value(f"{self._QS_PREFIX}/{key}", False)
            # QSettings renvoie souvent "true"/"false" en str sur registre Windows.
            if isinstance(v, bool):
                return v
            return str(v).lower() in ("true", "1", "yes")

        def _read_float(key: str) -> float:
            try:
                return float(s.value(f"{self._QS_PREFIX}/{key}", 0.0) or 0.0)
            except (ValueError, TypeError):
                return 0.0

        self._filter_sources = _read_str_list("filter_sources")
        self._filter_rayons = _read_str_list("filter_rayons")
        self._filter_in_season = _read_bool("filter_in_season")
        self._filter_with_brand = _read_bool("filter_with_brand")
        self._filter_with_piece_weight = _read_bool("filter_with_piece_weight")
        self._filter_with_price = _read_bool("filter_with_price")
        for macro in self._MACRO_NAMES:
            setattr(self, f"_filter_{macro}_min", _read_float(f"filter_{macro}_min"))
            setattr(self, f"_filter_{macro}_max", _read_float(f"filter_{macro}_max"))

    def _save_view_options(self) -> None:
        """Persiste tri / groupement / filtres dans QSettings. Connecté au
        signal `view_options_changed` — appelé à chaque modif utilisateur."""
        s = QSettings()
        s.setValue(f"{self._QS_PREFIX}/sort_by", self._sort_by)
        s.setValue(f"{self._QS_PREFIX}/group_by", self._group_by)
        # CSV : portable Windows registry / Linux ini / macOS plist sans souci
        # de typage QStringList vs str.
        s.setValue(f"{self._QS_PREFIX}/filter_sources", ",".join(sorted(self._filter_sources)))
        s.setValue(f"{self._QS_PREFIX}/filter_rayons", ",".join(sorted(self._filter_rayons)))
        s.setValue(f"{self._QS_PREFIX}/filter_in_season", self._filter_in_season)
        s.setValue(f"{self._QS_PREFIX}/filter_with_brand", self._filter_with_brand)
        s.setValue(f"{self._QS_PREFIX}/filter_with_piece_weight", self._filter_with_piece_weight)
        s.setValue(f"{self._QS_PREFIX}/filter_with_price", self._filter_with_price)
        for macro in self._MACRO_NAMES:
            s.setValue(f"{self._QS_PREFIX}/filter_{macro}_min", getattr(self, f"_filter_{macro}_min"))
            s.setValue(f"{self._QS_PREFIX}/filter_{macro}_max", getattr(self, f"_filter_{macro}_max"))

    def _apply_sort(self, items: list[Ingredient]) -> list[Ingredient]:
        """Tri Python-side selon `_sort_by`. Les valeurs None remontent à la
        fin pour les tris croissants, et au début pour les décroissants."""
        sort = self._sort_by

        def _macro_key(getter):
            def keyfn(i: Ingredient):
                v = getter(i)
                # None → +∞ pour le tri croissant (None last)
                return (1, 0) if v is None else (0, v)
            return keyfn

        def _macro_key_desc(getter):
            def keyfn(i: Ingredient):
                v = getter(i)
                return (1, 0) if v is None else (0, -v)
            return keyfn

        if sort == "name_asc":
            return sorted(items, key=lambda i: i.name.casefold())
        if sort == "name_desc":
            return sorted(items, key=lambda i: i.name.casefold(), reverse=True)
        # Macros — chaque (asc/desc)
        for macro, getter in (
            ("kcal",     lambda i: i.kcal_per_100g),
            ("proteins", lambda i: i.proteins_g),
            ("carbs",    lambda i: i.carbs_g),
            ("fats",     lambda i: i.fats_g),
            ("fiber",    lambda i: i.fiber_g),
            ("salt",     lambda i: i.salt_g),
        ):
            if sort == f"{macro}_asc":
                return sorted(items, key=_macro_key(getter))
            if sort == f"{macro}_desc":
                return sorted(items, key=_macro_key_desc(getter))
        # Prix
        if sort == "price_asc":
            return sorted(items, key=lambda i: (1, 0) if i.price_eur is None
                                                else (0, float(i.price_eur)))
        if sort == "price_desc":
            return sorted(items, key=lambda i: (1, 0) if i.price_eur is None
                                                else (0, -float(i.price_eur)))
        # Date
        if sort == "created_desc":
            return sorted(items, key=lambda i: i.created_at or datetime.min, reverse=True)
        if sort == "created_asc":
            return sorted(items, key=lambda i: i.created_at or datetime.min)
        return items

    def get(self, ingredient_id: int) -> Ingredient | None:
        if self.ctx is None:
            return None
        with self.ctx.session() as s:
            return IngredientRepo(s).get(ingredient_id)

    def save(self, ing: Ingredient) -> Ingredient:
        ing = ing.model_copy(update={"in_personal_library": True})
        is_update = ing.id is not None
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            saved = repo.update(ing) if is_update else repo.create(ing)
        # Refonte UX : pour un update d'ingrédient existant, on émet
        # dataChanged sur la row concernée au lieu d'un reset complet
        # (`refresh()`). Sans ça, la ListView clignote / scintille à chaque
        # save (beginResetModel vide la vue puis la repeuple). L'update
        # partiel garde les delegates en place et la position de scroll.
        # Pour une création (id était None avant), on doit refresh complet
        # car la liste s'agrandit.
        if is_update and self._model.update_one(saved):
            # Notify l'extérieur que les données ont changé sans signaler
            # items_changed (qui peut déclencher d'autres reload coûteux)
            return saved
        self.refresh()
        return saved

    def delete(self, ingredient_id: int) -> None:
        if self.ctx is None:
            return
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            ing = repo.get(ingredient_id)
            if ing is None:
                return
            # Snapshot before mutation — fuels the undo buffer (U3).
            self._last_deleted = ing
            self._last_deleted_was_unflagged = ing.source.value != "manual"
            if ing.source.value == "manual":
                repo.delete(ingredient_id)
            else:
                repo.mark_in_personal_library(ingredient_id, False)
        self.refresh()
        self.deletion_pending_undo.emit(f"« {ing.name} » retiré")

    @Slot()
    def undoLastDelete(self) -> None:  # noqa: N802
        """Restore the last deleted ingredient. Re-flags for CIQUAL/OFF (same id);
        re-creates the row for manual sources (NEW id — the original is gone).
        Idempotent — calling without a buffered delete is a no-op."""
        if self.ctx is None or self._last_deleted is None:
            return
        ing = self._last_deleted
        with self.ctx.session() as s:
            repo = IngredientRepo(s)
            if self._last_deleted_was_unflagged and ing.id is not None:
                repo.mark_in_personal_library(ing.id, True)
            else:
                # Hard-deleted manual: re-create with a fresh id.
                clean = ing.model_copy(update={"id": None, "in_personal_library": True})
                repo.create(clean)
        self._last_deleted = None
        self.refresh()

    def import_existing(self, ingredient_id: int) -> Ingredient | None:
        if self.ctx is None:
            return None
        with self.ctx.session() as s:
            saved = IngredientRepo(s).mark_in_personal_library(ingredient_id, True)
        if saved is not None:
            self.refresh()
        return saved

    def fetch_online(self, query: str) -> list[Ingredient]:
        if self.ctx is None:
            return []
        try:
            with self.ctx.session() as s:
                cached, _total = ingredient_search.fetch_from_openfoodfacts_and_cache(
                    s, query, add_to_personal_library=False
                )
        except OpenFoodFactsError as exc:
            self.error_emitted.emit(str(exc))
            return []
        return cached
