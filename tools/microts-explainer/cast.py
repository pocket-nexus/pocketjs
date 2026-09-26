"""Cartoon cast and props for the MicroTS explainer.

Every draw call takes logical center coordinates, a scale where 1.0 is the
reference size noted per character, and the scene clock for idle motion.
"""
from __future__ import annotations

import math

from stagecraft import (
    BG, CYAN, GREEN, INK, INK2, JS_YELLOW, MUTED, ORANGE, OUTLINE, PANEL, PANEL2,
    PINK, PURPLE, RED, RUST, TERM, TS_BLUE, YELLOW, Canvas, badge, clamp,
    ease_out_back, ease_out_cubic, lerp, mix, pulse, shade, smoothstep, sparkle,
)


def blink_open(t: float, seed: float = 0.0) -> float:
    """1 = open, 0 = shut. Blinks every ~3.1 s, closed for 0.12 s."""
    phase = (t + seed * 1.7) % 3.1
    if phase > 3.0:
        return 0.08
    if phase > 2.94:
        return 0.45
    return 1.0


def _eye(c: Canvas, xy, r: float, open_amount: float, look=(0.0, 0.0), ink=OUTLINE, sclera=INK):
    x, y = xy
    if open_amount < 0.2:
        c.line([(x - r, y), (x + r, y)], ink, r * 0.5)
        return
    c.ellipse((x - r, y - r * open_amount, x + r, y + r * open_amount), fill=sclera, outline=ink, width=r * 0.22)
    pr = r * 0.52
    c.circle((x + look[0] * r * 0.4, y + look[1] * r * 0.3), pr * open_amount + pr * 0.2, fill=ink)
    c.circle((x + look[0] * r * 0.4 - pr * 0.3, y - pr * 0.35), pr * 0.3 * open_amount, fill=INK)


def _smile(c: Canvas, xy, w: float, h: float, color=OUTLINE, width: float = 5, open_mouth: float = 0.0):
    x, y = xy
    if open_mouth > 0.3:
        c.ellipse((x - w * 0.45, y - h * 0.1, x + w * 0.45, y + h * 1.25 * open_mouth), fill=color)
        c.ellipse((x - w * 0.22, y + h * 0.5 * open_mouth, x + w * 0.22, y + h * 1.2 * open_mouth), fill=PINK)
        return
    pts = []
    for i in range(13):
        k = i / 12
        pts.append((x - w / 2 + w * k, y + math.sin(k * math.pi) * h))
    c.line(pts, color, width)


def ts_buddy(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, mood: str = "happy", look=(0.0, 0.0), arm=0.0):
    """TypeScript mascot. Reference body is 150x150 logical pixels."""
    s = scale
    bob = math.sin(t * 2.1 * math.tau / 3) * 5 * s
    x, y = xy[0], xy[1] + bob
    w = 150 * s
    h = 150 * s
    ink = OUTLINE
    # legs and feet
    for side in (-1, 1):
        lx = x + side * w * 0.22
        c.line([(lx, y + h * 0.42), (lx, y + h * 0.60)], ink, 11 * s)
        c.ellipse((lx - 20 * s, y + h * 0.56, lx + 20 * s, y + h * 0.70), fill=YELLOW, outline=ink, width=4 * s)
    # arms
    swing = math.sin(t * 2.6) * 0.5
    for side in (-1, 1):
        ax = x + side * w * 0.5
        ay = y + h * 0.08
        raised = arm if side > 0 else -arm * 0.35
        ex = ax + side * (36 + 22 * abs(raised)) * s
        ey = ay - (52 * raised + swing * 8) * s
        c.line([(ax, ay), (ex, ey)], ink, 11 * s)
        c.circle((ex, ey), 15 * s, fill=YELLOW, outline=ink, width=4 * s)
    # body
    c.rrect((x - w / 2 + 6 * s, y - h / 2 + 10 * s, x + w / 2 + 6 * s, y + h / 2 + 12 * s), 34 * s, fill=mix(BG, "#000000", 0.45))
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 34 * s, fill=TS_BLUE, outline=ink, width=6 * s)
    c.rrect((x - w / 2 + 10 * s, y - h / 2 + 10 * s, x + w / 2 - 10 * s, y - h / 2 + 34 * s), 14 * s, fill=mix(TS_BLUE, INK, 0.18))
    # face
    eye_y = y - h * 0.13
    er = 17 * s
    open_amount = blink_open(t, 0.3) if mood != "surprised" else 1.15
    _eye(c, (x - w * 0.19, eye_y), er, open_amount, look)
    _eye(c, (x + w * 0.19, eye_y), er, open_amount, look)
    if mood == "surprised":
        _smile(c, (x, y + h * 0.06), 30 * s, 14 * s, open_mouth=1.0)
    elif mood == "flat":
        c.line([(x - 16 * s, y + h * 0.10), (x + 16 * s, y + h * 0.10)], ink, 5 * s)
    else:
        _smile(c, (x, y + h * 0.04), 46 * s, 15 * s, width=5.5 * s)
    c.text((x, y + h * 0.31), "TS", 34 * s, INK, "latin", anchor="mm", stroke=3 * s, stroke_fill=mix(TS_BLUE, "#000000", 0.4))
    if mood == "cheer":
        for i in range(3):
            a = -0.9 + i * 0.9
            sparkle(c, (x + math.cos(a) * w * 0.8, y - h * 0.6 + math.sin(a) * 18 * s), (7 + 3 * math.sin(t * 8 + i)) * s, YELLOW, t * 3)


