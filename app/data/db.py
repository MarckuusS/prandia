"""DB engine + session factory + schema bootstrap (incl. FTS5 virtual table)."""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

from .orm import Base

log = logging.getLogger(__name__)

_DEFAULT_DB_FILENAME = "prandia.db"
_BACKUP_TIMESTAMP_FORMAT = "%Y-%m-%d_%H%M%S"


def default_db_path() -> Path:
    """Where the local SQLite DB lives. Override with PRANDIA_DB_PATH."""
    override = os.environ.get("PRANDIA_DB_PATH")
    if override:
        return Path(override)
    return Path.cwd() / _DEFAULT_DB_FILENAME


def default_backup_dir() -> Path:
    """Where DB backups live. Override with PRANDIA_BACKUP_DIR.

    Default: `~/.prandia/backups/` — outside the project tree so the
    backups survive a project move / delete. Created on demand.
    """
    override = os.environ.get("PRANDIA_BACKUP_DIR")
    if override:
        return Path(override)
    return Path.home() / ".prandia" / "backups"


# ============================================================ DB backup
# Strategy:
#   - At every app launch, copy the DB to `<backup_dir>/db-<timestamp>.db`.
#   - Use the SQLite backup API (not a raw file copy) so WAL files are handled
#     transparently and the snapshot is consistent even if the engine is open.
#   - Rotation: keep ALL backups from the last 7 days, then keep ONLY the most
#     recent one of each calendar month for the next 6 months. Older are dropped.
#     Result: ~13 files max (7 daily + ~6 monthly), bounded growth.
#
# The backup is a self-contained SQLite file that can be restored in-place by
# closing the live DB and copying the backup over `prandia.db`.


def backup_on_startup(
    db_path: Path | None = None,
    backup_dir: Path | None = None,
) -> Path | None:
    """Take a timestamped snapshot of the DB. No-op if the DB doesn't exist yet
    (first launch). Returns the new backup path, or None if nothing was backed up.
    Errors are logged and swallowed — a failed backup must NOT prevent the app
    from launching."""
    db_path = db_path or default_db_path()
    backup_dir = backup_dir or default_backup_dir()
    if not db_path.exists():
        return None
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        target = backup_dir / f"db-{datetime.now().strftime(_BACKUP_TIMESTAMP_FORMAT)}.db"
        _sqlite_backup(db_path, target)
        deleted = _rotate_backups(backup_dir)
        log.info("DB backup created: %s (rotated %d old files)", target.name, deleted)
        return target
    except Exception as exc:  # noqa: BLE001 — must not break app launch
        log.error("DB backup failed: %s", exc, exc_info=True)
        return None


def _sqlite_backup(src: Path, dst: Path) -> None:
    """Use SQLite's online backup API. Safe with WAL — copies a consistent snapshot
    even if the source DB has open writers."""
    src_conn = sqlite3.connect(str(src))
    dst_conn = sqlite3.connect(str(dst))
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()


def _rotate_backups(backup_dir: Path, *, now: datetime | None = None) -> int:
    """Apply retention policy. Returns the count of files deleted.

    Keep:
      - all backups newer than 7 days
      - the LATEST backup of each calendar month for the last 6 months
    Drop everything else. Files matching `db-*.db` whose timestamp doesn't parse
    are left alone (don't lose user-renamed files).
    """
    now = now or datetime.now()
    parsed: list[tuple[datetime, Path]] = []
    for p in backup_dir.glob("db-*.db"):
        try:
            ts_str = p.stem.removeprefix("db-")
            ts = datetime.strptime(ts_str, _BACKUP_TIMESTAMP_FORMAT)
        except ValueError:
            continue
        parsed.append((ts, p))

    parsed.sort()  # ascending = oldest first

    # Pick the latest backup of each month within the 7-180 day window.
    monthly_keep: dict[str, datetime] = {}
    for ts, _ in parsed:
        age_days = (now - ts).days
        if 7 < age_days <= 180:
            monthly_keep[ts.strftime("%Y-%m")] = ts  # ascending sort -> last wins

    deleted = 0
    for ts, path in parsed:
        age_days = (now - ts).days
        if age_days <= 7:
            keep = True
        elif age_days <= 180:
            keep = monthly_keep.get(ts.strftime("%Y-%m")) == ts
        else:
            keep = False
        if not keep:
            try:
                path.unlink()
                deleted += 1
            except OSError as exc:
                log.warning("Could not delete old backup %s: %s", path, exc)
    return deleted


