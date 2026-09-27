"""The nine Pocket Chan clips.

Each entry builds one looping animation: `frames(i, n)` returns the `Look` for
frame i of n, and every motion is a sine of `i / n` so the last frame hands
back to the first without a seam. `step` is how many vblanks one frame holds —
the core advances the atlas on its own vblank counter, so this is the whole
timing model.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

from geom import wave, wave2
from rig import Arm, Look


@dataclass(frozen=True)
class Clip:
    key: str
    group: str
    frames: int
    step: int
    build: Callable[[int, int], Look]


def _phase(i: int, n: int) -> float:
    return i / n


# --- emotions ---------------------------------------------------------------

def smile(i: int, n: int) -> Look:
    t = _phase(i, n)
    return Look(
        bob=wave(t) * 0.9,
        hair_sway=wave(t) * 0.7,
        skirt_sway=wave(t) * 0.5,
        head_tilt=wave(t) * 2.2,
        eyes="closed" if i == n - 2 else "open",
        mouth="smile",
        arm_l=Arm(swing=9 + wave(t) * 2.0, bend=11),
        arm_r=Arm(swing=9 - wave(t) * 2.0, bend=11),
    )


def happy(i: int, n: int) -> Look:
    t = _phase(i, n)
    hop = abs(math.sin(t * math.pi * 2.0))
    return Look(
        bob=-hop * 3.4,
        hair_sway=-wave2(t) * 1.4,
        skirt_sway=wave2(t) * 1.1,
        head_tilt=wave(t) * 5.0,
        eyes="happy",
        mouth="grin",
        brows="up",
        arm_l=Arm(reach=(-17.0, -46.0 - wave(t) * 2.5), hold="open"),
        arm_r=Arm(reach=(17.0, -46.0 + wave(t) * 2.5), hold="open"),
        props=["hearts"],
    )


def think(i: int, n: int) -> Look:
    t = _phase(i, n)
    return Look(
        bob=wave(t) * 0.6,
        lean=-1.6,
        head_tilt=-7.0 + wave(t) * 1.8,
        head_dx=-1.0,
        hair_sway=wave(t) * 0.5,
        eyes="half",
        mouth="flat",
        brows="worry",
        blush=False,
        arm_l=Arm(reach=(-3.5, -33.0 + wave(t) * 0.6), hold="point"),
        arm_r=Arm(reach=(10.0, -18.0), elbow_in=True, behind=True),
        props=["question"],
    )


def nap(i: int, n: int) -> Look:
    t = _phase(i, n)
    breathe = wave(t)
    return Look(
        bob=2.6 + breathe * 1.1,
        lean=5.0,
        head_tilt=13.0 + breathe * 1.6,
        head_dx=2.0,
        head_dy=2.4,
        hair_sway=1.4 + breathe * 0.7,
        eyes="sleep",
        mouth="small",
        brows="worry",
        legs="tuck",
        arm_l=Arm(swing=-4, bend=8),
        arm_r=Arm(swing=-4, bend=8),
        props=["zzz"],
    )


# --- actions ----------------------------------------------------------------

def code(i: int, n: int) -> Look:
    t = _phase(i, n)
    tap = math.sin(t * math.tau * 2.0)
    return Look(
        bob=wave(t) * 0.5,
        lean=2.2,
        head_tilt=3.0,
        head_dy=1.2,
        hair_sway=wave(t) * 0.4,
        eyes="half",
        mouth="flat",
        brows="flat",
        blush=False,
        arm_l=Arm(reach=(-8.5, -5.0 + tap * 1.3), hold="open"),
        arm_r=Arm(reach=(8.5, -5.0 - tap * 1.3), hold="open"),
        props=["laptop"],
    )


def hug(i: int, n: int) -> Look:
    t = _phase(i, n)
    squeeze = wave(t)
    return Look(
        bob=squeeze * 1.2,
        head_tilt=-4.0 + squeeze * 2.0,
        hair_sway=squeeze * 0.9,
        eyes="happy",
        mouth="cat",
        arm_l=Arm(reach=(-13.0 + squeeze * 0.8, -6.0), hold="open"),
        arm_r=Arm(reach=(13.0 - squeeze * 0.8, -6.0), hold="open"),
        props=["logo", "sparkles"],
    )


def proud(i: int, n: int) -> Look:
    t = _phase(i, n)
    return Look(
        bob=wave(t) * 1.4,
        lean=-2.4,
        head_tilt=-6.0 + wave(t) * 2.0,
        hair_sway=-wave(t) * 1.1,
        skirt_sway=-wave(t) * 0.8,
        eyes="wink",
        mouth="cat",
        brows="up",
        arm_l=Arm(swing=-16, bend=22),
        arm_r=Arm(reach=(20.0, -48.0 - wave(t) * 2.0), hold="point"),
        props=["sparkles"],
    )


def go(i: int, n: int) -> Look:
    t = _phase(i, n)
    stride = wave(t)
    return Look(
        turn=0.34,
        bob=-abs(stride) * 2.2,
        lean=-9.0,
        head_tilt=-4.0,
        head_dx=1.8,
        hair_sway=-3.2 - abs(stride) * 1.0,
        skirt_sway=-2.8,
        eyes="sparkle",
        mouth="open",
        brows="up",
        legs="apart",
        step=stride,
        arm_l=Arm(reach=(-4.0 + stride * 13.0, -21.0 - stride * 5.0), hold="fist"),
        arm_r=Arm(reach=(6.0 - stride * 13.0, -19.0 + stride * 5.0), hold="fist", behind=True),
        props=["bag"],
    )


# --- turnaround -------------------------------------------------------------

def spin(i: int, n: int) -> Look:
    """Front -> right 3/4 -> back -> left 3/4 -> front, one frame per stop."""
    t = _phase(i, n)
    a = t * math.tau
    facing = math.sin(a)
    back = math.cos(a) < 0.0
    return Look(
        turn=(-facing if back else facing) * 1.0,
        back=back,
        bob=wave2(t) * 0.5,
        hair_sway=-facing * 1.1,
        skirt_sway=-facing * 0.9,
        eyes="open",
        mouth="smile",
        arm_l=Arm(swing=10, bend=12),
        arm_r=Arm(swing=10, bend=12),
    )


CLIPS: list[Clip] = [
    Clip("smile", "mood", 8, 8, smile),
    Clip("happy", "mood", 8, 5, happy),
    Clip("think", "mood", 8, 7, think),
    Clip("nap", "mood", 8, 9, nap),
    Clip("code", "work", 8, 5, code),
    Clip("hug", "work", 8, 7, hug),
    Clip("proud", "work", 8, 6, proud),
    Clip("go", "work", 8, 4, go),
    Clip("spin", "sheet", 8, 7, spin),
]
