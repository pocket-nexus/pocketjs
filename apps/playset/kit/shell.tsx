// The interface every playset game shares: the same screens in the same
// places, so the games read as one family on the console.
//
// Top screen: the scene, with one line of readouts in the corner while
// playing and a banner while paused. Touch screen: the title (Play, Demo,
// the controls), the running readouts with bars, the game-over card, and a
// developer panel behind Y. A is the primary action, X the demo, START
// pauses; SELECT belongs to the host (it returns to Pocket Shell's Home).
//
// Per frame the shell reads the pad, runs the game's frame, and every sixth
// frame writes the changed readouts through @pocketjs/framework/hot into
// fixed cells, so a number changing costs a text op and no relayout.

import { createSignal, For, Show } from "solid-js";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import * as hot from "@pocketjs/framework/hot";
import { BTN } from "@pocketjs/framework/input";
import { analogX, analogY, onButtonPress, onFrame, rightAnalogX, rightAnalogY } from "@pocketjs/framework/lifecycle";
import { STAT, type Playset } from "@pocketjs/framework/playset";

export type GameStatus = "title" | "playing" | "paused" | "gameover";

/** The pad as a game reads it: sticks in -1..1 with up positive, buttons held and newly pressed. */
export interface Pad {
  x: number;
  y: number;
  rx: number;
  ry: number;
  held: number;
  pressed: number;
}

export interface Readout {
  readonly label: string;
  /** a number or short text, sampled six times a second */
  value(): string | number;
  /** 0..1 draws a bar under the value */
  bar?(): number;
  readonly color?: string;
}

export interface PlaysetGame {
  readonly title: string;
  readonly tagline: string;
  /** accent for buttons and bars, "#rrggbb" */
  readonly accent: string;
  readonly controls: readonly (readonly [string, string])[];
  readonly readouts: readonly Readout[];
  readonly play: Playset;
  status(): GameStatus;
  /** start a run; demo = the game plays itself */
  start(demo: boolean): void;
  frame(pad: Pad): void;
  /** the top-screen corner line while playing */
  topLine(): string;
  /** the game-over card's second line */
  result(): string;
  pause?(paused: boolean): void;
}

const DPAD = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