def ferris(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, mood: str = "happy", claw: float = 0.0, look=(0.0, 0.0), bg=BG):
    """Rust crab. Reference shell is 190x120 logical pixels."""
    s = scale
    bob = math.sin(t * 2.6) * 4 * s
    x, y = xy[0], xy[1] + bob
    w, h = 190 * s, 120 * s
    ink = OUTLINE
    # legs
    for side in (-1, 1):
        for i in range(3):
            lx = x + side * (w * 0.20 + i * 26 * s)
            step = math.sin(t * 7 + i * 1.5 + (0 if side > 0 else math.pi)) * 7 * s
            c.line([(lx, y + h * 0.28), (lx + side * 14 * s, y + h * 0.56 + step)], RUST, 9 * s)
            c.line([(lx, y + h * 0.28), (lx + side * 14 * s, y + h * 0.56 + step)], mix(RUST, "#000000", 0.25), 5 * s)
    # claws
    lift = claw
    for side in (-1, 1):
        cx = x + side * (w * 0.60)
        cy = y - h * 0.10 - lift * 70 * s
        c.line([(x + side * w * 0.42, y + h * 0.02), (cx, cy)], RUST, 12 * s)
        open_gap = (0.5 + 0.5 * math.sin(t * 5 + side)) * 0.5
        c.ellipse((cx - 30 * s, cy - 26 * s, cx + 30 * s, cy + 26 * s), fill=ORANGE, outline=ink, width=4.5 * s)
        c.poly(
            [
                (cx + side * 8 * s, cy - 4 * s),
                (cx + side * 36 * s, cy - (10 + 16 * open_gap) * s),
                (cx + side * 36 * s, cy + (10 + 16 * open_gap) * s),
            ],
            fill=bg,
        )
    # shell
    c.ellipse((x - w / 2 + 5 * s, y - h / 2 + 10 * s, x + w / 2 + 5 * s, y + h / 2 + 10 * s), fill=mix(BG, "#000000", 0.45))
    c.ellipse((x - w / 2, y - h / 2, x + w / 2, y + h / 2), fill=ORANGE, outline=ink, width=6 * s)
    c.ellipse((x - w * 0.42, y - h * 0.40, x + w * 0.42, y + h * 0.05), fill=mix(ORANGE, INK, 0.16))
    # eyes riding on the shell
    for side in (-1, 1):
        ex = x + side * w * 0.17
        c.line([(ex, y - h * 0.18), (ex, y - h * 0.34)], RUST, 9 * s)
        _eye(c, (ex, y - h * 0.40), 21 * s, blink_open(t, 1.2 + (0 if side < 0 else 0.03)), look)
    _smile(c, (x, y + h * 0.05), 60 * s, 17 * s, width=6 * s, open_mouth=1.0 if mood == "surprised" else 0.0)
    if mood == "work":
        c.line([(x + w * 0.45, y + h * 0.1), (x + w * 0.78, y - h * 0.25)], MUTED, 10 * s)
        c.circle((x + w * 0.80, y - h * 0.30), 14 * s, fill=INK2, outline=ink, width=4 * s)


