"""Pocket Chan — the parametric chibi rig.

One `Look` describes a single drawn frame: where the body leans, how the head
tilts, what each arm reaches for, which eyes and mouth are on, and which props
ride along. `build(look)` turns that into an ordered list of filled polygons in
a hip-origin design space; `tools/pocket-chan/bake.py` lays the frames out into
sprite atlases.

Design space: the hip centre is (0, 0), +y is down, one unit is one logical
pixel of the 128 px sprite cell. The character stands 112 units tall — crown at
y = -74, soles at y = +38.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from geom import (
    Poly,
    Pt,
    arc_band,
    catmull,
    circle,
    clamp,
    lerp,
    limb,
    mix,
    move_poly,
    norm,
    oval,
    outset,
    polar,
    ribbon,
    rotate_poly,
    rounded_rect,
    scale_poly,
    star,
    sub,
)

# ---------------------------------------------------------------------------
# palette — the arcade brand hues (site/assets/tokens.css) on a plum-black ink
# ---------------------------------------------------------------------------

INK = (14, 13, 22)
CLOTH = (27, 26, 38)
CLOTH_HI = (57, 56, 76)
HAIR = (255, 212, 0)
HAIR_LO = (226, 160, 10)
HAIR_HI = (255, 242, 134)
SKIN = (255, 227, 207)
SKIN_LO = (240, 183, 162)
INNER = (248, 248, 252)
INNER_LO = (206, 208, 222)
PINK = (255, 61, 139)
PINK_LO = (206, 40, 104)
CYAN = (53, 200, 232)
IRIS = (255, 196, 46)
IRIS_LO = (176, 102, 4)
WHITE = (255, 255, 255)
BLUSH = (255, 126, 160)

LINE = 1.15  # ink half-width, design units

# skeleton constants
HEAD = (0.0, -50.0)
HEAD_RX = 17.6
HEAD_RY = 19.6
NECK_Y = -30.0
SHOULDER_Y = -25.0
SHOULDER_X = 11.5
WAIST_Y = -3.0
UPPER_ARM = 10.5
FOREARM = 10.5

Shape = tuple[Poly, tuple[int, int, int], int]


@dataclass
class Arm:
    """Shoulder swing and elbow bend in degrees, measured away from the body.

    `reach` overrides both: give it a hand position in design space and the
    two-bone solve places the elbow, which is how the poses that hold
    something stay attached to it when the prop moves.
    """

    swing: float = 8.0
    bend: float = 14.0
    behind: bool = False
    hold: str = ""  # "" | "open" | "fist" | "point"
    reach: Pt | None = None
    elbow_in: bool = False


@dataclass
class Look:
    turn: float = 0.0  # -1 = full left profile, 0 = front, +1 = full right
    back: bool = False
    bob: float = 0.0
    lean: float = 0.0
    head_tilt: float = 0.0
    head_dx: float = 0.0
    head_dy: float = 0.0
    eyes: str = "open"
    mouth: str = "smile"
    brows: str = "calm"
    blush: bool = True
    hair_sway: float = 0.0
    skirt_sway: float = 0.0
    legs: str = "stand"
    step: float = 0.0
    arm_l: Arm = field(default_factory=Arm)
    arm_r: Arm = field(default_factory=Arm)
    props: list = field(default_factory=list)


def ink(out: list[Shape], poly: Poly, fill, width: float = LINE, alpha: int = 255) -> None:
    """Paint `poly`'s ink line, then its fill."""
    out.append((outset(poly, width), INK, 255))
    out.append((poly, fill, alpha))


def flat(out: list[Shape], poly: Poly, fill, alpha: int = 255) -> None:
    out.append((poly, fill, alpha))


# ---------------------------------------------------------------------------
# head
# ---------------------------------------------------------------------------

def face_shape(c: Pt, turn: float) -> Poly:
    rx, ry = HEAD_RX, HEAD_RY
    near = 1.0 + 0.06 * abs(turn)
    far = 1.0 - 0.30 * abs(turn)
    sx = turn
    right = near if sx >= 0 else far
    left = far if sx >= 0 else near
    knots = [
        (0.0, -ry),
        (rx * 0.88 * right, -ry * 0.62),
        (rx * 1.00 * right, -ry * 0.02),
        (rx * 0.86 * right, ry * 0.46),
        (rx * 0.44 * right, ry * 0.90),
        (0.0, ry * 1.02),
        (-rx * 0.44 * left, ry * 0.90),
        (-rx * 0.86 * left, ry * 0.46),
        (-rx * 1.00 * left, -ry * 0.02),
        (-rx * 0.88 * left, -ry * 0.62),
    ]
    return catmull([(c[0] + x + turn * 2.0, c[1] + y) for x, y in knots], steps=6)