export function GameShell(props: { game: PlaysetGame }) {
  const game = props.game;
  const [status, setStatus] = createSignal<GameStatus>(game.status());
  const [stats, setStats] = createSignal(false);
  const pad: Pad = { x: 0, y: 0, rx: 0, ry: 0, held: 0, pressed: 0 };
  let last = 0;
  let frames = 0;
  let jsUs = 0;
  let jsMax = 0;
  const values: (NodeMirror | undefined)[] = [];
  const bars: (NodeMirror | undefined)[] = [];
  let topLine: NodeMirror | undefined;
  const statNodes: (NodeMirror | undefined)[] = [];

  const start = (demo: boolean) => {
    game.start(demo);
    setStatus(game.status());
  };
  const togglePause = () => {
    const s = game.status();
    if (s === "playing" || s === "paused") {
      game.pause?.(s === "playing");
      setStatus(game.status());
    }
  };

  onButtonPress(BTN.CIRCLE, () => {
    const s = game.status();
    if (s === "title" || s === "gameover") start(false);
    else if (s === "paused") togglePause();
  });
  onButtonPress(BTN.TRIANGLE, () => {
    const s = game.status();
    if (s === "title" || s === "gameover") start(true);
  });
  onButtonPress(BTN.START, togglePause);
  onButtonPress(BTN.SQUARE, () => setStats(!stats()));

  onFrame((held) => {
    const t0 = game.play.now();
    pad.pressed = held & ~last;
    pad.held = held;
    last = held;
    let x = analogX();
    let y = -analogY();
    if (held & DPAD) {
      x = (held & BTN.RIGHT ? 1 : 0) - (held & BTN.LEFT ? 1 : 0);
      y = (held & BTN.UP ? 1 : 0) - (held & BTN.DOWN ? 1 : 0);
    }
    pad.x = x;
    pad.y = y;
    pad.rx = rightAnalogX();
    pad.ry = -rightAnalogY();
    game.frame(pad);
    const s = game.status();
    if (s !== status()) setStatus(s);
    frames++;
    if (frames % 6 === 0) {
      const rs = game.readouts;
      for (let i = 0; i < rs.length; i++) {
        hot.text(values[i], rs[i].value());
        const b = rs[i].bar;
        if (b) hot.prop(bars[i], "scaleX", Math.max(0, Math.min(1, b())));
      }
      hot.text(topLine, s === "playing" ? game.topLine() : "");
    }
    const us = game.play.now() - t0;
    jsUs += us;
    if (us > jsMax) jsMax = us;
    if (frames % 30 === 0) {
      if (stats()) {
        const st = game.play.stats;
        const r = game.play.renderStats();
        hot.text(statNodes[0], `frame js ${(jsUs / 30000).toFixed(1)} ms  max ${(jsMax / 1000).toFixed(1)}`);
        hot.text(statNodes[1], `step ${(st[STAT.STEP_US] / 1000).toFixed(2)} ms  render ${(st[STAT.RENDER_US] / 1000).toFixed(2)} ms`);
        hot.text(statNodes[2], `draws ${r[0]}  bones ${r[1]}  tris ${r[4]}  dyn ${r[3]}`);
        hot.text(statNodes[3], `live ${st[STAT.LIVE]}  fx ${st[STAT.PARTICLES]}  pairs ${st[STAT.PAIRS]}  culled ${st[STAT.CULLED]}`);
      }
      jsUs = 0;
      jsMax = 0;
    }
  });

  const button = (label: string, key: string, onPress: () => void, primary: boolean) => (
    <View
      class={primary ? "w-[136] h-[34] rounded-[10] items-center justify-center" : "w-[136] h-[34] rounded-[10] items-center justify-center border border-[#ffffff40]"}
      style={primary ? { bgColor: game.accent } : {}}
      onPress={onPress}
    >
      <Text class="text-sm text-white font-bold">{`${key}  ${label}`}</Text>
    </View>
  );

  return (
    <>
      {/* top screen: the scene shows through; text only where it is needed */}
      <View class="relative w-full h-full">
        <View class="absolute left-[6] top-[4] w-[388] h-[16]">
          <Text ref={(el) => (topLine = el)} class="text-sm text-white font-bold">{""}</Text>
        </View>
        <Show when={status() === "paused"}>
          <View class="absolute left-[130] top-[100] w-[140] h-[40] rounded-[12] bg-[#000000a0] items-center justify-center">
            <Text class="text-base text-white font-bold">Paused</Text>
          </View>
        </Show>
      </View>
      <AuxiliarySurface>
        <View class="relative w-full h-full bg-[#0b1020] overflow-hidden">
          <Show when={status() === "title" || status() === "gameover"}>
            <View class="absolute left-0 top-[12] w-[320] h-[30] flex-row justify-center">
              <Text class="text-xl text-white font-bold">{status() === "gameover" ? "Game Over" : game.title}</Text>
            </View>
            <View class="absolute left-[16] top-[44] w-[288] h-[36] flex-row justify-center">
              <Text class="w-[288] text-xs text-[#b8c4e0] text-center">{status() === "gameover" ? game.result() : game.tagline}</Text>
            </View>
            <View class="absolute left-[16] top-[86] w-[288] h-[34] flex-row justify-between">
              {button(status() === "gameover" ? "Again" : "Play", "A", () => start(false), true)}
              {button("Demo", "X", () => start(true), false)}
            </View>
            <View class="absolute left-[24] top-[132] w-[272] h-[80] flex-col">
              <For each={game.controls.slice(0, 5)}>
                {(c) => (
                  <View class="w-[272] h-[16] flex-row justify-between">
                    <Text class="text-xs text-[#8d9bc0]">{c[0]}</Text>
                    <Text class="text-xs text-[#dfe6f7]">{c[1]}</Text>
                  </View>
                )}
              </For>
            </View>
            <View class="absolute left-0 top-[222] w-[320] h-[14] flex-row justify-center">
              <Text class="text-2xs text-[#5e6a8a]">Built with GameBlocks · Pocket Playset</Text>
            </View>
          </Show>
          <View class="absolute left-[16] top-[12] w-[288] h-[200] flex-col" style={{ opacity: status() === "playing" || status() === "paused" ? 1 : 0 }}>
            <For each={game.readouts.slice(0, 6)}>
              {(r, i) => (
                <View class="w-[288] h-[32] flex-col">
                  <View class="w-[288] h-[18] flex-row justify-between">
                    <Text class="text-xs text-[#8d9bc0]">{r.label}</Text>
                    <View class="w-[140] h-[18] items-end">
                      <Text ref={(el) => (values[i()] = el)} class="text-sm text-white font-bold">{""}</Text>
                    </View>
                  </View>
                  <Show when={r.bar}>
                    <View class="w-[288] h-[6] rounded-[3] bg-[#ffffff20]">
                      <View ref={(el) => (bars[i()] = el)} class="w-[288] h-[6] rounded-[3] origin-left" style={{ bgColor: r.color ?? game.accent }} />
                    </View>
                  </Show>
                </View>
              )}
            </For>
          </View>
          <View class="absolute left-[8] top-[170] w-[304] h-[64] rounded-[8] bg-[#00000080] flex-col p-[4]" style={{ opacity: stats() ? 1 : 0 }}>
            {[0, 1, 2, 3].map((i) => (
              <View class="w-[296] h-[14]">
                <Text ref={(el) => (statNodes[i] = el)} class="text-2xs text-[#9fe8ff]">{""}</Text>
              </View>
            ))}
          </View>
          <Show when={status() === "playing" || status() === "paused"}>
            <View class="absolute left-[208] top-[214] w-[104] h-[20] rounded-[6] border border-[#ffffff30] items-center justify-center" onPress={togglePause}>
              <Text class="text-2xs text-[#c8d2ea]">{status() === "paused" ? "START  Resume" : "START  Pause"}</Text>
            </View>
          </Show>
        </View>
      </AuxiliarySurface>
    </>
  );
}
