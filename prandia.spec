# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec — Prandia (D1, Phase 2).

Mode `--onedir` : sortie = `dist/prandia/` avec l'exe + ses dlls/QML.
Démarrage instantané (pas d'extraction tmpdir comme `--onefile`). L'utilisateur
peut zipper le dossier pour le transporter.

Lancer :
    .venv\\Scripts\\python.exe -m pyinstaller prandia.spec --noconfirm

Ou via `build.bat` à la racine.

Préfère `Tree(...)` pour bundler un dossier complet sans avoir à lister chaque
fichier.
"""

from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

PROJECT_ROOT = Path(SPECPATH).resolve()


# ---- Données à embarquer dans le bundle ----
# `(source, dest)` : src est le chemin local, dest est le sous-dossier du bundle.
datas = [
    # Toute la couche QML (Theme, components, pages, dialogs).
    (str(PROJECT_ROOT / "app" / "ui" / "qml"), "app/ui/qml"),
    # Seeds CIQUAL — l'utilisateur final pourra appeler le loader pour peupler
    # sa DB la première fois (cf. README). Si le dossier est vide, c'est OK.
    (str(PROJECT_ROOT / "app" / "data" / "seeds"), "app/data/seeds"),
]


# ---- Hidden imports ----
# PyInstaller analyse les imports statiques mais loupe les chargements dynamiques
# (Pillow ouvre ses plugins format-par-format via importlib).
hiddenimports = [
    "PIL.Image",
    "PIL.JpegImagePlugin",
    "PIL.PngImagePlugin",
    "PIL.WebPImagePlugin",
    "PIL.GifImagePlugin",
    "PIL.BmpImagePlugin",
    # SQLAlchemy charge dynamiquement le dialect via le scheme d'URL
    "sqlalchemy.dialects.sqlite",
    # Pour `xlrd` (lecture .xls CIQUAL)
    "xlrd",
]


a = Analysis(
    [str(PROJECT_ROOT / "app" / "main.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # On n'utilise pas ces modules — gain de quelques Mo
        "tkinter",
        "test",
        "unittest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="prandia",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                    # UPX peut casser les dlls Qt — on évite
    console=False,                # Pas de console window pour l'app GUI
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,                    # TODO: ajouter une icône .ico plus tard
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="prandia",
)
