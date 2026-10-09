# Prandia

Application desktop personnelle de gestion culinaire (Windows / PySide6).

> **Prandia** vient du latin *prandium*, le repas. Le nom s'applique a l'application web (depuis le
> 2026-08-12) et, depuis le 2026-10-09, au depot, aux paquets npm, a la base locale et aux
> ressources Cloudflare. L'ancien nom a disparu partout.

## Fonctionnalites

- **Bibliotheque d'ingredients** : reference avec valeurs nutritionnelles (CIQUAL 2025 ANSES + OpenFoodFacts) et cout d'achat.
- **Bibliotheque de recettes** : composees d'ingrédients de la bibliotheque, calcul auto des macros + cout (total et par portion).
- **Calendrier hebdomadaire** : planification matin / midi / soir x 7 jours, avec recettes ou ingredients bruts.

## Stack

Python 3.11+, PySide6 (Qt 6) avec **QtQuick Controls 2 / QML** pour l'UI, SQLAlchemy 2 + SQLite (FTS5), Pydantic v2, httpx.

L'interface est entierement en QML, stylee via un `Theme.qml` singleton (palette, typo, espacements, animations). Aucun QtWidgets dans l'UI sauf le bootstrap `QApplication`.

## Demarrage

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
python -m app.main
```

Sous Windows, le script `run.bat` a la racine fait tout en une fois (creation du venv si absent, installation des deps, lancement). Detecte un venv casse (par exemple herite d'une autre machine) et le recree avec `py -3.12` ou `py -3.11`.

Au premier lancement, la base SQLite locale (`prandia.db` a la racine du projet) est creee. Pour beneficier de la table CIQUAL pre-remplie (~3500 aliments avec valeurs nutritionnelles officielles ANSES) :

1. Telecharger la table CIQUAL la plus recente sur https://ciqual.anses.fr/ (lien "Telecharger la table" en bas de page).
2. Placer le fichier sous `app/data/seeds/`. Les formats `.xls`, `.xlsx` et `.csv` sont tous supportes.
3. Lancer le seed (idempotent, peut etre rerun) :

```bash
python -m app.data.seeds.ciqual_loader
```

L'application fonctionne sans cette etape : tu pourras saisir tes ingredients manuellement ou les chercher via OpenFoodFacts.

## Tests

```bash
pytest
```

## Structure du projet

Voir [architecture.md](architecture.md) pour la cartographie detaillee. En bref :

- `app/domain/` : modeles Pydantic + fonctions pures (nutrition, pricing). Zero dependance Qt / DB.
- `app/data/` : SQLAlchemy ORM + repositories.
- `app/services/` : OpenFoodFacts client, recherche unifiee, calculs aggregs.
- `app/ui/qml/` : interface QML — `Theme.qml` (singleton design system), `Main.qml`, 3 pages (`pages/`), 14 composants reutilisables (`components/`), 2 dialogues detachables en fenetre systeme (`dialogs/`).
- `app/ui/viewmodels/` : ViewModels Python (QObject avec `@QmlElement`) qui exposent les donnees et slots a QML.
- `app/ui/models/` : `QAbstractListModel` qui pontent les listes Pydantic vers les `ListView` QML.
- `tests/` : tests unitaires (domaine, repositories, services).