def list_backups(backup_dir: Path | None = None) -> list[dict]:
    """Return all valid backups, sorted newest-first. Each item has
    `path` (str), `name` (str), `timestamp` (datetime), `sizeBytes` (int)."""
    backup_dir = backup_dir or default_backup_dir()
    if not backup_dir.exists():
        return []
    items: list[dict] = []
    for p in backup_dir.glob("db-*.db"):
        try:
            ts = datetime.strptime(p.stem.removeprefix("db-"), _BACKUP_TIMESTAMP_FORMAT)
        except ValueError:
            continue
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        items.append({
            "path": str(p),
            "name": p.name,
            "timestamp": ts,
            "sizeBytes": size,
        })
    items.sort(key=lambda d: d["timestamp"], reverse=True)
    return items


def restore_from_backup(backup_path: Path, db_path: Path | None = None) -> Path:
    """Restore the live DB from a backup file. Before overwriting, takes a
    *safety* backup of the current live DB so the restore itself is reversible.
    Returns the path of the safety backup.

    The caller is expected to have closed all open connections to the live DB
    (typically: the app must restart after this call).
    """
    db_path = db_path or default_db_path()
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup not found: {backup_path}")
    safety = None
    if db_path.exists():
        backup_dir = db_path.parent if db_path.parent != Path.cwd() else default_backup_dir()
        backup_dir.mkdir(parents=True, exist_ok=True)
        safety = backup_dir / f"db-pre-restore-{datetime.now().strftime(_BACKUP_TIMESTAMP_FORMAT)}.db"
        _sqlite_backup(db_path, safety)
        log.info("Safety backup before restore: %s", safety.name)
    shutil.copy2(backup_path, db_path)
    log.info("Restored DB from %s", backup_path.name)
    return safety or backup_path


def make_engine(url: str | None = None) -> Engine:
    """Create the SQLAlchemy engine. Pass an in-memory URL for tests."""
    if url is None:
        url = f"sqlite:///{default_db_path().as_posix()}"
    engine = create_engine(url, future=True)

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, _connection_record) -> None:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys = ON")
        # WAL only for file-backed DBs; in-memory rejects it.
        if ":memory:" not in url:
            cur.execute("PRAGMA journal_mode = WAL")
        cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