def eye(out: list[Shape], c: Pt, w: float, h: float, mode: str, gaze: float, outer: float = 1.0) -> None:
    """One eye. `outer` points away from the nose — the corner that carries the
    lash wing, which is what gives the reference sheet its sharp look."""
    if mode in ("closed", "happy"):
        out.append((arc_band((c[0], c[1] + 3.0), 5.0, 126.0, 234.0, 1.8), INK, 255))
        out.append((ribbon([polar((c[0], c[1] + 3.0), 126.0 if outer > 0 else 234.0, 5.0),
                            (c[0] + outer * 6.6, c[1] - 1.6)], [1.6, 0.4]), INK, 255))
        return
    if mode == "sleep":
        out.append((arc_band((c[0], c[1] - 5.2), 5.8, -42.0, 42.0, 1.6), INK, 255))
        return
    open_k = 0.52 if mode == "half" else 1.0
    hh = h * open_k
    knots = [
        (-w * 1.00, hh * 0.12),
        (-w * 0.40, -hh * 0.92),
        (w * 0.34, -hh * 1.00),
        (w * 1.10, -hh * 0.50),
        (w * 0.74, hh * 0.58),
        (-w * 0.28, hh * 0.92),
    ]
    shell = catmull([(c[0] + x * outer, c[1] + y) for x, y in knots], steps=6)
    out.append((outset(shell, 1.1), INK, 255))
    out.append((shell, WHITE, 255))
    ic = (c[0] + gaze * 1.1 + outer * w * 0.10, c[1] + hh * 0.02)
    out.append((oval(ic, w * 0.72, hh * 0.80, 22), IRIS, 255))
    out.append((oval((ic[0], ic[1] - hh * 0.34), w * 0.72, hh * 0.44, 22), IRIS_LO, 255))
    out.append((oval((ic[0], ic[1] + hh * 0.46), w * 0.58, hh * 0.34, 20), HAIR_HI, 255))
    out.append((oval(ic, w * 0.30, hh * 0.52, 18), INK, 255))
    out.append((oval((ic[0] - outer * w * 0.30, ic[1] - hh * 0.36), w * 0.30, hh * 0.26, 14), WHITE, 255))
    out.append((oval((ic[0] + outer * w * 0.34, ic[1] + hh * 0.42), w * 0.15, hh * 0.14, 12), WHITE, 255))
    # heavy upper lash, drawn out past the outer corner into a wing
    lash = [
        (c[0] - outer * w * 0.98, c[1] + hh * 0.06),
        (c[0] - outer * w * 0.34, c[1] - hh * 0.98),
        (c[0] + outer * w * 0.46, c[1] - hh * 0.96),
        (c[0] + outer * w * 1.14, c[1] - hh * 0.52),
        (c[0] + outer * w * 1.36, c[1] - hh * 0.74),
    ]
    out.append((ribbon(lash, [0.7, 1.8, 1.9, 1.2, 0.3]), INK, 255))
    if mode == "sparkle":
        out.append((star((ic[0] - outer * w * 0.20, ic[1] - hh * 0.28), w * 0.66, w * 0.20, 4, 12.0), WHITE, 255))


def brow(out: list[Shape], c: Pt, side: float, mode: str) -> None:
    y = c[1] - 10.2
    tilt = {"calm": 0.0, "up": -1.6, "worry": 1.7, "flat": 0.4}.get(mode, 0.0)
    spine = [
        (c[0] - side * 4.6, y + tilt * 0.6),
        (c[0], y - 0.9 - tilt * 0.3),
        (c[0] + side * 4.4, y + 0.5 - tilt * 0.9),
    ]
    out.append((ribbon(spine, [0.75, 1.05, 0.7]), HAIR_LO, 255))


def mouth(out: list[Shape], c: Pt, mode: str) -> None:
    y = c[1] + 10.4
    if mode == "smile":
        out.append((arc_band((c[0], y - 3.2), 3.9, -40.0, 40.0, 1.25), INK, 255))
    elif mode == "grin":
        shell = catmull([(c[0] - 4.6, y - 1.2), (c[0], y + 3.6), (c[0] + 4.6, y - 1.2), (c[0], y - 2.0)], steps=6)
        out.append((shell, INK, 255))
        out.append((catmull([(c[0] - 2.4, y + 0.9), (c[0], y + 3.0), (c[0] + 2.4, y + 0.9)], steps=5), PINK, 255))
    elif mode == "open":
        out.append((oval((c[0], y + 0.6), 2.7, 3.4, 20), INK, 255))
        out.append((oval((c[0], y + 1.7), 1.6, 1.5, 14), PINK, 255))
    elif mode == "cat":
        out.append((arc_band((c[0] - 2.1, y - 2.4), 2.4, -52.0, 18.0, 1.15), INK, 255))
        out.append((arc_band((c[0] + 2.1, y - 2.4), 2.4, -18.0, 52.0, 1.15), INK, 255))
    elif mode == "flat":
        out.append((ribbon([(c[0] - 2.4, y), (c[0] + 2.4, y)], [1.0, 1.0]), INK, 255))
    elif mode == "small":
        out.append((oval((c[0], y), 1.5, 1.7, 14), INK, 255))


