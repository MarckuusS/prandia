"""Top-level window. Hosts the three feature tabs.

Adding a new tab is a one-line registration here + one new file in `app/ui/tabs/`.
"""

from __future__ import annotations

from PySide6.QtCore import QSize
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import QMainWindow, QStatusBar, QTabWidget, QWidget

from app.ui.app_context import AppContext
from app.ui.tabs.calendar_tab import CalendarTab
from app.ui.tabs.ingredients_tab import IngredientsTab
from app.ui.tabs.recipes_tab import RecipesTab


class MainWindow(QMainWindow):
    def __init__(self, ctx: AppContext) -> None:
        super().__init__()
        self.ctx = ctx
        self.setWindowTitle("Prandia")
        self.resize(QSize(1280, 800))

        tabs = QTabWidget(self)
        tabs.setDocumentMode(True)

        # Build & register the three tabs. Each tab manages its own viewmodel.
        self._tabs: list[tuple[str, QWidget]] = [
            ("Ingrédients", IngredientsTab(ctx, parent=tabs)),
            ("Recettes", RecipesTab(ctx, parent=tabs)),
            ("Calendrier", CalendarTab(ctx, parent=tabs)),
        ]
        for label, widget in self._tabs:
            tabs.addTab(widget, label)
        self.setCentralWidget(tabs)
        self._tab_widget = tabs

        self.setStatusBar(QStatusBar(self))
        self._build_menu()

    def _build_menu(self) -> None:
        menu = self.menuBar().addMenu("&Fichier")
        quit_action = QAction("&Quitter", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        menu.addAction(quit_action)

        nav = self.menuBar().addMenu("&Navigation")
        for idx, (label, _) in enumerate(self._tabs):
            act = QAction(f"&{idx + 1}. {label}", self)
            act.setShortcut(QKeySequence(f"Ctrl+{idx + 1}"))
            act.triggered.connect(lambda _checked=False, i=idx: self._tab_widget.setCurrentIndex(i))
            nav.addAction(act)