# FTS5 virtual table + triggers to keep it in sync with `ingredient`.
# Using `unicode61 remove_diacritics 2` so "tomate" matches "Tomâte" / "TOMATE".
# Each entry is a single statement — naive `split(';')` would break triggers (BEGIN ... END).
_FTS5_STATEMENTS: list[str] = [
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS ingredient_fts USING fts5(
        name,
        content='ingredient',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS ingredient_ai AFTER INSERT ON ingredient BEGIN
        INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS ingredient_ad AFTER DELETE ON ingredient BEGIN
        INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS ingredient_au AFTER UPDATE ON ingredient BEGIN
        INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
        INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
    END
    """,
]


def init_schema(engine: Engine) -> None:
    """Create all tables + the FTS5 virtual table & triggers. Safe to rerun.

    Includes inline migrations for schema evolutions on existing DBs (no Alembic for
    the MVP — see CLAUDE.md). Each migration is idempotent.
    """
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for stmt in _FTS5_STATEMENTS:
            conn.execute(text(stmt))
        _migrate_add_in_personal_library(conn)
        _migrate_add_categories(conn)
        _migrate_add_piece_weight(conn)
        _migrate_add_meal_plan_entry_xor_check(conn)
        _migrate_add_season_months(conn)
        _migrate_add_recipe_ingredient_unit(conn)
        _migrate_add_brand(conn)
        _migrate_add_cooked_weight_per_100g_raw(conn)
        _seed_default_tags(conn)
        _seed_seasonality(conn)
        _seed_categories_from_existing(conn)


def _migrate_add_cooked_weight_per_100g_raw(conn) -> None:
    """Add `ingredient.cooked_weight_per_100g_raw` if missing.

    Estimation du poids d'une portion servie : pour les féculents qui
    boivent de l'eau (riz, pâtes, légumineuses), ce champ stocke combien de
    g cuits on obtient à partir de 100 g cru. Les valeurs nutritionnelles
    restent en cru (convention CIQUAL). Idempotent.
    """
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "cooked_weight_per_100g_raw" in cols:
        return
    conn.execute(text("ALTER TABLE ingredient ADD COLUMN cooked_weight_per_100g_raw REAL"))


def _migrate_add_brand(conn) -> None:
    """Add `ingredient.brand` if missing.

    Refonte UX : pour les produits OFF, on extrait la marque comme champ
    dédié (au lieu de la concaténer dans le nom). Champ TEXT nullable —
    les CIQUAL et les manual sans marque restent à NULL.
    """
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "brand" in cols:
        return
    conn.execute(text("ALTER TABLE ingredient ADD COLUMN brand TEXT"))


def _seed_categories_from_existing(conn) -> None:
    """Refonte UX (Phase 5) : pré-remplit `category_definition` depuis les
    catégories L1/L2 distinctes déjà présentes en `ingredient`.

    Idempotent — n'insère que ce qui n'existe pas. Permet à l'utilisateur
    de démarrer avec les ~50 catégories CIQUAL déjà seedées et de les
    réorganiser/renommer ensuite via l'éditeur Paramètres.
    """
    # Vérifie que la table existe (Base.metadata.create_all l'a créée mais
    # par sûreté en cas d'init partiel).
    table_exists = conn.execute(text(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='category_definition'"
    )).fetchone()
    if not table_exists:
        return

    # 1. Insère tous les L1 distincts non encore présents
    l1_rows = conn.execute(text(
        "SELECT DISTINCT category_l1 FROM ingredient "
        "WHERE category_l1 IS NOT NULL AND category_l1 != ''"
    )).fetchall()
    for (l1_name,) in l1_rows:
        existing = conn.execute(text(
            "SELECT id FROM category_definition WHERE parent_id IS NULL AND name = :n"
        ), {"n": l1_name}).fetchone()
        if existing is None:
            conn.execute(text(
                "INSERT INTO category_definition (name, parent_id, ordinal) "
                "VALUES (:n, NULL, 0)"
            ), {"n": l1_name})

    # 2. Insère tous les couples (L1, L2) distincts. On résout l'id du L1
    # puis on insère le L2 sous ce parent_id si pas déjà présent.
    l2_rows = conn.execute(text(
        "SELECT DISTINCT category_l1, category_l2 FROM ingredient "
        "WHERE category_l1 IS NOT NULL AND category_l1 != '' "
        "  AND category_l2 IS NOT NULL AND category_l2 != ''"
    )).fetchall()
    for l1_name, l2_name in l2_rows:
        l1_row = conn.execute(text(
            "SELECT id FROM category_definition WHERE parent_id IS NULL AND name = :n"
        ), {"n": l1_name}).fetchone()
        if l1_row is None:
            continue
        l1_id = l1_row[0]
        existing = conn.execute(text(
            "SELECT id FROM category_definition WHERE parent_id = :p AND name = :n"
        ), {"p": l1_id, "n": l2_name}).fetchone()
        if existing is None:
            conn.execute(text(
                "INSERT INTO category_definition (name, parent_id, ordinal) "
                "VALUES (:n, :p, 0)"
            ), {"n": l2_name, "p": l1_id})


def _migrate_add_recipe_ingredient_unit(conn) -> None:
    """Add `recipe_ingredient.unit` if missing.

    Refonte UX : sans ce champ, le composant QuantityField au reload d'une
    recette force l'affichage en "_piece" si l'ingrédient a un piece_weight_g
    défini, écrasant l'unité initialement saisie (ex : 100 ml → 5 pièces).
    On stocke maintenant le code d'unité (g, ml, c_cafe, _piece, etc.) pour
    le restituer fidèlement.

    Idempotent — `ALTER TABLE ADD COLUMN` est skippé si la colonne existe.
    """
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(recipe_ingredient)"))}
    if "unit" in cols:
        return
    conn.execute(text("ALTER TABLE recipe_ingredient ADD COLUMN unit TEXT"))


def _migrate_add_in_personal_library(conn) -> None:
    """Add `ingredient.in_personal_library` if missing. Existing manual/OFF rows are
    promoted to the personal library automatically (the user explicitly created/imported
    them); CIQUAL rows stay outside the library until picked."""
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "in_personal_library" in cols:
        return
    conn.execute(
        text(
            "ALTER TABLE ingredient ADD COLUMN in_personal_library "
            "INTEGER NOT NULL DEFAULT 0"
        )
    )
    conn.execute(
        text(
            "UPDATE ingredient SET in_personal_library = 1 "
            "WHERE source IN ('manual', 'openfoodfacts')"
        )
    )


def _migrate_add_categories(conn) -> None:
    """Add `ingredient.category_l1` and `category_l2` if missing. Populated by
    re-running the CIQUAL loader (idempotent). OFF/manual rows keep NULL."""
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "category_l1" not in cols:
        conn.execute(text("ALTER TABLE ingredient ADD COLUMN category_l1 TEXT"))
    if "category_l2" not in cols:
        conn.execute(text("ALTER TABLE ingredient ADD COLUMN category_l2 TEXT"))


def _migrate_add_piece_weight(conn) -> None:
    """Add `ingredient.piece_weight_g` if missing. NULL means the ingredient has no
    natural piece size; non-NULL is the gram-weight of one piece (1 egg ~60 g, etc.).
    The QuantityField widget exposes a "pièce" unit when this column is set."""
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "piece_weight_g" not in cols:
        conn.execute(text("ALTER TABLE ingredient ADD COLUMN piece_weight_g REAL"))


def _migrate_add_season_months(conn) -> None:
    """Add `ingredient.season_months` (CSV of months 1-12) if missing.
    NULL means "no seasonality data" — we don't infer (the QML filter
    is opt-in, "De saison uniquement", so unknown stays visible by default
    but isn't tagged with the 🌱 badge)."""
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ingredient)"))}
    if "season_months" not in cols:
        conn.execute(text("ALTER TABLE ingredient ADD COLUMN season_months VARCHAR(50)"))


def _seed_seasonality(conn) -> None:
    """Stamp `season_months` on ~50 well-known French ingredients (C3).
    Idempotent : we only set the value when the column is currently NULL,
    so a user-tweaked seasonality is never overwritten."""
    from app.data.seeds.seasons import SEASONS_BY_NAME
    for name_pattern, months_csv in SEASONS_BY_NAME.items():
        # CIQUAL names follow "Nom, état" pattern. We match on a LIKE prefix
        # so "Tomate" matches "Tomate, crue", "Tomate, en boîte", etc.
        conn.execute(
            text(
                "UPDATE ingredient SET season_months = :csv "
                "WHERE season_months IS NULL "
                "AND lower(name) LIKE lower(:pat)"
            ),
            {"csv": months_csv, "pat": name_pattern + "%"},
        )


def _migrate_add_meal_plan_entry_xor_check(conn) -> None:
    """A5 : ensure `meal_plan_entry` has the XOR CHECK constraint on
    `(recipe_id, ingredient_id)`. Pydantic enforces XOR in memory but a
    direct SQL bypass (e.g. future scripts, accidental imports) could still
    insert invalid rows. The CheckConstraint is in the ORM since the start,
    so DBs created via `Base.metadata.create_all()` already have it ; this
    migration is a safety net for older DBs.

    SQLite doesn't support `ALTER TABLE ADD CONSTRAINT`. The standard pattern
    is rename-rebuild-copy. We only do this if the CHECK is genuinely missing
    (idempotent : a re-run of `init_schema()` is a no-op)."""
    row = conn.execute(
        text("SELECT sql FROM sqlite_master WHERE type='table' AND name='meal_plan_entry'")
    ).fetchone()
    if row is None:
        return  # table doesn't exist yet — Base.metadata.create_all() will create it with the CHECK
    sql = row[0] or ""
    if "ck_meal_plan_entry_xor" in sql or "recipe_id IS NOT NULL" in sql:
        return  # already constrained
    log.info("Migrating meal_plan_entry to add XOR CHECK constraint")
    # Rename old table, recreate with CHECK, copy rows that satisfy the new
    # rule, drop the old. Rows that violate XOR are dropped — this should
    # never happen since Pydantic has always enforced the rule, but log if
    # any are encountered for forensics.
    conn.execute(text("ALTER TABLE meal_plan_entry RENAME TO _meal_plan_entry_old"))
    conn.execute(text(
        "CREATE TABLE meal_plan_entry ("
        "  id INTEGER NOT NULL PRIMARY KEY,"
        "  iso_week VARCHAR(8) NOT NULL,"
        "  day_of_week INTEGER NOT NULL,"
        "  slot VARCHAR(10) NOT NULL,"
        "  recipe_id INTEGER,"
        "  ingredient_id INTEGER,"
        "  quantity_g FLOAT,"
        "  portions FLOAT,"
        "  ordinal INTEGER NOT NULL,"
        "  CONSTRAINT ck_meal_plan_entry_xor CHECK ("
        "    (recipe_id IS NOT NULL AND ingredient_id IS NULL) OR "
        "    (recipe_id IS NULL AND ingredient_id IS NOT NULL)),"
        "  FOREIGN KEY(recipe_id) REFERENCES recipe(id) ON DELETE CASCADE,"
        "  FOREIGN KEY(ingredient_id) REFERENCES ingredient(id) ON DELETE CASCADE"
        ")"
    ))
    invalid = conn.execute(text(
        "SELECT COUNT(*) FROM _meal_plan_entry_old "
        "WHERE NOT ((recipe_id IS NOT NULL AND ingredient_id IS NULL) OR "
        "          (recipe_id IS NULL AND ingredient_id IS NOT NULL))"
    )).scalar()
    if invalid:
        log.warning(
            "Dropping %d meal_plan_entry rows that violate XOR (recipe_id, ingredient_id)",
            invalid,
        )
    conn.execute(text(
        "INSERT INTO meal_plan_entry "
        "SELECT * FROM _meal_plan_entry_old "
        "WHERE (recipe_id IS NOT NULL AND ingredient_id IS NULL) OR "
        "      (recipe_id IS NULL AND ingredient_id IS NOT NULL)"
    ))
    conn.execute(text("DROP TABLE _meal_plan_entry_old"))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_meal_plan_week "
        "ON meal_plan_entry(iso_week, day_of_week, slot)"
    ))


