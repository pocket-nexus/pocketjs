import type { JSX } from "solid-js";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { color } from "../theme.ts";
import { game } from "../native.ts";
import {
  NOTE_AIR,
  NOTE_BIG_AIR,
  NOTE_BIG_GROUND,
  NOTE_GROUND,
  stepMs,
  type Song,
} from "../game/songs.ts";
import { rankFor, type GameResult } from "../game/result.ts";
import type { TextTone } from "../ui/text-classes.ts";
import { Bar, Button, Label, LeftLabel } from "../ui/kit.tsx";

// -- Layout and timing constants ---------------------------------------------------
const HIT_X = 88;
const AIR_Y = 84;
const GROUND_Y = 156;
const LANE_SPLIT = 120;
const SPAWN_X = 420;
const APPROACH_MS = 1100;
const SPEED = (SPAWN_X - HIT_X) / APPROACH_MS; // px per ms
// The renderer diffs the draw list op by op and repaints the whole screen when
// the op sequence changes shape (any node entering or leaving the visible clip,
// any text becoming empty). So nothing on the stage is ever moved off-screen or
// emptied: idle notes wait on the right edge, texts stay non-empty, and the
// judgement label parks behind the opaque bottom bar.
const SCREEN_W = 400;
// Idle notes wait as a 1px sliver on the right edge, in their own lane: they never
// leave the clip (no structural change) and cost almost nothing to repaint.
const WAIT_X = SCREEN_W - 1;
const RING_AIR = "#4fb8e8";
const RING_GROUND = "#ff6f7d";
const RING_LIT = "#ffffff";
const PERFECT_MS = 90;
const GREAT_MS = 170;
const BONUS_MS = 350;
const JUDGE_SHOW_MS = 420;
const SMALL = 32;
const BIG = 40;

const POOL_SMALL = 8;
const POOL_BIG = 2;

const NOTE_PENDING = 0;
const NOTE_HIT = 1;
const NOTE_MISSED = 2;

// Judgement identifiers (also the native sfx ids).
const PERFECT = 0;
const GREAT = 1;
const MISS = 2;

type Phase = "ready" | "playing" | "done";

function range(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i);
  return out;
}

const SMALL_SLOTS = range(POOL_SMALL);
const BIG_SLOTS = range(POOL_BIG);

/** Pool index for a note type: 0 ground, 1 air, 2 big ground, 3 big air. */
function noteLane(type: number): number {
  return type === NOTE_AIR || type === NOTE_BIG_AIR ? 1 : 0;
}

function isBig(type: number): boolean {
  return type === NOTE_BIG_GROUND || type === NOTE_BIG_AIR;
}

export interface StageProps {
  song: Song;
  previousBest: number;
  onExit: () => void;
  onFinish: (result: GameResult) => void;
}

