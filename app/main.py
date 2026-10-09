"""Entry point: bootstraps the app context (DB + schema), launches QML."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtQml import QQmlApplicationEngine, qmlRegisterSingletonType
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWidgets import QApplication

from app.data.db import backup_on_startup
from app.logging_setup import default_log_dir, install_excepthook, setup_logging
from app.services.receipt_watcher import ReceiptWatcher, ensure_receipt_dir
from app.ui.app_context import AppContext
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


def _resolve_qml_dir() -> Path:
    """Locate the QML root, supporting both source and PyInstaller-bundled runs.

    - From source : `<repo>/app/ui/qml/` — `__file__` is `app/main.py`.
    - Bundled (PyInstaller) : `sys._MEIPASS/app/ui/qml/` — the spec copies the
      QML tree under `app/ui/qml/` of the bundle. `_MEIPASS` points to the
      bundle root (the `_internal/` folder in `--onedir` mode).
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "app" / "ui" / "qml"  # type: ignore[attr-defined]
    return Path(__file__).parent / "ui" / "qml"


_QML_DIR = _resolve_qml_dir()


def main() -> int:
    # Logging FIRST — so any subsequent error during bootstrap is captured.
    setup_logging()
    install_excepthook()
    logging.getLogger(__name__).info("Application starting (frozen=%s)", getattr(sys, "frozen", False))

    qt_app = QApplication(sys.argv)
    qt_app.setApplicationName("Prandia")
    qt_app.setOrganizationName("prandia")

    # On Windows the default Qt Quick Controls style is FluentWinUI3, which is a
    # native style — it forbids overriding `background`, `indicator`, `contentItem`
    # on Buttons/ComboBoxes/etc. We force `Basic` so our Theme-driven custom paint
    # actually takes effect.
    QQuickStyle.setStyle("Basic")

    # Snapshot the DB before opening it. Failure here is non-fatal — the app must
    # launch even if the backup folder is unwritable. See `app/data/db.py` for
    # the rotation policy (7 daily + ~6 monthly, ~13 files max).
    backup_on_startup()

    # Plan v3 Phase 2 : prépare le sous-dossier de tickets (idempotent — créé
    # s'il n'existe pas, no-op sinon). Le watcher démarrera après l'init du VM.
    ensure_receipt_dir()

    ctx = AppContext.from_default()

    engine = QQmlApplicationEngine()
    engine.addImportPath(str(_QML_DIR))

    # Register Theme as a real QML singleton via its file URL. Singletons are
    # accessible from any QML scope (MenuBar, Popups, Dialogs…), unlike context
    # properties which don't propagate to all sub-trees. Module URI is "App",
    # used in QML as `import App` then `App.Theme.colorPrimary` — but since
    # singleton type name is "Theme", we add a one-line qmldir so the import
    # stays minimal: `import App` and `Theme.foo` (no `App.Theme.foo` needed,
    # because qmlRegisterSingletonType auto-imports the type into the namespace).
    theme_url = QUrl.fromLocalFile(str(_QML_DIR / "Theme.qml"))
    qmlRegisterSingletonType(theme_url, "App", 1, 0, "Theme")

    # AppContext exposed for the (future) viewmodels-from-QML wiring.
    engine.rootContext().setContextProperty("appCtx", ctx)

    # Instantiate the viewmodels Python-side (they need AppContext to open sessions)
    # and expose them as context properties. QML accesses them as `ingredientVM`,
    # `recipeListVM`, `recipeEditorVM`, `calendarVM` from any scope. The classes
    # are also registered via @QmlElement (`import App.ViewModels`) so QML can
    # reference their types — useful for typed bindings or future instantiation.
    ingredient_vm = IngredientViewModel(ctx)
    recipe_list_vm = RecipeListViewModel(ctx)
    recipe_editor_vm = RecipeEditorViewModel(ctx)
    calendar_vm = CalendarViewModel(ctx)
    shopping_vm = ShoppingViewModel(ctx)
    tag_vm = TagListViewModel(ctx)
    backup_vm = BackupViewModel()
    network_vm = NetworkStatusViewModel()
    pantry_vm = PantryViewModel(ctx)
    receipt_import_vm = ReceiptImportViewModel(ctx)
    recipe_url_import_vm = RecipeUrlImportViewModel(ctx)
    lidl_plus_vm = LidlPlusViewModel(ctx, parent=qt_app)
    category_vm = CategoryViewModel(ctx)

    # Phase 2 — démarre le watcher du sous-dossier `~/Downloads/Tickets de caisse/`.
    # Le watcher signale chaque nouveau fichier via `file_detected` ; on relaie
    # au VM qui maintient `pending_files`. Au boot, on scanne aussi les fichiers
    # déjà présents (cas où l'utilisateur en a déposé pendant que l'app était
    # fermée).
    receipt_watcher = ReceiptWatcher(parent=qt_app)
    receipt_watcher.file_detected.connect(receipt_import_vm.onWatcherDetectedFile)
    receipt_watcher.start()
    receipt_import_vm.rescanPending()

    # Plan v3 Phase 5 — démarre le polling Lidl Plus si l'utilisateur l'a
    # activé lors d'une session précédente. No-op si la lib n'est pas
    # installée ou si l'utilisateur n'a jamais activé la feature.
    lidl_plus_vm.start_if_enabled()

    engine.rootContext().setContextProperty("ingredientVM", ingredient_vm)
    engine.rootContext().setContextProperty("recipeListVM", recipe_list_vm)
    engine.rootContext().setContextProperty("recipeEditorVM", recipe_editor_vm)
    engine.rootContext().setContextProperty("calendarVM", calendar_vm)
    engine.rootContext().setContextProperty("shoppingVM", shopping_vm)
    engine.rootContext().setContextProperty("tagVM", tag_vm)
    engine.rootContext().setContextProperty("backupVM", backup_vm)
    engine.rootContext().setContextProperty("networkVM", network_vm)
    engine.rootContext().setContextProperty("pantryVM", pantry_vm)
    engine.rootContext().setContextProperty("receiptImportVM", receipt_import_vm)
    engine.rootContext().setContextProperty("recipeUrlImportVM", recipe_url_import_vm)
    engine.rootContext().setContextProperty("lidlPlusVM", lidl_plus_vm)
    engine.rootContext().setContextProperty("categoryVM", category_vm)

    # Path strings exposed to QML for the "Open folder" actions in the Aide menu.
    engine.rootContext().setContextProperty("logDirPath", str(default_log_dir()))

    main_qml = QUrl.fromLocalFile(str(_QML_DIR / "Main.qml"))
    engine.load(main_qml)
    if not engine.rootObjects():
        logging.error("Failed to load Main.qml")
        return 1

    try:
        return qt_app.exec()
    finally:
        receipt_watcher.stop()
        ctx.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
