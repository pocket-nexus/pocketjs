"""Storyboard for the MicroTS explainer video.

Each scene carries its narration lines and a draw function. The renderer times
every scene from the spoken audio, so `ctx.since(i)` is the time since line i
started: a visual beat lands on the sentence that describes it.

Facts on screen come from site/content/docs/microts*.md, docs/STRUCTURE.md,
tests/aot-differential.test.ts and hosts/gba/README.md.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import cast
import stagecraft as sg
from stagecraft import (
    AMBER, BG, BG2, CYAN, GREEN, INK, INK2, MUTED, ORANGE, PANEL, PANEL2, PINK,
    PURPLE, RED, RUST, TERM, TS_BLUE, YELLOW, arrow, badge, bubble, burst,
    caption, clamp, code_card, conveyor, ease_out_back, ease_out_cubic,
    ease_out_elastic, lerp, mix, plate, pulse, shade, smoothstep, sparkle, stamp,
)

STAGE_TOP = 128
STAGE_BOTTOM = 848
MID = 960


@dataclass
class Ctx:
    t: float
    dur: float
    frame: int
    beats: list

    def since(self, i: int) -> float:
        return self.t - self.beats[i][0] if i < len(self.beats) else -99.0

    def on(self, i: int) -> bool:
        return self.t >= self.beats[i][0]

    def during(self, i: int) -> bool:
        if i >= len(self.beats):
            return False
        start, end = self.beats[i]
        return start <= self.t < end


@dataclass
class Scene:
    key: str
    chapter: str
    lines: list
    draw: Callable
    tail: float = 0.5
    lead: float = 0.15


def pop(t: float, dur: float = 0.42, overshoot: float = 2.0) -> float:
    if t < 0:
        return 0.0
    return ease_out_back(clamp(t / dur), overshoot)


def slide_in(t: float, start: float, end: float, dur: float = 0.55) -> float:
    return lerp(start, end, pop(t, dur, 1.6))


def no_entry(c, xy, r: float, t: float, width: float = 13) -> None:
    k = pop(t, 0.35)
    if k <= 0:
        return
    r = r * k
    c.circle(xy, r, outline=RED, width=width)
    a = math.radians(-45)
    c.line(
        [(xy[0] - math.cos(a) * r, xy[1] - math.sin(a) * r), (xy[0] + math.cos(a) * r, xy[1] + math.sin(a) * r)],
        RED,
        width,
    )


def fact_plate(c, box, title: str, rows, accent=CYAN, reveal: float = 1.0) -> None:
    x0, y0, x1, y1 = box
    plate(c, box, 20, fill=PANEL, outline=INK, width=4, shadow=9)
    c.rrect((x0 + 16, y0 + 14, x0 + 26, y1 - 14), 5, fill=accent)
    c.text((x0 + 44, y0 + 38), title, 29, INK, anchor="lm")
    for i, row in enumerate(rows):
        c.circle((x0 + 54, y0 + 88 + i * 46), 6, fill=accent)
        c.text((x0 + 74, y0 + 88 + i * 46), row, 27, INK2, anchor="lm")


# ------------------------------------------------------------------ 1. opening

def scene_open(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    t0 = x.since(0)
    ts_x = slide_in(t0 - 0.05, -260, 330)
    fe_x = slide_in(t0 - 0.15, 2200, 1590)
    dev_y = lerp(-380, 640, pop(t0 - 0.3, 0.7, 1.9))
    cast.ts_buddy(c, (ts_x, 660), 1.3, x.t, arm=0.35 + 0.2 * math.sin(x.t * 2))
    cast.ferris(c, (fe_x, 690), 1.3, x.t, claw=0.25 + 0.25 * math.sin(x.t * 1.7))
    cast.handheld(
        c, (MID, dev_y), 0.9, x.t, face=x.since(1) < 0.2,
        screen=None if x.since(1) < 0.2 else (lambda cv, b: cast.counter_screen(cv, b, 1, True, 0.5 * (0.5 + 0.5 * math.sin(x.t * 4)))),
    )
    if 0 < t0 < 1.2:
        burst(c, (MID, 640), t0 - 0.55, 0.5, 12, AMBER, 190)

    k = pop(t0 - 0.35, 0.6, 1.8)
    if k > 0:
        ty = lerp(150, 258, k)
        size = 136 * lerp(0.7, 1.0, k)
        c.text((MID + 6, ty + 7), "MicroTS", size, mix(BG, INK, 0.22), "hand", anchor="mm")
        c.text((MID, ty), "MicroTS", size, PINK, "hand", anchor="mm")
        c.stroke([(MID - 300, ty + 74), (MID + 300, ty + 74)], YELLOW, 9, amp=2.4, passes=1)
        for i in range(3):
            a = x.t * 1.6 + i * 2.1
            sparkle(c, (MID + math.cos(a) * 430, ty + math.sin(a * 1.3) * 62), 14 + 5 * math.sin(x.t * 6 + i), CYAN if i % 2 else AMBER, a)
    k1 = pop(x.since(1), 0.5)
    if k1 > 0:
        badge(c, (MID, lerp(410, 386, k1)), "TypeScript, compiled to native handheld code", 32, PANEL, INK, 30)
        arrow(c, (470, 670), (760, 670), INK, 6, 22, bend=-34)
        c.text((615, 600), "compile", 28, INK2, anchor="mm")
        arrow(c, (1160, 670), (1410, 670), INK, 6, 22, bend=-34)
        c.text((1290, 600), "run", 28, INK2, anchor="mm")

    k2 = x.since(2)
    if k2 > -0.2:
        ex = lerp(2400, 1570, pop(k2, 0.5))
        fade = clamp(1 - (k2 - 2.6) / 0.6) if k2 > 2.6 else 1.0
        if fade > 0.05:
            cast.js_engine(c, (ex, 300 + 26 * math.sin(x.t * 2)), 0.6 * fade, x.t, strain=0.2, smoke=fade > 0.5)
            no_entry(c, (ex, 300), 100 * fade, k2 - 0.45)
        stamp(c, (430, 252), "No JS engine at runtime", k2 - 0.9, 40, PINK, PANEL, -7)
        if k2 > 0.9:
            burst(c, (430, 252), k2 - 0.9, 0.6, 14, AMBER, 240)


# --------------------------------------------------------------- 2. motivation

def scene_why(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    strain = clamp(smoothstep(0.2, 1.4, x.since(1)) - smoothstep(0.1, 0.9, x.since(2)))
    dev_x = 360
    cast.handheld(c, (dev_x, 400), 0.74, x.t, face=True, mood="strain" if strain > 0.4 else "happy")
    k0 = pop(x.since(0) - 0.7, 0.5)
    if k0 > 0:
        fact_plate(c, (dev_x - 300 * k0, 600, dev_x + 300 * k0, 790), "Handheld / MCU", ["memory in megabytes", "CPU at tens of MHz"], CYAN)

    k1 = x.since(1)
    k2 = x.since(2)
    moved = clamp(smoothstep(0.1, 1.0, k2))
    if k1 > -0.2:
        ex = lerp(2400, 1080, pop(k1, 0.8, 1.2)) + moved * 1500
        cast.js_engine(c, (ex, 420), 1.5, x.t, strain=strain, smoke=True)
        if moved < 0.3:
            c.text((ex, 660), "a script engine", 30, INK, anchor="mm")
            c.text((ex, 702), "parser + interpreter + GC", 25, MUTED, anchor="mm")

    if k2 > 0:
        kk = pop(k2 - 0.1, 0.55)
        box = (lerp(2200, 980, kk), 250, lerp(2900, 1760, kk), 700)
        plate(c, box, 22, fill=PANEL, outline=INK, width=4, shadow=10)
        c.text(((box[0] + box[2]) / 2, box[1] + 52), "done at build time", 34, INK, anchor="mm")
        c.stroke([(box[0] + 90, box[1] + 84), (box[2] - 90, box[1] + 84)], YELLOW, 7, amp=2, passes=1)
    costs = ["parse the source", "interpret it", "collect garbage"]
    for i, label in enumerate(costs):
        kc = pop(k1 - 0.75 - i * 0.45, 0.4)
        if kc <= 0:
            continue
        home = (1660, 250 + i * 150)
        landed = (1370, 410 + i * 112)
        move = pop(k2 - 0.35 - i * 0.18, 0.6)
        bx = lerp(home[0], landed[0], move)
        by = lerp(home[1], landed[1], move)
        fill = mix(mix(BG, RED, 0.45), YELLOW, move)
        badge(c, (bx, by), label, 31, fill, INK, 26)
        if 0.2 < move < 0.9:
            burst(c, (bx, by), move - 0.2, 0.5, 6, AMBER, 70)
    if k2 > 1.5:
        badge(c, (dev_x, 890), "the device runs machine code", 29, mix(BG, CYAN, 0.55), INK, 24)


# ------------------------------------------------------------------- 3. source

VIEW_CODE = [
    'import { Text, View } from ".../solid/components";',
    'import { count, setCount } from "./Counter";',
    "",
    "export default function Counter() {",
    "  return (",
    "    <View focusable onPress={() => setCount(count()+1)}>",
    "      <Text>Count: {count()}</Text>",
    "    </View>",
    "  );",
    "}",
]

MODEL_CODE = [
    'import { createSignal } from "solid-js";',
    'import type { i32 } from ".../solid/std";',
    "",
    "export const [count, setCount] = createSignal<i32>(0);",
    "",
    "export function increment(): void {",
    "  setCount(count() + 1);",
    "}",
]


def scene_source(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    left = (120, 250, 960, 700)
    right = (1000, 250, 1840, 700)
    code_card(c, left, "Counter.tsx", VIEW_CODE, 23, reveal=clamp(x.since(0) / 1.6), accent=CYAN,
              highlight=(6,) if x.since(1) > 1.2 else ())
    if x.since(0) > 0.1:
        c.text((left[0] + 8, 202), "view: what is on screen", 30, INK, anchor="lm")
    if x.since(1) > -0.2:
        code_card(c, right, "Counter.ts", MODEL_CODE, 23, reveal=clamp(x.since(1) / 1.9), accent=YELLOW,
                  highlight=(3,) if x.since(2) > 0.3 else ())
        c.text((right[0] + 8, 202), "model: state and methods", 30, INK, anchor="lm")
    k0 = pop(x.since(0) - 0.2, 0.5)
    cast.ts_buddy(c, (lerp(-200, 150, k0), 830), 0.78, x.t, arm=0.7, look=(0.4, -0.3))
    if x.since(1) > 0.4:
        arrow(c, (700, 762), (1120, 762), PINK, 6, 20, bend=26)
        c.text((910, 816), "same basename", 28, PINK, anchor="mm")

    k2 = x.since(2)
    if k2 > 0:
        kk = pop(k2, 0.45)
        badge(c, (1480, lerp(860, 800, kk)), "i32  →  a Rust i32", 29, mix(BG, CYAN, 0.55), INK, 26)
        arrow(c, (1480, 762), (1450, 706), CYAN, 6, 18)
    if k2 > 1.3:
        kk = pop(k2 - 1.3, 0.45)
        text = "number → f64, rejected under --strict"
        cx, cy = 560, 800
        badge(c, (cx, cy), text, 27, mix(BG, RED, 0.35), INK, 24)
        half = c.measure(text, 27) / 2 + 20
        c.line([(cx - half * kk, cy + 20), (cx + half * kk, cy - 20)], RED, 5)


# ----------------------------------------------------------------- 4. pipeline

STATIONS = [
    ("TypeScript checker", CYAN, "every value's real type"),
    ("View IR + Model IR", PURPLE, "nodes, bindings, state, tasks"),
    ("Rust codegen", ORANGE, "gen/*.rs + styles.bin"),
    ("Cargo + microts", YELLOW, "one native program"),
]
STATION_X = [420, 830, 1240, 1650]


def _station(c, x_pos: float, y: float, index: int, appear: float, active: float) -> None:
    label, color, note = STATIONS[index]
    k = pop(appear, 0.45)
    if k <= 0:
        return
    w, h = 356 * k, 206 * k
    top = y - h
    c.rrect((x_pos - w / 2 + 7, top + 10, x_pos + w / 2 + 7, y + 10), 22, fill=mix(BG, INK, 0.14))
    c.rrect((x_pos - w / 2, top, x_pos + w / 2, y), 22, fill=mix(BG, color, 0.3 + 0.28 * active), outline=INK, width=4)
    c.rrect((x_pos - w / 2 + 16, top + 16, x_pos + w / 2 - 16, top + h * 0.46), 12, fill=PANEL, outline=INK, width=3)
    if k > 0.9:
        c.text((x_pos, top + h * 0.31), label, 25, INK, anchor="mm")
        for i, line in enumerate(c.wrap(note, 21, w - 40)[:2]):
            c.text((x_pos, top + h * 0.62 + i * 28), line, 21, INK2, anchor="mm")
        for i in range(3):
            lit = (c.frame // 6 + i) % 3 == 0 and active > 0.2
            c.circle((x_pos - 40 + i * 40, y - 22), 7, fill=color if lit else mix(BG, color, 0.35), outline=INK, width=2)


def scene_pipeline(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    belt_y = 686
    conveyor(c, (110, belt_y, 1810, belt_y + 54), x.t, 150)
    beats = [x.since(i) for i in range(4)]
    for i in range(4):
        active = clamp(smoothstep(-0.1, 0.5, beats[i]) - (smoothstep(0.1, 0.7, beats[i + 1]) if i + 1 < 4 else 0))
        _station(c, STATION_X[i], belt_y - 104, i, beats[i] - 0.05, active)

    stage = -1
    for i in range(4):
        if beats[i] > 0.15:
            stage = i
    progress = clamp((beats[stage] - 0.15) / 0.9) if stage >= 0 else 0.0
    start_x = 150 if stage <= 0 else STATION_X[stage - 1]
    end_x = STATION_X[0] if stage < 0 else STATION_X[stage]
    item_x = lerp(start_x, end_x, ease_out_cubic(progress))
    item_y = belt_y - 30 + math.sin(x.t * 4) * 4

    labels = [
        ("Counter.tsx + Counter.ts", CYAN),
        ("types known: i32 / str / bool", CYAN),
        ("View IR · Model IR", PURPLE),
        ("gen/counter.rs · styles.bin", ORANGE),
    ]
    if stage < 3 or progress < 0.9:
        label, color = labels[max(0, stage)]
        w = c.measure(label, 25, "mono") + 54
        c.rrect((item_x - w / 2, item_y - 32, item_x + w / 2, item_y + 32), 14, fill=PANEL, outline=INK, width=3.6)
        c.text((item_x, item_y + 1), label, 25, mix(color, INK, 0.35), "mono", anchor="mm", jitter=0.3)
    for i in range(4):
        if 0.1 < beats[i] < 1.4:
            burst(c, (STATION_X[i], belt_y - 40), beats[i] - 0.65, 0.5, 8, STATIONS[i][1], 130)

    k1 = x.since(1)
    if 0.4 < k1 and x.since(3) < 0.2:
        for i, (title, rows, color) in enumerate(
            [
                ("View IR format 1", ["nodes and structure", "binding expressions", "input dispatch"], PURPLE),
                ("Model IR format 1", ["state and derived values", "dependencies and schedule", "task state machines"], PINK),
            ]
        ):
            kk = pop(k1 - 0.4 - i * 0.25, 0.5)
            if kk <= 0:
                continue
            bx = 620 + i * 620
            leave = clamp(smoothstep(-0.2, 0.2, x.since(3)))
            fact_plate(c, (bx - 280, lerp(380, 128, kk) - leave * 300, bx + 280, lerp(380, 340, kk) - leave * 300), title, rows, color)
    k3 = x.since(3)
    if k3 > 0.5:
        kk = pop(k3 - 0.5, 0.6, 2.2)
        cast.cartridge(c, (1640, lerp(660, 212, kk)), 0.88 * kk, "native binary", glow=kk, t=x.t)
        cast.ferris(c, (1170, 268), 0.72, x.t, claw=0.7, mood="work")
        if k3 > 1.2:
            badge(c, (1640, 344), "no_std Rust · no engine", 26, mix(BG, YELLOW, 0.65), INK, 22)


# -------------------------------------------------------------------- 5. trait

TRAIT_CODE = [
    "pub trait CounterViewModel {",
    "    fn count(&self) -> i32;",
    "    fn set_count(&mut self, value: i32);",
    "}",
]


def scene_trait(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    card = (620, 300, 1300, 560)
    rows = TRAIT_CODE if x.since(1) > 1.5 else TRAIT_CODE[:2] + ["}"]
    highlight = ()
    if 0.4 < x.since(1) < 1.5:
        highlight = (1,)
    elif x.since(1) >= 1.5:
        highlight = (2,)
    code_card(c, card, "gen/counter.rs", rows, 26, accent=YELLOW, highlight=highlight)
    c.text((960, 248), "one Rust trait between view and model", 30, INK, anchor="mm")

    kv = pop(x.since(0), 0.5)
    vx = lerp(-200, 300, kv)
    plate(c, (vx - 190, 380, vx + 190, 700), 22, fill=PANEL, outline=INK, width=4)
    c.text((vx, 420), "generated view", 30, INK, anchor="mm")
    cast.counter_screen(c, (vx - 150, 452, vx + 150, 582), 1, True, 0.0)
    c.text((vx, 628), "calls vm.count()", 25, INK2, anchor="mm")
    c.text((vx, 664), "no reflection, no bridge", 24, MUTED, anchor="mm")

    km = pop(x.since(0) - 0.2, 0.5)
    mx = lerp(2120, 1620, km)
    plate(c, (mx - 200, 380, mx + 200, 700), 22, fill=PANEL, outline=INK, width=4)
    c.text((mx, 420), "model implementation", 28, INK, anchor="mm")
    pick = clamp(smoothstep(0.2, 0.8, x.since(2)))
    for i, (title, note, who) in enumerate(
        [("compiled", "generated from your .ts", TS_BLUE), ("rust", "you write it in Rust", RUST)]
    ):
        on = (1 - pick) if i == 0 else pick
        if x.since(2) < 0:
            on = 1.0 if i == 0 else 0.3
        y0 = 468 + i * 106
        c.rrect((mx - 172, y0, mx + 172, y0 + 88), 16, fill=mix(BG, who, 0.16 + 0.5 * on), outline=INK, width=3.4)
        c.text((mx, y0 + 30), title, 28, INK if on > 0.5 else MUTED, "mono", anchor="mm")
        c.text((mx, y0 + 62), note, 24, INK2 if on > 0.5 else MUTED, anchor="mm")
    if x.since(2) > 0.3:
        if pick > 0.5:
            cast.ferris(c, (mx, 812), 0.78, x.t, claw=0.5, mood="work")
        else:
            cast.ts_buddy(c, (mx, 806), 0.78, x.t, arm=0.6)

    k1 = x.since(1)
    for start, label, color, target_y in ((0.2, "{count()}", CYAN, 388), (1.3, "setCount(...)", PINK, 468)):
        age = k1 - start
        if age < 0 or age > 1.5:
            continue
        kk = clamp(age / 0.7)
        px = lerp(vx + 190, card[0] - 96, ease_out_cubic(kk))
        py = lerp(560, target_y, ease_out_cubic(kk))
        badge(c, (px, py), label, 26, mix(BG, color, 0.6), INK, 20, kind="mono")
        if age > 1.0:
            burst(c, (card[0] - 96, target_y), age - 1.0, 0.45, 7, color, 90)
    if x.since(2) > 1.2:
        badge(c, (960, 800), "admission failure stops the build", 28, PANEL, INK2, 26)


# ---------------------------------------------------------------- 6. one frame

LOOP_NODES = [
    ("frame(input)", YELLOW),
    ("input → model", PINK),
    ("update changed bindings", CYAN),
    ("layout · text · animation", PURPLE),
    ("DrawList → host", GREEN),
]


def scene_frame(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = pop(x.since(0), 0.5)
    if k0 > 0:
        c.text((300, 248), "at runtime, no:", 30, INK, anchor="mm")
        for i, label in enumerate(("ref", "effect", "render()")):
            kk = pop(x.since(0) - 0.15 - i * 0.22, 0.4)
            if kk <= 0:
                continue
            y = 330 + i * 92
            badge(c, (300, y), label, 30, PANEL, MUTED, 28, kind="mono")
            w = c.measure(label, 30, "mono") / 2 + 26
            c.line([(300 - w * kk, y + 18), (300 + w * kk, y - 18)], RED, 6)
        if x.since(1) > 0.2:
            badge(c, (300, 640), "only compiled update code", 26, mix(BG, CYAN, 0.55), INK, 22)

    k1 = pop(x.since(1), 0.6)
    if k1 > 0:
        cx, cy, r = 940, 470, 200 * k1
        c.circle((cx, cy), r, outline=mix(BG, PURPLE, 0.75), width=8)
        lap = (x.t * 0.42) % 1.0
        for i, (label, color) in enumerate(LOOP_NODES):
            a = -math.pi / 2 + i * math.tau / 5
            nx, ny = cx + math.cos(a) * r, cy + math.sin(a) * r
            live = abs(((lap - i / 5) + 0.5) % 1.0 - 0.5) < 0.1
            c.circle((nx, ny), 18, fill=color if live else mix(BG, color, 0.45), outline=INK, width=3)
            lx = cx + math.cos(a) * (r + 96)
            ly = cy + math.sin(a) * (r + 66)
            badge(c, (lx, ly), label, 25, mix(BG, color, 0.25 + 0.45 * live), INK, 20, kind="mono" if i == 0 else "hand")
        angle = -math.pi / 2 + lap * math.tau
        c.circle((cx + math.cos(angle) * r, cy + math.sin(angle) * r), 14, fill=INK)
        c.text((cx, cy - 18), "once per frame", 32, INK, anchor="mm")
        c.text((cx, cy + 26), "host driven", 27, MUTED, anchor="mm")

    k2 = x.since(2)
    count = 1 if k2 > 0.9 else 0
    flash = clamp(1.0 - (k2 - 0.9) / 0.9) if k2 > 0.9 else 0.0
    pressed = 0.55 < k2 < 0.95
    if x.since(0) > -0.2:
        cast.handheld(
            c, (1620, 420), 0.82, x.t,
            screen=lambda cv, b: cast.counter_screen(cv, b, count, True, flash, pressed),
        )
    if pressed:
        burst(c, (1620, 500), k2 - 0.55, 0.4, 7, PINK, 120)
    if k2 > 1.0:
        kk = pop(k2 - 1.0, 0.45)
        badge(c, (1620, lerp(640, 612, kk)), "only this text node changed", 26, mix(BG, CYAN, 0.55), INK, 22)
        badge(c, (1620, lerp(724, 692, kk)), "the button stays put", 26, PANEL, INK2, 22)
    k3 = x.since(3)
    if k3 > 0.2:
        kk = pop(k3 - 0.2, 0.5)
        box = (lerp(2100, 1190, kk), 790, lerp(2700, 1880, kk), 872)
        c.rrect(box, 18, fill=mix(BG, GREEN, 0.3), outline=INK, width=3.4)
        c.text((box[0] + 26, (box[1] + box[3]) / 2), "DrawList: one frame of draw commands", 26, INK, anchor="lm")


# ----------------------------------------------------------------- 7. admission

ADMITTED = ["i32 · u8 · f64", "string · boolean", "Cap<string, 16>", "objects · string unions", "T[] · tuples"]
REJECTED = ["any · unknown", "Map · Set · Record", "class", "functions as data"]


def scene_admission(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    door_x = 960
    k0 = pop(x.since(0), 0.5)
    if k0 > 0:
        h = 470 * k0
        c.rrect((door_x - 150, 560 - h, door_x + 150, 560), 26, fill=PANEL2, outline=INK, width=5)
        c.rrect((door_x - 120, 590 - h, door_x + 120, 560), 18, fill=PANEL, outline=INK, width=3)
        c.text((door_x, 618 - h), "AOT admission", 30, INK, anchor="mm")
        scan = 648 - h + ((x.t * 190) % max(1.0, h - 130))
        c.rrect((door_x - 104, scan - 5, door_x + 104, scan + 5), 5, fill=mix(BG, CYAN, 0.8))
        c.text((door_x, 330), "the compiler checks", 24, INK2, anchor="mm")
        cast.ferris(c, (door_x, 660), 0.82, x.t, claw=0.35, mood="work")

    for i, label in enumerate(ADMITTED):
        kk = pop(x.since(0) - 0.25 - i * 0.18, 0.45)
        if kk <= 0:
            continue
        y = 230 + i * 86
        half = (c.measure(label, 26, "mono") + 48) / 2
        bx = lerp(-400, 150 + half, kk)
        badge(c, (bx, y), label, 26, mix(BG, GREEN, 0.4), INK, 24, kind="mono")
        c.stroke([(560, y), (572, y + 12), (594, y - 14)], GREEN, 6, amp=1.0, passes=1)

    k1 = x.since(1)
    for i, label in enumerate(REJECTED):
        kk = pop(k1 - 0.1 - i * 0.22, 0.45)
        if kk <= 0:
            continue
        y = 250 + i * 96
        shake = math.sin((k1 - i * 0.22) * 26) * 9 * clamp(1.6 - (k1 - i * 0.22))
        half = (c.measure(label, 26, "mono") + 48) / 2
        bx = lerp(2320, 1790 - half, kk) + shake
        badge(c, (bx, y), label, 26, mix(BG, RED, 0.4), INK, 24, kind="mono")
        c.stroke([(1340, y - 14), (1368, y + 14)], RED, 6, amp=1.0, passes=1)
        c.stroke([(1368, y - 14), (1340, y + 14)], RED, 6, amp=1.0, passes=1)
        if 0.2 < (k1 - 0.1 - i * 0.22) < 1.2:
            burst(c, (1354, y), k1 - 0.5 - i * 0.22, 0.4, 5, RED, 70)

    k2 = x.since(2)
    if k2 > 0.1:
        kk = pop(k2 - 0.1, 0.5)
        box = (lerp(-900, 120, kk), 700, lerp(-40, 980, kk), 862)
        plate(c, box, 18, fill=PANEL, outline=RED, width=4, shadow=10)
        c.text((box[0] + 28, box[1] + 50), "Counter.ts:12:8", 30, RED, "mono", anchor="lm", jitter=0.3)
        c.text((box[0] + 28, box[1] + 108), "unsupported type: any", 28, INK2, "mono", anchor="lm", jitter=0.3)
    k3 = x.since(2) - 1.6
    if k3 > -0.3:
        fade = clamp(1.0 - (k3 - 0.9) / 0.7) if k3 > 0.9 else clamp(k3 + 0.3)
        gx = lerp(1620, 1330, clamp(k3 + 0.3))
        if fade > 0.05:
            ghost = mix(BG, MUTED, 0.5 * fade)
            c.ellipse((gx - 70, 640, gx + 70, 770), fill=ghost, outline=mix(BG, INK, 0.3 * fade), width=3)
            c.circle((gx - 26, 686), 9, fill=mix(BG, INK, 0.7 * fade))
            c.circle((gx + 26, 686), 9, fill=mix(BG, INK, 0.7 * fade))
            c.text((gx, 812), "interpreter", 26, mix(BG, INK, 0.6 * fade), anchor="mm")
        if k3 > 0.9:
            burst(c, (gx, 700), k3 - 0.9, 0.5, 8, MUTED, 120)
        stamp(c, (1340, 700), "no interpreter in the binary", k3 - 1.1, 36, PINK, PANEL, -6)


# --------------------------------------------------------------- 8. differential

def scene_differential(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = pop(x.since(0), 0.5)
    reel_x = 250
    if k0 > 0:
        spin = x.t * 2.2
        c.circle((reel_x, 470), 106 * k0, fill=PANEL, outline=INK, width=5)
        for i in range(6):
            a = spin + i * math.tau / 6
            c.line([(reel_x, 470), (reel_x + math.cos(a) * 86 * k0, 470 + math.sin(a) * 86 * k0)], mix(BG, AMBER, 0.75), 6)
        c.circle((reel_x, 470), 24 * k0, fill=YELLOW, outline=INK, width=3)
        badge(c, (reel_x, 650), "one recorded input tape", 26, PANEL, INK2, 22)

    k1 = x.since(1)
    lanes = [(300, TS_BLUE, "the JavaScript implementation", "framework/src/model-*.ts"),
             (640, RUST, "the generated Rust", "gen/app_model.rs")]
    for i, (y, color, title, note) in enumerate(lanes):
        kk = pop(k1 - i * 0.3, 0.5)
        if kk <= 0:
            continue
        c.rrect((470, y - 62, lerp(470, 1840, kk), y + 62), 26, fill=mix(BG, color, 0.16), outline=INK, width=3.4)
        c.text((510, y - 22), title, 28, INK, anchor="lm")
        c.text((510, y + 20), note, 23, MUTED, "mono", anchor="lm", jitter=0.3)
        if i == 0:
            cast.ts_buddy(c, (1035, y - 4), 0.48, x.t, arm=0.3)
        else:
            cast.ferris(c, (1035, y + 6), 0.48, x.t, claw=0.3)
        arrow(c, (reel_x + 104, 470 - 40 + i * 80), (462, y), mix(color, INK, 0.2), 6, 18, bend=26 if i else -26)

    k2 = x.since(2)
    if k2 > 0:
        for i in range(4):
            kk = pop(k2 - i * 0.28, 0.4)
            if kk <= 0:
                continue
            fx = 1180 + i * 172
            mismatch = i == 2 and 1.25 < k2 - i * 0.28 < 1.9
            for lane_index, (y, color, _, _) in enumerate(lanes):
                c.rrect((fx - 62, y - 38, fx + 62, y + 38), 12, fill=PANEL, outline=RED if mismatch and lane_index else mix(color, INK, 0.2), width=3)
                value = f"f{i}:{i * 2 + (1 if mismatch and lane_index else 0)}"
                c.text((fx, y + 1), value, 24, RED if mismatch and lane_index else INK2, "mono", anchor="mm", jitter=0.3)
            c.text((fx, 470), "≠" if mismatch else "=", 40, RED if mismatch else GREEN, "hand", anchor="mm")
            if mismatch:
                badge(c, (fx, 372), "a mismatch is a bug", 24, mix(BG, RED, 0.45), INK, 20)
    if k2 > 1.9:
        stamp(c, (1520, 830), "frame by frame", k2 - 1.9, 36, GREEN, PANEL, -5)
        c.text((470, 830), "tests/aot-differential.test.ts", 27, MUTED, "mono", anchor="lm", jitter=0.3)


# ---------------------------------------------------------------------- 9. GBA

def scene_gba(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = x.since(0)
    cart = clamp(1.0 - smoothstep(0.3, 1.1, k0))
    boot = clamp(smoothstep(0.1, 0.9, x.since(1)))
    press_clock = max(0.0, x.since(1) - 1.0)
    count = min(int(press_clock / 0.55) if press_clock > 0 else 0, 6)
    phase = int(x.t * 6) % 8
    cast.gba(
        c, (700, 450), 1.22, x.t, cart=cart, boot=boot,
        screen=lambda cv, b: cast.hero_screen(cv, b, count, phase, clamp(boot * 1.2)),
    )
    if 0.25 < k0 < 1.6:
        burst(c, (700, 250), k0 - 0.95, 0.5, 10, AMBER, 170)
    if x.since(0) > -0.2:
        c.text((700, 700), "apps/gba-hero → hosts/gba → gba-hero.gba", 26, MUTED, "mono", anchor="mm", jitter=0.3)

    k1 = pop(x.since(1) - 0.4, 0.55)
    if k1 > 0:
        fact_plate(
            c, (lerp(2100, 1240, k1), 200, lerp(2900, 1850, k1), 470), "in the cartridge",
            ["TSX view + TypeScript model", "compiled to Rust, then to a ROM", "no JS VM, no operating system"], YELLOW,
        )
    k2 = pop(x.since(2) - 0.2, 0.55)
    if k2 > 0:
        fact_plate(
            c, (lerp(2100, 1240, k2), 510, lerp(2900, 1850, k2), 780), "how a frame reaches the LCD",
            ["a Mode 0 background plus sprites", "DMA uploads what changed in VBlank", "no per-frame framebuffer"], PINK,
        )
    if x.since(1) > 1.6:
        cast.ts_buddy(c, (170, 560), 0.68, x.t, arm=0.9, mood="cheer")
        cast.ferris(c, (300, 790), 0.58, x.t, claw=0.8)


# ------------------------------------------------------------------- 10. ending

def scene_end(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = pop(x.since(0), 0.6)
    size = 112 * lerp(0.8, 1.0, k0)
    ty = lerp(130, 200, k0)
    c.text((MID + 6, ty + 7), "MicroTS", size, mix(BG, INK, 0.2), "hand", anchor="mm")
    c.text((MID, ty), "MicroTS", size, PINK, "hand", anchor="mm")
    if k0 > 0.4:
        c.stroke([(MID - 250, ty + 62), (MID + 250, ty + 62)], YELLOW, 8, amp=2.2, passes=1)
        badge(c, (MID, 302), "TypeScript stays in the source. The runtime is Rust.", 30, PANEL, INK, 28)
    cast.ts_buddy(c, (330, 540), 1.0, x.t, arm=0.8 + 0.2 * math.sin(x.t * 3), mood="cheer")
    cast.ferris(c, (1600, 560), 1.0, x.t, claw=0.6 + 0.3 * math.sin(x.t * 2.4))
    cast.handheld(c, (MID, 520), 0.72, x.t, face=True)

    rows = [
        ("run", "bun microts/compiler/cli.ts build <app> --strict", YELLOW),
        ("read", "site/content/docs/microts.md", CYAN),
        ("code", "microts/compiler/ · engine/crates/microts", PINK),
    ]
    for i, (tag, value, color) in enumerate(rows):
        kk = pop(x.since(1) - 0.1 - i * 0.35, 0.5)
        if kk <= 0:
            continue
        y = lerp(940, 700 + i * 76, kk)
        box = (520, y - 32, 1400, y + 32)
        c.rrect(box, 16, fill=PANEL, outline=INK, width=3.4)
        c.rrect((box[0] + 10, box[1] + 8, box[0] + 20, box[3] - 8), 5, fill=color)
        c.text((box[0] + 34, y), tag, 26, INK, anchor="lm")
        c.text((box[0] + 116, y + 1), value, 24, INK2, "mono", anchor="lm", jitter=0.3)
    if x.since(1) > 1.6:
        r = sg.random.Random(99)
        for i in range(22):
            a = r.uniform(0, math.tau)
            speed = r.uniform(90, 260)
            age = (x.since(1) - 1.6) + r.uniform(0, 1.2)
            px = MID + math.cos(a) * speed * age
            py = 420 + math.sin(a) * speed * age * 0.7 + 60 * age * age
            if -40 < px < 1960 and -40 < py < 1000:
                sparkle(c, (px, py), max(2.5, 14 - age * 4), r.choice([YELLOW, PINK, CYAN, PURPLE]), a + x.t * 3)


SCENES = [
    Scene(
        key="open",
        chapter="What MicroTS is",
        draw=scene_open,
        lines=[
            ("PocketJS ships a compiler called MicroTS.",
             "PocketJS ships a compiler called MicroTS."),
            ("It turns your TypeScript into native code that runs straight on a handheld.",
             "It turns your TypeScript into native code that runs straight on a handheld."),
            ("At runtime, there is no JavaScript engine.",
             "At runtime, there is no JavaScript engine."),
        ],
    ),
    Scene(
        key="why",
        chapter="Why no engine",
        draw=scene_why,
        lines=[
            ("Handhelds count memory in megabytes, and run at tens of megahertz.",
             "Handhelds count memory in megabytes, and run at tens of megahertz."),
            ("A script engine would parse, interpret, and collect garbage on the device.",
             "A script engine would parse, interpret, and collect garbage on the device."),
            ("MicroTS moves all of that to build time.",
             "MicroTS moves all of that to build time."),
        ],
    ),
    Scene(
        key="source",
        chapter="What you write",
        draw=scene_source,
        lines=[
            ("You write two files: a view, and a model.",
             "You write two files: a view, and a model."),
            ("TSX describes the screen. The model beside it holds signals and methods.",
             "TSX describes the screen; the model beside it holds signals and methods."),
            ("Types have to land in native storage, so the counter is an i32, not a number.",
             "Types have to land in native storage, so the counter is an i32, not a number."),
        ],
    ),
    Scene(
        key="pipeline",
        chapter="The compile pipeline",
        draw=scene_pipeline,
        lines=[
            ("The compiler borrows the TypeScript checker to learn every value's real type.",
             "The compiler borrows the TypeScript checker to learn every value's real type."),
            ("It emits two IRs: View IR for nodes, bindings and dispatch, Model IR for state and tasks.",
             "Two IRs: View IR for nodes, bindings and dispatch; Model IR for state and tasks."),
            ("Both get printed as Rust source, next to a compiled style table.",
             "Both are printed as Rust source, next to a compiled style table."),
            ("Cargo builds that with the microts runtime into one native program.",
             "Cargo builds that with the microts runtime into one native program."),
        ],
    ),
    Scene(
        key="trait",
        chapter="The trait in between",
        draw=scene_trait,
        lines=[
            ("View and model meet at a Rust trait.",
             "View and model meet at a Rust trait."),
            ("Read count, and the view calls vm dot count. Write to it, and the trait grows set underscore count.",
             "Read count and the view calls vm.count(); write to it and the trait grows set_count."),
            ("Compiled mode writes those methods from your TypeScript. Rust mode leaves them to you.",
             "Compiled mode writes those methods from your .ts; rust mode leaves them to you."),
        ],
    ),
    Scene(
        key="frame",
        chapter="Inside one frame",
        draw=scene_frame,
        lines=[
            ("At runtime there are no refs, no effects, no render function.",
             "At runtime there are no refs, no effects, no render function."),
            ("The host calls frame once per tick, and input goes to the model first.",
             "The host calls frame(input) once per tick, and input goes to the model first."),
            ("The view updates only the bindings that changed: one text node, the button stays put.",
             "The view updates only the bindings that changed: one text node, the button stays put."),
            ("The Rust core lays out the tree and hands back a draw list.",
             "The Rust core lays out the tree and hands back a draw list."),
        ],
    ),
    Scene(
        key="admission",
        chapter="Admission",
        draw=scene_admission,
        lines=[
            ("The price: your source stays inside a subset.",
             "The price: your source stays inside a subset."),
            ("Any, Map, classes, functions used as data: none of those get in.",
             "any, Map, classes, functions used as data: none of those get in."),
            ("It fails at a file, line and column, and never falls back to interpreting: there is no interpreter in the binary.",
             "It fails at file:line:column, and never falls back to interpreting: there is no interpreter."),
        ],
    ),
    Scene(
        key="differential",
        chapter="Keeping both paths honest",
        draw=scene_differential,
        lines=[
            ("So how do we know both paths agree?",
             "So how do we know both paths agree?"),
            ("A differential test runs the same TypeScript twice: as JavaScript, and as the generated Rust.",
             "A differential test runs the same TypeScript twice: as JavaScript, and as the generated Rust."),
            ("Same recorded input, compared frame by frame. A mismatch is a bug.",
             "Same recorded input, compared frame by frame. A mismatch is a bug."),
        ],
    ),
    Scene(
        key="gba",
        chapter="Onto a Game Boy Advance",
        draw=scene_gba,
        lines=[
            ("The clearest example is apps slash gba hero.",
             "The clearest example is apps/gba-hero."),
            ("Its TSX view and TypeScript model compile into a Game Boy Advance cartridge: no JavaScript VM, no operating system.",
             "Its TSX view and TypeScript model compile into a GBA cartridge ROM: no JS VM, no operating system."),
            ("The LCD composes a background and sprites, and DMA uploads only what changed during the vertical blank.",
             "The LCD composes a background and sprites; DMA uploads only what changed during VBlank."),
        ],
    ),
    Scene(
        key="end",
        chapter="Start here",
        draw=scene_end,
        tail=1.2,
        lines=[
            ("MicroTS keeps the expressiveness in your TypeScript, and hands the runtime to Rust.",
             "MicroTS keeps the expressiveness in your TypeScript, and hands the runtime to Rust."),
            ("Start with one build command, with strict turned on.",
             "Start with one build command, with --strict turned on."),
        ],
    ),
]