def js_engine(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, strain: float = 0.0, smoke: bool = True):
    """The script engine as heavy machinery. Reference body is 230x190."""
    s = scale
    shiver = strain * math.sin(t * 22) * 3 * s
    x, y = xy[0] + shiver, xy[1] + math.sin(t * 1.6) * 2 * s
    w, h = 230 * s, 190 * s
    ink = OUTLINE
    body = mix("#4a5260", RED, strain * 0.35)
    # chimney and smoke
    c.rrect((x + w * 0.16, y - h * 0.72, x + w * 0.34, y - h * 0.44), 8 * s, fill=shade(body, -0.2), outline=ink, width=5 * s)
    if smoke:
        for i in range(4):
            k = ((t * 0.7 + i * 0.25) % 1.0)
            puff = 14 * s + k * 34 * s
            c.circle(
                (x + w * 0.25 + math.sin(k * 5 + i) * 26 * s, y - h * 0.78 - k * 130 * s),
                puff,
                fill=mix(BG, MUTED, lerp(0.55, 0.0, k)),
            )
    # feet
    for side in (-1, 1):
        c.rrect((x + side * w * 0.38 - 26 * s, y + h * 0.44, x + side * w * 0.38 + 26 * s, y + h * 0.58), 7 * s, fill=shade(body, -0.35), outline=ink, width=4 * s)
    c.rrect((x - w / 2 + 6 * s, y - h / 2 + 10 * s, x + w / 2 + 6 * s, y + h / 2 + 10 * s), 24 * s, fill=mix(BG, "#000000", 0.5))
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 24 * s, fill=body, outline=ink, width=6 * s)
    for sx in (-1, 1):
        for sy in (-1, 1):
            c.circle((x + sx * w * 0.40, y + sy * h * 0.36), 7 * s, fill=shade(body, -0.4))
    # JS plate
    pw, ph = w * 0.46, h * 0.30
    c.rrect((x - w * 0.40, y - h * 0.30, x - w * 0.40 + pw, y - h * 0.30 + ph), 6 * s, fill=JS_YELLOW, outline=ink, width=4 * s)
    c.text((x - w * 0.40 + pw * 0.5, y - h * 0.30 + ph * 0.56), "JS", 40 * s, OUTLINE, "latin", anchor="mm")
    # gauge
    gx, gy, gr = x + w * 0.22, y - h * 0.12, 34 * s
    c.circle((gx, gy), gr, fill=TERM, outline=ink, width=5 * s)
    needle = lerp(-2.4, -0.6, clamp(strain * 0.8 + 0.2 + 0.08 * math.sin(t * 9)))
    c.line([(gx, gy), (gx + math.cos(needle) * gr * 0.8, gy + math.sin(needle) * gr * 0.8)], RED if strain > 0.4 else CYAN, 6 * s)
    c.circle((gx, gy), 6 * s, fill=INK2)
    # vent grille
    for i in range(4):
        yy = y + h * 0.12 + i * 12 * s
        c.rrect((x - w * 0.38, yy, x + w * 0.10, yy + 6 * s), 3 * s, fill=shade(body, -0.35))
    # eyes and strain
    for side in (-1, 1):
        _eye(c, (x + side * 26 * s, y + h * 0.30), 14 * s, blink_open(t, 2.1))
    if strain > 0.3:
        for i, side in enumerate((-1, 1)):
            k = (t * 1.6 + i * 0.5) % 1.0
            dx = x + side * w * 0.52
            dy = y - h * 0.34 + k * 90 * s
            c.ellipse((dx - 9 * s, dy - 13 * s, dx + 9 * s, dy + 11 * s), fill=CYAN, outline=mix(CYAN, OUTLINE, 0.4), width=2 * s)