def hair_back_group(look: Look) -> list[Shape]:
    """The mass behind everything — drawn before the body so the arms read."""
    out: list[Shape] = []
    c = (HEAD[0] + look.head_dx, HEAD[1] + look.head_dy)
    sway = look.hair_sway
    tx = look.turn * 3.0
    knots = [
        (0.0, -30.0), (15.0, -27.0), (23.0, -15.0), (26.0, -1.0),
        (22.5 + sway * 0.3, 11.0), (26.5 + sway * 0.7, 23.0),
        (22.0 + sway * 1.1, 36.0), (25.5 + sway * 1.6, 48.0),
        (18.0 + sway * 2.1, 61.0), (10.0 + sway * 2.5, 70.0),
        (4.5 + sway * 1.4, 54.0), (0.0 + sway * 0.9, 38.0),
        (-4.5 + sway * 1.4, 56.0), (-10.5 + sway * 2.5, 72.0),
        (-18.5 + sway * 2.1, 62.0), (-25.0 + sway * 1.6, 49.0),
        (-21.5 + sway * 1.1, 35.0), (-26.0 + sway * 0.7, 21.0),
        (-23.0 + sway * 0.3, 9.0), (-26.0, -3.0),
        (-23.0, -15.0), (-15.0, -27.0),
    ]
    back = catmull([(c[0] + x + tx, c[1] + y) for x, y in knots], steps=6)
    ink(out, back, HAIR_LO)
    if not look.back:
        return out
    crown = catmull([(c[0] + x * 0.95 + tx, c[1] + y * 0.90 - 2.0) for x, y in knots], steps=6)
    ink(out, crown, HAIR)
    out.append((ribbon(
        [(c[0] - 14.0, c[1] - 19.0), (c[0], c[1] - 25.0), (c[0] + 14.0, c[1] - 19.0)],
        [1.8, 2.8, 1.6]), HAIR_HI, 210))
    _bow(out, (c[0], c[1] + 14.0), 1.15)
    return out


def side_locks(look: Look) -> list[Shape]:
    out: list[Shape] = []
    if look.back:
        return out
    c = (HEAD[0] + look.head_dx, HEAD[1] + look.head_dy)
    sway = look.hair_sway
    tx = look.turn * 3.0
    for side in (-1.0, 1.0):
        spine = [
            (c[0] + side * 18.0 + tx, c[1] - 14.0),
            (c[0] + side * 21.5 + tx + sway * 0.3, c[1] + 4.0),
            (c[0] + side * 18.5 + tx + sway * 0.9, c[1] + 22.0),
            (c[0] + side * 21.0 + tx + sway * 1.6, c[1] + 40.0),
            (c[0] + side * 14.0 + tx + sway * 2.3, c[1] + 56.0),
        ]
        ink(out, ribbon(spine, [3.5, 3.6, 2.8, 1.7, 0.4]), HAIR)
    return out


