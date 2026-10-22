"""Cut the two buddy illustrations out of their source images and write web-sized sprites.

  rembg python scripts/make_companions.py "E:/Downloads/<robots>.png" "E:/Downloads/<orbs>.png"

Needs: pillow numpy rembg onnxruntime (the first run downloads a small segmentation model, about 170 MB,
to your home folder; everything after that is offline). Outputs go to assets/companions/ and are copied
into each extension and the dashboard.

  robot-family.png / robot-adult.png    full-body buddies (the door robot and the ring robot)
  orb-family.png   / orb-adult.png      small round avatars (popups, toasts)
  *-head.png                            head-only crops for tiny spaces
"""
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "companions"
COPIES = {"extension": ROOT / "extension" / "companion", "shield": ROOT / "shield" / "companion",
          "dashboard": ROOT / "dashboard" / "img"}


# Crop away the transparent border, keeping `pad` pixels.
def trim(img, pad=6):
    a = np.array(img)[..., 3]
    ys, xs = np.where(a > 8)
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad, img.width), min(ys.max() + pad, img.height))
    return img.crop(box)


def fit_height(img, h):
    return img.resize((round(img.width * h / img.height), h), Image.LANCZOS)


# Write the image at each requested height (full size and '-sm' small).
def save(img, name, heights):
    for tag, h in heights.items():
        fit_height(img, h).save(OUT / f"{name}{tag}.png", optimize=True)


# Cut each full-body robot out of the source picture (background removal) and save it with a small version and a head-only crop.
def robots(path):
    from rembg import new_session, remove
    src = Image.open(path).convert("RGB")
    session = new_session("u2net")
    w = src.width // 2
    for name, box in (("robot-family", (0, 0, w, src.height)), ("robot-adult", (w, 0, src.width, src.height))):
        half = src.crop(box)
        cut = remove(half, session=session, alpha_matting=True, alpha_matting_foreground_threshold=235,
                     alpha_matting_background_threshold=20, alpha_matting_erode_size=6)
        cut = trim(cut.convert("RGBA"))
        save(cut, name, {"": 520, "-sm": 240})
        # head crop: the top ~46% of the figure, for tiny spaces
        head = cut.crop((0, 0, cut.width, int(cut.height * 0.46)))
        save(trim(head), name + "-head", {"": 160})
        print("robot", name, cut.size)


# Cut out the two round avatars, dropping the speckled fringe around their glow.
def orbs(path):
    src = Image.open(path).convert("RGBA")
    a = np.array(src).astype(np.float32)
    # the source has speckled, near-white fringe pixels around the glow: drop faint ones, soften the rest
    alpha = a[..., 3]
    alpha[alpha < 70] = 0
    a[..., 3] = alpha
    cleaned = Image.fromarray(a.astype(np.uint8), "RGBA")
    w = cleaned.width // 2
    for name, box in (("orb-family", (0, 0, w, cleaned.height)), ("orb-adult", (w, 0, cleaned.width, cleaned.height))):
        part = trim(cleaned.crop(box), pad=10)
        save(part, name, {"": 360, "-sm": 120})
        print("orb", name, part.size)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    robots(sys.argv[1])
    orbs(sys.argv[2])
    for dest in COPIES.values():
        dest.mkdir(parents=True, exist_ok=True)
        for f in OUT.glob("*.png"):
            shutil.copyfile(f, dest / f.name)
    print("copied to", ", ".join(str(d.relative_to(ROOT)) for d in COPIES.values()))
