"""Tests for the Intermarché PDF parser (Plan v3, Phase 1).

Le test principal utilise le sample fourni par l'utilisateur (5 articles,
dont 2 non-alimentaires en TVA B). Si tu en as d'autres (multi-qty, vrac
au poids, promos), ajoute-les comme fixtures et étends les tests.
"""

from __future__ import annotations

import os
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from app.services.receipt_parser.intermarche_parser import parse_intermarche_pdf


# Un vrai ticket Intermarché contient des données personnelles (magasin, date,
# achats) : il n'a pas sa place dans un dépôt public. Le test s'active en
# pointant PRANDIA_SAMPLE_RECEIPT_PDF vers un PDF local, sinon il est ignoré.
#
# Les valeurs attendues plus bas décrivent le sample d'origine : 5 articles,
# 43,13 € TTC, ticket du 02/05/2026. Un autre PDF fera échouer les assertions
# — c'est voulu, elles documentent un cas précis.
SAMPLE_PDF = Path(os.environ.get("PRANDIA_SAMPLE_RECEIPT_PDF", "tests/fixtures/intermarche-sample.pdf"))


@pytest.mark.skipif(
    not SAMPLE_PDF.exists(),
    reason="Sample PDF Intermarché non disponible (utilisateur-spécifique)",
)
def test_parse_intermarche_sample() -> None:
    """Test sur le sample fourni : 5 articles, 43,13 € TTC, ticket du 02/05/2026."""
    receipt = parse_intermarche_pdf(SAMPLE_PDF)

    assert receipt.store == "intermarche"
    assert receipt.line_count == 5
    assert receipt.total_eur == Decimal("43.13")
    assert receipt.date == datetime(2026, 5, 2, 16, 35, 41)
    assert receipt.ticket_id == "202605021635010402310718"


@pytest.mark.skipif(
    not SAMPLE_PDF.exists(),
    reason="Sample PDF Intermarché non disponible",
)
def test_parse_intermarche_sample_lines() -> None:
    """Vérifie les détails de chaque ligne extraite : nom, prix, code TVA."""
    receipt = parse_intermarche_pdf(SAMPLE_PDF)
    lines = receipt.lines

    # Ordre exact selon le sample
    assert lines[0].raw_name == "FRANUI FRAMBSE CHOCO"
    assert lines[0].unit_price == Decimal("6.06")
    assert lines[0].vat_code == "A"
    assert lines[0].is_likely_food is True

    assert lines[1].raw_name == "L'ANGELYS SORB ORASA"
    assert lines[1].unit_price == Decimal("5.29")

    assert lines[2].raw_name == "DOM LOUCHE INOX"
    assert lines[2].vat_code == "B"
    assert lines[2].is_likely_food is False    # louche en métal = non-food

    assert lines[3].raw_name == "ELEPHANT KIT DE LAVA"
    assert lines[3].vat_code == "B"

    assert lines[4].raw_name == "PAT CREME UHT SE 18%"
    assert lines[4].vat_code == "A"


@pytest.mark.skipif(
    not SAMPLE_PDF.exists(),
    reason="Sample PDF Intermarché non disponible",
)
def test_parse_intermarche_store_key_normalized() -> None:
    """Le store_key doit être normalisé pour servir de clé d'alias :
    casefold + collapse whitespace."""
    receipt = parse_intermarche_pdf(SAMPLE_PDF)

    # FRANUI FRAMBSE CHOCO → "franui frambse choco"
    assert receipt.lines[0].store_key == "franui frambse choco"
    # L'ANGELYS SORB ORASA → "l'angelys sorb orasa"
    assert receipt.lines[1].store_key == "l'angelys sorb orasa"


@pytest.mark.skipif(
    not SAMPLE_PDF.exists(),
    reason="Sample PDF Intermarché non disponible",
)
def test_parse_intermarche_food_lines_filter() -> None:
    """`food_lines` doit retourner uniquement les lignes TVA A (alimentaires).
    Sur le sample : FRANUI, ANGELYS, PAT CREME → 3 sur 5."""
    receipt = parse_intermarche_pdf(SAMPLE_PDF)
    food = receipt.food_lines
    assert len(food) == 3
    food_names = [line.raw_name for line in food]
    assert "DOM LOUCHE INOX" not in food_names
    assert "ELEPHANT KIT DE LAVA" not in food_names


def test_parse_intermarche_no_articles_raises(tmp_path: Path) -> None:
    """Si le PDF a du texte mais aucune ligne d'article, on lève une ValueError
    explicite (signal au dialog que ce n'est pas un ticket Intermarché valide).

    On ne peut pas générer un vrai PDF vide ici sans une dépendance comme
    `reportlab`. À la place on teste indirectement le pattern : on appelle
    le parser sur un texte forgé via une mock minimale de pdfplumber.
    """
    from unittest.mock import patch

    class _FakePage:
        def extract_text(self) -> str:
            return "Hello world\nNo article lines here\n"

    class _FakePdf:
        pages = [_FakePage()]
        def __enter__(self): return self
        def __exit__(self, *a, **k): pass

    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_text("dummy")  # juste pour passer le check `path.exists()`

    with patch("app.services.receipt_parser.intermarche_parser.pdfplumber.open",
               return_value=_FakePdf()):
        with pytest.raises(ValueError, match="article|format"):
            parse_intermarche_pdf(fake_pdf)


def test_parse_intermarche_missing_file_raises() -> None:
    with pytest.raises(Exception):  # FileNotFoundError ou pdfplumber error
        parse_intermarche_pdf(Path("/nonexistent/ticket.pdf"))
