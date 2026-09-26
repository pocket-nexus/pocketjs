"""Storyboard for the MicroTS explainer video.

Each scene carries its narration lines and a draw function. The renderer times
every scene from the spoken audio, so `ctx.since(i)` is the time since line i
started speaking: visual beats land on the sentence that describes them.

Facts on screen come from site/content/docs/microts*.md, docs/STRUCTURE.md,
tests/aot-differential.test.ts and hosts/gba/README.md.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import cast
import stagecraft as sg
from stagecraft import (
    BG, CYAN, GREEN, INK, INK2, MUTED, ORANGE, OUTLINE, PANEL, PANEL2, PINK,
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
    tail: float = 0.75
    lead: float = 0.18


def pop(t: float, dur: float = 0.42, overshoot: float = 2.0) -> float:
    """0 before the beat, 1 after the entrance settles."""
    if t < 0:
        return 0.0
    return ease_out_back(clamp(t / dur), overshoot)


def slide_in(t: float, start: float, end: float, dur: float = 0.55) -> float:
    return lerp(start, end, pop(t, dur, 1.6))


def no_entry(c, xy, r: float, t: float, width: float = 14) -> None:
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
    plate(c, box, 20, fill=mix(BG, PANEL, 0.9), outline=mix(BG, accent, 0.35), width=3, shadow=9)
    c.text((x0 + 26, y0 + 34), title, 28, accent, anchor="lm")
    for i, row in enumerate(rows):
        if reveal < (i + 1) / max(1, len(rows)) - 0.999:
            break
        c.circle((x0 + 36, y0 + 82 + i * 44), 6, fill=accent)
        c.text((x0 + 56, y0 + 82 + i * 44), row, 27, INK2, anchor="lm")


# ------------------------------------------------------------------ 1. opening

def scene_open(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    t0 = x.since(0)
    # cast entrance
    ts_x = slide_in(t0 - 0.05, -260, 330)
    fe_x = slide_in(t0 - 0.15, 2200, 1590)
    dev_y = lerp(-380, 640, pop(t0 - 0.3, 0.7, 1.9))
    cast.ts_buddy(c, (ts_x, 660), 1.35, x.t, arm=0.35 + 0.2 * math.sin(x.t * 2))
    cast.ferris(c, (fe_x, 690), 1.35, x.t, claw=0.25 + 0.25 * math.sin(x.t * 1.7))
    cast.handheld(c, (MID, dev_y), 0.95, x.t, face=x.since(1) < 0.2,
                  screen=None if x.since(1) < 0.2 else (lambda cv, b: cast.counter_screen(cv, b, 1, True, 0.5 * (0.5 + 0.5 * math.sin(x.t * 4)))))
    if 0 < t0 < 1.2:
        burst(c, (MID, 640), t0 - 0.55, 0.5, 14, YELLOW, 190)

    # title lockup
    k = pop(t0 - 0.35, 0.6, 1.8)
    if k > 0:
        ty = lerp(140, 262, k)
        size = 150 * lerp(0.7, 1.0, k)
        c.text((MID, ty + 8), "MicroTS", size, PINK, "latin", anchor="mm", stroke=9, stroke_fill=OUTLINE)
        c.text((MID, ty), "MicroTS", size, YELLOW, "latin", anchor="mm", stroke=9, stroke_fill=OUTLINE)
        for i in range(3):
            a = x.t * 1.6 + i * 2.1
            sparkle(c, (MID + math.cos(a) * 420, ty + math.sin(a * 1.3) * 60), 13 + 5 * math.sin(x.t * 6 + i), CYAN if i % 2 else YELLOW, a)
    k1 = pop(x.since(1), 0.5)
    if k1 > 0:
        badge(c, (MID, lerp(400, 372, k1)), "把 TypeScript 编译成掌机上的原生代码", 34, mix(BG, PANEL2, 0.95), INK, 30)
        arrow(c, (470, 660), (760, 660), YELLOW, 9, 24, bend=-34)
        c.text((615, 596), "编译", 28, YELLOW, anchor="mm")
        arrow(c, (1160, 660), (1410, 660), CYAN, 9, 24, bend=-34)
        c.text((1285, 592), "运行", 28, CYAN, anchor="mm")

    # no engine
    k2 = x.since(2)
    if k2 > -0.2:
        ex = lerp(2400, 1560, pop(k2, 0.5))
        fade = clamp(1 - (k2 - 2.6) / 0.6) if k2 > 2.6 else 1.0
        if fade > 0.05:
            c.shift(0, 0)
            cast.js_engine(c, (ex, 290 + 26 * math.sin(x.t * 2)), 0.6 * fade, x.t, strain=0.2, smoke=fade > 0.5)
            no_entry(c, (ex, 290), 100 * fade, k2 - 0.45)
        stamp(c, (520, 300), "运行时没有 JS 引擎", k2 - 0.9, 46, PINK, INK, -7)
        if k2 > 0.9:
            burst(c, (520, 300), k2 - 0.9, 0.6, 16, YELLOW, 240)


# --------------------------------------------------------------- 2. motivation

def scene_why(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    strain = clamp(smoothstep(0.2, 1.4, x.since(1)) - smoothstep(0.1, 0.9, x.since(2)))
    dev_x = 360
    cast.handheld(c, (dev_x, 400), 0.78, x.t, face=True, mood="strain" if strain > 0.4 else "happy")
    k0 = pop(x.since(0) - 0.7, 0.5)
    if k0 > 0:
        fact_plate(c, (dev_x - 290 * k0, 610, dev_x + 290 * k0, 790), "掌机 / 单片机", ["内存以 MB 计", "CPU 只有几十 MHz"], CYAN)

    k1 = x.since(1)
    k2 = x.since(2)
    moved = clamp(smoothstep(0.1, 1.0, k2))
    if k1 > -0.2:
        ex = lerp(2400, 1120, pop(k1, 0.8, 1.2)) + moved * 1500
        cast.js_engine(c, (ex, 420), 1.55, x.t, strain=strain, smoke=True)
        if moved < 0.3:
            c.text((ex, 660), "脚本引擎", 30, INK2, anchor="mm")
            c.text((ex, 700), "解析器 + 解释器 + GC", 25, MUTED, anchor="mm")

    # build-time box the costs move into
    if k2 > 0:
        kk = pop(k2 - 0.1, 0.55)
        box = (lerp(2200, 980, kk), 250, lerp(2900, 1740, kk), 700)
        plate(c, box, 22, fill=mix(BG, PANEL2, 0.95), outline=YELLOW, width=4, shadow=10)
        c.text(((box[0] + box[2]) / 2, box[1] + 50), "编译期做完", 34, YELLOW, anchor="mm")
    costs = ["解析源码", "解释执行", "垃圾回收"]
    for i, label in enumerate(costs):
        kc = pop(k1 - 0.75 - i * 0.45, 0.4)
        if kc <= 0:
            continue
        home = (1700, 250 + i * 150)
        landed = (1360, 400 + i * 110)
        move = pop(k2 - 0.35 - i * 0.18, 0.6)
        bx = lerp(home[0], landed[0], move)
        by = lerp(home[1], landed[1], move)
        fill = mix(mix(BG, RED, 0.36), mix(BG, YELLOW, 0.8), move)
        badge(c, (bx, by), label, 32, fill, INK if move < 0.5 else OUTLINE, 26)
        if 0.2 < move < 0.9:
            burst(c, (bx, by), move - 0.2, 0.5, 6, YELLOW, 70)
    if k2 > 1.5:
        badge(c, (dev_x, 900), "设备只跑编译好的机器码", 30, mix(BG, CYAN, 0.7), OUTLINE, 24)


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
    r0 = clamp(x.since(0) / 1.6)
    r1 = clamp(x.since(1) / 1.9)
    code_card(c, left, "Counter.tsx", VIEW_CODE, 23, reveal=r0, accent=CYAN,
              highlight=(6,) if x.since(1) > 1.2 else ())
    if x.since(0) > 0.1:
        c.text((left[0] + 8, 206), "视图：界面长什么样", 30, CYAN, anchor="lm")
    if x.since(1) > -0.2:
        code_card(c, right, "Counter.ts", MODEL_CODE, 23, reveal=r1, accent=YELLOW,
                  highlight=(3,) if x.since(2) > 0.3 else ())
        c.text((right[0] + 8, 206), "模型：状态和方法", 30, YELLOW, anchor="lm")
    k0 = pop(x.since(0) - 0.2, 0.5)
    cast.ts_buddy(c, (lerp(-200, 150, k0), 830), 0.8, x.t, arm=0.7, look=(0.4, -0.3))
    if x.since(1) > 0.4:
        arrow(c, (700, 760), (1120, 760), PINK, 8, 22, bend=26)
        c.text((910, 812), "同名的两个文件", 28, PINK, anchor="mm")

    k2 = x.since(2)
    if k2 > 0:
        kk = pop(k2, 0.45)
        badge(c, (1470, lerp(860, 800, kk)), "i32 → Rust 里就是 i32 整数", 29, mix(BG, CYAN, 0.8), OUTLINE, 26)
        arrow(c, (1470, 762), (1440, 706), CYAN, 7, 18)
    if k2 > 1.3:
        kk = pop(k2 - 1.3, 0.45)
        cx, cy = 560, 800
        badge(c, (cx, cy), "number → f64，--strict 下拒绝", 28, mix(BG, RED, 0.42), INK, 24)
        half = c.measure("number → f64，--strict 下拒绝", 28) / 2 + 20
        c.line([(cx - half * kk, cy + 22), (cx + half * kk, cy - 22)], RED, 5)


# ----------------------------------------------------------------- 4. pipeline

STATIONS = [
    ("TypeScript 类型检查器", CYAN, "问清每个值的真实类型"),
    ("View IR + Model IR", PURPLE, "节点与绑定 · 状态与任务"),
    ("Rust 代码生成", ORANGE, "gen/*.rs + styles.bin"),
    ("Cargo + microts", YELLOW, "一个原生可执行程序"),
]
STATION_X = [420, 830, 1240, 1650]


def _station(c, x_pos: float, y: float, index: int, appear: float, active: float) -> None:
    label, color, note = STATIONS[index]
    k = pop(appear, 0.45)
    if k <= 0:
        return
    w = 330 * k
    h = 210 * k
    top = y - h
    glow = mix(BG, color, 0.18 + 0.22 * active)
    c.rrect((x_pos - w / 2, top, x_pos + w / 2, y), 22, fill=glow, outline=color, width=4)
    c.rrect((x_pos - w / 2 + 16, top + 16, x_pos + w / 2 - 16, top + h * 0.46), 12, fill=TERM)
    if k > 0.9:
        c.text((x_pos, top + h * 0.31), label, 25, color, anchor="mm")
        lines = c.wrap(note, 22, w - 44)
        for i, line in enumerate(lines[:2]):
            c.text((x_pos, top + h * 0.64 + i * 32), line, 22, INK2, anchor="mm")
        for i in range(3):
            lit = (c.frame // 6 + i) % 3 == 0 and active > 0.2
            c.circle((x_pos - 40 + i * 40, y - 24, ), 8, fill=color if lit else mix(BG, color, 0.3))


def scene_pipeline(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    belt_y = 686
    conveyor(c, (110, belt_y, 1810, belt_y + 54), x.t, 150)
    beats = [x.since(i) for i in range(4)]
    for i in range(4):
        active = clamp(smoothstep(-0.1, 0.5, beats[i]) - (smoothstep(0.1, 0.7, beats[i + 1]) if i + 1 < 4 else 0))
        _station(c, STATION_X[i], belt_y - 104, i, beats[i] - 0.05, active)

    # the work item rides the belt and changes shape at each station
    stage = -1
    for i in range(4):
        if beats[i] > 0.15:
            stage = i
    progress = 0.0
    if stage >= 0:
        progress = clamp((beats[stage] - 0.15) / 0.9)
    start_x = 150 if stage < 0 else (150 if stage == 0 else STATION_X[stage - 1])
    end_x = STATION_X[0] if stage < 0 else STATION_X[stage]
    item_x = lerp(start_x, end_x, ease_out_cubic(progress))
    item_y = belt_y - 46 + math.sin(x.t * 4) * 4

    labels = [
        ("Counter.tsx + Counter.ts", CYAN),
        ("类型已定：i32 / str / bool", CYAN),
        ("View IR · Model IR", PURPLE),
        ("gen/counter.rs · styles.bin", ORANGE),
    ]
    if stage < 3 or progress < 0.9:
        idx = max(0, stage)
        label, color = labels[idx]
        w = c.measure(label, 25, "mono") + 54
        c.rrect((item_x - w / 2, item_y - 32, item_x + w / 2, item_y + 32), 14, fill=mix(BG, PANEL2, 0.98), outline=color, width=4)
        c.text((item_x, item_y + 1), label, 25, color, "mono", anchor="mm")
    for i in range(4):
        if 0.1 < beats[i] < 1.4:
            burst(c, (STATION_X[i], belt_y - 46), beats[i] - 0.65, 0.5, 10, STATIONS[i][1], 130)

    # IR detail cards while beat 2 speaks
    k1 = x.since(1)
    if 0.4 < k1 and x.since(3) < 0.2:
        for i, (title, rows, color) in enumerate(
            [
                ("View IR format 1", ["节点与结构", "绑定表达式", "输入分发"], PURPLE),
                ("Model IR format 1", ["状态与派生值", "依赖与反应调度", "任务状态机"], PINK),
            ]
        ):
            kk = pop(k1 - 0.4 - i * 0.25, 0.5)
            if kk <= 0:
                continue
            bx = 620 + i * 620
            leave = clamp(smoothstep(-0.2, 0.2, x.since(3)))
            fact_plate(c, (bx - 270, lerp(400, 150, kk) - leave * 300, bx + 270, lerp(400, 360, kk) - leave * 300), title, rows, color)
    # the finished cartridge
    k3 = x.since(3)
    if k3 > 0.5:
        kk = pop(k3 - 0.5, 0.6, 2.2)
        cast.cartridge(c, (1640, lerp(660, 212, kk)), 0.88 * kk, "原生程序", glow=kk, t=x.t)
        cast.ferris(c, (1170, 268), 0.72, x.t, claw=0.7, mood="work")
        if k3 > 1.2:
            badge(c, (1640, 342), "no_std Rust · 无引擎", 26, mix(BG, YELLOW, 0.8), OUTLINE, 22)


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
    c.text((960, 252), "视图和模型之间的 Rust trait", 30, YELLOW, anchor="mm")

    # view side
    kv = pop(x.since(0), 0.5)
    vx = lerp(-200, 300, kv)
    plate(c, (vx - 190, 380, vx + 190, 700), 22, fill=mix(BG, PANEL, 0.92), outline=CYAN, width=4)
    c.text((vx, 424), "生成的视图", 30, CYAN, anchor="mm")
    cast.counter_screen(c, (vx - 150, 460, vx + 150, 590), 1, True, 0.0)
    c.text((vx, 634), "调用 vm.count()", 25, INK2, anchor="mm")
    c.text((vx, 668), "不反射、不桥接", 24, MUTED, anchor="mm")

    # model side
    km = pop(x.since(0) - 0.2, 0.5)
    mx = lerp(2120, 1620, km)
    plate(c, (mx - 200, 380, mx + 200, 700), 22, fill=mix(BG, PANEL, 0.92), outline=PINK, width=4)
    c.text((mx, 424), "模型实现", 30, PINK, anchor="mm")
    pick = clamp(smoothstep(0.2, 0.8, x.since(2)))
    for i, (title, note, who) in enumerate(
        [("compiled", "编译器从 .ts 生成", TS_BLUE), ("rust", "你在 Rust 里实现", RUST)]
    ):
        on = (1 - pick) if i == 0 else pick
        if x.since(2) < 0:
            on = 1.0 if i == 0 else 0.35
        y0 = 470 + i * 105
        c.rrect((mx - 170, y0, mx + 170, y0 + 86), 16, fill=mix(BG, who, 0.25 + 0.55 * on), outline=mix(BG, INK, 0.2 + 0.6 * on), width=3)
        c.text((mx, y0 + 30), title, 28, INK if on > 0.5 else MUTED, "mono", anchor="mm")
        c.text((mx, y0 + 62), note, 24, INK2 if on > 0.5 else MUTED, anchor="mm")
    if x.since(2) > 0.3:
        who = cast.ferris if pick > 0.5 else cast.ts_buddy
        if pick > 0.5:
            cast.ferris(c, (mx, 810), 0.8, x.t, claw=0.5, mood="work")
        else:
            cast.ts_buddy(c, (mx, 800), 0.8, x.t, arm=0.6)

    # signal slips flying into the trait
    k1 = x.since(1)
    for start, label, color, target_y in ((0.2, "{count()}", CYAN, 388), (1.3, "setCount(...)", PINK, 468)):
        age = k1 - start
        if age < 0 or age > 1.5:
            continue
        kk = clamp(age / 0.7)
        px = lerp(vx + 190, card[0] - 96, ease_out_cubic(kk))
        py = lerp(560, target_y, ease_out_cubic(kk))
        badge(c, (px, py), label, 26, color, OUTLINE, 20, kind="mono")
        if age > 1.0:
            burst(c, (card[0] - 96, target_y), age - 1.0, 0.45, 8, color, 90)
    if x.since(2) > 1.2:
        badge(c, (960, 800), "admission 失败不会退回：编译期报错", 28, mix(BG, PANEL2, 0.95), INK2, 26)


# ---------------------------------------------------------------- 6. one frame

LOOP_NODES = [
    ("frame(input)", YELLOW),
    ("输入 → 模型", PINK),
    ("更新受影响的绑定", CYAN),
    ("布局 · 文本 · 动画", PURPLE),
    ("DrawList → 宿主", GREEN),
]


def scene_frame(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    # what the runtime does not carry
    k0 = pop(x.since(0), 0.5)
    if k0 > 0:
        c.text((300, 250), "运行时没有：", 30, MUTED, anchor="mm")
        for i, label in enumerate(("ref", "effect", "render()")):
            kk = pop(x.since(0) - 0.15 - i * 0.22, 0.4)
            if kk <= 0:
                continue
            y = 330 + i * 92
            badge(c, (300, y), label, 30, mix(BG, PANEL2, 1.0), INK2, 28, kind="mono")
            w = c.measure(label, 30, "mono") / 2 + 26
            c.line([(300 - w * kk, y + 18), (300 + w * kk, y - 18)], RED, 6)
        if x.since(1) > 0.2:
            badge(c, (300, 640), "只有编译好的更新代码", 26, mix(BG, CYAN, 0.7), OUTLINE, 22)

    # the frame loop
    k1 = pop(x.since(1), 0.6)
    if k1 > 0:
        cx, cy, r = 940, 470, 200 * k1
        c.circle((cx, cy), r, outline=mix(BG, PURPLE, 0.55), width=10)
        lap = (x.t * 0.42) % 1.0
        for i, (label, color) in enumerate(LOOP_NODES):
            a = -math.pi / 2 + i * math.tau / 5
            nx, ny = cx + math.cos(a) * r, cy + math.sin(a) * r
            live = abs(((lap - i / 5) + 0.5) % 1.0 - 0.5) < 0.1
            c.circle((nx, ny), 19, fill=color if live else mix(BG, color, 0.45), outline=OUTLINE, width=4)
            lx = cx + math.cos(a) * (r + 96)
            ly = cy + math.sin(a) * (r + 66)
            badge(c, (lx, ly), label, 25, mix(BG, color, 0.22 + 0.5 * live), INK, 20, kind="mono" if i == 0 else "cjk")
        angle = -math.pi / 2 + lap * math.tau
        c.circle((cx + math.cos(angle) * r, cy + math.sin(angle) * r), 15, fill=INK)
        c.text((cx, cy - 20), "每帧一次", 34, INK, anchor="mm")
        c.text((cx, cy + 24), "宿主驱动", 28, YELLOW, anchor="mm")

    # the counter reacting to one press
    k2 = x.since(2)
    count = 1 if k2 > 0.9 else 0
    flash = clamp(1.0 - (k2 - 0.9) / 0.9) if k2 > 0.9 else 0.0
    pressed = 0.55 < k2 < 0.95
    if x.since(0) > -0.2:
        cast.handheld(
            c, (1620, 420), 0.86, x.t,
            screen=lambda cv, b: cast.counter_screen(cv, b, count, True, flash, pressed),
        )
    if pressed:
        burst(c, (1620, 500), k2 - 0.55, 0.4, 8, PINK, 120)
    if k2 > 1.0:
        kk = pop(k2 - 1.0, 0.45)
        badge(c, (1620, lerp(650, 620, kk)), "只改写了这个文本节点", 27, mix(BG, CYAN, 0.75), OUTLINE, 22)
        badge(c, (1620, lerp(730, 696, kk)), "按钮原地不动", 27, mix(BG, PANEL2, 1.0), INK2, 22)
    k3 = x.since(3)
    if k3 > 0.2:
        kk = pop(k3 - 0.2, 0.5)
        box = (lerp(2100, 1240, kk), 790, lerp(2700, 1880, kk), 872)
        c.rrect(box, 18, fill=mix(BG, GREEN, 0.25), outline=GREEN, width=3)
        c.text((box[0] + 24, (box[1] + box[3]) / 2), "DrawList：一帧的绘制指令", 28, INK, anchor="lm")


# ----------------------------------------------------------------- 7. admission

ADMITTED = ["i32 · u8 · f64", "string · boolean", "Cap<string, 16>", "对象 · 字符串联合", "T[] · 元组"]
REJECTED = ["any · unknown", "Map · Set · Record", "class", "当数据用的函数"]


def scene_admission(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    door_x = 960
    # the doorway
    k0 = pop(x.since(0), 0.5)
    if k0 > 0:
        h = 470 * k0
        c.rrect((door_x - 150, 560 - h, door_x + 150, 560), 26, fill=mix(BG, PANEL2, 0.95), outline=YELLOW, width=6)
        c.rrect((door_x - 120, 590 - h, door_x + 120, 560), 18, fill=TERM)
        c.text((door_x, 620 - h), "AOT 准入", 32, YELLOW, anchor="mm")
        scan = 640 - h + ((x.t * 190) % max(1.0, h - 120))
        c.rrect((door_x - 108, scan - 5, door_x + 108, scan + 5), 5, fill=mix(BG, CYAN, 0.75))
        c.text((door_x, 330), "编译器检查", 27, INK2, anchor="mm")
        cast.ferris(c, (door_x, 660), 0.85, x.t, claw=0.35, mood="work")

    for i, label in enumerate(ADMITTED):
        kk = pop(x.since(0) - 0.25 - i * 0.18, 0.45)
        if kk <= 0:
            continue
        y = 230 + i * 86
        bx = lerp(-200, 380, kk)
        badge(c, (bx, y), label, 27, mix(BG, GREEN, 0.30), INK, 24, kind="mono")
        c.text((bx + 200, y), "✓", 34, GREEN, "latin", anchor="mm")

    k1 = x.since(1)
    for i, label in enumerate(REJECTED):
        kk = pop(k1 - 0.1 - i * 0.22, 0.45)
        if kk <= 0:
            continue
        y = 250 + i * 96
        shake = math.sin((k1 - i * 0.22) * 26) * 9 * clamp(1.6 - (k1 - i * 0.22))
        bx = lerp(2120, 1520, kk) + shake
        badge(c, (bx, y), label, 27, mix(BG, RED, 0.38), INK, 24, kind="mono")
        c.text((bx - 210, y), "✗", 34, RED, "latin", anchor="mm")
        if 0.2 < (k1 - 0.1 - i * 0.22) < 1.2:
            burst(c, (bx - 210, y), k1 - 0.5 - i * 0.22, 0.4, 6, RED, 70)

    k2 = x.since(2)
    if k2 > 0.1:
        kk = pop(k2 - 0.1, 0.5)
        box = (lerp(-900, 120, kk), 700, lerp(-40, 980, kk), 860)
        plate(c, box, 18, fill=TERM, outline=RED, width=4, shadow=10)
        c.text((box[0] + 28, box[1] + 50), "Counter.ts:12:8", 30, RED, "mono", anchor="lm")
        c.text((box[0] + 28, box[1] + 106), "unsupported type: any", 28, INK2, "mono", anchor="lm")
    k3 = x.since(3)
    if k3 > -0.3:
        fade = clamp(1.0 - (k3 - 0.9) / 0.7) if k3 > 0.9 else clamp(k3 + 0.3)
        gx = lerp(1620, 1330, clamp(k3 + 0.3))
        if fade > 0.05:
            ghost = mix(BG, MUTED, 0.55 * fade)
            c.ellipse((gx - 70, 640, gx + 70, 770), fill=ghost)
            c.circle((gx - 26, 680), 10, fill=BG)
            c.circle((gx + 26, 680), 10, fill=BG)
            c.text((gx, 810), "解释器", 26, mix(BG, MUTED, fade), anchor="mm")
        if k3 > 0.9:
            burst(c, (gx, 700), k3 - 0.9, 0.5, 10, MUTED, 120)
        stamp(c, (1340, 700), "原生程序里没有解释器", k3 - 1.1, 42, PINK, INK, -6)


# --------------------------------------------------------------- 8. differential

def scene_differential(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = pop(x.since(0), 0.5)
    reel_x = 250
    if k0 > 0:
        spin = x.t * 2.2
        c.circle((reel_x, 470), 108 * k0, fill=mix(BG, PANEL2, 0.95), outline=YELLOW, width=6)
        for i in range(6):
            a = spin + i * math.tau / 6
            c.line([(reel_x, 470), (reel_x + math.cos(a) * 88 * k0, 470 + math.sin(a) * 88 * k0)], mix(BG, YELLOW, 0.5), 7)
        c.circle((reel_x, 470), 26 * k0, fill=YELLOW)
        badge(c, (reel_x, 650), "同一条输入录像 tape", 27, mix(BG, PANEL2, 1.0), INK2, 22)

    k1 = x.since(1)
    lanes = [(300, TS_BLUE, "浏览器上的 JS 实现", "framework/src/model-*.ts"), (640, RUST, "生成的 Rust", "gen/app_model.rs")]
    for i, (y, color, title, note) in enumerate(lanes):
        kk = pop(k1 - i * 0.3, 0.5)
        if kk <= 0:
            continue
        c.rrect((470, y - 62, lerp(470, 1840, kk), y + 62), 26, fill=mix(BG, color, 0.16), outline=mix(BG, color, 0.5), width=3)
        c.text((510, y - 22), title, 28, INK, anchor="lm")
        c.text((510, y + 20), note, 24, MUTED, "mono", anchor="lm")
        if i == 0:
            cast.ts_buddy(c, (930, y - 4), 0.52, x.t, arm=0.3)
        else:
            cast.ferris(c, (930, y + 6), 0.52, x.t, claw=0.3)
        arrow(c, (reel_x + 106, 470 - 40 + i * 80), (462, y), color, 7, 20, bend=26 if i else -26)

    k2 = x.since(2)
    if k2 > 0:
        for i in range(4):
            kk = pop(k2 - i * 0.28, 0.4)
            if kk <= 0:
                continue
            fx = 1080 + i * 190
            mismatch = i == 2 and 1.25 < k2 - i * 0.28 < 1.9
            for lane_index, (y, color, _, _) in enumerate(lanes):
                c.rrect((fx - 66, y - 40, fx + 66, y + 40), 12, fill=TERM, outline=RED if mismatch and lane_index else color, width=3)
                value = f"f{i}:{i * 2 + (1 if mismatch and lane_index else 0)}"
                c.text((fx, y + 1), value, 24, RED if mismatch and lane_index else INK2, "mono", anchor="mm")
            c.text((fx, 470), "≠" if mismatch else "=", 40, RED if mismatch else GREEN, "latin", anchor="mm")
            if mismatch:
                badge(c, (fx, 380), "对不上就是 bug", 24, mix(BG, RED, 0.5), INK, 20)
    if k2 > 1.9:
        stamp(c, (1460, 840), "逐帧比对", k2 - 1.9, 40, GREEN, OUTLINE, -5)
        c.text((470, 840), "tests/aot-differential.test.ts", 28, MUTED, "mono", anchor="lm")


# ---------------------------------------------------------------------- 9. GBA

def scene_gba(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = x.since(0)
    cart = clamp(1.0 - smoothstep(0.3, 1.1, k0))
    boot = clamp(smoothstep(0.1, 0.9, x.since(1)))
    press_clock = max(0.0, x.since(1) - 1.0)
    count = int(press_clock / 0.55) if press_clock > 0 else 0
    count = min(count, 6)
    phase = int(x.t * 6) % 8
    cast.gba(
        c, (740, 430), 1.12, x.t, cart=cart, boot=boot,
        screen=lambda cv, b: cast.hero_screen(cv, b, count, phase, clamp(boot * 1.2)),
    )
    if 0.25 < k0 < 1.6:
        burst(c, (740, 250), k0 - 0.95, 0.5, 12, YELLOW, 170)
    if x.since(0) > -0.2:
        c.text((860, 710), "apps/gba-hero → hosts/gba → gba-hero.gba", 27, MUTED, "mono", anchor="mm")

    k1 = pop(x.since(1) - 0.4, 0.55)
    if k1 > 0:
        fact_plate(
            c,
            (lerp(2100, 1320, k1), 210, lerp(2900, 1860, k1), 470),
            "卡带里有什么",
            ["TSX 视图 + TypeScript 模型", "编译成 Rust，再编译成 ROM", "没有 JS 虚拟机，没有操作系统"],
            YELLOW,
        )
    k2 = pop(x.since(2) - 0.2, 0.55)
    if k2 > 0:
        fact_plate(
            c,
            (lerp(2100, 1320, k2), 510, lerp(2900, 1860, k2), 780),
            "仓库记下的数字",
            ["mGBA 实测 ≈ 11 FPS", "30 FPS 是目标，不是结论", "物理主机尚未验证"],
            PINK,
        )
    if x.since(1) > 1.6:
        cast.ts_buddy(c, (170, 560), 0.7, x.t, arm=0.9, mood="cheer")
        cast.ferris(c, (300, 790), 0.6, x.t, claw=0.8)


# ------------------------------------------------------------------- 10. ending

def scene_end(c, x: Ctx) -> None:
    sg.backdrop(c, x.t)
    k0 = pop(x.since(0), 0.6)
    c.text((MID, lerp(120, 210, k0)), "MicroTS", 118 * lerp(0.8, 1.0, k0), PINK, "latin", anchor="mm", stroke=8, stroke_fill=OUTLINE)
    c.text((MID, lerp(112, 202, k0)), "MicroTS", 118 * lerp(0.8, 1.0, k0), YELLOW, "latin", anchor="mm", stroke=8, stroke_fill=OUTLINE)
    if k0 > 0.4:
        badge(c, (MID, 300), "TypeScript 留在源码里，运行时交给 Rust", 32, mix(BG, PANEL2, 0.95), INK, 28)
    cast.ts_buddy(c, (330, 540), 1.05, x.t, arm=0.8 + 0.2 * math.sin(x.t * 3), mood="cheer")
    cast.ferris(c, (1600, 560), 1.05, x.t, claw=0.6 + 0.3 * math.sin(x.t * 2.4))
    cast.handheld(c, (MID, 520), 0.74, x.t, face=True)

    rows = [
        ("命令", "bun microts/compiler/cli.ts build <app> --strict", YELLOW),
        ("文档", "site/content/docs/microts.md", CYAN),
        ("代码", "microts/compiler/ · engine/crates/microts", PINK),
    ]
    for i, (tag, value, color) in enumerate(rows):
        kk = pop(x.since(1) - 0.1 - i * 0.35, 0.5)
        if kk <= 0:
            continue
        y = lerp(940, 700 + i * 76, kk)
        box = (520, y - 32, 1400, y + 32)
        c.rrect(box, 16, fill=mix(BG, PANEL, 0.92), outline=mix(BG, color, 0.45), width=3)
        c.text((box[0] + 24, y), tag, 26, color, anchor="lm")
        c.text((box[0] + 100, y + 1), value, 25, INK2, "mono", anchor="lm")
    if x.since(2) > 0.2:
        r = sg.random.Random(99)
        for i in range(26):
            a = r.uniform(0, math.tau)
            speed = r.uniform(90, 260)
            age = (x.since(2) - 0.2) + r.uniform(0, 1.2)
            px = MID + math.cos(a) * speed * age
            py = 420 + math.sin(a) * speed * age * 0.7 + 60 * age * age
            if -40 < px < 1960 and -40 < py < 1000:
                sparkle(c, (px, py), max(2.0, 13 - age * 4), r.choice([YELLOW, PINK, CYAN, PURPLE]), a + x.t * 3)


SCENES = [
    Scene(
        key="open",
        chapter="MicroTS 是什么",
        draw=scene_open,
        lines=[
            ("PocketJS 仓库里有一个编译器，叫 MicroTS。", "PocketJS 仓库里有一个编译器，叫 MicroTS。"),
            ("它把你写的 TypeScript，编译成掌机上直接运行的原生代码。", "它把你写的 TypeScript，编译成掌机上直接运行的原生代码。"),
            ("整个运行过程里，没有 JavaScript 引擎。", "整个运行过程里，没有 JavaScript 引擎。"),
        ],
    ),
    Scene(
        key="why",
        chapter="为什么不带引擎",
        draw=scene_why,
        lines=[
            ("先说为什么。掌机和单片机的内存以兆为单位，CPU 只有几十兆赫兹。", "先说为什么：掌机和单片机的内存以 MB 计，CPU 只有几十 MHz。"),
            ("带一个脚本引擎进去，要解析源码、要解释执行、还要垃圾回收。", "带一个脚本引擎进去，要解析源码、要解释执行、还要垃圾回收。"),
            ("MicroTS 的做法是，把这些事全部提前到编译期做完。", "MicroTS 的做法是：把这些事全部提前到编译期做完。"),
        ],
    ),
    Scene(
        key="source",
        chapter="你写的是什么",
        draw=scene_source,
        lines=[
            ("你照常写两个文件：视图和模型。", "你照常写两个文件：视图和模型。"),
            ("TSX 描述界面，同名的点 ts 文件里放信号、派生值和方法。", "TSX 描述界面，同名的 .ts 里放信号、派生值和方法。"),
            ("类型要能落到原生存储上，所以计数器写的是 i32，不是 number。", "类型要能落到原生存储上：计数器写的是 i32，不是 number。"),
        ],
    ),
    Scene(
        key="pipeline",
        chapter="编译流水线",
        draw=scene_pipeline,
        lines=[
            ("编译的时候，编译器先借 TypeScript 的类型检查器，问清每个值的真实类型。", "编译器先借 TypeScript 的类型检查器，问清每个值的真实类型。"),
            ("然后产出两份中间表示：View IR 记录节点、绑定和事件分发，Model IR 记录状态、依赖和任务。", "两份中间表示：View IR 记录节点、绑定、分发；Model IR 记录状态、依赖、任务。"),
            ("它们被打印成 Rust 源码，再加上编译好的样式表 styles 点 bin。", "它们被打印成 Rust 源码，加上编译好的样式表 styles.bin。"),
            ("最后 Cargo 把生成的代码和 microts 运行时，编译成一个原生程序。", "最后 Cargo 把生成的代码和 microts 运行时编译成一个原生程序。"),
        ],
    ),
    Scene(
        key="trait",
        chapter="视图与模型的契约",
        draw=scene_trait,
        lines=[
            ("生成的视图和模型之间，是一个 Rust trait。", "生成的视图和模型之间，是一个 Rust trait。"),
            ("模板里读 count，视图就调用 vm 的 count 方法；模板里给它赋值，trait 上就多一个 set count。", "模板里读 count，视图就调用 vm.count()；给它赋值，trait 上就多一个 set_count。"),
            ("compiled 模式由编译器从 ts 文件生成这些方法，rust 模式由你在 Rust 里实现。", "compiled 模式由编译器从 .ts 生成这些方法，rust 模式由你在 Rust 里实现。"),
        ],
    ),
    Scene(
        key="frame",
        chapter="一帧里发生什么",
        draw=scene_frame,
        lines=[
            ("运行时没有 ref，没有 effect，也没有 render 函数。", "运行时没有 ref，没有 effect，也没有 render 函数。"),
            ("宿主每帧调用一次 frame，输入先交给模型。", "宿主每帧调用一次 frame(input)：输入先交给模型。"),
            ("模型改了值，视图就只更新受影响的绑定。计数从 0 变成 1，只有那个文本节点被改写，按钮原地不动。", "模型改了值，视图只更新受影响的绑定：0 变成 1，只改写那个文本节点。"),
            ("然后 Rust 核心算布局，输出一份绘制列表，交给宿主上屏。", "然后 Rust 核心算布局，输出一份绘制列表交给宿主上屏。"),
        ],
    ),
    Scene(
        key="admission",
        chapter="准入检查",
        draw=scene_admission,
        lines=[
            ("代价是，源码必须落在一个子集里。", "代价是：源码必须落在一个子集里。"),
            ("any、Map、类、当数据用的函数，都进不去。", "any、Map、类、当数据用的函数，都进不去。"),
            ("编译器会在出错的文件、行、列上直接报错，不会偷偷退回解释执行。", "编译器在 file:line:column 上直接报错，不会偷偷退回解释执行。"),
            ("因为原生程序里，根本没有解释器。", "因为原生程序里，根本没有解释器。"),
        ],
    ),
    Scene(
        key="differential",
        chapter="怎么保证两边一致",
        draw=scene_differential,
        lines=[
            ("那怎么保证两条路算出来的结果一样？", "那怎么保证两条路算出来的一样？"),
            ("仓库里有差分测试：同一段 TypeScript，一边跑浏览器上的 JS 实现，一边跑生成的 Rust。", "差分测试：同一段 TypeScript，一边跑 JS 实现，一边跑生成的 Rust。"),
            ("喂同一条输入录像，逐帧比对输出。对不上，就是 bug。", "喂同一条输入录像，逐帧比对输出。对不上，就是 bug。"),
        ],
    ),
    Scene(
        key="gba",
        chapter="跑在 GBA 上",
        draw=scene_gba,
        lines=[
            ("最能说明问题的例子，是仓库里的 gba hero。", "最能说明问题的例子是 apps/gba-hero。"),
            ("它的 TSX 视图和 TypeScript 模型，被编译成一个 Game Boy Advance 卡带 ROM，没有 JS 虚拟机，也没有操作系统。", "TSX 视图和 TypeScript 模型被编译成一个 GBA 卡带 ROM：没有 JS 虚拟机，也没有操作系统。"),
            ("仓库里也老实记着数字：在 mGBA 里实测约 11 帧，30 帧还是目标，真机还没测。", "仓库也记着数字：mGBA 实测约 11 FPS，30 FPS 还是目标，真机未测。"),
        ],
    ),
    Scene(
        key="end",
        chapter="开始动手",
        draw=scene_end,
        tail=1.6,
        lines=[
            ("一句话：MicroTS 把 TypeScript 的表达力留在源码里，把运行时交给 Rust。", "MicroTS 把 TypeScript 的表达力留在源码里，把运行时交给 Rust。"),
            ("想动手，就从一行 build 命令开始，记得加上 strict。", "想动手，从一行 build 命令开始，加上 --strict。"),
            ("文档在 docs 的 microts 页面，代码在 microts 目录里。", "文档在 docs/microts，代码在 microts/ 目录里。"),
        ],
    ),
]
