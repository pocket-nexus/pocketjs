"""Geometry and rasterisation primitives for the Pocket Chan cel renderer.

Shapes are plain closed polygons in a y-down design space. Curves are baked
into polylines here so the renderer only ever fills polygons; line art is an
outward offset of the same polygon painted underneath its fill, which is how
this rig gets ink lines out of a fill-only rasteriser.

`Cel` supersamples into two buffers — an opaque colour buffer whose ground is
the ink colour and a coverage buffer — and box-filters both on export. The
ground choice matters: every silhouette edge blends toward the ink line that
already surrounds it, so the downsampled RGBA carries no dark or light halo.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

from PIL import Image, ImageDraw

Pt = tuple[float, float]
Poly = list[Pt]


# ---------------------------------------------------------------------------
# scalar helpers
# ---------------------------------------------------------------------------

def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def ease_sine(t: float) -> float:
    """0..1 -> 0..1 with zero slope at both ends."""
    return 0.5 - 0.5 * math.cos(math.pi * clamp(t, 0.0, 1.0))


def wave(phase: float) -> float:
    """A -1..1 sine over a 0..1 phase — the loop primitive every pose uses."""
    return math.sin(phase * math.tau)


def wave2(phase: float) -> float:
    return math.sin(phase * math.tau * 2.0)


# ---------------------------------------------------------------------------
# point helpers
# ---------------------------------------------------------------------------

def add(p: Pt, q: Pt) -> Pt:
    return (p[0] + q[0], p[1] + q[1])


def sub(p: Pt, q: Pt) -> Pt:
    return (p[0] - q[0], p[1] - q[1])


def mul(p: Pt, k: float) -> Pt:
    return (p[0] * k, p[1] * k)


def mix(p: Pt, q: Pt, t: float) -> Pt:
    return (lerp(p[0], q[0], t), lerp(p[1], q[1], t))


def norm(p: Pt) -> Pt:
    d = math.hypot(p[0], p[1]) or 1.0
    return (p[0] / d, p[1] / d)


def perp(p: Pt) -> Pt:
    return (p[1], -p[0])


def polar(origin: Pt, deg: float, dist: float) -> Pt:
    """Screen-space polar: 0 deg points down, positive turns clockwise."""
    r = math.radians(deg)
    return (origin[0] + math.sin(r) * dist, origin[1] + math.cos(r) * dist)


def rotate(p: Pt, pivot: Pt, deg: float) -> Pt:
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    dx, dy = p[0] - pivot[0], p[1] - pivot[1]
    return (pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c)


def rotate_poly(pts: Sequence[Pt], pivot: Pt, deg: float) -> Poly:
    if deg == 0.0:
        return list(pts)
    return [rotate(p, pivot, deg) for p in pts]


def move_poly(pts: Sequence[Pt], dx: float, dy: float) -> Poly:
    return [(x + dx, y + dy) for x, y in pts]


def scale_poly(pts: Sequence[Pt], pivot: Pt, sx: float, sy: float | None = None) -> Poly:
    sy = sx if sy is None else sy
    return [(pivot[0] + (x - pivot[0]) * sx, pivot[1] + (y - pivot[1]) * sy) for x, y in pts]


# ---------------------------------------------------------------------------
# curve construction
# ---------------------------------------------------------------------------

def catmull(knots: Sequence[Pt], closed: bool = True, steps: int = 8, tension: float = 0.5) -> Poly:
    """Catmull-Rom spline through `knots`, flattened to a polyline."""
    n = len(knots)
    if n < 3:
        return list(knots)
    out: Poly = []
    last = n if closed else n - 1
    for i in range(last):
        p0 = knots[(i - 1) % n] if closed else knots[max(i - 1, 0)]
        p1 = knots[i % n]
        p2 = knots[(i + 1) % n]
        p3 = knots[(i + 2) % n] if closed else knots[min(i + 2, n - 1)]
        for s in range(steps):
            t = s / steps
            t2, t3 = t * t, t * t * t
            m1 = mul(sub(p2, p0), tension)
            m2 = mul(sub(p3, p1), tension)
            h1 = 2 * t3 - 3 * t2 + 1
            h2 = -2 * t3 + 3 * t2
            h3 = t3 - 2 * t2 + t
            h4 = t3 - t2
            out.append((
                h1 * p1[0] + h2 * p2[0] + h3 * m1[0] + h4 * m2[0],
                h1 * p1[1] + h2 * p2[1] + h3 * m1[1] + h4 * m2[1],
            ))
    if not closed:
        out.append(knots[-1])
    return out


def oval(center: Pt, rx: float, ry: float, steps: int = 40, tilt: float = 0.0) -> Poly:
    cx, cy = center
    pts = []
    for i in range(steps):
        a = i / steps * math.tau
        pts.append((cx + math.cos(a) * rx, cy + math.sin(a) * ry))
    return rotate_poly(pts, center, tilt) if tilt else pts


def circle(center: Pt, r: float, steps: int = 36) -> Poly:
    return oval(center, r, r, steps)


def limb(a: Pt, b: Pt, ra: float, rb: float, steps: int = 10) -> Poly:
    """A tapering capsule from `a` (radius ra) to `b` (radius rb)."""
    d = norm(sub(b, a))
    n = perp(d)
    out: Poly = []
    for i in range(steps + 1):
        t = math.pi * (i / steps - 0.5)
        out.append((a[0] - n[0] * ra * math.cos(t) - d[0] * ra * math.sin(t),
                    a[1] - n[1] * ra * math.cos(t) - d[1] * ra * math.sin(t)))
    for i in range(steps + 1):
        t = math.pi * (i / steps - 0.5)
        out.append((b[0] + n[0] * rb * math.cos(t) + d[0] * rb * math.sin(t),
                    b[1] + n[1] * rb * math.cos(t) + d[1] * rb * math.sin(t)))
    return out


def ribbon(spine: Sequence[Pt], widths: Sequence[float]) -> Poly:
    """A tapering band around an open polyline — hair locks, straps, mouths."""
    n = len(spine)
    left: Poly = []
    right: Poly = []
    for i, p in enumerate(spine):
        prev = spine[max(i - 1, 0)]
        nxt = spine[min(i + 1, n - 1)]
        t = norm(sub(nxt, prev)) if nxt != prev else (1.0, 0.0)
        nrm = perp(t)
        w = widths[i] if i < len(widths) else widths[-1]
        left.append((p[0] + nrm[0] * w, p[1] + nrm[1] * w))
        right.append((p[0] - nrm[0] * w, p[1] - nrm[1] * w))
    return left + right[::-1]


def rounded_rect(x: float, y: float, w: float, h: float, r: float, steps: int = 5) -> Poly:
    r = min(r, w / 2, h / 2)
    out: Poly = []
    corners = [
        ((x + w - r, y + r), -90.0),
        ((x + w - r, y + h - r), 0.0),
        ((x + r, y + h - r), 90.0),
        ((x + r, y + r), 180.0),
    ]
    for (cx, cy), start in corners:
        for i in range(steps + 1):
            a = math.radians(start + 90.0 * i / steps)
            out.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return out


def arc_band(center: Pt, r: float, a0: float, a1: float, width: float, steps: int = 14) -> Poly:
    """A crescent: the band between two concentric arcs. Angles in degrees,
    measured like `polar` (0 = down, clockwise)."""
    inner: Poly = []
    outer: Poly = []
    for i in range(steps + 1):
        a = lerp(a0, a1, i / steps)
        inner.append(polar(center, a, r - width / 2))
        outer.append(polar(center, a, r + width / 2))
    return outer + inner[::-1]


def star(center: Pt, r: float, inner: float, points: int = 4, tilt: float = 0.0) -> Poly:
    out: Poly = []
    for i in range(points * 2):
        a = math.radians(tilt) + i * math.pi / points
        rad = r if i % 2 == 0 else inner
        out.append((center[0] + math.sin(a) * rad, center[1] - math.cos(a) * rad))
    return out


# ---------------------------------------------------------------------------
# outward offset — the ink line
# ---------------------------------------------------------------------------

def signed_area(pts: Sequence[Pt]) -> float:
    total = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return total / 2.0


def outset(pts: Sequence[Pt], d: float) -> Poly:
    """Push every vertex out along its mitred normal. Concave corners can fold
    a little; the fill painted on top covers the fold."""
    n = len(pts)
    if n < 3 or d == 0.0:
        return list(pts)
    sign = 1.0 if signed_area(pts) > 0 else -1.0
    out: Poly = []
    for i in range(n):
        p0 = pts[(i - 1) % n]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        e0 = norm(sub(p1, p0))
        e1 = norm(sub(p2, p1))
        n0 = (e0[1] * sign, -e0[0] * sign)
        n1 = (e1[1] * sign, -e1[0] * sign)
        m = norm((n0[0] + n1[0], n0[1] + n1[1]))
        cosine = m[0] * n1[0] + m[1] * n1[1]
        length = d / max(cosine, 0.35)
        out.append((p1[0] + m[0] * length, p1[1] + m[1] * length))
    return out


# ---------------------------------------------------------------------------
# the cel
# ---------------------------------------------------------------------------

Color = tuple[int, int, int]


class Cel:
    """One supersampled drawing surface that exports straight-alpha RGBA."""

    def __init__(self, width: int, height: int, ink: Color, ss: int = 4) -> None:
        self.ss = ss
        self.size = (width, height)
        big = (width * ss, height * ss)
        self.rgb = Image.new("RGB", big, ink)
        self.cov = Image.new("L", big, 0)
        self._rgb = ImageDraw.Draw(self.rgb)
        self._cov = ImageDraw.Draw(self.cov)
        self._scratch = Image.new("L", big, 0)
        self._scratch_draw = ImageDraw.Draw(self._scratch)

    def poly(self, pts: Sequence[Pt], color: Color, alpha: int = 255) -> None:
        if len(pts) < 3:
            return
        s = self.ss
        scaled = [(x * s, y * s) for x, y in pts]
        if alpha >= 255:
            self._rgb.polygon(scaled, fill=color)
            self._cov.polygon(scaled, fill=255)
            return
        self._scratch_draw.rectangle((0, 0, self.size[0] * s, self.size[1] * s), fill=0)
        self._scratch_draw.polygon(scaled, fill=alpha)
        self.rgb.paste(color, (0, 0), self._scratch)
        self.cov.paste(255, (0, 0), self._scratch)

    def polys(self, shapes: Iterable[tuple[Sequence[Pt], Color, int]]) -> None:
        for pts, color, alpha in shapes:
            self.poly(pts, color, alpha)

    def image(self) -> Image.Image:
        rgb = self.rgb.resize(self.size, Image.BOX)
        cov = self.cov.resize(self.size, Image.BOX)
        out = rgb.convert("RGBA")
        out.putalpha(cov)
        return out
