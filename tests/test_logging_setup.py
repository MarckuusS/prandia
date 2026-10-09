"""Tests for `app.logging_setup`."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import pytest

from app.logging_setup import (
    default_log_dir,
    install_excepthook,
    setup_logging,
)


@pytest.fixture(autouse=True)
def _reset_logging():
    """Reset logging state between tests so they don't pollute each other."""
    yield
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass


def test_default_log_dir_default_location() -> None:
    expected = Path.home() / ".prandia" / "logs"
    # Drop any PRANDIA_LOG_DIR env that the test runner might have set
    if "PRANDIA_LOG_DIR" in os.environ:
        del os.environ["PRANDIA_LOG_DIR"]
    assert default_log_dir() == expected


def test_default_log_dir_respects_env_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PRANDIA_LOG_DIR", str(tmp_path / "custom"))
    assert default_log_dir() == tmp_path / "custom"


def test_setup_logging_creates_log_file(tmp_path: Path) -> None:
    log_path = setup_logging(log_dir=tmp_path)
    assert log_path == tmp_path / "app.log"

    log = logging.getLogger("test_logger")
    log.info("hello world")
    # Force flush
    for h in logging.getLogger().handlers:
        h.flush()

    assert log_path.exists()
    content = log_path.read_text(encoding="utf-8")
    assert "hello world" in content
    assert "INFO" in content


def test_setup_logging_idempotent(tmp_path: Path) -> None:
    """Calling twice should not double the handlers (one StreamHandler + one
    RotatingFileHandler each time)."""
    setup_logging(log_dir=tmp_path)
    setup_logging(log_dir=tmp_path)
    handlers = logging.getLogger().handlers
    assert len(handlers) == 2  # exactly one console + one file


def test_setup_logging_debug_level_via_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PRANDIA_DEBUG", "1")
    setup_logging(log_dir=tmp_path)
    # Console handler should be DEBUG
    root = logging.getLogger()
    console = next(
        h for h in root.handlers
        if isinstance(h, logging.StreamHandler)
        and not isinstance(h, logging.handlers.RotatingFileHandler)
    )
    assert console.level == logging.DEBUG


def test_setup_logging_info_level_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("PRANDIA_DEBUG", raising=False)
    setup_logging(log_dir=tmp_path)
    root = logging.getLogger()
    console = next(
        h for h in root.handlers
        if isinstance(h, logging.StreamHandler)
        and not isinstance(h, logging.handlers.RotatingFileHandler)
    )
    assert console.level == logging.INFO


def test_setup_logging_silences_noisy_loggers(tmp_path: Path) -> None:
    """SQLAlchemy / Pillow / httpx are pinned to WARNING+ to avoid spam."""
    setup_logging(log_dir=tmp_path)
    assert logging.getLogger("sqlalchemy.engine").level == logging.WARNING
    assert logging.getLogger("PIL").level == logging.WARNING
    assert logging.getLogger("httpx").level == logging.WARNING


def test_setup_logging_handles_unwritable_dir(tmp_path: Path) -> None:
    """If the log dir can't be created, fallback to console-only — must not crash."""
    # Use a path that can't be created (a file masquerading as a dir).
    blocking_file = tmp_path / "blocked"
    blocking_file.write_text("not a directory")
    bad_path = blocking_file / "logs"  # would fail mkdir because parent is a file

    log_path = setup_logging(log_dir=bad_path)
    # Returns empty path on failure, doesn't raise
    assert log_path == Path()
    # Console handler still installed
    handlers = logging.getLogger().handlers
    assert any(isinstance(h, logging.StreamHandler) for h in handlers)


def test_install_excepthook_logs_and_chains(tmp_path: Path) -> None:
    setup_logging(log_dir=tmp_path)
    install_excepthook()

    # Capture the chained excepthook
    called = []
    original_after_install = sys.excepthook

    def fake_previous(*args):
        called.append(args)

    # Swap in our spy AFTER install_excepthook (which captured the previous one).
    # We need to re-install with the fake as the chained target.
    sys.excepthook = fake_previous
    install_excepthook()  # captures fake_previous as `previous`

    # Trigger the hook
    try:
        raise ValueError("boom")
    except ValueError:
        sys.excepthook(*sys.exc_info())

    # Force file flush
    for h in logging.getLogger().handlers:
        h.flush()

    log_content = (tmp_path / "app.log").read_text(encoding="utf-8")
    assert "Uncaught ValueError" in log_content
    assert "boom" in log_content
    assert len(called) == 1  # chained to the previous hook

    # Restore for cleanliness
    sys.excepthook = original_after_install


def test_install_excepthook_preserves_keyboard_interrupt(tmp_path: Path) -> None:
    """Ctrl+C must NOT clutter the log file — pass through unchanged."""
    setup_logging(log_dir=tmp_path)
    chained_calls = []
    sys.excepthook = lambda *a: chained_calls.append(a)
    install_excepthook()

    try:
        raise KeyboardInterrupt()
    except KeyboardInterrupt:
        sys.excepthook(*sys.exc_info())

    for h in logging.getLogger().handlers:
        h.flush()

    log_content = (tmp_path / "app.log").read_text(encoding="utf-8") if (tmp_path / "app.log").exists() else ""
    assert "Uncaught" not in log_content
    assert len(chained_calls) == 1
