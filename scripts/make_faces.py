"""Draw the buddies' expressions.

Each robot's face is a dark glass panel with two glowing smiling eyes. For every other mood this script
smooths the original eyes away (so the glass keeps its own shading), draws new eyes, and saves a small
transparent overlay that the UI places over the base sprite. "happy" and "nod" are the original face.

    python scripts/make_faces.py        (needs assets/companions/robot-*.png from make_companions.py)

Writes assets/companions/face-<who>-<mood>.png and assets/companions/faces.json (where each overlay sits,
as percentages of the sprite), then copies them next to the sprites.
"""
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "companions"
COPIES = [ROOT / "extension" / "companion", ROOT / "shield" / "companion", ROOT / "dashboard" / "img"]

# Measured on the 520px-tall sprites (percent of sprite width/height).
# Per robot: where its dark glass 'band' is, where the two eyes sit, their size and the glow, eye and blush colours.
ROBOTS = {
    "family": {"band": (33, 26, 90, 55), "eyes": ((48.3, 41.0), (75.0, 41.0)), "eye_w": 14.0, "eye_h": 6.0,
               "eye": (238, 224, 255), "glow": (190, 160, 255), "blush": (255, 150, 200)},
    "adult": {"band": (19, 20, 78, 45), "eyes": ((34.7, 33.0), (61.9, 33.0)), "eye_w": 14.5, "eye_h": 5.8,
              "eye": (170, 255, 252), "glow": (60, 230, 220), "blush": (140, 255, 230)},
}
SS = 4  # draw at 4x and shrink for smooth edges


def gauss(arr, sigma):
    """Separable gaussian blur of an (h, w, c) float array (no scipy needed)."""
    r = int(sigma * 3) + 1
    k = np.exp(-(np.arange(-r, r + 1) ** 2) / (2 * sigma ** 2)); k /= k.sum()
    out = arr.copy()
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim; pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        out = sum(np.take(p, range(i, i + out.shape[axis]), axis=axis) * k[i] for i in range(len(k)))
    return out


# Smooth the original eyes away so the glass keeps its own shading.
def erase_eyes(band_rgb, eye_mask):
    """Fill the eye pixels from their surroundings (normalised convolution) so the glass shading stays."""
    w = (1 - eye_mask)[..., None]
    num = gauss(band_rgb * w, 9)
    den = gauss(w, 9)
    fill = np.where(den > .02, num / np.maximum(den, 1e-6), np.median(band_rgb.reshape(-1, 3), axis=0))
    return band_rgb * w + fill * (1 - w)


# Draw the new eyes (and brows and blush) for one mood at 4x size.
def eye_layer(size, cfg, mood, W, H, band):
    """Return (crisp L-image at SS scale) shapes for the mood, in band coordinates."""
    bw, bh = size
    layer = Image.new("L", (bw * SS, bh * SS), 0)
    d = ImageDraw.Draw(layer)
    bx0, by0 = band[0] * W / 100, band[1] * H / 100
    ew, eh = cfg["eye_w"] * W / 100, cfg["eye_h"] * H / 100
    brows = Image.new("L", layer.size, 0); bd = ImageDraw.Draw(brows)
    blush = Image.new("L", layer.size, 0); sd = ImageDraw.Draw(blush)

    def P(x, y):  # percent -> band pixels at SS scale
        return ((x * W / 100 - bx0) * SS, (y * H / 100 - by0) * SS)

    for i, (ex, ey) in enumerate(cfg["eyes"]):
        cx, cy = P(ex, ey)
        s = SS
        if mood == "curious":            # tall rounded pills, like a wide-awake stare
            w, h = ew * .42 * s, eh * 2.5 * s
            d.rounded_rectangle([cx - w / 2, cy - h / 2 - eh * .2 * s, cx + w / 2, cy + h / 2 - eh * .2 * s], radius=w / 2, fill=255)
        elif mood == "look":             # plain round eyes: what the buddy uses when it follows the pointer
            r = eh * .88 * s
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
        elif mood == "alert":            # bigger, taller, a touch wider apart
            w, h = ew * .52 * s, eh * 3.0 * s
            d.rounded_rectangle([cx - w / 2, cy - h / 2 - eh * .3 * s, cx + w / 2, cy + h / 2 - eh * .3 * s], radius=w / 2, fill=255)
        elif mood == "thinking":         # round eyes glancing up and to the side
            r = eh * .78 * s
            ox, oy = (ew * .22 * s, -eh * .75 * s)
            d.ellipse([cx + ox - r, cy + oy - r, cx + ox + r, cy + oy + r], fill=255)
        elif mood in ("sleepy", "blink"):  # closed: a flat, slightly curved line
            w = ew * (.86 if mood == "sleepy" else .78) * s
            y = cy + eh * (.45 if mood == "sleepy" else .2) * s
            d.line([cx - w / 2, y, cx + w / 2, y], fill=255, width=int(eh * .38 * s))
            for sx in (cx - w / 2, cx + w / 2):
                d.ellipse([sx - eh * .19 * s, y - eh * .19 * s, sx + eh * .19 * s, y + eh * .19 * s], fill=255)
        elif mood == "sorry":            # round, glassy eyes with worried brows
            r = eh * .95 * s
            d.ellipse([cx - r, cy - r + eh * .35 * s, cx + r, cy + r + eh * .35 * s], fill=255)
            t = -1 if i == 0 else 1       # inner ends of the brows are higher
            bd.line([cx + (-t) * ew * .42 * s, cy - eh * 1.95 * s, cx + t * ew * .42 * s, cy - eh * 1.35 * s],
                    fill=255, width=int(eh * .32 * s))
        elif mood == "shy":              # small happy arcs plus a blush
            w, h = ew * .8 * s, eh * 1.5 * s
            d.arc([cx - w / 2, cy - h / 2 + eh * .3 * s, cx + w / 2, cy + h / 2 + eh * .9 * s], 200, 340, fill=255, width=int(eh * .42 * s))
            bxc, byc = cx, cy + eh * 1.55 * s
            sd.ellipse([bxc - ew * .5 * s, byc - eh * .5 * s, bxc + ew * .5 * s, byc + eh * .5 * s], fill=255)
    return layer, brows, blush