def counter_screen(c: Canvas, box, count: int, focus: bool = True, flash: float = 0.0, pressed: bool = False):
    """The docs counter: one text binding and one focusable button, drawn to fit `box`."""
    x0, y0, x1, y1 = box
    w = x1 - x0
    u = w / 200.0
    c.rrect(box, 8 * u, fill="#f5f3ff")
    if flash > 0:
        c.rrect((x0 + 10 * u, y0 + 12 * u, x0 + 130 * u, y0 + 44 * u), 5 * u, fill=mix("#f5f3ff", CYAN, flash))
    c.text((x0 + 16 * u, y0 + 28 * u), f"Count: {count}", 21 * u, "#1e1b4b", "mono", anchor="lm")
    bx0, by0 = x0 + 16 * u, y0 + 56 * u
    bx1, by1 = x0 + 128 * u, y0 + 92 * u
    fill = "#1d4ed8" if pressed else ("#3b82f6" if focus else "#60a5fa")
    c.rrect((bx0, by0, bx1, by1), 8 * u, fill=fill, outline="#1e3a8a", width=2 * u)
    c.text(((bx0 + bx1) / 2, (by0 + by1) / 2 + u), "ADD ONE", 17 * u, INK, "mono", anchor="mm")
    if focus:
        c.rrect((bx0 - 5 * u, by0 - 5 * u, bx1 + 5 * u, by1 + 5 * u), 12 * u, outline=PINK, width=3 * u)


def handheld(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, face: bool = False, screen=None, mood: str = "happy"):
    """Brand-mark handheld. Reference shell is 420x290 logical pixels."""
    s = scale
    x, y = xy[0], xy[1] + math.sin(t * 1.9) * 4 * s
    w, h = 420 * s, 290 * s
    ink = OUTLINE
    if face:
        for side in (-1, 1):
            fx = x + side * w * 0.22
            c.line([(fx, y + h * 0.48), (fx, y + h * 0.60)], ink, 10 * s)
            c.ellipse((fx - 22 * s, y + h * 0.56, fx + 22 * s, y + h * 0.70), fill=YELLOW, outline=ink, width=4 * s)
    c.rrect((x - w / 2 + 7 * s, y - h / 2 + 12 * s, x + w / 2 + 7 * s, y + h / 2 + 12 * s), 60 * s, fill=mix(BG, "#000000", 0.5))
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 60 * s, fill="#171226", outline=YELLOW, width=11 * s)
    screen_box = (x - w * 0.44, y - h * 0.30, x + w * 0.10, y + h * 0.30)
    c.rrect(screen_box, 14 * s, fill="#0b0817", outline=mix(BG, CYAN, 0.45), width=4 * s)
    inner = (screen_box[0] + 8 * s, screen_box[1] + 8 * s, screen_box[2] - 8 * s, screen_box[3] - 8 * s)
    if screen:
        screen(c, inner)
    else:
        c.rrect(inner, 10 * s, fill="#120c22")
        fx = (inner[0] + inner[2]) / 2
        fy = (inner[1] + inner[3]) / 2
        if face:
            for side in (-1, 1):
                _eye(c, (fx + side * 40 * s, fy - 14 * s), 20 * s, blink_open(t, 0.8), sclera=CYAN, ink="#07131a")
            if mood == "strain":
                c.line([(fx - 30 * s, fy + 34 * s), (fx + 30 * s, fy + 34 * s)], CYAN, 6 * s)
                for i, side in enumerate((-1, 1)):
                    k = (t * 1.4 + i * 0.5) % 1.0
                    sx = fx + side * 74 * s
                    sy = fy - 30 * s + k * 70 * s
                    c.ellipse((sx - 7 * s, sy - 11 * s, sx + 7 * s, sy + 9 * s), fill=CYAN)
            else:
                _smile(c, (fx, fy + 24 * s), 62 * s, 16 * s, color=CYAN, width=6 * s)
        else:
            c.circle((fx, fy), 24 * s, fill=PINK)
    # right-hand keys, matching the mark's accents
    c.circle((x + w * 0.30, y - h * 0.16), 26 * s, fill=PINK)
    c.rrect((x + w * 0.18, y + h * 0.02, x + w * 0.42, y + h * 0.10), 10 * s, fill=CYAN)
    c.rrect((x + w * 0.18, y + h * 0.16, x + w * 0.33, y + h * 0.24), 10 * s, fill=PINK)
    if face:
        for side in (-1, 1):
            ax = x + side * w * 0.52
            ay = y + h * 0.02
            swing = math.sin(t * 2.4 + side) * 10 * s
            c.line([(x + side * w * 0.48, y - h * 0.06), (ax + side * 30 * s, ay + swing)], OUTLINE, 10 * s)
            c.circle((ax + side * 30 * s, ay + swing), 14 * s, fill=YELLOW, outline=OUTLINE, width=4 * s)