export function Stage(props: StageProps): JSX.Element {
  const song = props.song;
  const beatMs = 60000 / song.bpm;
  const unit = stepMs(song.bpm);
  const noteCount = song.notes.length / 2;
  const noteTime: number[] = [];
  const noteType: number[] = [];
  for (let i = 0; i < noteCount; i++) {
    noteTime.push(song.notes[i * 2] * unit);
    noteType.push(song.notes[i * 2 + 1]);
  }
  const endMs = (noteCount > 0 ? noteTime[noteCount - 1] : 0) + 1800;
  const noteState: number[] = new Array<number>(noteCount).fill(NOTE_PENDING);
  const noteSlot: number[] = new Array<number>(noteCount).fill(-1);

  // Node pools, one array per visual kind.
  const pools: NodeMirror[][] = [[], [], [], []];
  const freeSlots: number[][] = [SMALL_SLOTS.slice(), SMALL_SLOTS.slice(), BIG_SLOTS.slice(), BIG_SLOTS.slice()];
  const active: number[] = [];
  let nextSpawn = 0;

  let runner: NodeMirror | undefined;
  let airRing: NodeMirror | undefined;
  let groundRing: NodeMirror | undefined;
  let airLitShown = false;
  let groundLitShown = false;

  const [phase, setPhase] = createSignal<Phase>("ready");
  const [score, setScore] = createSignal(0);
  const [combo, setCombo] = createSignal(0);
  const [hp, setHp] = createSignal(100);
  const [progress, setProgress] = createSignal(0);
  const [judgeText, setJudgeText] = createSignal("GO!");
  const [judgeTone, setJudgeTone] = createSignal<TextTone>("mist");
  const [startFailed, setStartFailed] = createSignal(false);

  let scoreValue = 0;
  let comboValue = 0;
  let maxCombo = 0;
  let hpValue = 100;
  let perfectCount = 0;
  let greatCount = 0;
  let missCount = 0;
  let offset = game.offset();
  let judgeUntil = 0;
  let lastHitAt = -1000;
  let lastHitLane = 0;
  let bonusLane = -1;
  let bonusUntil = 0;
  let airFlash = 0;
  let groundFlash = 0;
  let frame = 0;
  let runnerY = 0;
  let runnerX = 0;
  let clockStarted = false;
  let startedFrame = 0;
  let finished = false;

  function releaseSlot(index: number): void {
    const slot = noteSlot[index];
    if (slot < 0) return;
    const type = noteType[index];
    const node = pools[type][slot];
    if (node) jump(node, "translateX", WAIT_X);
    freeSlots[type].push(slot);
    noteSlot[index] = -1;
  }

  function showJudge(kind: number, text: string, now: number): void {
    setJudgeText(text);
    setJudgeTone(kind === PERFECT ? "amber" : kind === GREAT ? "sky" : "coral");
    judgeUntil = now + JUDGE_SHOW_MS;
  }

  function award(kind: number, now: number): void {
    if (kind === MISS) {
      comboValue = 0;
      hpValue = Math.max(0, hpValue - 10);
      missCount++;
      showJudge(kind, "MISS", now);
    } else {
      comboValue++;
      if (comboValue > maxCombo) maxCombo = comboValue;
      if (kind === PERFECT) {
        perfectCount++;
        hpValue = Math.min(100, hpValue + 2);
      } else {
        greatCount++;
      }
      scoreValue += (kind === PERFECT ? 300 : 150) + Math.min(comboValue, 100) * 3;
      showJudge(kind, kind === PERFECT ? "PERFECT" : "GREAT", now);
    }
    setScore(scoreValue);
    setCombo(comboValue);
    setHp(hpValue);
    game.sfx(kind);
  }

  function finish(failed: boolean): void {
    if (finished) return;
    finished = true;
    game.stop();
    setPhase("done");
    const judged = perfectCount + greatCount + missCount;
    const total = Math.max(noteCount, judged, 1);
    const accuracy = Math.round(((perfectCount + greatCount * 0.6) * 100) / total);
    const rank = rankFor(accuracy, failed);
    props.onFinish({
      songId: song.id,
      title: song.title,
      score: scoreValue,
      maxCombo,
      perfect: perfectCount,
      great: greatCount,
      miss: missCount + Math.max(0, total - judged),
      total,
      accuracy,
      rank,
      failed,
      newBest: !failed && scoreValue > props.previousBest,
    });
  }

  function begin(): void {
    if (phase() !== "ready") return;
    if (!game.start(song.bpm, song.events)) {
      setStartFailed(true);
      return;
    }
    setStartFailed(false);
    clockStarted = false;
    startedFrame = frame;
    setPhase("playing");
  }

  function tap(lane: number, now: number): void {
    if (lane === 1) airFlash = 5;
    else groundFlash = 5;

    let best = -1;
    let bestDelta = GREAT_MS + 1;
    for (let k = 0; k < active.length; k++) {
      const index = active[k];
      if (noteState[index] !== NOTE_PENDING || noteLane(noteType[index]) !== lane) continue;
      const delta = Math.abs(noteTime[index] - now);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    }
    if (best < 0) {
      if (bonusLane === lane && now <= bonusUntil) {
        bonusLane = -1;
        scoreValue += 200;
        setScore(scoreValue);
        showJudge(PERFECT, "BONUS", now);
        game.sfx(PERFECT);
        lastHitAt = now;
        lastHitLane = lane;
      }
      return;
    }
    noteState[best] = NOTE_HIT;
    releaseSlot(best);
    lastHitAt = now;
    lastHitLane = lane;
    if (isBig(noteType[best])) {
      bonusLane = lane;
      bonusUntil = now + BONUS_MS;
    }
    award(bestDelta <= PERFECT_MS ? PERFECT : GREAT, now);
  }

  createGesture({
    onDown: (contact) => {
      const current = phase();
      if (contact.y < 34 && contact.x < 66) return; // EXIT button
      if (current === "ready") {
        begin();
        return;
      }
      if (current !== "playing" || !clockStarted) return;
      const now = game.clock() + offset;
      tap(contact.y < LANE_SPLIT ? 1 : 0, now);
    },
  });

  onCleanup(() => {
    finished = true;
    game.stop();
  });

  onFrame(() => {
    frame++;
    if (phase() !== "playing") return;

    const raw = game.clock();
    if (raw < 0) {
      // The synthesizer has not produced its first block yet.
      if (frame - startedFrame > 90) {
        game.stop();
        setStartFailed(true);
        setPhase("ready");
      }
      return;
    }
    clockStarted = true;
    const now = raw + offset;

    // Spawn notes that entered the approach window.
    while (nextSpawn < noteCount && noteTime[nextSpawn] - now < APPROACH_MS) {
      const index = nextSpawn++;
      const type = noteType[index];
      if (noteTime[index] - now < -GREAT_MS) {
        noteState[index] = NOTE_MISSED;
        continue;
      }
      const slot = freeSlots[type].pop();
      if (slot === undefined) {
        noteState[index] = NOTE_MISSED;
        continue;
      }
      noteSlot[index] = slot;
      active.push(index);
    }

    // Move visible notes, resolve misses, recycle finished ones.
    for (let k = active.length - 1; k >= 0; k--) {
      const index = active[k];
      const type = noteType[index];
      const size = isBig(type) ? BIG : SMALL;
      const delta = noteTime[index] - now;
      if (noteState[index] === NOTE_PENDING && delta < -GREAT_MS) {
        noteState[index] = NOTE_MISSED;
        award(MISS, now);
      }
      const x = HIT_X + delta * SPEED;
      if (noteState[index] === NOTE_HIT || x - size / 2 < 0) {
        releaseSlot(index);
        active.splice(k, 1);
        continue;
      }
      const node = pools[type][noteSlot[index]];
      if (node) jump(node, "translateX", Math.min(x - size / 2, WAIT_X));
    }

    // Hit-zone pulse on the beat, brighter right after a tap.
    const beatPhase = (now % beatMs) / beatMs;
    // Rings flash by colour on a tap. (Never scale them: a scaled box is drawn
    // with a different set of ops, and any change in the op sequence makes the
    // renderer repaint the whole screen.)
    const airLit = airFlash > 0;
    const groundLit = groundFlash > 0;
    if (airRing && airLit !== airLitShown) {
      airLitShown = airLit;
      jump(airRing, "borderColor", airLit ? RING_LIT : RING_AIR);
    }
    if (groundRing && groundLit !== groundLitShown) {
      groundLitShown = groundLit;
      jump(groundRing, "borderColor", groundLit ? RING_LIT : RING_GROUND);
    }
    if (airFlash >= 0) airFlash--;
    if (groundFlash >= 0) groundFlash--;

    // Runner: hop toward the air lane, lunge on the ground lane, bob on the beat.
    if (runner) {
      let dy = beatPhase < 0.3 ? -3 : 0;
      let dx = 0;
      const age = now - lastHitAt;
      if (age >= 0 && age < 260) {
        const wave = Math.sin((Math.PI * age) / 260);
        if (lastHitLane === 1) dy = -36 * wave;
        else dx = 10 * wave;
      }
      if (dy !== runnerY) {
        runnerY = dy;
        jump(runner, "translateY", dy);
      }
      if (Math.abs(dx - runnerX) > 0.4) {
        runnerX = dx;
        jump(runner, "translateX", dx);
      }
    }

    if (judgeUntil !== 0 && now > judgeUntil) {
      judgeUntil = 0;
      setJudgeTone("mist");
    }
    if (frame % 3 === 0) setProgress(Math.min(1, now / endMs));

    if (hpValue <= 0) finish(true);
    else if (now >= endMs) finish(false);
  });

  // Notes are single pre-baked sprites: one draw op each, so a note costs a
  // fraction of a rounded box (7 ops) both to move and to sit idle in the pool.
  const noteSprite = (pool: number, slot: number) => {
    const big = pool >= 2;
    const size = big ? BIG : SMALL;
    const air = pool === 1 || pool === 3;
    const src = big
      ? air ? "note_big_air.png" : "note_big_ground.png"
      : air ? "note_air.png" : "note_ground.png";
    return (
      <Image
        nodeRef={(node: NodeMirror) => {
          pools[pool][slot] = node;
        }}
        class={big ? "absolute left-0 top-0 w-[40] h-[40]" : "absolute left-0 top-0 w-[32] h-[32]"}
        style={{ translateX: WAIT_X, translateY: (air ? AIR_Y : GROUND_Y) - size / 2 }}
        src={src}
      />
    );
  };

  return (
    <View
      debugName="Stage"
      class="absolute left-0 top-[480] w-[400] h-[240] bg-gradient-to-b from-[#0b1622] to-[#12304a] overflow-hidden"
    >
      {/* Lane bands */}
      <View
        class="absolute left-0 w-[400] bg-[#16324a]"
        style={{ insetT: 58, height: 52 }}
      />
      <View
        class="absolute left-0 w-[400] bg-[#16324a]"
        style={{ insetT: 130, height: 52 }}
      />
      {/* Hit zones */}
      <View
        ref={(node: NodeMirror) => {
          airRing = node;
        }}
        class="absolute w-[40] h-[40] border-2 border-[#4fb8e8]"
        style={{ insetL: HIT_X - 20, insetT: AIR_Y - 20, radius: 20 }}
      />
      <View
        ref={(node: NodeMirror) => {
          groundRing = node;
        }}
        class="absolute w-[40] h-[40] border-2 border-[#ff6f7d]"
        style={{ insetL: HIT_X - 20, insetT: GROUND_Y - 20, radius: 20 }}
      />

      {/* Runner */}
      <View class="absolute w-[30] h-[6] bg-[#050b12]" style={{ insetL: 20, insetT: 181, radius: 3 }} />
      <Image
        nodeRef={(node: NodeMirror) => {
          runner = node;
        }}
        class="absolute w-[40] h-[40]"
        style={{ insetL: 15, insetT: 142 }}
        src="avatar.png"
      />

      {/* Notes */}
      <For each={SMALL_SLOTS}>{(slot) => noteSprite(0, slot)}</For>
      <For each={SMALL_SLOTS}>{(slot) => noteSprite(1, slot)}</For>
      <For each={BIG_SLOTS}>{(slot) => noteSprite(2, slot)}</For>
      <For each={BIG_SLOTS}>{(slot) => noteSprite(3, slot)}</For>

      <View class="absolute left-0 top-[184] w-[400] h-[3] bg-[#3b6e8f]" />
      <View class="absolute left-0 top-[187] w-[400] h-[53] bg-[#0a1420]" />

      {/* HUD */}
      <Button debugName="StageExit" x={10} y={6} w={46} h={20} text="EXIT" tone="night" textTone="mist" onPress={props.onExit} />
      <LeftLabel x={68} y={3} w={110} h={24} text={() => `${score()}`} size="lg" tone="white" />
      <Label x={176} y={3} w={76} h={24} text={() => `${combo()}x`} size="lg" tone={combo() >= 2 ? "amber" : "mist"} />
      <LeftLabel x={258} y={6} w={22} h={16} text="HP" size="xsb" tone="mist" />
      <Bar x={282} y={12} w={106} h={8} fraction={() => hp() / 100} trackClass="night" fillTone={hp() < 30 ? "coral" : "teal"} />
      <Label x={HIT_X - 60} y={34} w={120} h={20} text={judgeText} size="base" tone={judgeTone()} />
      <Bar x={12} y={212} w={376} h={4} fraction={progress} trackClass="night" fillTone="amber" />
      <LeftLabel x={14} y={220} w={180} h={14} text={song.title} size="xs" tone="mist" />
      <Label x={230} y={220} w={158} h={14} text="Upper: air   Lower: ground" size="xs" tone="mist" />

      {/* Ready card */}
      <Show when={phase() === "ready"}>
        <View
          class="absolute bg-[#12304a] border-2 border-[#4fb8e8]"
          style={{ insetL: 70, insetT: 52, width: 260, height: 124, radius: 18 }}
        >
          <Label x={0} y={12} w={256} h={24} text={song.title} size="lg" tone="white" />
          <Label x={0} y={38} w={256} h={16} text={`${song.bpm} BPM`} size="xs" tone="mist" />
          <Label x={0} y={62} w={256} h={18} text="TAP TO START" size="base" tone="amber" />
          <Show when={startFailed()}>
            <Label x={0} y={84} w={256} h={14} text="Audio unavailable, try again" size="xs" tone="coral" />
          </Show>
          <Show when={!startFailed()}>
            <Label x={0} y={86} w={256} h={14} text="Blue notes: tap upper half" size="xs" tone="sky" />
            <Label x={0} y={101} w={256} h={14} text="Red notes: tap lower half" size="xs" tone="coral" />
          </Show>
        </View>
      </Show>
    </View>
  );
}
