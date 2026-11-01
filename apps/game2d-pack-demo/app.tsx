// The pack module and streamed music on one screen, driven by a frame timeline
// so every host runs the same script:
//
//   frames        what
//   0..           open demo/tiles.pack (a browser host answers on a later frame)
//   one per frame load the six IMG entries and show them
//   30            start demo/tone.pcm looping from 2 s
//   270, 273, 276 three overlapping sound effects, then a fourth that steals
//   930           crossfade over 1 s to demo/scale.pcm (60 s, looping)
//   1200..1399    200 loadImg/freeTexture cycles while music streams
//   4890          stop with a 1 s fade
//   4970          write the report (fs on PSP, globalThis.__demoReport everywhere)
//
// The six textures show in a 3x2 grid. gen-assets.ts holds the patterns.
import { createEffect, createSignal, Index } from "solid-js";
import { getOps, type NodeMirror } from "@pocketjs/framework";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createMusicPlayer, createSfxBank } from "../../framework/src/game2d/music.ts";

const TILES = "demo/tiles.pack";
const TONE = "demo/tone.pcm";
const SCALE = "demo/scale.pcm";
const RATE = 22050;

const FRAME_MUSIC = 30;
const FRAME_SFX = [270, 273, 276, 279];
const FRAME_SWITCH = 930;
const FRAME_CHURN = 1200;
const CHURN_CYCLES = 200;
const FRAME_STOP = 4890;
const FRAME_REPORT = 4970;

interface Pack {
  open(path: string): number;
  size(fh: number): number;
  read(fh: number, offset: number, dst: Uint8Array): number;
  loadImg(fh: number, offset: number, length: number): number;
  close(fh: number): void;
  stats?(): string;
}
interface Ops {
  setImage(node: number, handle: number): void;
  freeTexture?(handle: number): void;
  debugStats?(): string;
}
interface Fs {
  write(path: string, data: string, mode: number): number;
}
interface Arena {
  arenaBump: number;
  arenaTailFree: number;
}

const packNs = (): Pack | null => (globalThis as { pack?: Pack }).pack ?? null;
const packStats = () => {
  const text = packNs()?.stats?.();
  return text ? (JSON.parse(text) as Record<string, number | string>) : {};
};
function arena(ops: Ops): Arena | null {
  try {
    const memory = JSON.parse(ops.debugStats?.() ?? "{}").memory;
    return memory ? { arenaBump: memory.arenaBump, arenaTailFree: memory.arenaTailFree } : null;
  } catch {
    return null;
  }
}

export default function App() {
  const ops = getOps() as unknown as Ops;
  const music = createMusicPlayer();
  const sfx = createSfxBank(["blip", { name: "chime", volume: 0.8 }]);
  const [cells, setCells] = createSignal<number[]>([-1, -1, -1, -1, -1, -1]);
  const [line, setLine] = createSignal("opening");
  const [line2, setLine2] = createSignal("");

  let fh = -1;
  let opened = false;
  let table: { offset: number; length: number }[] = [];
  const loads: { length: number; us: number; handle: number }[] = [];
  const handles: number[] = [-1, -1, -1, -1, -1, -1];
  let next = 0;
  let frame = -1;
  let churned = 0;
  let churnFailed = 0;
  let arenaStart: Arena | null = null;
  let arenaWarm: Arena | null = null;
  let arenaEnd: Arena | null = null;
  let error = "";

  function openTiles(pack: Pack): void {
    const handle = pack.open(TILES);
    if (handle === -2) return;
    opened = true;
    if (handle < 0) {
      error = "tiles.pack not found";
      return;
    }
    fh = handle;
    const head = new Uint8Array(8 + 6 * 8);
    if (pack.read(fh, 0, head) !== head.length) {
      error = "short read";
      return;
    }
    const view = new DataView(head.buffer);
    const count = view.getUint32(4, true);
    for (let i = 0; i < count && i < 6; i++) {
      table.push({ offset: view.getUint32(8 + i * 8, true), length: view.getUint32(12 + i * 8, true) });
    }
  }

  function churn(pack: Pack): void {
    const entry = table[churned % table.length]!;
    const handle = pack.loadImg(fh, entry.offset, entry.length);
    if (handle < 0) churnFailed++;
    else ops.freeTexture?.(handle);
    // Open and close too: a leak in the handle table would run out at 8.
    const probe = pack.open(TILES);
    if (probe >= 0) pack.close(probe);
    else if (probe !== -2) churnFailed++;
    churned++;
    if (churned === table.length) arenaWarm = arena(ops);
  }

  function report(): void {
    const payload = {
      frame,
      error,
      loads,
      pack: packStats(),
      music: music.stats(),
      sfx: sfx.stats(),
      churn: { cycles: churned, failed: churnFailed, arenaStart, arenaWarm, arenaEnd },
    };
    (globalThis as { __demoReport?: unknown }).__demoReport = payload;
    const fs = (globalThis as { fs?: Fs }).fs;
    fs?.write("report.json", JSON.stringify(JSON.stringify(payload)), 0);
  }

  onFrame(() => {
    frame++;
    const pack = packNs();
    if (pack) {
      if (!opened) openTiles(pack);
      else if (next < table.length) {
        const entry = table[next]!;
        const handle = pack.loadImg(fh, entry.offset, entry.length);
        loads.push({ length: entry.length, us: Number(packStats().loadImgUsLast ?? 0), handle });
        handles[next] = handle;
        next++;
        setCells(handles.slice());
      }
    }
    if (frame === FRAME_MUSIC) music.play(TONE, { rate: RATE, loop: true, loopStartFrames: 2 * RATE, volume: 0.9 });
    for (let i = 0; i < FRAME_SFX.length; i++) {
      if (frame === FRAME_SFX[i]) sfx.play(i % 2 === 0 ? "blip" : "chime");
    }
    if (frame === FRAME_SWITCH) music.play(SCALE, { rate: RATE, loop: true, fadeInMs: 1000 });
    if (pack && table.length > 0 && frame >= FRAME_CHURN && churned < CHURN_CYCLES) {
      if (churned === 0) arenaStart = arena(ops);
      churn(pack);
      if (churned === CHURN_CYCLES) arenaEnd = arena(ops);
    }
    if (frame === FRAME_STOP) music.stop(1000);
    music.pump();
    sfx.pump();
    if (frame === FRAME_REPORT) report();
    if (frame % 30 === 0) {
      const stats = music.stats();
      setLine(`f${frame} ${music.current() ?? "no track"}`);
      setLine2(`under ${stats.underruns} read ${(stats.bytesRead / 1024) | 0}KB churn ${churned}${error ? " " + error : ""}`);
    }
  });

  return (
    <View class="w-full h-full bg-[#101018]">
      <Index each={cells()}>
        {(handle, i) => (
          <View
            class="absolute w-[112] h-[112] bg-[#303040]"
            style={{ insetL: 6 + (i % 3) * 118, insetT: 6 + Math.floor(i / 3) * 118 }}
          >
            <Image
              class="w-[112] h-[112]"
              ref={(node: NodeMirror) => {
                createEffect(() => {
                  if (handle() >= 0) ops.setImage(node.id, handle());
                });
              }}
            />
          </View>
        )}
      </Index>
      <View class="absolute left-[6] bottom-[2] flex-col">
        <Text class="text-xs text-amber-200">{line()}</Text>
        <Text class="text-xs text-sky-200">{line2()}</Text>
      </View>
    </View>
  );
}