def gba(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, cart: float = 1.0, screen=None, boot: float = 1.0):
    """Wide 2001-era handheld with a cartridge slot. Reference shell is 560x330."""
    s = scale
    x, y = xy
    w, h = 560 * s, 330 * s
    ink = OUTLINE
    shell = "#5b52a8"
    # cartridge sliding into the top slot
    if cart > 0:
        cw, ch = 210 * s, 150 * s
        cy = y - h * 0.50 - ch * (1.0 - cart) - ch * 0.28
        c.rrect((x - cw / 2, cy - ch / 2, x + cw / 2, cy + ch / 2), 14 * s, fill="#2b2148", outline=ink, width=5 * s)
        c.rrect((x - cw * 0.40, cy - ch * 0.34, x + cw * 0.40, cy + ch * 0.06), 8 * s, fill=YELLOW)
        c.text((x, cy - ch * 0.14), "gba-hero", 26 * s, OUTLINE, "mono", anchor="mm")
        for i in range(7):
            c.rrect((x - cw * 0.34 + i * cw * 0.10, cy + ch * 0.20, x - cw * 0.34 + i * cw * 0.10 + cw * 0.06, cy + ch * 0.42), 3 * s, fill=mix(YELLOW, MUTED, 0.4))
    c.rrect((x - w / 2 + 7 * s, y - h / 2 + 12 * s, x + w / 2 + 7 * s, y + h / 2 + 12 * s), 46 * s, fill=mix(BG, "#000000", 0.5))
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 46 * s, fill=shell, outline=ink, width=6 * s)
    c.rrect((x - w / 2 + 12 * s, y - h / 2 + 12 * s, x + w / 2 - 12 * s, y - h / 2 + 30 * s), 14 * s, fill=shade(shell, 0.18))
    bezel = (x - w * 0.30, y - h * 0.32, x + w * 0.19, y + h * 0.30)
    c.rrect(bezel, 16 * s, fill="#241f45", outline=shade(shell, -0.35), width=5 * s)
    glass = (bezel[0] + 14 * s, bezel[1] + 14 * s, bezel[2] - 14 * s, bezel[3] - 14 * s)
    if screen and boot > 0.05:
        screen(c, glass)
        if boot < 1.0:
            c.rrect(glass, 6 * s, fill=mix("#f8fafc", "#ffffff", 0.0)) if False else None
    else:
        c.rrect(glass, 6 * s, fill="#0d1a12")
    if boot < 1.0:
        band = lerp(glass[1], glass[3], boot)
        c.rect((glass[0], band, glass[2], glass[3]), fill="#0d1a12")
        c.rect((glass[0], band - 4 * s, glass[2], band + 2 * s), fill=GREEN)
    # d-pad and buttons
    dx, dy = x - w * 0.37, y + h * 0.10
    c.rrect((dx - 46 * s, dy - 15 * s, dx + 46 * s, dy + 15 * s), 6 * s, fill="#2a2450", outline=ink, width=4 * s)
    c.rrect((dx - 15 * s, dy - 46 * s, dx + 15 * s, dy + 46 * s), 6 * s, fill="#2a2450", outline=ink, width=4 * s)
    c.rrect((dx - 12 * s, dy - 12 * s, dx + 12 * s, dy + 12 * s), 4 * s, fill="#2a2450")
    for i, (bx, by, label) in enumerate(((x + w * 0.40, y + h * 0.02, "A"), (x + w * 0.28, y + h * 0.18, "B"))):
        c.circle((bx, by), 28 * s, fill="#ff5f9e" if i == 0 else "#3fd0e8", outline=ink, width=4 * s)
        c.text((bx, by + 1 * s), label, 26 * s, OUTLINE, "latin", anchor="mm")
    c.text((x - w * 0.06, y + h * 0.40), "MICROTS ADVANCE", 20 * s, mix(shell, INK, 0.55), "latin", anchor="mm")


