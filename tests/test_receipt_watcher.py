"""Tests du watcher de tickets (Plan v3, Phase 2).

On teste sans dépendre du filesystem réel quand c'est possible (helpers
purs : `default_receipt_dir`, `list_pending_files`, `_ReceiptHandler`).
Pour l'observer watchdog en bout de chaîne, on crée un dossier tmp et on
y écrit un .pdf vide pour vérifier que l'event est bien capté.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.services.receipt_watcher import (
    ReceiptWatcher,
    _ReceiptHandler,
    default_receipt_dir,
    ensure_receipt_dir,
    list_pending_files,
)


def test_default_receipt_dir_uses_env_override(monkeypatch, tmp_path: Path) -> None:
    """Quand `PRANDIA_RECEIPT_DIR` est défini, il prime sur le defaut Downloads."""
    monkeypatch.setenv("PRANDIA_RECEIPT_DIR", str(tmp_path / "custom"))
    assert default_receipt_dir() == tmp_path / "custom"


def test_default_receipt_dir_fallback_downloads(monkeypatch) -> None:
    monkeypatch.delenv("PRANDIA_RECEIPT_DIR", raising=False)
    p = default_receipt_dir()
    # Attendu : ~/Downloads/Tickets de caisse/
    assert p.name == "Tickets de caisse"
    assert p.parent.name == "Downloads"


def test_ensure_receipt_dir_is_idempotent(tmp_path: Path) -> None:
    target = tmp_path / "subfolder" / "tickets"
    # Premier appel : crée tout le chemin
    out = ensure_receipt_dir(target)
    assert out == target
    assert target.exists() and target.is_dir()
    # Second appel : no-op, ne plante pas
    out2 = ensure_receipt_dir(target)
    assert out2 == target


def test_list_pending_files_filters_extensions(tmp_path: Path) -> None:
    # Tickets valides
    (tmp_path / "ticket1.pdf").write_bytes(b"x")
    (tmp_path / "ticket2.html").write_bytes(b"y")
    (tmp_path / "ticket3.HTM").write_bytes(b"z")  # casse mixte
    # Bruit à ignorer
    (tmp_path / ".DS_Store").write_bytes(b"")
    (tmp_path / "notes.txt").write_text("ignore")
    (tmp_path / "subdir").mkdir()
    (tmp_path / "subdir" / "deep.pdf").write_bytes(b"x")  # pas récursif

    out = list_pending_files(tmp_path)
    names = sorted(p.name for p in out)
    assert names == ["ticket1.pdf", "ticket2.html", "ticket3.HTM"]


def test_list_pending_files_orders_oldest_first(tmp_path: Path) -> None:
    # On crée 3 fichiers avec des mtimes explicites pour vérifier l'ordre.
    f1 = tmp_path / "a.pdf"
    f2 = tmp_path / "b.pdf"
    f3 = tmp_path / "c.pdf"
    for f in (f1, f2, f3):
        f.write_bytes(b"x")
    now = time.time()
    os.utime(f1, (now - 300, now - 300))   # le plus ancien
    os.utime(f2, (now - 100, now - 100))
    os.utime(f3, (now - 10, now - 10))     # le plus récent

    out = list_pending_files(tmp_path)
    assert [p.name for p in out] == ["a.pdf", "b.pdf", "c.pdf"]


def test_list_pending_files_missing_dir_returns_empty(tmp_path: Path) -> None:
    assert list_pending_files(tmp_path / "does-not-exist") == []


# ============================================================ Handler tests


def test_handler_filters_non_receipt_extension(tmp_path: Path) -> None:
    """Un .txt déposé dans le dossier ne déclenche pas le callback."""
    cb = MagicMock()
    handler = _ReceiptHandler(cb)
    txt = tmp_path / "notes.txt"
    txt.write_text("hello")

    # Simule un event de création
    class _Evt:
        is_directory = False
        src_path = str(txt)

    handler.on_created(_Evt())
    # `cb` est appelé via `QTimer.singleShot(250, ...)` quand l'extension est
    # valide. Pour .txt → l'early-return fait que cb n'est jamais armé.
    # On laisse 50 ms pour confirmer que rien n'arrive.
    time.sleep(0.05)
    cb.assert_not_called()


def test_handler_ignores_directories(tmp_path: Path) -> None:
    cb = MagicMock()
    handler = _ReceiptHandler(cb)

    class _Evt:
        is_directory = True
        src_path = str(tmp_path / "newfolder")

    handler.on_created(_Evt())
    time.sleep(0.05)
    cb.assert_not_called()


def test_handler_on_moved_captures_pdf_rename(tmp_path: Path, qtbot) -> None:
    """Le cas Chrome : `.crdownload` → `.pdf`. L'event est `on_moved`,
    le handler doit déclencher le callback (après le délai)."""
    cb = MagicMock()
    handler = _ReceiptHandler(cb)
    pdf = tmp_path / "ticket.pdf"
    pdf.write_bytes(b"x")

    class _Evt:
        is_directory = False
        src_path = str(tmp_path / "ticket.pdf.crdownload")
        dest_path = str(pdf)

    handler.on_moved(_Evt())
    # Le callback est armé via QTimer.singleShot(250, ...). On laisse 400 ms.
    qtbot.wait(400)
    cb.assert_called_once()
    args = cb.call_args[0]
    assert args[0] == pdf


# ============================================================ End-to-end watcher


def test_watcher_emits_signal_on_new_pdf(tmp_path: Path, qtbot) -> None:
    """Test bout en bout : on démarre le watcher sur un dossier tmp,
    on y dépose un .pdf, on attend l'émission du signal."""
    watcher = ReceiptWatcher(watch_dir=tmp_path)
    received: list[str] = []
    watcher.file_detected.connect(received.append)

    watcher.start()
    try:
        # watchdog peut avoir une latence d'init côté observer ; attendre un poil.
        qtbot.wait(100)
        target = tmp_path / "ticket.pdf"
        target.write_bytes(b"x")
        # on attend l'émission Qt (timer 250 ms + marge)
        qtbot.waitUntil(lambda: len(received) > 0, timeout=3000)
        assert len(received) == 1
        assert Path(received[0]).resolve() == target.resolve()
    finally:
        watcher.stop()


