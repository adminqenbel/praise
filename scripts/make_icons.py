"""Draw the door-and-lamp icons for the extension (no image libraries needed).  python scripts/make_icons.py"""
import struct, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# Write one square PNG by hand: a door shape (rounded top) in the leaf colour with a round knob in the dot colour, on a transparent background.
def png(size, leaf, dot, path):
    clear = (0, 0, 0, 0)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            u, v = (x + .5) / size, (y + .5) / size
            inside = (v >= .46 and .04 <= u <= .96) or ((u - .5) ** 2 + (v - .46) ** 2 <= .46 ** 2 and v < .46)
            px = clear if not inside else leaf
            if inside and ((u - .72) ** 2 + (v - .62) ** 2 <= .085 ** 2):
                px = dot
            row += bytes(px)
        rows.append(bytes(row))
    # A PNG file is a sequence of chunks, each with a length, a type, data and a checksum.
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
    Path(path).write_bytes(data)


# One extension, three looks: neutral until a pairing code is accepted, then the family or the personal colours.
LOOKS = {
    "": ((0x4a, 0x5d, 0x73, 255), (0xf2, 0xf5, 0xf4, 255)),            # neutral (the manifest's own icons)
    "family-": ((0x8b, 0x5c, 0xf6, 255), (0xff, 0xb6, 0x27, 255)),
    "adult-": ((0x2f, 0xbf, 0x9b, 255), (0xff, 0xb6, 0x27, 255)),
}
(ROOT / "extension" / "icons").mkdir(exist_ok=True)
for prefix, (leaf, dot) in LOOKS.items():
    for s in (16, 48, 128):
        png(s, leaf, dot, ROOT / "extension" / "icons" / f"{prefix}{s}.png")
print("icons written")