def head_group(look: Look) -> list[Shape]:
    out: list[Shape] = []
    if look.back:
        return out
    c = (HEAD[0] + look.head_dx, HEAD[1] + look.head_dy)
    turn = look.turn
    sway = look.hair_sway
    tx = turn * 3.0

    face = face_shape(c, turn)
    ink(out, face, SKIN)
    out.append((catmull([
        (c[0] - HEAD_RX * 0.70, c[1] + HEAD_RY * 0.52),
        (c[0], c[1] + HEAD_RY * 0.98),
        (c[0] + HEAD_RX * 0.70, c[1] + HEAD_RY * 0.52),
        (c[0], c[1] + HEAD_RY * 0.70),
    ], steps=6), SKIN_LO, 80))

    if abs(turn) > 0.22:
        d = 1.0 if turn > 0 else -1.0
        nx = c[0] + d * (HEAD_RX * 0.96 + abs(turn) * 1.4)
        ny = c[1] + 4.6
        out.append((catmull([
            (nx - d * 3.4, ny - 3.4), (nx + d * abs(turn) * 2.4, ny),
            (nx - d * 3.0, ny + 2.6),
        ], steps=5), SKIN, 255))
        out.append((outset(catmull([
            (nx - d * 3.4, ny - 3.4), (nx + d * abs(turn) * 2.4, ny),
            (nx - d * 3.0, ny + 2.6),
        ], steps=5), 0.0), SKIN, 255))

    gaze = turn * 1.6
    ex = 8.8
    left_c = (c[0] - ex + turn * 7.2, c[1] + 4.2)
    right_c = (c[0] + ex + turn * 7.2, c[1] + 4.2)
    near = 1.0 + 0.05 * abs(turn)
    far = 1.0 - 0.42 * abs(turn)
    lw = 5.7 * (near if turn < 0 else far)
    rw = 5.7 * (near if turn > 0 else far)
    lmode = "closed" if look.eyes == "wink" else look.eyes
    if look.blush:
        out.append((oval((left_c[0] - 2.8, left_c[1] + 7.6), 4.8, 2.6, 20), BLUSH, 115))
        out.append((oval((right_c[0] + 2.8, right_c[1] + 7.6), 4.8, 2.6, 20), BLUSH, 115))
    if abs(turn) < 0.82:
        eye(out, left_c, lw, 6.4, lmode, gaze, -1.0)
    eye(out, right_c, rw, 6.4, look.eyes, gaze, 1.0)
    mouth(out, (c[0] + turn * 8.0, c[1] + 0.8), look.mouth)

    # bangs: a smooth crown closed off by a sharp zigzag of lock tips
    crown = [
        (-19.8, -9.5), (-23.4, -20.5), (-14.0, -30.5), (2.0, -33.0),
        (16.5, -29.5), (23.4, -19.5), (20.0, -8.5),
    ]
    tips = [
        (16.0, 0.5), (12.0, -8.5), (7.0, -0.5), (1.5, -9.5), (-4.5, -1.5), (-10.0, -8.5), (-15.0, -7.5),
    ]
    arc = catmull([(c[0] + x + tx, c[1] + y) for x, y in crown], closed=False, steps=7)
    bang = arc + [(c[0] + x + tx, c[1] + y) for x, y in tips]
    ink(out, bang, HAIR)
    # the long strand the reference parts to her left, then the crown highlight
    out.append((outset(ribbon([
        (c[0] + 18.5 + tx, c[1] - 24.0), (c[0] + 7.0 + tx, c[1] - 20.0),
        (c[0] - 5.0 + tx, c[1] - 14.5), (c[0] - 14.5 + tx, c[1] - 8.0),
    ], [2.2, 2.4, 1.7, 0.5]), 0.55), HAIR_LO, 255))
    out.append((ribbon([
        (c[0] + 18.5 + tx, c[1] - 24.0), (c[0] + 7.0 + tx, c[1] - 20.0),
        (c[0] - 5.0 + tx, c[1] - 14.5), (c[0] - 14.5 + tx, c[1] - 8.0),
    ], [2.2, 2.4, 1.7, 0.5]), HAIR, 255))
    out.append((ribbon(
        [(c[0] - 14.0 + tx, c[1] - 21.5), (c[0] - 3.0 + tx, c[1] - 27.0),
         (c[0] + 9.0 + tx, c[1] - 24.5), (c[0] + 17.0 + tx, c[1] - 16.5)],
        [1.0, 2.0, 1.7, 0.8]), HAIR_HI, 205))

    if abs(turn) < 0.82:
        brow(out, left_c, -1.0, look.brows)
    brow(out, right_c, 1.0, look.brows)

    a = sway * 1.6
    ahoge = ribbon([
        (c[0] - 1.0 + tx, c[1] - 31.0),
        (c[0] + 2.0 + tx + a, c[1] - 38.5),
        (c[0] + 8.5 + tx + a * 1.6, c[1] - 41.5),
        (c[0] + 11.5 + tx + a * 2.0, c[1] - 36.5),
    ], [2.0, 1.6, 1.1, 0.5])
    ink(out, ahoge, HAIR, 0.9)

    _bow(out, (c[0] + 18.5 + tx, c[1] - 23.0), 1.1)
    _badge(out, (c[0] - 19.0 + tx, c[1] - 14.0))
    return out


def _bow(out: list[Shape], c: Pt, k: float) -> None:
    for side in (-1.0, 1.0):
        loop = catmull([
            (c[0], c[1]),
            (c[0] + side * 9.0 * k, c[1] - 5.2 * k),
            (c[0] + side * 10.5 * k, c[1] + 1.0 * k),
            (c[0] + side * 6.0 * k, c[1] + 5.0 * k),
        ], steps=6)
        ink(out, loop, CLOTH, 0.95)
    ink(out, oval(c, 3.0 * k, 2.6 * k, 18), CLOTH_HI, 0.85)