def test_watcher_idempotent_start_stop(tmp_path: Path) -> None:
    """Multi-appel start() = no-op. stop() avant start() = no-op."""
    watcher = ReceiptWatcher(watch_dir=tmp_path)
    watcher.stop()           # avant start : ne plante pas
    watcher.start()
    obs1 = watcher._observer
    watcher.start()          # second appel = no-op
    assert watcher._observer is obs1
    watcher.stop()
    assert watcher._observer is None


def test_watcher_ignores_text_files(tmp_path: Path, qtbot) -> None:
    """Si l'utilisateur dépose un .txt par erreur, le signal NE doit PAS être émis."""
    watcher = ReceiptWatcher(watch_dir=tmp_path)
    received: list[str] = []
    watcher.file_detected.connect(received.append)
    watcher.start()
    try:
        qtbot.wait(100)
        (tmp_path / "notes.txt").write_text("rien")
        qtbot.wait(500)
        assert received == []
    finally:
        watcher.stop()


# ============================================================ ViewModel integration


def test_vm_rescan_pending_picks_up_existing_files(
    app_ctx, tmp_path: Path, monkeypatch,
) -> None:
    """Si des fichiers résiduels traînent au boot dans le dossier dédié,
    `rescanPending` les remonte dans le VM."""
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel

    # Override du dossier pour pointer vers tmp_path
    monkeypatch.setenv("PRANDIA_RECEIPT_DIR", str(tmp_path))
    (tmp_path / "old1.pdf").write_bytes(b"x")
    (tmp_path / "old2.html").write_bytes(b"x")
    (tmp_path / "ignore.txt").write_text("...")

    vm = ReceiptImportViewModel(app_ctx)
    assert vm.pendingFileCount == 0
    vm.rescanPending()
    assert vm.pendingFileCount == 2


def test_vm_on_watcher_detected_appends_to_pendings(app_ctx, tmp_path: Path) -> None:
    """Le VM accumule les paths via onWatcherDetectedFile et signale."""
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel

    vm = ReceiptImportViewModel(app_ctx)
    assert vm.pendingFileCount == 0

    p1 = tmp_path / "t1.pdf"
    p1.write_bytes(b"x")
    vm.onWatcherDetectedFile(str(p1))
    assert vm.pendingFileCount == 1

    # Doublon : ne ré-incrémente pas
    vm.onWatcherDetectedFile(str(p1))
    assert vm.pendingFileCount == 1

    # Nouveau fichier
    p2 = tmp_path / "t2.pdf"
    p2.write_bytes(b"x")
    vm.onWatcherDetectedFile(str(p2))
    assert vm.pendingFileCount == 2


def test_vm_load_next_pending_returns_empty_when_none(app_ctx) -> None:
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel

    vm = ReceiptImportViewModel(app_ctx)
    assert vm.loadNextPending() == ""


def test_vm_load_next_pending_skips_missing_file(app_ctx, tmp_path: Path) -> None:
    """Si le fichier en tête de liste a été supprimé entre détection et appel,
    on le drop et retourne ""."""
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel

    vm = ReceiptImportViewModel(app_ctx)
    ghost = tmp_path / "ghost.pdf"
    ghost.write_bytes(b"x")
    vm.onWatcherDetectedFile(str(ghost))
    assert vm.pendingFileCount == 1

    ghost.unlink()
    out = vm.loadNextPending()
    assert out == ""
    assert vm.pendingFileCount == 0


# Voir tests/test_receipt_parser_intermarche.py : le PDF d'exemple contient des
# données personnelles et reste hors du dépôt. Défini PRANDIA_SAMPLE_RECEIPT_PDF
# pour activer ce test.
_SAMPLE_PDF = Path(
    os.environ.get("PRANDIA_SAMPLE_RECEIPT_PDF", "tests/fixtures/intermarche-sample.pdf")
)


@pytest.mark.skipif(
    not _SAMPLE_PDF.exists(),
    reason="Sample PDF Intermarché absent (définir PRANDIA_SAMPLE_RECEIPT_PDF)",
)
def test_vm_cleanup_deletes_only_inside_dedicated_dir(
    app_ctx, tmp_path: Path, monkeypatch,
) -> None:
    """Le cleanup Option B ne doit supprimer le fichier QUE s'il est sous
    `default_receipt_dir()`. Un fichier importé depuis ailleurs (ex : un
    file picker pointant vers le bureau) doit être préservé."""
    from app.ui.viewmodels.receipt_import_vm import ReceiptImportViewModel

    monkeypatch.setenv("PRANDIA_RECEIPT_DIR", str(tmp_path))
    sample = _SAMPLE_PDF

    # Cas A : fichier hors du dossier dédié → on charge et commit, le fichier reste.
    outside = tmp_path.parent / "outside.pdf"
    outside.write_bytes(sample.read_bytes())

    vm = ReceiptImportViewModel(app_ctx)
    assert vm.loadFromPath(str(outside)) is True
    # Sans assigner d'ingrédient on commit quand même (0 prix créés)
    result = vm.commitImport()
    assert result["success"] is True
    # Le fichier hors-dossier est PRÉSERVÉ
    assert outside.exists()
    outside.unlink()
