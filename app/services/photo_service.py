"""Recipe photo storage service.

Photos sont stockées sous `~/.prandia/recipe_photos/<recipe_id>.jpg`.
Le `image_path` en DB est le **nom de fichier seulement** (chemin relatif au
dossier de photos) — ça permet de déplacer le projet sans casser les liens.

Pillow s'occupe du resize+recompress :
  - max 1024×1024 (préserve le ratio)
  - JPEG quality 85 (~150-300 Ko par photo, vs 5-10 Mo pour un PNG 4K brut)
  - EXIF rotation appliquée (sinon les photos verticales d'iPhone apparaissent
    couchées)
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import httpx
from PIL import Image, ImageOps

log = logging.getLogger(__name__)

_MAX_DIMENSION = 1024
_JPEG_QUALITY = 85
# Téléchargements distants : le User-Agent identifie l'app, et le timeout est
# court pour ne pas bloquer un import URL si l'image est lente.
_DOWNLOAD_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_DOWNLOAD_USER_AGENT = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
# Garde-fou anti-fichier énorme — on stoppe au-delà de 20 Mo (Pillow gère
# bien jusqu'à plusieurs centaines de Mo mais ça consommerait de la RAM
# inutilement pour une photo de recette).
_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024


def default_photo_dir() -> Path:
    """Where recipe photos live. Override with PRANDIA_PHOTO_DIR.

    Default: `~/.prandia/recipe_photos/`. Created on demand.
    """
    override = os.environ.get("PRANDIA_PHOTO_DIR")
    if override:
        return Path(override)
    return Path.home() / ".prandia" / "recipe_photos"


def absolute_photo_path(image_path: str | None, photo_dir: Path | None = None) -> Path | None:
    """Resolve a `recipe.image_path` (filename only) to an absolute Path.
    Returns None when the recipe has no photo or the file is missing on disk.

    A2 : when `image_path` is set but the file is missing (user deleted it
    accidentally from disk), we log a warning the first time so the issue
    is diagnosable from `~/.prandia/logs/app.log`. The QML side
    falls back to a placeholder ("🍽 Aucune photo")."""
    if not image_path:
        return None
    photo_dir = photo_dir or default_photo_dir()
    abs_path = photo_dir / image_path
    if not abs_path.exists():
        log.warning("Photo file referenced but missing on disk: %s", abs_path)
        return None
    return abs_path


def save_recipe_photo(
    src_path: Path | str,
    recipe_id: int,
    photo_dir: Path | None = None,
) -> str:
    """Resize and store a photo for the given recipe. Returns the **filename
    only** (e.g. `42.jpg`) — the caller is responsible for storing it on
    `recipe.image_path`.

    Steps :
      1. Open source image (Pillow auto-detects format).
      2. Apply EXIF orientation (avoids upside-down phone photos).
      3. Resize to at most 1024×1024 preserving aspect ratio.
      4. Convert to RGB (JPEG doesn't support alpha).
      5. Write as `<photo_dir>/<recipe_id>.jpg` with quality 85.

    Raises:
      FileNotFoundError if `src_path` doesn't exist.
      OSError / PIL.UnidentifiedImageError if the format isn't supported.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Source image not found: {src}")

    photo_dir = photo_dir or default_photo_dir()
    photo_dir.mkdir(parents=True, exist_ok=True)
    target_filename = f"{recipe_id}.jpg"
    target = photo_dir / target_filename

    with Image.open(src) as img:
        # 2. Apply EXIF orientation (iPhone, Android — pictures shot in
        # portrait have an EXIF Orientation tag rather than rotated pixels).
        img = ImageOps.exif_transpose(img)

        # 3. Resize. `thumbnail` is in-place + preserves ratio + skips when
        # the image is already smaller than the target.
        img.thumbnail((_MAX_DIMENSION, _MAX_DIMENSION), Image.Resampling.LANCZOS)

        # 4. JPEG-compatible mode.
        if img.mode in ("RGBA", "LA", "P"):
            # Flatten transparency onto white (most recipe photos don't need
            # transparency anyway).
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            background.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # 5. Save.
        img.save(target, "JPEG", quality=_JPEG_QUALITY, optimize=True)

    log.info("Saved recipe photo: %s (src=%s, %d bytes)", target_filename, src.name, target.stat().st_size)
    return target_filename


def save_recipe_photo_from_http_url(
    url: str,
    recipe_id: int,
    photo_dir: Path | None = None,
    *,
    client: httpx.Client | None = None,
) -> str:
    """Télécharge une image depuis `url` et la persiste comme photo de recette.

    Utilisé par :
      - le wizard d'import URL (au commit, si `ExtractedRecipe.image_url` est défini)
      - le drag-drop d'une URL HTTP(S) sur `RecipePhotoBlock`

    Stratégie :
      1. GET via httpx (User-Agent + timeout, redirects suivis)
      2. Lecture streamée bornée à 20 Mo (anti-fichier énorme)
      3. Écriture dans un fichier temporaire avec l'extension détectée
      4. Délégation à `save_recipe_photo` qui resize/recompresse en JPEG
      5. Cleanup du temp dans tous les cas (try/finally)

    Param `client` injectable pour les tests (`httpx.MockTransport`).

    Raises :
      OSError / httpx.HTTPError sur erreur réseau / HTTP 4xx-5xx.
      PIL.UnidentifiedImageError si le téléchargement n'est pas une image.
    """
    if not url or not url.strip():
        raise ValueError("URL vide.")

    own_client = client is None
    client = client or httpx.Client(
        timeout=_DOWNLOAD_TIMEOUT,
        headers={"User-Agent": _DOWNLOAD_USER_AGENT},
        follow_redirects=True,
    )
    tmp_path: Path | None = None
    try:
        # On utilise GET classique (pas streaming) — les images recettes font
        # rarement plus que quelques centaines de Ko ; le garde-fou de 20 Mo
        # empêche les abus.
        resp = client.get(url)
        resp.raise_for_status()
        content = resp.content
        if len(content) > _MAX_DOWNLOAD_BYTES:
            raise OSError(
                f"Image trop volumineuse ({len(content)} bytes ; max "
                f"{_MAX_DOWNLOAD_BYTES})."
            )

        # Détection d'extension grossière depuis l'URL ; Pillow lit n'importe
        # quel format reconnu, mais l'extension du fichier temp aide les outils
        # qui inspectent le nom (peu critique).
        suffix = ".img"
        for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"):
            if url.lower().split("?", 1)[0].endswith(ext):
                suffix = ext
                break

        with tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, prefix="recipe-photo-",
        ) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)

        return save_recipe_photo(tmp_path, recipe_id, photo_dir=photo_dir)
    finally:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError as exc:
                log.warning("Could not delete temp photo file %s: %s", tmp_path, exc)
        if own_client:
            client.close()


def delete_recipe_photo(image_path: str | None, photo_dir: Path | None = None) -> bool:
    """Delete the photo file, if it exists. Returns True if a file was deleted,
    False otherwise. Errors during unlink are logged and swallowed."""
    if not image_path:
        return False
    photo_dir = photo_dir or default_photo_dir()
    target = photo_dir / image_path
    if not target.exists():
        return False
    try:
        target.unlink()
        log.info("Deleted recipe photo: %s", image_path)
        return True
    except OSError as exc:
        log.warning("Could not delete photo %s: %s", target, exc)
        return False