def _badge(out: list[Shape], c: Pt) -> None:
    """The PocketJS mark, worn as a hair clip (assets/brand/pocketjs-avatar-dark.svg)."""
    w, h = 13.5, 9.6
    plate = rounded_rect(c[0] - w / 2, c[1] - h / 2, w, h, 2.8)
    out.append((outset(plate, 1.3), HAIR, 255))
    out.append((plate, INK, 255))
    out.append((circle((c[0] - w * 0.26, c[1]), 1.7, 16), PINK, 255))
    out.append((rounded_rect(c[0] + w * 0.00, c[1] - 2.1, 4.6, 1.5, 0.75, 3), CYAN, 255))
    out.append((rounded_rect(c[0] + w * 0.00, c[1] + 0.6, 3.0, 1.5, 0.75, 3), PINK, 255))


# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------

LEG_POSE = {
    #          knee            ankle
    "stand": ((5.8, 20.0), (6.8, 36.0)),
    "apart": ((7.8, 20.5), (10.4, 36.5)),
    "tuck": ((9.6, 14.0), (5.4, 25.0)),
}


def legs_group(look: Look) -> list[Shape]:
    out: list[Shape] = []
    knee, ankle = LEG_POSE.get(look.legs, LEG_POSE["stand"])
    for side in (-1.0, 1.0):
        lift = look.step * side
        hip = (side * 4.6, 0.0)
        k = (side * knee[0], knee[1] - abs(lift) * 0.35 - max(lift, 0.0) * 3.0)
        a = (side * ankle[0] + lift * 2.2, ankle[1] - max(lift, 0.0) * 6.0)
        ink(out, taper([hip, k, mix(k, a, 0.3)], 5.2, 4.2), SKIN)
        sock_top = mix(k, a, 0.22)
        ink(out, taper([sock_top, a], 4.4, 3.3, 3), CLOTH)
        flat(out, ribbon([mix(sock_top, a, 0.02), mix(sock_top, a, 0.12)], [4.3, 4.1]), CLOTH_HI)
        toe = (a[0] + side * 3.4, a[1] + 4.6)
        boot = catmull([
            (a[0] - 3.4, a[1] - 0.6), (a[0] + 3.4, a[1] - 0.6),
            (toe[0] + side * 1.2, toe[1] - 1.6), (toe[0] + side * 0.8, toe[1] + 1.0),
            (a[0] - side * 3.2, toe[1] + 1.0),
        ], steps=5)
        ink(out, boot, CLOTH)
        flat(out, catmull([
            (a[0] - 3.0, toe[1] - 0.4), (toe[0] + side * 0.7, toe[1] - 0.6),
            (toe[0] + side * 0.6, toe[1] + 0.8), (a[0] - side * 3.0, toe[1] + 0.8),
        ], steps=3), HAIR)
        flat(out, ribbon([(a[0] - 3.4, a[1] + 1.4), (a[0] + 3.4, a[1] + 1.4)], [0.8, 0.8]), CLOTH_HI)
    return out


