"""Tests for the CIQUAL CSV loader using a synthetic fixture (real file is not in repo)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.data.seeds import ciqual_loader

# A tiny CSV that mimics the real CIQUAL header layout — separator ';', decimal ','.
SAMPLE_CSV = (
    "alim_code;alim_nom_fr;Energie, Règlement UE N° 1169/2011 (kcal/100 g);"
    "Protéines, N x facteur de Jones (g/100 g);Glucides (g/100 g);Sucres (g/100 g);"
    "Lipides (g/100 g);AG saturés (g/100 g);Fibres alimentaires (g/100 g);"
    "Sel chlorure de sodium (g/100 g)\n"
    "20055;Tomate, crue;18;0,8;3,5;2,6;0,3;0,1;1,2;0,01\n"
    "13016;Pomme, crue;52;0,3;14;10;0,2;0,1;2,0;-\n"
    "17110;Carotte, crue;36;traces;7,9;5,5;< 0.5;0;3,1;0,06\n"
)


@pytest.fixture
def sample_csv(tmp_path: Path) -> Path:
    p = tmp_path / "ciqual.csv"
    p.write_text(SAMPLE_CSV, encoding="utf-8")
    return p


def test_loader_inserts_rows(monkeypatch, tmp_path, sample_csv):
    monkeypatch.setenv("PRANDIA_DB_PATH", str(tmp_path / "test.db"))
    n = ciqual_loader.load_csv(sample_csv)
    assert n == 3


def test_loader_idempotent(monkeypatch, tmp_path, sample_csv):
    monkeypatch.setenv("PRANDIA_DB_PATH", str(tmp_path / "test.db"))
    ciqual_loader.load_csv(sample_csv)
    ciqual_loader.load_csv(sample_csv)  # second run should not duplicate

    # Verify directly via the repo on the same DB.
    from app.data.db import init_schema, make_engine, make_session_factory
    from app.data.repositories import IngredientRepo
    from app.domain.models import Source

    engine = make_engine()
    init_schema(engine)
    factory = make_session_factory(engine)
    with factory() as s:
        repo = IngredientRepo(s)
        all_ciqual = [i for i in repo.list_all() if i.source == Source.CIQUAL]
        assert len(all_ciqual) == 3
        codes = sorted(i.source_ref for i in all_ciqual)
        assert codes == ["13016", "17110", "20055"]


def test_loader_parses_traces_and_dash(monkeypatch, tmp_path, sample_csv):
    monkeypatch.setenv("PRANDIA_DB_PATH", str(tmp_path / "test.db"))
    ciqual_loader.load_csv(sample_csv)

    from app.data.db import init_schema, make_engine, make_session_factory
    from app.data.repositories import IngredientRepo
    from app.domain.models import Source

    engine = make_engine()
    init_schema(engine)
    factory = make_session_factory(engine)
    with factory() as s:
        repo = IngredientRepo(s)
        carrot = repo.find_by_source_ref(Source.CIQUAL, "17110")
        apple = repo.find_by_source_ref(Source.CIQUAL, "13016")
        assert carrot is not None
        assert apple is not None
        # 'traces' -> 0.0
        assert carrot.proteins_g == 0.0
        # '< 0.5' -> 0.0
        assert carrot.fats_g == 0.0
        # '-' -> None
        assert apple.salt_g is None
        # decimal comma
        assert carrot.fiber_g == 3.1


def test_loader_missing_file_returns_zero(tmp_path):
    n = ciqual_loader.load_csv(tmp_path / "does-not-exist.csv")
    assert n == 0


def test_loader_keeps_in_personal_library_flag(monkeypatch, tmp_path, sample_csv):
    """Re-seeding CIQUAL must NOT clobber in_personal_library when the user has
    already imported a row to their working library."""
    monkeypatch.setenv("PRANDIA_DB_PATH", str(tmp_path / "test.db"))

    from app.data.db import init_schema, make_engine, make_session_factory
    from app.data.repositories import IngredientRepo
    from app.domain.models import Source

    # First seed
    ciqual_loader.load_csv(sample_csv)

    engine = make_engine()
    init_schema(engine)
    factory = make_session_factory(engine)

    # Promote the apple to the personal library, simulating an import.
    with factory() as s:
        repo = IngredientRepo(s)
        apple = repo.find_by_source_ref(Source.CIQUAL, "13016")
        assert apple is not None
        repo.mark_in_personal_library(apple.id, True)
        s.commit()

    # Re-seed; the user's flag must survive.
    ciqual_loader.load_csv(sample_csv)

    with factory() as s:
        repo = IngredientRepo(s)
        apple = repo.find_by_source_ref(Source.CIQUAL, "13016")
        carrot = repo.find_by_source_ref(Source.CIQUAL, "17110")
        assert apple is not None and apple.in_personal_library is True
        # Untouched row stays out of the library
        assert carrot is not None and carrot.in_personal_library is False
