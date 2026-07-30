#!/usr/bin/env python3
"""Build transparent, platform-ready Manga Sub application icons."""

from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "icon-source.png"
PNG = ROOT / "build" / "icon.png"
ICNS = ROOT / "build" / "icon.icns"
CANVAS = 1024
VISIBLE = 900
OFFSET = (CANVAS - VISIBLE) // 2


def render_png() -> None:
    source_path = SOURCE if SOURCE.exists() else PNG
    source = Image.open(source_path).convert("RGB")
    source = source.resize((VISIBLE, VISIBLE), Image.Resampling.LANCZOS)

    scale = 4
    mask_large = Image.new("L", (VISIBLE * scale, VISIBLE * scale), 0)
    draw = ImageDraw.Draw(mask_large)
    draw.rounded_rectangle(
        (0, 0, VISIBLE * scale - 1, VISIBLE * scale - 1),
        radius=205 * scale,
        fill=255,
    )
    mask = mask_large.resize((VISIBLE, VISIBLE), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(source, (OFFSET, OFFSET), mask)
    canvas.save(PNG, optimize=True)


def render_icns() -> None:
    with tempfile.TemporaryDirectory(prefix="manga-sub-icon-") as directory:
        iconset = Path(directory) / "MangaSub.iconset"
        iconset.mkdir()
        source = Image.open(PNG).convert("RGBA")
        for size in (16, 32, 128, 256, 512):
            regular = source.resize((size, size), Image.Resampling.LANCZOS)
            regular.save(iconset / f"icon_{size}x{size}.png")
            retina = source.resize((size * 2, size * 2), Image.Resampling.LANCZOS)
            retina.save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)],
            check=True,
        )


def main() -> None:
    if not SOURCE.exists():
        shutil.copy2(PNG, SOURCE)
    render_png()
    render_icns()
    image = Image.open(PNG)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0))[3] == 0
    assert image.getbbox() == (OFFSET, OFFSET, CANVAS - OFFSET, CANVAS - OFFSET)


if __name__ == "__main__":
    main()