def torso_group(look: Look) -> list[Shape]:
    out: list[Shape] = []
    sw = look.skirt_sway

    core = catmull([
        (0.0, NECK_Y - 1.0),
        (SHOULDER_X * 0.70, NECK_Y + 1.0), (SHOULDER_X, SHOULDER_Y + 1.5),
        (10.0, -14.0), (8.4, -5.0), (9.4, 2.0),
        (0.0, 3.0),
        (-9.4, 2.0), (-8.4, -5.0), (-10.0, -14.0),
        (-SHOULDER_X, SHOULDER_Y + 1.5), (-SHOULDER_X * 0.70, NECK_Y + 1.0),
    ], steps=6)
    ink(out, core, CLOTH if look.back else SKIN)

    if look.back:
        out.append((rounded_rect(-6.8, -21.0, 13.6, 9.6, 2.8), HAIR, 255))
        out.append((circle((-3.0, -16.2), 1.6, 14), PINK, 255))
        out.append((rounded_rect(0.4, -18.0, 4.4, 1.5, 0.75, 3), CYAN, 255))
        out.append((rounded_rect(0.4, -15.4, 2.9, 1.5, 0.75, 3), PINK, 255))
        for side in (-1.0, 1.0):
            flat(out, ribbon([(side * 9.6, SHOULDER_Y + 1.0), (side * 3.0, -13.0)], [1.2, 1.2]), CLOTH_HI)
    else:
        # white bustier: straight band across the top, sweetheart hem
        bust = catmull([
            (-9.0, -26.2), (0.0, -25.6), (9.0, -26.2),
            (9.4, -18.0), (4.6, -14.0), (0.0, -16.4), (-4.6, -14.0), (-9.4, -18.0),
        ], steps=6)
        ink(out, bust, INNER)
        flat(out, ribbon([(-8.8, -24.6), (0.0, -24.0), (8.8, -24.6)], [0.9, 1.0, 0.9]), INNER_LO)

        # harness: shoulder straps crossing to a sternum buckle, plus an underbust band
        for side in (-1.0, 1.0):
            flat(out, ribbon([(side * 8.4, -27.0), (side * 4.0, -24.0), (-side * 1.6, -19.6)], [1.05, 1.0, 0.9]), CLOTH)
        out.append((rounded_rect(-2.2, -21.2, 4.4, 3.8, 1.1, 3), CLOTH, 255))
        out.append((rounded_rect(-1.3, -20.4, 2.6, 2.2, 0.7, 3), HAIR, 255))

    # skirt
    skirt = catmull([
        (-10.0, -6.0), (10.0, -6.0),
        (14.4 + sw, 3.0), (16.6 + sw, 10.0),
        (8.4 + sw * 0.6, 12.6), (0.0, 10.6), (-8.4 + sw * 0.6, 12.6),
        (-16.6 + sw, 10.0), (-14.4 + sw, 3.0),
    ], steps=6)
    ink(out, skirt, CLOTH)
    for px in (-9.6, -3.2, 3.2, 9.6):
        flat(out, ribbon([(px * 0.70, -3.0), (px + sw * 0.8, 11.0)], [0.5, 0.85]), CLOTH_HI)

    if not look.back:
        # cropped open jacket, worn off the shoulders
        for side in (-1.0, 1.0):
            panel = catmull([
                (side * 4.4, NECK_Y + 1.5),
                (side * 10.4, -26.6), (side * 13.8, -22.0),
                (side * 12.8, -12.0), (side * 11.8, -3.0),
                (side * 8.0, -2.4), (side * 8.8, -12.0), (side * 6.2, -20.0),
            ], steps=6)
            ink(out, panel, CLOTH)
            flat(out, catmull([
                (side * 6.0, -25.8), (side * 10.6, -24.2),
                (side * 9.8, -16.0), (side * 7.4, -14.6),
            ], steps=5), CLOTH_HI)
        flat(out, ribbon([(-4.0, -27.6), (0.0, -24.6), (4.0, -27.6)], [1.0, 1.2, 1.0]), PINK)

        # lanyard: the strap and its tag ride on her right
        flat(out, ribbon([(-3.0, -28.2), (-5.6, -22.0), (-6.8, -12.0), (-6.6, -3.0)], [0.7, 0.75, 0.75, 0.7]), CLOTH)

    # belt
    out.append((rounded_rect(-10.4, -8.4, 20.8, 4.2, 1.5), INK, 255))
    out.append((rounded_rect(-9.8, -7.9, 19.6, 3.2, 1.2), CLOTH_HI, 255))
    out.append((rounded_rect(-2.7, -8.8, 5.4, 5.0, 1.4), HAIR, 255))
    if not look.back:
        out.append((rounded_rect(-9.1, -3.4, 5.0, 6.8, 1.3, 3), HAIR, 255))
        out.append((rounded_rect(-8.2, -2.0, 3.2, 1.1, 0.55, 3), INK, 255))
        out.append((rounded_rect(-8.2, 0.0, 2.2, 1.1, 0.55, 3), INK, 255))
    return out


def neck_group(look: Look) -> list[Shape]:
    out: list[Shape] = []
    if look.back:
        return out
    ink(out, limb((look.turn * 2.0, NECK_Y - 3.0), (look.turn * 1.2, NECK_Y + 3.4), 4.3, 4.6), SKIN)
    flat(out, limb((look.turn * 2.0, NECK_Y - 2.0), (look.turn * 1.4, NECK_Y + 1.0), 3.9, 4.0), SKIN_LO)
    ch = look.turn * 1.6
    flat(out, ribbon([(ch - 4.4, NECK_Y - 0.4), (ch, NECK_Y + 0.6), (ch + 4.4, NECK_Y - 0.4)], [1.15, 1.25, 1.15]), CLOTH)
    out.append((circle((ch, NECK_Y + 1.2), 1.15, 12), HAIR, 255))
    return out


def hand_shape(p: Pt, mode: str, side: float) -> list[Shape]:
    out: list[Shape] = []
    if mode == "point":
        ink(out, limb(p, (p[0] + side * 0.8, p[1] - 5.6), 3.2, 1.5), SKIN)
        ink(out, oval(p, 3.2, 3.0, 18), SKIN)
    elif mode == "open":
        ink(out, oval(p, 4.0, 3.7, 20), SKIN)
        for k in (-1.0, 0.0, 1.0):
            out.append((limb(p, (p[0] + k * 2.1 + side * 0.6, p[1] - 4.4), 1.2, 0.9), SKIN_LO, 255))
    else:
        ink(out, oval(p, 3.7, 3.5, 20), SKIN)
    return out


