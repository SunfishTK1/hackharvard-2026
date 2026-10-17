"""Draws the card art and icons in the game's black-and-white style.

Writes public/card.jpg (iMessage card), public/og.png (link preview), public/icon.png, and the
iOS app and iMessage icons. Run from Charles-Sprint/: python3 scripts/make-art.py (needs Pillow).
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
BLACK, WHITE = (0, 0, 0), (255, 255, 255)


def font(size, bold=True):
    # HelveticaNeue.ttc index 1 is Bold; 0 is Regular.
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def scene(w, h, s, title=True):
    """River, banks, bridge and an eight. `s` scales line widths."""
    img = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(img)
    cx = lambda y: w / 2 + math.sin(y / (h * 0.35)) * w * 0.06
    half = w * 0.30
    # Hatched banks.
    for k in range(-h, w + h, int(12 * s)):
        d.line([(k, h), (k + h, 0)], fill=BLACK, width=max(1, int(1.6 * s)))
    pts = [(cx(y), y) for y in range(-10, h + 11, 4)]
    d.polygon([(x - half, y) for x, y in pts] + [(x + half, y) for x, y in reversed(pts)], fill=WHITE)
    for side in (-1, 1):
        d.line([(x + side * half, y) for x, y in pts], fill=BLACK, width=int(4 * s))
        d.line([(x + side * (half + 16 * s), y) for x, y in pts], fill=BLACK, width=int(2 * s))
    # Ripples.
    for i, y in enumerate(range(int(18 * s), h, int(26 * s))):
        f = (math.sin(i * 12.9898) * 43758.5453) % 1
        x = cx(y) - half + 24 * s + f * (half * 2 - 48 * s)
        d.line([(x, y), (x + (8 + f * 14) * s, y)], fill=BLACK, width=int(2 * s))
    # Bridge near the top with three arches.
    by, deck = h * 0.30, 34 * s
    x0, x1 = cx(by) - half - 30 * s, cx(by) + half + 30 * s
    d.rectangle([x0, by - deck, x1, by], fill=BLACK)
    span = half * 2 / 3
    for i in range(3):
        ax = cx(by) - half + span * (i + 0.5)
        d.pieslice([ax - span * 0.38, by - deck * 0.62, ax + span * 0.38, by + deck * 0.62], 180, 360, fill=WHITE)
    d.line([(x0, by - deck + 5 * s), (x1, by - deck + 5 * s)], fill=WHITE, width=int(2 * s))
    # The eight, mid-stroke.
    bx, boy, ln = cx(h * 0.70), h * 0.70, min(h * 0.42, 72 * s * 1.6)
    for i in range(8):
        side = 1 if i % 2 else -1
        oy = boy - ln / 2 + 14 * s + i * ((ln - 26 * s) / 7)
        tx, ty = bx + side * 40 * s, oy + 10 * s
        d.line([(bx + side * 4 * s, oy), (tx, ty)], fill=BLACK, width=int(2.4 * s))
        d.rectangle([tx - 5 * s, ty - 3 * s, tx + 5 * s, ty + 3 * s], fill=BLACK)
    hull = [(bx + math.sin(t) * 9 * s * math.sin(t), boy - math.cos(t) * ln / 2) for t in [i * math.pi / 30 for i in range(31)]]
    hull += [(bx - math.sin(t) * 9 * s * math.sin(t), boy + math.cos(t) * ln / 2) for t in [i * math.pi / 30 for i in range(31)]]
    d.polygon(hull, fill=WHITE, outline=BLACK, width=int(3 * s))
    for i in range(8):
        oy = boy - ln / 2 + 14 * s + i * ((ln - 26 * s) / 7)
        r = 2.6 * s
        d.ellipse([bx - r, oy - r, bx + r, oy + r], fill=BLACK)
    if title:
        f1, f2 = font(int(64 * s)), font(int(20 * s))
        lines = ["CHARLES", "SPRINT"]
        tw = max(d.textlength(t, font=f1) for t in lines)
        pad = 22 * s
        bx0, by0 = 34 * s, h - 34 * s - (64 * 2 + 30 + 20) * s - pad * 2
        box = [bx0, by0, bx0 + tw + pad * 2, h - 34 * s]
        d.rectangle([box[0] + 10 * s, box[1] + 10 * s, box[2] + 10 * s, box[3] + 10 * s], fill=BLACK)
        d.rectangle(box, fill=WHITE, outline=BLACK, width=int(5 * s))
        y = by0 + pad - 8 * s
        for t in lines:
            d.text((bx0 + pad, y), t, font=f1, fill=BLACK)
            y += 60 * s
        d.text((bx0 + pad, y + 12 * s), "500 M · TAP TO ROW", font=f2, fill=BLACK)
    return img


def icon(size):
    """Square icon: black field, white hull and oars, heavy frame."""
    img = Image.new("RGB", (size, size), BLACK)
    d = ImageDraw.Draw(img)
    s = size / 1024
    cx, cy, ln = size / 2, size / 2, 760 * s
    for i in range(8):
        side = 1 if i % 2 else -1
        oy = cy - ln / 2 + 120 * s + i * ((ln - 240 * s) / 7)
        tx, ty = cx + side * 330 * s, oy + 70 * s
        d.line([(cx, oy), (tx, ty)], fill=WHITE, width=int(22 * s))
        d.rectangle([tx - 46 * s, ty - 24 * s, tx + 46 * s, ty + 24 * s], fill=WHITE)
    steps = [i * math.pi / 40 for i in range(41)]
    hull = [(cx + math.sin(t) ** 2 * 92 * s, cy - math.cos(t) * ln / 2) for t in steps]
    hull += [(cx - math.sin(t) ** 2 * 92 * s, cy + math.cos(t) * ln / 2) for t in steps]
    d.polygon(hull, fill=WHITE)
    for i in range(8):
        oy = cy - ln / 2 + 120 * s + i * ((ln - 240 * s) / 7)
        r = 22 * s
        d.ellipse([cx - r, oy - r, cx + r, oy + r], fill=BLACK)
    return img


def messages_icon(w, h):
    """iMessage app icons are 4:3; center the square icon on black."""
    img = Image.new("RGB", (w, h), BLACK)
    sq = icon(h).resize((h, h), Image.LANCZOS)
    img.paste(sq, ((w - h) // 2, 0))
    return img


def main():
    public = ROOT / "public"
    public.mkdir(exist_ok=True)
    scene(1200, 800, 2.0).save(public / "card.jpg", quality=88)
    scene(1200, 630, 1.7).save(public / "og.png")
    icon(512).save(public / "icon.png")

    ios = ROOT / "ios"
    app_icon = ios / "App" / "Assets.xcassets" / "AppIcon.appiconset"
    app_icon.mkdir(parents=True, exist_ok=True)
    icon(1024).save(app_icon / "icon-1024.png")
    (app_icon / "Contents.json").write_text(json.dumps({
        "images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n")

    # Sizes Xcode's iMessage App Icon set expects (points x scale).
    msg = ios / "MessagesExtension" / "Assets.xcassets" / "iMessage App Icon.stickersiconset"
    msg.mkdir(parents=True, exist_ok=True)
    slots = [
        ("iphone", "29x29", [2, 3]), ("iphone", "60x45", [2, 3]),
        ("ipad", "29x29", [2]), ("ipad", "67x50", [2]), ("ipad", "74x55", [2]),
        ("universal", "27x20", [2, 3]), ("universal", "32x24", [2, 3]),
        ("ios-marketing", "1024x768", [1]),
    ]
    images = []
    for idiom, size, scales in slots:
        pw, ph = (float(v) for v in size.split("x"))
        for sc in scales:
            name = f"icon-{size}@{sc}x-{idiom}.png"
            w, h = round(pw * sc), round(ph * sc)
            (icon(h).resize((w, h), Image.LANCZOS) if w == h else messages_icon(w, h)).save(msg / name)
            entry = {"filename": name, "idiom": idiom, "scale": f"{sc}x", "size": size}
            if idiom in ("universal", "ios-marketing"):
                entry["platform"] = "ios"
            images.append(entry)
    (msg / "Contents.json").write_text(json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
    for catalog in (ios / "App" / "Assets.xcassets", ios / "MessagesExtension" / "Assets.xcassets"):
        (catalog / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")


if __name__ == "__main__":
    main()