def colorize(mask_l, rgb, alpha=1.0):
    a = np.array(mask_l).astype(np.float32) / 255 * alpha
    return np.dstack([np.full_like(a, c) for c in rgb] + [a])


# Build one expression overlay: erase the original eyes, draw the mood's eyes with a soft glow, and keep only two soft ovals around the eyes so nothing else changes.
def make(who, cfg, mood, base):
    W, H = base.size
    x0, y0, x1, y1 = cfg["band"]
    box = (round(x0 * W / 100), round(y0 * H / 100), round(x1 * W / 100), round(y1 * H / 100))
    band = base.crop(box)
    arr = np.array(band).astype(np.float32)
    rgb, alpha = arr[..., :3], arr[..., 3:] / 255
    lum = rgb.mean(axis=2)
    ref = np.median(lum[alpha[..., 0] > .9])
    # only pixels near where the eyes actually are count as "eye": the rim of the helmet is bright too
    near = np.zeros(lum.shape, bool)
    yy, xx = np.mgrid[0:lum.shape[0], 0:lum.shape[1]]
    for ex, ey in cfg["eyes"]:
        cx, cy = ex * W / 100 - box[0], ey * H / 100 - box[1]
        near |= ((xx - cx) / (cfg["eye_w"] * W / 100 * .75)) ** 2 + ((yy - cy) / (cfg["eye_h"] * H / 100 * 2.2)) ** 2 < 1
    eye_mask = ((lum > ref + 30) & (alpha[..., 0] > .9) & near).astype(np.float32)
    eye_mask = np.array(Image.fromarray((eye_mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(17))).astype(np.float32) / 255
    clean = erase_eyes(rgb, eye_mask)

    layer, brows, blush = eye_layer(band.size, cfg, mood, W, H, cfg["band"])
    shrink = lambda im: im.resize(band.size, Image.LANCZOS)
    eyes_l, brows_l, blush_l = shrink(layer), shrink(brows), shrink(blush)
    eye_all = Image.fromarray(np.maximum(np.array(eyes_l), np.array(brows_l)))
    glow = np.array(eye_all.filter(ImageFilter.GaussianBlur(5))).astype(np.float32) / 255

    out = clean.copy()
    g = np.array(cfg["glow"], dtype=np.float32)
    out = out + (g - out) * np.clip(glow[..., None] * .85, 0, 1)                   # soft glow
    bl = np.array(blush_l).astype(np.float32)[..., None] / 255 * .4
    out = out + (np.array(cfg["blush"], dtype=np.float32) - out) * bl                # blush
    e = np.array(eye_all).astype(np.float32)[..., None] / 255
    out = out + (np.array(cfg["eye"], dtype=np.float32) - out) * e                   # crisp eyes

    # the overlay is two soft ovals, one around each eye: everything else (the glass highlight, the rim)
    # stays the original, and a tall eye can never be clipped by a rectangular edge
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    soft = np.zeros((h, w), np.float32)
    for ex, ey in cfg["eyes"]:
        cx, cy = ex * W / 100 - box[0], ey * H / 100 - box[1]
        d = np.sqrt(((xx - cx) / (cfg["eye_w"] * W / 100 * .95)) ** 2 + ((yy - cy) / (cfg["eye_h"] * H / 100 * 2.9)) ** 2)
        soft = np.maximum(soft, np.clip((1.0 - d) / 0.4, 0, 1))
    rgba = np.dstack([np.clip(out, 0, 255), soft * (alpha[..., 0] > .5) * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


# Make every mood for both robots, write faces.json (where each overlay sits) and copy the results next to the sprites.
def main():
    layout = {}
    for who, cfg in ROBOTS.items():
        base = Image.open(OUT / f"robot-{who}.png").convert("RGBA")
        W, H = base.size
        layout[who] = {"band": cfg["band"], "aspect": [W, H]}
        for mood in ("curious", "thinking", "sleepy", "alert", "sorry", "shy", "blink", "look"):
            make(who, cfg, mood, base).save(OUT / f"face-{who}-{mood}.png", optimize=True)
    (OUT / "faces.json").write_text(json.dumps(layout, indent=1))
    for dest in COPIES:
        dest.mkdir(parents=True, exist_ok=True)
        for f in list(OUT.glob("face-*.png")) + [OUT / "faces.json"]:
            shutil.copyfile(f, dest / f.name)
    print("faces written:", len(list(OUT.glob("face-*.png"))))


if __name__ == "__main__":
    main()