def taper(knots: list[Pt], w0: float, w1: float, steps: int = 4) -> Poly:
    """A smooth band through `knots`, its half-width easing from w0 to w1."""
    spine = catmull(knots, closed=False, steps=steps)
    n = len(spine) - 1
    return ribbon(spine, [lerp(w0, w1, i / max(n, 1)) for i in range(len(spine))])


def arm_angles(arm: Arm, side: float, shoulder: Pt) -> tuple[float, float]:
    """Absolute polar angles for the upper arm and forearm."""
    if arm.reach is None:
        a1 = side * arm.swing
        return a1, a1 + side * arm.bend
    dx = arm.reach[0] - shoulder[0]
    dy = arm.reach[1] - shoulder[1]
    d = clamp(math.hypot(dx, dy), abs(UPPER_ARM - FOREARM) + 0.8, UPPER_ARM + FOREARM - 0.6)
    base = math.degrees(math.atan2(dx, dy))
    cos_a = (UPPER_ARM * UPPER_ARM + d * d - FOREARM * FOREARM) / (2.0 * UPPER_ARM * d)
    spread = math.degrees(math.acos(clamp(cos_a, -1.0, 1.0)))
    a1 = base + (side if arm.elbow_in else -side) * spread
    elbow = polar(shoulder, a1, UPPER_ARM)
    a2 = math.degrees(math.atan2(arm.reach[0] - elbow[0], arm.reach[1] - elbow[1]))
    return a1, a2


def arm_group(arm: Arm, side: float) -> list[Shape]:
    out: list[Shape] = []
    shoulder = (side * (SHOULDER_X - 0.8), SHOULDER_Y + 1.5)
    a1, a2 = arm_angles(arm, side, shoulder)
    elbow = polar(shoulder, a1, UPPER_ARM)
    wrist = polar(elbow, a2, FOREARM)
    cuff = mix(elbow, wrist, 0.66)
    ink(out, taper([shoulder, elbow, cuff], 4.9, 3.2), CLOTH)
    flat(out, oval(mix(shoulder, elbow, 0.22), 4.4, 3.8, 20, a1), CLOTH_HI)
    ink(out, taper([mix(elbow, wrist, 0.58), wrist], 3.0, 2.8, 3), SKIN)
    out.extend(hand_shape(wrist, arm.hold, side))
    return out


# ---------------------------------------------------------------------------
# props
# ---------------------------------------------------------------------------

def prop_laptop(look: Look) -> list[Shape]:
    out: list[Shape] = []
    cx, cy = 0.0, -1.0
    base = catmull([
        (cx - 16.0, cy + 4.0), (cx + 16.0, cy + 4.0),
        (cx + 14.0, cy + 7.6), (cx - 14.0, cy + 7.6),
    ], steps=3)
    ink(out, base, CLOTH_HI)
    lid = rounded_rect(cx - 15.0, cy - 15.0, 30.0, 19.5, 2.6)
    ink(out, lid, CLOTH)
    out.append((rounded_rect(cx - 10.0, cy - 11.0, 20.0, 11.4, 2.4), INK, 255))
    out.append((circle((cx - 5.0, cy - 5.3), 2.1, 16), PINK, 255))
    out.append((rounded_rect(cx - 1.0, cy - 8.0, 6.6, 1.9, 0.95, 3), CYAN, 255))
    out.append((rounded_rect(cx - 1.0, cy - 4.4, 4.3, 1.9, 0.95, 3), PINK, 255))
    return out


def prop_logo(look: Look) -> list[Shape]:
    """The mark itself, hugged."""
    out: list[Shape] = []
    w, h = 30.0, 21.0
    cx, cy = 0.0, -6.0
    plate = rounded_rect(cx - w / 2, cy - h / 2, w, h, 6.0, 6)
    out.append((outset(plate, 2.4), HAIR, 255))
    out.append((plate, INK, 255))
    out.append((circle((cx - w * 0.24, cy), 3.5, 20), PINK, 255))
    out.append((rounded_rect(cx - 0.4, cy - 4.4, 10.2, 3.0, 1.5, 4), CYAN, 255))
    out.append((rounded_rect(cx - 0.4, cy + 1.0, 6.6, 3.0, 1.5, 4), PINK, 255))
    return out


def prop_zzz(phase: float) -> list[Shape]:
    out: list[Shape] = []
    for i in range(3):
        t = (phase + i / 3.0) % 1.0
        k = 2.0 + 2.6 * (1 - i * 0.22)
        x = 16.0 + i * 7.0 + t * 3.0
        y = -66.0 - i * 9.0 - t * 7.0
        a = int(255 * max(0.0, 1.0 - t))
        bar = [(x - k, y - k), (x + k, y - k), (x + k, y - k + 1.1),
               (x - k * 0.2, y + k - 1.1), (x + k, y + k - 1.1), (x + k, y + k),
               (x - k, y + k), (x - k, y + k - 1.1), (x + k * 0.2, y - k + 1.1), (x - k, y - k + 1.1)]
        out.append((bar, INNER, a))
    return out


