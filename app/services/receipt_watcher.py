"""Watcher du sous-dossier de tickets (Plan v3, Phase 2).

Surveille `~/Downloads/Tickets de caisse/` (ou un dossier configurable via
`PRANDIA_RECEIPT_DIR`) et émet un signal Qt quand un nouveau fichier ticket
y atterrit. L'app écoute le signal pour proposer l'import en 1 clic.

Le watcher utilise `watchdog` (FSEvents/inotify/ReadDirectoryChangesW selon
l'OS) — fiable, pas de polling, latence sub-seconde.

**Sécurité** : on ne touche jamais à `~/Downloads/` direct. Uniquement le
sous-dossier dédié, avec un filtre sur l'extension (.pdf / .html). C'est
exclusivement la zone de tampon de l'app — pas un dossier utilisateur.

**Cleanup Option B** : la suppression du fichier après import réussi est
faite par le ViewModel (`commitImport`), pas par le watcher. Ce module ne
fait que la détection.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from PySide6.QtCore import QObject, Signal
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

log = logging.getLogger(__name__)

_VALID_EXTENSIONS = {".pdf", ".html", ".htm"}


def default_receipt_dir() -> Path:
    """Sous-dossier dédié `~/Downloads/Tickets de caisse/`.

    Override via la variable d'env `PRANDIA_RECEIPT_DIR`. Le dossier est créé
    automatiquement par `ensure_receipt_dir()` au démarrage de l'app si
    absent.
    """
    override = os.environ.get("PRANDIA_RECEIPT_DIR")
    if override:
        return Path(override)
    return Path.home() / "Downloads" / "Tickets de caisse"


def ensure_receipt_dir(path: Path | None = None) -> Path:
    """Crée le sous-dossier s'il n'existe pas. Idempotent.

    Retourne le Path effectif. À appeler une fois au boot, avant de démarrer
    le watcher.
    """
    path = path or default_receipt_dir()
    path.mkdir(parents=True, exist_ok=True)
    log.info("Receipt dir ready: %s", path)
    return path


def list_pending_files(path: Path | None = None) -> list[Path]:
    """Liste les fichiers ticket déjà présents dans le dossier au boot.

    Le watcher détecte uniquement les NOUVEAUX fichiers ; cet helper sert à
    rattraper les fichiers déposés alors que l'app était fermée. Filtre sur
    l'extension pour ignorer les fichiers que l'utilisateur aurait pu mettre
    par erreur (ex : .DS_Store, .tmp, .json…).
    """
    path = path or default_receipt_dir()
    if not path.exists():
        return []
    out: list[Path] = []
    for p in path.iterdir():
        if p.is_file() and p.suffix.lower() in _VALID_EXTENSIONS:
            out.append(p)
    out.sort(key=lambda p: p.stat().st_mtime)   # oldest first
    return out


class ReceiptWatcher(QObject):
    """Daemon thread surveillant le dossier des tickets.

    Émet `file_detected(path: str)` à chaque nouveau fichier d'extension
    valide. La QML écoute pour afficher un toast / déclencher l'import.

    Le signal est émis depuis le **thread principal Qt** (via QTimer.singleShot
    avec interval 0) — sinon QML pourrait tenter de toucher au DB hors thread
    Qt et planter. Le watchdog observer vit dans un thread séparé géré par la
    lib elle-même.
    """

    file_detected = Signal(str)   # absolute path

    def __init__(self, watch_dir: Path | None = None, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._dir = watch_dir or default_receipt_dir()
        self._observer: Observer | None = None
        self._handler: _ReceiptHandler | None = None
        self._lock = threading.Lock()

    @property
    def watch_dir(self) -> Path:
        return self._dir

    def start(self) -> None:
        """Démarre le watcher. Idempotent — appel multiple = no-op."""
        with self._lock:
            if self._observer is not None:
                return
            ensure_receipt_dir(self._dir)
            self._handler = _ReceiptHandler(self._on_new_file)
            self._observer = Observer()
            self._observer.schedule(self._handler, str(self._dir), recursive=False)
            self._observer.daemon = True
            self._observer.start()
            log.info("Receipt watcher started on %s", self._dir)

    def stop(self) -> None:
        """Arrête le watcher proprement (à appeler au shutdown de l'app)."""
        with self._lock:
            if self._observer is None:
                return
            self._observer.stop()
            self._observer.join(timeout=2.0)
            self._observer = None
            self._handler = None
            log.info("Receipt watcher stopped")

    def _on_new_file(self, path: Path) -> None:
        """Callback du handler watchdog — appelé depuis un thread `threading.Timer`
        détaché du thread observer (cf. `_ReceiptHandler`).

        Émission directe du signal Qt : `Signal.emit()` est thread-safe et,
        comme le slot connecté (côté ViewModel) vit dans le thread principal,
        Qt route automatiquement via une `QueuedConnection`. Pas besoin de
        `QTimer.singleShot(0, ...)` — ce serait illégal ici puisque le thread
        appelant n'a pas de boucle d'événements Qt.
        """
        log.debug("New receipt file detected: %s", path)
        self.file_detected.emit(str(path.resolve()))


_WRITE_SETTLE_DELAY_S = 0.25


class _ReceiptHandler(FileSystemEventHandler):
    """Handler watchdog interne. Filtre sur l'extension et ignore les events
    qui ne sont pas des créations de fichier (modifications, dossiers, etc.).

    Le délai de 250 ms avant de notifier laisse le temps au fichier d'être
    complètement écrit sur disque (sinon parser un PDF en cours de download
    lève). On utilise `threading.Timer` plutôt que `QTimer.singleShot` parce
    que les events watchdog arrivent sur un thread non-Qt — il n'y a pas de
    boucle d'événements Qt sur ce thread, donc `QTimer.singleShot` y est
    illégal. `threading.Timer` est neutre et le callback (`ReceiptWatcher.
    _on_new_file`) émet ensuite un signal Qt thread-safe.
    """

    def __init__(self, callback) -> None:
        super().__init__()
        self._callback = callback

    def _schedule(self, path: Path) -> None:
        """Arme le callback après `_WRITE_SETTLE_DELAY_S` secondes."""
        timer = threading.Timer(_WRITE_SETTLE_DELAY_S, self._callback, args=(path,))
        timer.daemon = True
        timer.start()

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in _VALID_EXTENSIONS:
            return
        self._schedule(path)

    def on_moved(self, event: FileSystemEvent) -> None:
        """Cas du téléchargement Chrome : le fichier est créé en `.crdownload`
        puis renommé vers `.pdf` à la fin → on capte l'event MOVE final."""
        if event.is_directory:
            return
        dest = Path(event.dest_path)
        if dest.suffix.lower() not in _VALID_EXTENSIONS:
            return
        self._schedule(dest)
