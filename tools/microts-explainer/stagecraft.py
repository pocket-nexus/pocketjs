"""Drawing toolkit for the MicroTS explainer video.

Scene code works in 1920x1080 logical pixels. The canvas draws at SS times that
size and downsamples with Lanczos on export, which is where the antialiasing
comes from. Colors are the site's brand tokens (site/assets/tokens.css).
"""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
WIDTH, HEIGHT = 1920, 1080
SS = 2

# Brand tokens from site/assets/tokens.css plus the mascot hues.
BG = "#171226"
BG2 = "#1c1630"
PANEL = "#231b3b"
PANEL2 = "#2b2148"
TERM = "#150f26"
INK = "#fcf6ff"
INK2 = "#cbbde2"
MUTED = "#8e80ac"
YELLOW = "#ffd23f"
PINK = "#ff5f9e"
PINK2 = "#ff7fb4"
CYAN = "#3fd0e8"
PURPLE = "#a98bff"
GREEN = "#4ade80"
RED = "#ff5d5d"
ORANGE = "#ff7a33"
RUST = "#f74c00"
TS_BLUE = "#3178c6"
JS_YELLOW = "#f7df1e"
OUTLINE = "#0d0918"

FONT_DIR = ROOT / "assets" / "fonts"
LATIN_BOLD = FONT_DIR / "InterDisplay-Bold.ttf"
LATIN_REGULAR = FONT_DIR / "InterDisplay-Regular.ttf"
MONO = FONT_DIR / "JetBrainsMono-Regular.ttf"
CJK_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
]
CJK_LIGHT_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/STHeiti Light.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
]

_font_cache: dict = {}


def _run_font(kind: str, is_cjk: bool) -> str:
    """Latin fonts carry no CJK glyphs; fall back per run instead of drawing tofu."""
    if not is_cjk:
        return kind
    return "cjk-light" if kind == "latin-light" else "cjk"


def _cjk_path(light: bool) -> tuple[str, int]:
    for path, index in CJK_LIGHT_CANDIDATES if light else CJK_CANDIDATES:
        if Path(path).exists():
            return path, index
    raise SystemExit(
        "No CJK font found. Install one of: " + ", ".join(p for p, _ in CJK_CANDIDATES)
    )


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    """kind: cjk, cjk-light, latin, latin-light, mono. Size is in device pixels."""
    key = (kind, size)
    hit = _font_cache.get(key)
    if hit is not None:
        return hit
    if kind == "cjk" or kind == "cjk-light":
        path, index = _cjk_path(kind == "cjk-light")
        made = ImageFont.truetype(path, size, index=index)
    elif kind == "latin":
        made = ImageFont.truetype(str(LATIN_BOLD), size)
    elif kind == "latin-light":
        made = ImageFont.truetype(str(LATIN_REGULAR), size)
    elif kind == "mono":
        made = ImageFont.truetype(str(MONO), size)
    else:
        raise ValueError(kind)
    _font_cache[key] = made
    return made


# ---------------------------------------------------------------- color helpers

def rgb(color) -> tuple[int, int, int]:
    if isinstance(color, tuple):
        return color[:3]
    text = color.lstrip("#")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t: float) -> tuple[int, int, int]:
    """Blend toward b. Fake transparency against a known background."""
    ca, cb = rgb(a), rgb(b)
    t = clamp(t, 0.0, 1.0)
    return tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))


def shade(color, amount: float) -> tuple[int, int, int]:
    """Negative darkens, positive lightens."""
    return mix(color, "#ffffff" if amount > 0 else "#000000", abs(amount))


# --------------------------------------------------------------- math and easing

def norm(box):
    """Boxes come from animated coordinates; keep them well ordered."""
    x0, y0, x1, y1 = box
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 0.0 if x < edge0 else 1.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)


def ease_out_cubic(t: float) -> float:
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t: float) -> float:
    t = clamp(t)
    return 3 * t * t - 2 * t * t * t


def ease_out_back(t: float, overshoot: float = 1.9) -> float:
    t = clamp(t)
    c = overshoot
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


def ease_out_elastic(t: float) -> float:
    t = clamp(t)
    if t in (0.0, 1.0):
        return t
    return 1 + 2 ** (-9 * t) * math.sin((t * 6.0 - 0.75) * math.pi)


def bounce_in(t: float) -> float:
    """0 at t=0, 1 at t=1, with a landing squash overshoot."""
    return ease_out_back(t, 2.4)


