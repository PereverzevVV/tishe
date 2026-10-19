"""Draws Tishe tray icons (64x64) from the logo's waveform, at 4x and downscaled."""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
S = 256  # drawing size; saved at 64
WHITE, BLACK = (255, 255, 255, 255), (0, 0, 0, 255)
SILVER, TILE = (205, 205, 210, 255), (17, 17, 19, 255)


def bars(draw, cx, cy, scale, color):
    """Five rounded bars, the logo's diamond silhouette."""
    w, gap = 30 * scale, 20 * scale
    heights = [88, 167, 232, 167, 88]
    total = 5 * w + 4 * gap
    x = cx - total / 2
    for h in heights:
        h *= scale
        draw.rounded_rectangle([x, cy - h / 2, x + w, cy + h / 2], radius=w * 0.45, fill=color)
        x += w + gap


def bars3(draw, cx, cy, scale, color):
    """Three thick bars: the waveform inside a circle, legible at 16 px."""
    w, gap = 46 * scale, 30 * scale
    heights = [120, 196, 120]
    total = 3 * w + 2 * gap
    x = cx - total / 2
    for h in heights:
        h *= scale
        draw.rounded_rectangle([x, cy - h / 2, x + w, cy + h / 2], radius=w * 0.45, fill=color)
        x += w + gap


def lines(draw, cx, cy, scale, color):
    """Three lines of text: speech turned into a document."""
    h, gap = 26 * scale, 22 * scale
    widths = [150, 150, 96]
    top = cy - (3 * h + 2 * gap) / 2
    left = cx - 150 * scale / 2
    for i, w in enumerate(widths):
        y = top + i * (h + gap)
        draw.rounded_rectangle([left, y, left + w * scale, y + h], radius=h / 2, fill=color)


def blank():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def cut(img, painter):
    """Make whatever `painter` draws transparent in img."""
    mask = Image.new("L", img.size, 0)
    painter(ImageDraw.Draw(mask), 255)
    clear = Image.new("RGBA", img.size, (0, 0, 0, 0))
    img.paste(clear, (0, 0), mask)
    return img


def idle(color):
    img = blank()
    bars(ImageDraw.Draw(img), S / 2, S / 2, 1.0, color)
    return img


def circle_with(color, inner):
    img = blank()
    ImageDraw.Draw(img).ellipse([2, 2, S - 3, S - 3], fill=color)
    return cut(img, lambda d, c: inner(d, S / 2, S / 2, 0.7, c))


def warning(color):
    img = idle(color)
    r, cx, cy = 54, S - 56, S - 56
    cut(img, lambda d, c: d.ellipse([cx - r - 12, cy - r - 12, cx + r + 12, cy + r + 12], fill=c))
    ImageDraw.Draw(img).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

    def mark(d, c):
        d.rounded_rectangle([cx - 10, cy - 36, cx + 10, cy + 10], radius=9, fill=c)
        d.ellipse([cx - 11, cy + 17, cx + 11, cy + 39], fill=c)

    return cut(img, mark)


def tile():
    """Colored theme (Linux): a small copy of the app icon."""
    img = blank()
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, S - 9, S - 9], radius=58, fill=TILE)
    bars(d, S / 2, S / 2, 0.72, SILVER)
    return img


def save(img, name):
    img.resize((64, 64), Image.LANCZOS).save(f"{OUT}/{name}", optimize=True)


save(idle(WHITE), "tray_idle.png")
save(idle(BLACK), "tray_idle_dark.png")
save(circle_with(WHITE, bars3), "tray_recording.png")
save(circle_with(BLACK, bars3), "tray_recording_dark.png")
save(circle_with(WHITE, lines), "tray_transcribing.png")
save(circle_with(BLACK, lines), "tray_transcribing_dark.png")
save(warning(WHITE), "tray_idle_warning.png")
save(warning(BLACK), "tray_idle_warning_dark.png")
save(tile(), "handy.png")
save(circle_with(SILVER, bars3), "recording.png")
save(circle_with(SILVER, lines), "transcribing.png")
w = tile()
save(w, "handy_warning.png")