def hero_screen(c: Canvas, box, count: int = 0, phase: int = 0, underline: float = 1.0, t: float = 0.0):
    """apps/gba-hero at 240x160, redrawn to the TSX layout."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    u = w / 240.0  # the app's logical pixel
    c.rrect(box, 6, fill="#f8fafc")
    c.rect((x0, y0 + h * 0.5, x1, y1), fill="#f1f5f9")
    c.rrect((x0 + 8 * u, y0 + 8 * u, x0 + 32 * u, y0 + 32 * u), 5 * u, fill=YELLOW, outline="#cbd5e1", width=1.5 * u)
    c.circle((x0 + 20 * u, y0 + 20 * u), 6 * u, fill=PINK)
    c.text((x0 + 40 * u, y0 + 14 * u), "PocketJS", 11 * u, "#020617", "latin", anchor="lm")
    c.text((x0 + 40 * u, y0 + 26 * u), "MICROTS + GBA", 8 * u, "#64748b", "latin", anchor="lm")
    c.text((x1 - 8 * u, y0 + 13 * u), "30", 15 * u, "#059669", "latin", anchor="rm")
    c.text((x1 - 8 * u, y0 + 27 * u), "FPS target", 8 * u, "#64748b", "latin", anchor="rm")
    c.text((x0 + 8 * u, y0 + 48 * u), "ONE RUST CORE / ONE TSX APP", 8 * u, "#2563eb", "latin", anchor="lm")
    c.text((x0 + 8 * u, y0 + 68 * u), "JSX on GBA.", 17 * u, "#020617", "latin", anchor="lm")
    # spinner: eight baked frames
    sx, sy = x0 + 216 * u, y0 + 74 * u
    for i in range(8):
        a = phase * math.tau / 8 + i * math.tau / 8
        fade = 1.0 - (i / 8) * 0.8
        c.line(
            [(sx + math.cos(a) * 6 * u, sy + math.sin(a) * 6 * u), (sx + math.cos(a) * 13 * u, sy + math.sin(a) * 13 * u)],
            mix("#f8fafc", "#2563eb", fade),
            3 * u,
        )
    bar_w = 144 * u * clamp(underline)
    if bar_w > 1:
        steps = 20
        for i in range(steps):
            xa = x0 + 8 * u + bar_w * i / steps + count * 2 * u
            xb = x0 + 8 * u + bar_w * (i + 1) / steps + 1 + count * 2 * u
            c.rect((xa, y0 + 87 * u, xb, y0 + 90 * u), fill=mix("#3b82f6", "#06b6d4", i / (steps - 1)))
    c.text((x0 + 8 * u, y0 + 103 * u), "TSX + flexbox, 2001 hardware.", 8 * u, "#475569", "latin", anchor="lm")
    c.rrect((x0 + 8 * u, y0 + 118 * u, x0 + 88 * u, y0 + 142 * u), 5 * u, fill="#2563eb", outline="#3b82f6", width=1.5 * u)
    c.text((x0 + 48 * u, y0 + 130 * u), "Press A", 9 * u, INK, "latin", anchor="mm")
    c.text((x0 + 100 * u, y0 + 128 * u), f"Count: {count}", 8 * u, "#475569", "latin", anchor="lm")
    c.text((x0 + 185 * u, y0 + 128 * u), "B: Reset", 8 * u, "#64748b", "latin", anchor="lm")
    if count > 3:
        c.text((x0 + 8 * u, y0 + 150 * u), "Reactive on GBA.", 8 * u, "#059669", "latin", anchor="lm")


def cartridge(c: Canvas, xy, scale: float = 1.0, label: str = "app", glow: float = 0.0, t: float = 0.0):
    """Generic build artifact: a cartridge sticker card."""
    s = scale
    x, y = xy
    w, h = 190 * s, 210 * s
    if glow > 0:
        for i in range(4, 0, -1):
            c.rrect(
                (x - w / 2 - i * 8 * s, y - h / 2 - i * 8 * s, x + w / 2 + i * 8 * s, y + h / 2 + i * 8 * s),
                20 * s + i * 6 * s,
                fill=mix(BG, YELLOW, 0.10 * glow * (5 - i) / 4),
            )
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 18 * s, fill=PANEL2, outline=OUTLINE, width=5 * s)
    c.rrect((x - w * 0.38, y - h * 0.40, x + w * 0.38, y + h * 0.04), 10 * s, fill=YELLOW)
    c.text((x, y - h * 0.18), label, 24 * s, OUTLINE, "mono", anchor="mm")
    for i in range(6):
        c.rrect(
            (x - w * 0.34 + i * w * 0.12, y + h * 0.18, x - w * 0.34 + i * w * 0.12 + w * 0.07, y + h * 0.40),
            3 * s,
            fill=mix(YELLOW, MUTED, 0.35),
        )