def pulse(t: float, hz: float = 1.0, phase: float = 0.0) -> float:
    """-1..1 sine."""
    return math.sin((t * hz + phase) * math.tau)


def wobble(seed: int, frame: int, amount: float, hold: int = 3) -> tuple[float, float]:
    """Deterministic hand-drawn jitter; holds for `hold` frames like cel animation."""
    r = random.Random((seed * 7919) ^ (frame // hold))
    return (r.uniform(-amount, amount), r.uniform(-amount, amount))


def cjk_runs(text: str):
    """Split into (is_cjk, chunk) runs so Latin words keep their proportional font."""
    runs = []
    for ch in text:
        is_cjk = (
            "⺀" <= ch <= "鿿"
            or "＀" <= ch <= "￯"
            or ch in "、。《》〈〉「」『』【】—…·°"
        )
        if runs and runs[-1][0] == is_cjk:
            runs[-1][1].append(ch)
        else:
            runs.append((is_cjk, [ch]))
    return [(is_cjk, "".join(chunk)) for is_cjk, chunk in runs]


# ------------------------------------------------------------------------ canvas

class Canvas:
    """Logical-pixel drawing surface. Every coordinate is scaled by ss."""

    def __init__(self, bg=BG, width: int = WIDTH, height: int = HEIGHT, ss: int = SS):
        self.ss = ss
        self.width = width
        self.height = height
        self.img = Image.new("RGB", (width * ss, height * ss), rgb(bg))
        self.d = ImageDraw.Draw(self.img)
        self.frame = 0
        self.ox = 0.0
        self.oy = 0.0

    # -- coordinate plumbing
    def shift(self, dx: float, dy: float) -> None:
        self.ox += dx
        self.oy += dy

    def _p(self, x: float, y: float):
        return ((x + self.ox) * self.ss, (y + self.oy) * self.ss)

    def _box(self, box):
        x0, y0, x1, y1 = norm(box)
        return [
            (x0 + self.ox) * self.ss,
            (y0 + self.oy) * self.ss,
            (x1 + self.ox) * self.ss,
            (y1 + self.oy) * self.ss,
        ]

    def _w(self, width: float) -> int:
        return max(1, round(width * self.ss))

    # -- primitives
    def rect(self, box, fill=None, outline=None, width: float = 0):
        self.d.rectangle(
            self._box(box),
            fill=rgb(fill) if fill else None,
            outline=rgb(outline) if outline else None,
            width=self._w(width) if outline else 0,
        )

    def rrect(self, box, radius: float, fill=None, outline=None, width: float = 0):
        x0, y0, x1, y1 = norm(box)
        radius = max(0.0, min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
        self.d.rounded_rectangle(
            self._box(box),
            radius=radius * self.ss,
            fill=rgb(fill) if fill else None,
            outline=rgb(outline) if outline else None,
            width=self._w(width) if outline else 0,
        )

    def ellipse(self, box, fill=None, outline=None, width: float = 0):
        self.d.ellipse(
            self._box(box),
            fill=rgb(fill) if fill else None,
            outline=rgb(outline) if outline else None,
            width=self._w(width) if outline else 0,
        )

    def circle(self, xy, r: float, fill=None, outline=None, width: float = 0):
        x, y = xy
        self.ellipse((x - r, y - r, x + r, y + r), fill, outline, width)

    def poly(self, points, fill=None, outline=None, width: float = 0):
        pts = [self._p(x, y) for x, y in points]
        self.d.polygon(pts, fill=rgb(fill) if fill else None, outline=None)
        if outline and width:
            closed = pts + [pts[0]]
            self.d.line(closed, fill=rgb(outline), width=self._w(width), joint="curve")

    def line(self, points, color, width: float = 3, caps: bool = True):
        pts = [self._p(x, y) for x, y in points]
        self.d.line(pts, fill=rgb(color), width=self._w(width), joint="curve")
        if caps:
            r = self._w(width) / 2
            for px, py in (pts[0], pts[-1]):
                self.d.ellipse([px - r, py - r, px + r, py + r], fill=rgb(color))

    def arc(self, box, start: float, end: float, color, width: float = 3):
        self.d.arc(self._box(box), start, end, fill=rgb(color), width=self._w(width))

    def curve(self, p0, p1, p2, color, width: float = 3, steps: int = 24):
        pts = []
        for i in range(steps + 1):
            t = i / steps
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
            pts.append((x, y))
        self.line(pts, color, width)

    def blend(self, color, alpha: float) -> None:
        """Flat fade layer over the whole frame."""
        if alpha <= 0:
            return
        top = Image.new("RGB", self.img.size, rgb(color))
        self.img = Image.blend(self.img, top, clamp(alpha))
        self.d = ImageDraw.Draw(self.img)

    # -- text
    def measure(self, text: str, size: float, kind: str = "cjk") -> float:
        px = round(size * self.ss)
        total = 0.0
        for is_cjk, chunk in cjk_runs(text):
            total += font(_run_font(kind, is_cjk), px).getlength(chunk)
        return total / self.ss

    def text(
        self,
        xy,
        text: str,
        size: float,
        color=INK,
        kind: str = "cjk",
        anchor: str = "lm",
        stroke: float = 0,
        stroke_fill=OUTLINE,
        shadow=None,
        shadow_offset=(0, 0),
    ):
        """anchor uses the x rule of PIL anchors (l/m/r) plus m/t/b vertically."""
        px = round(size * self.ss)
        width = self.measure(text, size, kind)
        x, y = xy
        if anchor[0] == "m":
            x -= width / 2
        elif anchor[0] == "r":
            x -= width
        vertical = anchor[1] if len(anchor) > 1 else "m"
        pil_anchor = "l" + {"m": "m", "t": "a", "b": "d", "s": "s"}[vertical]
        if shadow is not None:
            self._text_runs(
                (x + shadow_offset[0], y + shadow_offset[1]),
                text,
                px,
                shadow,
                kind,
                pil_anchor,
                0,
                stroke_fill,
            )
        self._text_runs((x, y), text, px, color, kind, pil_anchor, stroke, stroke_fill)
        return width

    def _text_runs(self, xy, text, px, color, kind, pil_anchor, stroke, stroke_fill):
        x, y = self._p(*xy)
        cursor = x
        for is_cjk, chunk in cjk_runs(text):
            use = font(_run_font(kind, is_cjk), px)
            self.d.text(
                (cursor, y),
                chunk,
                font=use,
                fill=rgb(color),
                anchor=pil_anchor,
                stroke_width=self._w(stroke) if stroke else 0,
                stroke_fill=rgb(stroke_fill),
            )
            cursor += use.getlength(chunk)

    def wrap(self, text: str, size: float, max_width: float, kind: str = "cjk"):
        """Break CJK at any character and Latin at spaces."""
        lines: list[str] = []
        current = ""
        tokens: list[str] = []
        for is_cjk, chunk in cjk_runs(text):
            if is_cjk:
                tokens.extend(list(chunk))
            else:
                for i, word in enumerate(chunk.split(" ")):
                    tokens.append((" " if i else "") + word)
        for token in tokens:
            if token in "，。、：；！？)）》」":
                current += token
                continue
            if current and self.measure(current + token, size, kind) > max_width:
                lines.append(current)
                current = token.lstrip(" ")
            else:
                current += token
        if current:
            lines.append(current)
        return lines

    def export(self) -> Image.Image:
        return self.img.resize((self.width, self.height), Image.LANCZOS)


# --------------------------------------------------------------- composite parts

def backdrop(c: Canvas, t: float, tint=BG, grid=True) -> None:
    """Arcade gradient wash, faint grid and drifting dust."""
    top = mix(tint, PURPLE, 0.06)
    bottom = mix(tint, "#000000", 0.25)
    bands = 48
    for i in range(bands):
        y0 = c.height * i / bands
        y1 = c.height * (i + 1) / bands + 1
        c.rect((0, y0, c.width, y1), fill=mix(top, bottom, i / (bands - 1)))
    if grid:
        step = 80
        color = mix(tint, PURPLE, 0.13)
        offset = (t * 10) % step
        for i in range(-1, c.width // step + 2):
            x = i * step + offset
            c.line([(x, 0), (x, c.height)], color, 1.2, caps=False)
        for i in range(c.height // step + 2):
            y = i * step
            c.line([(0, y), (c.width, y)], color, 1.2, caps=False)
    r = random.Random(4242)
    for i in range(34):
        bx = r.uniform(0, c.width)
        by = r.uniform(0, c.height)
        speed = r.uniform(6, 22)
        size = r.uniform(1.6, 4.2)
        hue = r.choice([YELLOW, PINK, CYAN, PURPLE])
        y = (by - t * speed) % (c.height + 40) - 20
        x = bx + math.sin(t * 0.6 + i) * 12
        c.circle((x, y), size, fill=mix(BG, hue, 0.45))


def sparkle(c: Canvas, xy, r: float, color=YELLOW, spin: float = 0.0) -> None:
    x, y = xy
    inner = r * 0.34
    pts = []
    for i in range(8):
        a = spin + i * math.pi / 4
        rad = r if i % 2 == 0 else inner
        pts.append((x + math.cos(a) * rad, y + math.sin(a) * rad))
    c.poly(pts, fill=color)


def burst(c: Canvas, xy, t: float, dur: float = 0.55, count: int = 12, color=YELLOW, spread: float = 150) -> None:
    """One-shot radial pop; t is seconds since the hit."""
    if t < 0 or t > dur:
        return
    k = clamp(t / dur)
    r = random.Random(hash(xy) & 0xFFFF)
    for i in range(count):
        a = i / count * math.tau + r.uniform(-0.2, 0.2)
        dist = spread * ease_out_cubic(k) * r.uniform(0.7, 1.25)
        size = lerp(11, 0, k) * r.uniform(0.7, 1.3)
        if size <= 0.6:
            continue
        hue = color if i % 3 else mix(color, INK, 0.5)
        sparkle(c, (xy[0] + math.cos(a) * dist, xy[1] + math.sin(a) * dist), size, hue, a)


def plate(
    c: Canvas,
    box,
    radius: float = 26,
    fill=PANEL,
    outline=None,
    width: float = 4,
    shadow: float = 10,
    accent=None,
) -> None:
    """Sticker panel: hard drop shadow, optional outline and left accent bar."""
    x0, y0, x1, y1 = norm(box)
    if shadow:
        c.rrect((x0 + shadow * 0.45, y0 + shadow, x1 + shadow * 0.45, y1 + shadow), radius, fill=mix(BG, "#000000", 0.55))
    c.rrect(box, radius, fill=fill, outline=outline, width=width)
    if accent:
        c.rrect((x0 + 10, y0 + 12, x0 + 20, y1 - 12), 5, fill=accent)


def badge(c: Canvas, xy, text: str, size: float = 30, fill=YELLOW, ink=OUTLINE, pad: float = 18, kind="cjk", radius=None):
    """Pill label centered on xy. Returns its box."""
    w = c.measure(text, size, kind) + pad * 2
    h = size * 1.72
    x, y = xy
    box = (x - w / 2, y - h / 2, x + w / 2, y + h / 2)
    c.rrect(box, radius if radius is not None else h / 2, fill=fill, outline=mix(fill, "#000000", 0.45), width=3)
    c.text((x, y + size * 0.03), text, size, ink, kind, anchor="mm")
    return box


def stamp(c: Canvas, xy, text: str, t: float, size: float = 46, fill=PINK, ink=INK, angle: float = -8):
    """Rubber-stamp entrance: overshoot down, then settle. t is since the hit."""
    if t < 0:
        return
    k = clamp(t / 0.28)
    scale = lerp(2.3, 1.0, ease_out_cubic(k)) if k < 1 else 1.0
    if t > 0.28:
        scale = 1 + 0.04 * math.exp(-(t - 0.28) * 8) * math.sin((t - 0.28) * 40)
    w = c.measure(text, size, "cjk") + 46
    h = size * 1.9
    x, y = xy
    layer = Image.new("RGBA", (round(w * c.ss * 2.6), round(h * c.ss * 2.6)), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    cx, cy = layer.size[0] / 2, layer.size[1] / 2
    bw, bh = w * c.ss, h * c.ss
    ld.rounded_rectangle(
        [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
        radius=14 * c.ss,
        fill=rgb(fill) + (255,),
        outline=rgb(shade(fill, -0.45)) + (255,),
        width=max(1, round(4 * c.ss)),
    )
    px = round(size * c.ss)
    cursor = cx - c.measure(text, size, "cjk") * c.ss / 2
    for is_cjk, chunk in cjk_runs(text):
        use = font("cjk" if is_cjk else "latin", px)
        ld.text((cursor, cy), chunk, font=use, fill=rgb(ink) + (255,), anchor="lm")
        cursor += use.getlength(chunk)
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=False)
    if scale != 1.0:
        size_px = (max(1, round(layer.size[0] * scale)), max(1, round(layer.size[1] * scale)))
        layer = layer.resize(size_px, Image.BICUBIC)
    px0 = round((xy[0] + c.ox) * c.ss - layer.size[0] / 2)
    py0 = round((xy[1] + c.oy) * c.ss - layer.size[1] / 2)
    c.img.paste(layer, (px0, py0), layer)
    c.d = ImageDraw.Draw(c.img)


def arrow(c: Canvas, p0, p1, color=YELLOW, width: float = 9, head: float = 26, bend: float = 0.0):
    """Straight or bent arrow with a solid head."""
    mx = (p0[0] + p1[0]) / 2
    my = (p0[1] + p1[1]) / 2
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1
    nx, ny = -dy / length, dx / length
    ctrl = (mx + nx * bend, my + ny * bend)
    tip_back = 0.86
    tx = (1 - tip_back) ** 2 * p0[0] + 2 * (1 - tip_back) * tip_back * ctrl[0] + tip_back**2 * p1[0]
    ty = (1 - tip_back) ** 2 * p0[1] + 2 * (1 - tip_back) * tip_back * ctrl[1] + tip_back**2 * p1[1]
    c.curve(p0, ctrl, (tx, ty), color, width)
    ang = math.atan2(p1[1] - ty, p1[0] - tx)
    left = (p1[0] - math.cos(ang) * head + math.cos(ang + math.pi / 2) * head * 0.62,
            p1[1] - math.sin(ang) * head + math.sin(ang + math.pi / 2) * head * 0.62)
    right = (p1[0] - math.cos(ang) * head + math.cos(ang - math.pi / 2) * head * 0.62,
             p1[1] - math.sin(ang) * head + math.sin(ang - math.pi / 2) * head * 0.62)
    c.poly([p1, left, right], fill=color)


def bubble(c: Canvas, box, text: str, size: float = 34, fill=INK, ink=OUTLINE, tail=None, radius: float = 28, kind="cjk"):
    """Speech bubble with wrapped text and an optional tail point."""
    x0, y0, x1, y1 = box
    c.rrect((x0 + 6, y0 + 9, x1 + 6, y1 + 9), radius, fill=mix(BG, "#000000", 0.5))
    if tail:
        ax, ay = tail
        base = ((x0 + x1) / 2, y1 if ay > y1 else y0)
        c.poly([(base[0] - 26, base[1] - 4), (base[0] + 26, base[1] - 4), (ax, ay)], fill=fill)
    c.rrect(box, radius, fill=fill, outline=mix(fill, "#000000", 0.35), width=3)
    lines = c.wrap(text, size, (x1 - x0) - 44, kind)
    line_h = size * 1.42
    start = (y0 + y1) / 2 - (len(lines) - 1) * line_h / 2
    for i, line in enumerate(lines):
        c.text(((x0 + x1) / 2, start + i * line_h), line, size, ink, kind, anchor="mm")


# ------------------------------------------------------------------- code cards

KEYWORDS = {
    "import", "from", "export", "const", "let", "function", "return", "async",
    "await", "for", "if", "else", "pub", "trait", "fn", "impl", "self", "mut",
    "struct", "type", "default", "new", "true", "false", "as",
}
TYPES = {
    "i32", "u8", "f64", "bool", "str", "String", "Vec", "number", "string",
    "boolean", "void", "Accessor", "Setter", "Ref", "Cap", "Map", "any",
    "Promise", "i32;", "Option",
}


def token_color(word: str) -> str:
    bare = word.strip("(),;:.<>{}[]=&")
    if word.startswith("//"):
        return MUTED
    if bare in KEYWORDS:
        return PINK
    if bare in TYPES:
        return CYAN
    if word.startswith('"') or word.startswith("'"):
        return GREEN
    if bare.isdigit() or bare.rstrip("iuf0123456789") == "" and any(ch.isdigit() for ch in bare):
        return YELLOW
    if bare and bare[0].isupper():
        return PURPLE
    return INK2


def code_card(
    c: Canvas,
    box,
    title: str,
    lines,
    size: float = 27,
    reveal: float = 1.0,
    highlight=(),
    accent=YELLOW,
    title_kind="mono",
):
    """Terminal-styled card. `reveal` types the body in; `highlight` marks rows."""
    x0, y0, x1, y1 = box
    plate(c, box, 22, fill=TERM, outline=mix(TERM, accent, 0.35), width=4, shadow=12)
    tab_w = c.measure(title, size * 0.92, title_kind) + 40
    c.rrect((x0 + 18, y0 - size * 0.74, x0 + 18 + tab_w, y0 + size * 0.78), 14, fill=accent)
    c.text((x0 + 38, y0 + size * 0.02), title, size * 0.92, OUTLINE, title_kind, anchor="lm")
    line_h = size * 1.62
    top = y0 + size * 1.7
    total = sum(len(line) for line in lines) or 1
    budget = total * clamp(reveal)
    for row, line in enumerate(lines):
        y = top + row * line_h
        if y > y1 - line_h * 0.2:
            break
        shown = line
        if budget < len(line):
            shown = line[: max(0, int(budget))]
        budget -= len(line)
        if row in highlight:
            c.rrect((x0 + 20, y - line_h * 0.52, x1 - 20, y + line_h * 0.52), 8, fill=mix(TERM, accent, 0.26))
            c.rrect((x0 + 20, y - line_h * 0.52, x0 + 26, y + line_h * 0.52), 3, fill=accent)
        indent = len(shown) - len(shown.lstrip(" "))
        cursor = x0 + 40 + indent * size * 0.6
        comment = False
        for word in shown.strip(" ").split(" "):
            if word.startswith("//"):
                comment = True
            color = MUTED if comment else token_color(word)
            cursor += c.text((cursor, y), word + " ", size, color, "mono", anchor="lm")
        if budget < 0:
            caret_on = (c.frame // 8) % 2 == 0
            if caret_on:
                c.rrect((cursor, y - size * 0.6, cursor + size * 0.52, y + size * 0.6), 2, fill=accent)
            break


def conveyor(c: Canvas, box, t: float, speed: float = 120, tread: float = 46) -> None:
    x0, y0, x1, y1 = box
    c.rrect((x0, y0, x1, y1), (y1 - y0) / 2, fill=mix(BG, PURPLE, 0.16), outline=mix(BG, PURPLE, 0.4), width=4)
    offset = (t * speed) % tread
    for i in range(int((x1 - x0) / tread) + 2):
        x = x0 + i * tread - offset
        if x0 + 6 < x < x1 - 6:
            c.line([(x, y0 + 8), (x - 12, y1 - 8)], mix(BG, PURPLE, 0.42), 5)
    c.circle((x0 + (y1 - y0) / 2, (y0 + y1) / 2), (y1 - y0) / 2 - 7, outline=mix(BG, PURPLE, 0.5), width=4)
    c.circle((x1 - (y1 - y0) / 2, (y0 + y1) / 2), (y1 - y0) / 2 - 7, outline=mix(BG, PURPLE, 0.5), width=4)


def chapter_chip(c: Canvas, index: int, title: str) -> None:
    label = f"{index:02d}"
    x, y = 62, 66
    w = c.measure(title, 30, "cjk") + 118
    c.rrect((x, y - 30, x + w, y + 30), 30, fill=mix(BG, PANEL2, 0.85), outline=mix(BG, PURPLE, 0.35), width=3)
    c.circle((x + 32, y), 21, fill=YELLOW)
    c.text((x + 32, y + 1), label, 24, OUTLINE, "latin", anchor="mm")
    c.text((x + 64, y + 1), title, 30, INK2, "cjk", anchor="lm")


def progress_bar(c: Canvas, done: float) -> None:
    y = c.height - 10
    c.rect((0, y, c.width, c.height), fill=mix(BG, "#000000", 0.4))
    width = c.width * clamp(done)
    steps = 40
    for i in range(steps):
        x0 = width * i / steps
        x1 = width * (i + 1) / steps + 1
        c.rect((x0, y, x1, c.height), fill=mix(YELLOW, CYAN, i / (steps - 1)))


def caption(c: Canvas, text: str, appear: float) -> None:
    """Lower-third narration line. `appear` is seconds since the line started."""
    if not text:
        return
    size = 40
    lines = c.wrap(text, size, 1420)
    line_h = size * 1.5
    h = line_h * len(lines) + 46
    w = max(c.measure(line, size) for line in lines) + 110
    k = ease_out_back(clamp(appear / 0.22), 1.5)
    cx = c.width / 2
    cy = c.height - 92 - (h - 90) / 2
    dy = lerp(26, 0, k)
    box = (cx - w / 2, cy - h / 2 + dy, cx + w / 2, cy + h / 2 + dy)
    plate(c, box, 22, fill=mix(BG, PANEL2, 0.96), outline=mix(BG, PURPLE, 0.45), width=3, shadow=8, accent=YELLOW)
    start = (box[1] + box[3]) / 2 - (len(lines) - 1) * line_h / 2
    for i, line in enumerate(lines):
        c.text((cx + 16, start + i * line_h), line, size, INK, anchor="mm")
