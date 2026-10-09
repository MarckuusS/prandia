"""Centralized logging configuration.

Behavior :
  - Console (stderr) : INFO by default, DEBUG when `PRANDIA_DEBUG=1`. Useful
    when running from source (`python -m app.main`).
  - File : `~/.prandia/logs/app.log`, rotating at 5 MB × 5 backups
    (~25 MB max on disk). Always at INFO+ regardless of the console level —
    so a user who reports a bug always has the last few sessions captured.
  - Uncaught exceptions are logged via `sys.excepthook` then re-raised so the
    process still terminates abnormally (important for crash reporting).

Call `setup_logging()` ONCE at app startup, before any other logger emits.
`default_log_dir()` is exported so QML can offer an "Open log folder" action.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import traceback
from pathlib import Path


def default_log_dir() -> Path:
    """Where the rotating log files live. Override with `PRANDIA_LOG_DIR`."""
    override = os.environ.get("PRANDIA_LOG_DIR")
    if override:
        return Path(override)
    return Path.home() / ".prandia" / "logs"


_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def setup_logging(log_dir: Path | None = None) -> Path:
    """Configure the root logger. Returns the path to the active log file.

    Idempotent : if called twice, removes existing handlers first so the
    config is applied cleanly (useful in tests).
    """
    log_dir = log_dir or default_log_dir()
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # Log dir not writable — fall back to stderr-only logging.
        # Don't crash the app over this.
        print(f"[logging] Could not create log dir {log_dir}: {exc}", file=sys.stderr)
        log_dir = None  # type: ignore[assignment]

    debug = os.environ.get("PRANDIA_DEBUG") == "1"
    console_level = logging.DEBUG if debug else logging.INFO
    file_level = logging.INFO  # always at least INFO in file

    root = logging.getLogger()
    # Wipe pre-existing handlers (`logging.basicConfig` from a previous run, etc.)
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(min(console_level, file_level))

    formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)

    # Console handler
    console = logging.StreamHandler(sys.stderr)
    console.setLevel(console_level)
    console.setFormatter(formatter)
    root.addHandler(console)

    # File handler with rotation
    log_path: Path | None = None
    if log_dir is not None:
        log_path = log_dir / "app.log"
        try:
            file_h = logging.handlers.RotatingFileHandler(
                str(log_path),
                maxBytes=5 * 1024 * 1024,  # 5 MB
                backupCount=5,
                encoding="utf-8",
            )
            file_h.setLevel(file_level)
            file_h.setFormatter(formatter)
            root.addHandler(file_h)
        except OSError as exc:
            print(f"[logging] Could not open log file {log_path}: {exc}", file=sys.stderr)
            log_path = None

    # Tame the noisy third-party loggers — we don't want SQLAlchemy DEBUG
    # spamming our log (use PRANDIA_DEBUG=1 + PRANDIA_DEBUG_SQL=1 to enable).
    if not (debug and os.environ.get("PRANDIA_DEBUG_SQL") == "1"):
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
        logging.getLogger("PIL").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)

    if log_path is not None:
        logging.getLogger(__name__).info("Logging started — file: %s", log_path)
    return log_path or Path()


def install_excepthook() -> None:
    """Catch every uncaught exception, log it with full traceback, then chain
    to the previous excepthook (default = print + exit). Without this, a
    silent crash in a packaged .exe leaves no trace."""
    log = logging.getLogger("uncaught")
    previous = sys.excepthook

    def _hook(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            # Don't pollute logs with Ctrl+C in dev
            previous(exc_type, exc_value, exc_tb)
            return
        log.critical(
            "Uncaught %s: %s\n%s",
            exc_type.__name__,
            exc_value,
            "".join(traceback.format_exception(exc_type, exc_value, exc_tb)),
        )
        previous(exc_type, exc_value, exc_tb)

    sys.excepthook = _hook