def prop_sparkles(phase: float) -> list[Shape]:
    out: list[Shape] = []
    spots = [(-28.0, -62.0, 4.6), (26.0, -70.0, 5.6), (31.0, -40.0, 3.8), (-31.0, -34.0, 3.4)]
    for i, (x, y, r) in enumerate(spots):
        t = (phase + i * 0.27) % 1.0
        k = 0.35 + 0.65 * math.sin(t * math.pi)
        out.append((star((x, y), r * k, r * k * 0.28, 4, 10.0 * i), HAIR_HI, 255))
    return out


def prop_hearts(phase: float) -> list[Shape]:
    out: list[Shape] = []
    for i in range(2):
        t = (phase + i * 0.5) % 1.0
        x = (-27.0 if i == 0 else 28.0) + math.sin(t * math.tau) * 3.0
        y = -52.0 - t * 22.0
        r = 4.2 * (1.0 - t * 0.30)
        a = int(235 * max(0.0, 1.0 - t * 1.05))
        out.append((circle((x - r * 0.62, y - r * 0.35), r * 0.78, 14), PINK, a))
        out.append((circle((x + r * 0.62, y - r * 0.35), r * 0.78, 14), PINK, a))
        out.append(([(x - r * 1.32, y - r * 0.05), (x + r * 1.32, y - r * 0.05), (x, y + r * 1.55)], PINK, a))
    return out


def prop_question(phase: float) -> list[Shape]:
    out: list[Shape] = []
    y = -74.0 + math.sin(phase * math.tau) * 2.2
    x = 25.0
    out.append((arc_band((x, y), 4.4, 196.0, 384.0, 2.0), HAIR, 255))
    out.append((ribbon([(x + 0.4, y + 3.6), (x + 0.4, y + 7.0)], [1.0, 1.0]), HAIR, 255))
    out.append((circle((x + 0.4, y + 10.2), 1.5, 14), HAIR, 255))
    return out


def prop_bag(look: Look) -> list[Shape]:
    out: list[Shape] = []
    ink(out, ribbon([(-9.0, -26.0), (-1.0, -18.0), (6.0, -10.0)], [1.3, 1.3, 1.3]), CLOTH_HI, 0.8)
    body = rounded_rect(2.0, -11.0, 17.0, 14.0, 4.0)
    ink(out, body, CLOTH)
    out.append((rounded_rect(4.4, -8.6, 7.0, 2.4, 1.2, 3), HAIR, 255))
    out.append((circle((14.6, -4.0), 1.9, 14), PINK, 255))
    return out


PROPS = {
    "laptop": prop_laptop,
    "logo": prop_logo,
    "bag": prop_bag,
}
PHASED = {
    "zzz": prop_zzz,
    "sparkles": prop_sparkles,
    "hearts": prop_hearts,
    "question": prop_question,
}


# ---------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------

def build(look: Look, phase: float = 0.0) -> list[Shape]:
    body: list[Shape] = []
    body += legs_group(look)
    for arm, side in ((look.arm_l, -1.0), (look.arm_r, 1.0)):
        if arm.behind:
            body += arm_group(arm, side)
    body += torso_group(look)
    body += neck_group(look)

    if look.lean:
        body = [(rotate_poly(p, (0.0, 4.0), look.lean), c, a) for p, c, a in body]

    head = head_group(look)
    locks = side_locks(look)
    if look.head_tilt:
        rot = lambda g: [(rotate_poly(p, (look.head_dx, NECK_Y), look.head_tilt), c, a) for p, c, a in g]
        head, locks = rot(head), rot(locks)

    front: list[Shape] = []
    for name in look.props:
        if name in PROPS:
            front += PROPS[name](look)
    for arm, side in ((look.arm_l, -1.0), (look.arm_r, 1.0)):
        if not arm.behind:
            front += arm_group(arm, side)

    out = hair_back_group(look) + body + locks + head + front
    if look.turn:
        # foreshortening sells the turn far better than moved features alone
        k = 1.0 - 0.20 * abs(look.turn)
        out = [(scale_poly(p, (look.turn * 4.0, -12.0), k, 1.0), c, a) for p, c, a in out]
    if look.bob:
        out = [(move_poly(p, 0.0, look.bob), c, a) for p, c, a in out]
    for name in look.props:
        if name in PHASED:
            out += PHASED[name](phase)
    return out