# Default tags seeded on first run. Idempotent : `INSERT OR IGNORE` skips
# entries already present (matched by unique `name`). Removing or renaming a
# tag in this list does NOT remove it from existing DBs — that's intentional,
# the user may have customized them. Adding a new tag here = it appears on
# next launch alongside the user's existing tags.
_DEFAULT_TAGS: list[tuple[str, str]] = [
    ("entrée",          "#fbbf24"),  # amber
    ("plat principal",  "#3b82f6"),  # blue
    ("dessert",         "#ec4899"),  # pink
    ("petit-déjeuner",  "#fb923c"),  # orange
    ("batch-cooking",   "#14b8a6"),  # teal
    ("végétarien",      "#22c55e"),  # green
    ("végan",           "#16a34a"),  # darker green
    ("sans gluten",     "#a855f7"),  # purple
    ("rapide",          "#ef4444"),  # red
    ("du placard",      "#78716c"),  # warm gray
]


def _seed_default_tags(conn) -> None:
    """Insert the canonical tag set if missing. Uses INSERT OR IGNORE on the
    unique `name` column for idempotence."""
    for name, color in _DEFAULT_TAGS:
        conn.execute(
            text("INSERT OR IGNORE INTO tag (name, color_hex) VALUES (:n, :c)"),
            {"n": name, "c": color},
        )


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    """Transactional scope: commit on success, rollback on exception."""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
