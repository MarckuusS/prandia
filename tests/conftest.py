"""Shared pytest fixtures."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from app.data.db import init_schema, make_engine, make_session_factory
from app.ui.app_context import AppContext


# ============================================================ QSettings hermetic mode
#
# Les viewmodels utilisent `QSettings` pour persister les options de vue (tri,
# groupement, filtres). Sans isolation, les tests pollueraient le registre
# Windows / les fichiers de config utilisateur, ET les options sauvegardées par
# un test fuiteraient dans le test suivant. On redirige donc QSettings vers un
# tmp dir avant tout import de viewmodel et on le purge entre chaque test.
@pytest.fixture(autouse=True)
def _isolate_qsettings(tmp_path, monkeypatch) -> Iterator[None]:
    from PySide6.QtCore import QCoreApplication, QSettings

    # `QSettings()` lit les noms d'org/app depuis QCoreApplication ; on les
    # impose pour éviter une dépendance à l'ordre de création de QApplication.
    QCoreApplication.setOrganizationName("prandia-tests")
    QCoreApplication.setApplicationName("Prandia (tests)")
    # IniFormat + UserScope + path = fichier .ini dans tmp_path, jeté à la fin.
    QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, str(tmp_path))
    QSettings.setDefaultFormat(QSettings.Format.IniFormat)
    # Purge explicite en cas de leak depuis un précédent run (paranoïa).
    QSettings().clear()
    yield
    QSettings().clear()


@pytest.fixture
def db_session() -> Iterator[Session]:
    """A fresh SQLite in-memory DB with schema + FTS5 ready, per test."""
    engine = make_engine("sqlite:///:memory:")
    init_schema(engine)
    factory = make_session_factory(engine)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def app_ctx() -> Iterator[AppContext]:
    """Like `db_session` but wrapped in an AppContext — what the viewmodels
    expect as their entry point."""
    engine = make_engine("sqlite:///:memory:")
    init_schema(engine)
    factory = make_session_factory(engine)
    ctx = AppContext(engine, factory)
    try:
        yield ctx
    finally:
        ctx.shutdown()


# ============================================================ A4 — QML test fixtures


QML_DIR = Path(__file__).resolve().parent.parent / "app" / "ui" / "qml"


@pytest.fixture
def qml_engine(qtbot, app_ctx, monkeypatch):
    """A QQmlApplicationEngine with `Theme` registered as a singleton and the
    full set of viewmodels exposed as context properties — same wiring as
    `app/main.py`. Tests can call `qml_engine.load(...)` on a QML file and
    inspect `rootObjects()`.

    The viewmodels are bound to the `app_ctx` fixture (in-memory DB) so QML
    that calls slots actually exercises the data layer.
    """
    from PySide6.QtCore import QUrl
    from PySide6.QtQml import QQmlApplicationEngine, qmlRegisterSingletonType
    from PySide6.QtQuickControls2 import QQuickStyle

    from app.ui.viewmodels.backup_vm import BackupViewModel
    from app.ui.viewmodels.calendar_vm import CalendarViewModel
    from app.ui.viewmodels.category_vm import CategoryViewModel
    from app.ui.viewmodels.ingredient_vm import IngredientViewModel
    from app.ui.viewmodels.lidl_plus_vm import LidlPlusViewModel
    from app.ui.viewmodels.network_vm import NetworkStatusViewModel
    from app.ui.viewmodels.pantry_vm import PantryViewModel
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel
    from app.ui.viewmodels.recipe_url_import_vm import RecipeUrlImportViewModel
    from app.ui.viewmodels.recipe_vm import RecipeEditorViewModel, RecipeListViewModel
    from app.ui.viewmodels.shopping_vm import ShoppingViewModel
    from app.ui.viewmodels.tag_vm import TagListViewModel

    QQuickStyle.setStyle("Basic")
    engine = QQmlApplicationEngine()
    engine.addImportPath(str(QML_DIR))
    qmlRegisterSingletonType(
        QUrl.fromLocalFile(str(QML_DIR / "Theme.qml")), "App", 1, 0, "Theme",
    )

    vms = {
        "ingredientVM":     IngredientViewModel(app_ctx),
        "recipeListVM":     RecipeListViewModel(app_ctx),
        "recipeEditorVM":   RecipeEditorViewModel(app_ctx),
        "calendarVM":       CalendarViewModel(app_ctx),
        "shoppingVM":       ShoppingViewModel(app_ctx),
        "tagVM":            TagListViewModel(app_ctx),
        "backupVM":         BackupViewModel(),
        # Disable the periodic ping during tests — it spawns a daemon thread
        # that would race the in-memory DB lifecycle.
        "networkVM":        NetworkStatusViewModel(
            check_interval_ms=10 ** 9, initial_delay_ms=10 ** 9,
        ),
        "pantryVM":         PantryViewModel(app_ctx),
        "receiptImportVM": ReceiptImportViewModel(app_ctx),
        "recipeUrlImportVM": RecipeUrlImportViewModel(app_ctx),
        "lidlPlusVM":      LidlPlusViewModel(app_ctx),
        "categoryVM":      CategoryViewModel(app_ctx),
        "appCtx":            app_ctx,
        "logDirPath":        "",
    }
    for k, v in vms.items():
        engine.rootContext().setContextProperty(k, v)

    # Keep VMs alive : they were instantiated inside the fixture and would
    # otherwise be GC'd when the function returns. Stash them on the engine
    # so QML's references stay valid.
    engine._test_vms = vms  # type: ignore[attr-defined]

    yield engine

    engine.deleteLater()
