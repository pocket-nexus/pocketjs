<script setup lang="ts">
// A device from the front: the shell's picture (microts:shells), the screen where the shell's screen is, and
// places over the shell's keys that take a pointer. Everything is placed in fractions of the picture, and the
// device scales as one thing to fit, its screen at most twice its logical size. The parent passes the screen
// content through the default slot; the screen element survives device switches, so the slotted iframe / canvas
// is not recreated. A held key shows on the picture as the Pocket3D player shows it: the shell's moving parts are
// windows on a sheet laid over the case, and a held key goes down into its socket, a shoulder key in from the
// edge, a moulded cross leans toward the arm that is held.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { Rect } from "microts:shells";
import type { DeviceSpec } from "./devices";

const props = defineProps<{ device: DeviceSpec; mode: "ui" | "retro" }>();
const emit = defineEmits<{ press: [button: string, down: boolean] }>();

const area = ref<HTMLElement | null>(null);
const size = ref({ w: 0, h: 0 });
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    const r = entry!.contentRect;
    size.value = { w: r.width, h: r.height };
  });
  observer.observe(area.value!);
});
onBeforeUnmount(() => observer?.disconnect());

/** The picture's size and its screen. A custom size has no picture: a bezel of BEZEL units about a screen 360 units on its long side */
const BEZEL = 22;
const geometry = computed(() => {
  const d = props.device;
  if (d.shell) return { width: d.shell.width, height: d.shell.height, screen: d.shell.screens.upper };
  const k = 360 / Math.max(d.screen.width, d.screen.height);
  const w = d.screen.width * k;
  const h = d.screen.height * k;
  return { width: w + 2 * BEZEL, height: h + 2 * BEZEL, screen: [BEZEL, BEZEL, w, h] as Rect };
});
/** The screen content: the largest box of the logical screen's shape in the shell's screen, in its middle */
const slot = computed<Rect>(() => {
  const [x, y, w, h] = geometry.value.screen;
  const { width, height } = props.device.screen;
  const k = Math.min(w / width, h / height);
  return [x + (w - width * k) / 2, y + (h - height * k) / 2, width * k, height * k];
});

/** Picture pixel → CSS pixel: the whole device fits, and the screen is at most twice its logical size */
const s = computed(() => {
  const g = geometry.value;
  if (!size.value.w || !size.value.h) return 0;
  return Math.min(size.value.w / g.width, size.value.h / g.height, (2 * props.device.screen.width) / slot.value[2]);
});
const frameStyle = computed(() => {
  const g = geometry.value;
  return {
    width: `${g.width * s.value}px`,
    height: `${g.height * s.value}px`,
    left: `${(size.value.w - g.width * s.value) / 2}px`,
    top: `${(size.value.h - g.height * s.value) / 2}px`,
    "--unit": `${s.value}px`,
  };
});
/** A rectangle of the picture as a box in fractions of the shell */
function place([x, y, w, h]: Rect) {
  const g = geometry.value;
  return { left: `${(x / g.width) * 100}%`, top: `${(y / g.height) * 100}%`, width: `${(w / g.width) * 100}%`, height: `${(h / g.height) * 100}%` };
}
/** A rectangle grown by `by` of its shorter side each way: a finger is wider than a key */
function grow([x, y, w, h]: Rect, by: number): Rect {
  const d = Math.min(w, h) * by;
  return [x - d, y - d, w + 2 * d, h + 2 * d];
}

// ---------- The picture ----------

const loaded = ref(false);
watch(
  () => props.device.shell?.art,
  () => (loaded.value = false),
);

const DIRECTIONS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
/** Controls held by a pointer, by their name in the profile */
const held = reactive(new Set<string>());

/** The moving parts: windows on the parts' sheet, each with the controls that move it */
const parts = computed(() => {
  const shell = props.device.shell;
  if (!shell?.partsArt) return [];
  const pw = shell.partsWidth!;
  const ph = shell.partsHeight!;
  const caps = new Set(shell.sticks.map((st) => st.part));
  return shell.parts.map(([x, y, w, h, sx, sy], i) => {
    const controls = shell.controls.filter((c) => c.part === i).map((c) => c.button);
    // (one moulded cross rocks under a thumb; a key of its own goes straight down; a shoulder key goes in from the edge)
    const kind = caps.has(i) ? "cap" : controls.length > 1 ? "rocker" : controls[0] === "l" || controls[0] === "r" ? "shoulder" : "key";
    return {
      controls,
      kind,
      style: {
        ...place([x, y, w, h]),
        backgroundImage: `url("${shell.partsArt}")`,
        backgroundSize: `${(pw / w) * 100}% ${(ph / h) * 100}%`,
        backgroundPosition: `${pw === w ? 0 : (sx / (pw - w)) * 100}% ${ph === h ? 0 : (sy / (ph - h)) * 100}%`,
      },
    };
  });
});
function partState(p: { controls: string[] }) {
  const on = p.controls.filter((c) => held.has(c));
  // (a rocker leans toward what is held on it)
  const lean = on.reduce(([lx, ly], c) => [lx + (DIRECTIONS[c]?.[0] ?? 0), ly + (DIRECTIONS[c]?.[1] ?? 0)], [0, 0]);
  return { held: on.length > 0, style: { "--lean-x": lean[0], "--lean-y": lean[1] } };
}

// ---------- Keys ----------

/** The button a control is in the current mode; a control with none does not respond */
function target(button: string): string | undefined {
  const k = props.device.keys[button];
  return props.mode === "ui" ? k?.ui : k?.retro;
}
function hold(button: string, on: boolean) {
  const t = target(button);
  if (!t || held.has(button) === on) return;
  if (on) held.add(button);
  else held.delete(button);
  emit("press", t, on);
}
/** Press and release at once: pulses from the wheel and the trackpad (the preview holds a press between frames until the next frame) */
function pulse(button: string) {
  emit("press", button, true);
  emit("press", button, false);
}
function capture(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

/** The d-pad: one place for a thumb, over the four arms, when the device maps them */
const pad = computed<Rect | null>(() => {
  const arms = props.device.shell?.controls.filter((c) => c.button in DIRECTIONS && target(c.button)) ?? [];
  if (arms.length !== 4) return null;
  const x0 = Math.min(...arms.map((c) => c.rect[0]));
  const y0 = Math.min(...arms.map((c) => c.rect[1]));
  const x1 = Math.max(...arms.map((c) => c.rect[0] + c.rect[2]));
  const y1 = Math.max(...arms.map((c) => c.rect[1] + c.rect[3]));
  const d = (x1 - x0) * 0.08;
  return [x0 - d, y0 - d, x1 - x0 + 2 * d, y1 - y0 + 2 * d];
});
/** Where the thumb is on the pad: one arm, or two at a diagonal, as a thumb rolls from one to the next */
function aim(e: PointerEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width - 0.5;
  const y = (e.clientY - box.top) / box.height - 0.5;
  let arms: string[] = [];
  if (Math.hypot(x, y) > 0.07) {
    // (eight ways: an arm takes the 45 degrees about its own direction and shares the rest with its neighbour)
    const way = ((Math.round(Math.atan2(-y, x) / (Math.PI / 4)) % 8) + 8) % 8;
    arms = [["right"], ["right", "up"], ["up"], ["up", "left"], ["left"], ["left", "down"], ["down"], ["down", "right"]][way]!;
  }
  for (const arm of Object.keys(DIRECTIONS)) hold(arm, arms.includes(arm));
}
function padDown(e: PointerEvent) {
  capture(e);
  aim(e);
}
function padMove(e: PointerEvent) {
  if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) aim(e);
}
function padUp() {
  for (const arm of Object.keys(DIRECTIONS)) hold(arm, false);
}

const GESTURES = new Set(["wheel", "trackpad"]);
/** Every other control: a key under a finger. A key with no part of its own shows its caption when it has one (it is out of sight from the front), and lights up while held */
const keys = computed(() =>
  (props.device.shell?.controls ?? [])
    .filter((c) => !GESTURES.has(c.button) && !(c.button in DIRECTIONS && pad.value) && c.button in props.device.keys)
    .map((c) => ({ button: c.button, part: c.part, rect: grow(c.rect, 0.2) })),
);
const control = (button: string) => props.device.shell?.controls.find((c) => c.button === button);

// ---------- iPod click wheel: drag around → UP / DOWN; tap the four edges → MENU ⏭ ⏯ ⏮ ----------

const wheelRect = computed(() => control("wheel")?.rect ?? null);
const WHEEL_STEP = 20; // degrees
let wheel: { cx: number; cy: number; last: number; travel: number; acc: number; zone: string } | null = null;
const angleOf = (e: PointerEvent, cx: number, cy: number) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;

function wheelDown(e: PointerEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const a = angleOf(e, cx, cy);
  const zone = a >= -135 && a < -45 ? "TRIANGLE" : a >= -45 && a < 45 ? "RIGHT" : a >= 45 && a < 135 ? "START" : "LEFT";
  capture(e);
  wheel = { cx, cy, last: a, travel: 0, acc: 0, zone };
}
function wheelMove(e: PointerEvent) {
  if (!wheel) return;
  const a = angleOf(e, wheel.cx, wheel.cy);
  let d = a - wheel.last;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  wheel.last = a;
  wheel.travel += Math.abs(d);
  wheel.acc += d;
  // Screen y points down, so a growing angle is clockwise: clockwise scrolls down
  while (wheel.acc >= WHEEL_STEP) {
    pulse("DOWN");
    wheel.acc -= WHEEL_STEP;
  }
  while (wheel.acc <= -WHEEL_STEP) {
    pulse("UP");
    wheel.acc += WHEEL_STEP;
  }
}
function wheelUp() {
  if (wheel && wheel.travel < 8) pulse(wheel.zone);
  wheel = null;
}

// ---------- BlackBerry trackpad: drag → direction pulses; tap → its key (CIRCLE) ----------

const trackpad = computed(() => control("trackpad") ?? null);
let pad2: { x: number; y: number; ax: number; ay: number; moved: boolean; step: number } | null = null;
function trackDown(e: PointerEvent) {
  capture(e);
  // (a step is a quarter of the pad's width on the page)
  const step = (e.currentTarget as HTMLElement).getBoundingClientRect().width / 4;
  pad2 = { x: e.clientX, y: e.clientY, ax: 0, ay: 0, moved: false, step };
  held.add("trackpad");
}
function trackMove(e: PointerEvent) {
  if (!pad2) return;
  pad2.ax += e.clientX - pad2.x;
  pad2.ay += e.clientY - pad2.y;
  pad2.x = e.clientX;
  pad2.y = e.clientY;
  if (Math.abs(pad2.ax) >= pad2.step) {
    pulse(pad2.ax > 0 ? "RIGHT" : "LEFT");
    pad2.ax = 0;
    pad2.moved = true;
  }
  if (Math.abs(pad2.ay) >= pad2.step) {
    pulse(pad2.ay > 0 ? "DOWN" : "UP");
    pad2.ay = 0;
    pad2.moved = true;
  }
}
function trackUp() {
  const t = target("trackpad");
  if (pad2 && !pad2.moved && t) pulse(t);
  pad2 = null;
  held.delete("trackpad");
}

// ---------- Keys the device keeps for itself, and a second screen the preview does not use ----------

const system = computed(() =>
  Object.entries(props.device.shell?.system ?? {}).map(([name, rect]) => ({ name, rect, title: props.device.system?.[name] ?? "" })),
);
const lower = computed(() => (props.device.lower ? (props.device.shell?.screens.lower ?? null) : null));

// A device switch lets go of whatever was held on the one before
watch(
  () => props.device.id,
  () => held.clear(),
);
</script>

<template>
  <div ref="area" class="device-area relative h-full w-full select-none" @contextmenu.prevent>
    <div class="dev-shell absolute" :class="{ 'dev-plain': !device.shell, 'dev-loading': device.shell && !loaded }" :style="frameStyle">
      <img
        v-if="device.shell"
        :key="device.shell.art"
        class="dev-art"
        :src="device.shell.art"
        alt=""
        draggable="false"
        @load="loaded = true"
        @error="loaded = true"
      />

      <!-- Screen: slot content (iframe or canvas). This element survives device switches -->
      <div class="absolute overflow-hidden bg-black" :style="place(slot)">
        <slot />
      </div>

      <template v-if="device.shell">
        <div class="dev-parts">
          <div
            v-for="(p, i) in parts"
            :key="`${device.id}-p${i}`"
            class="dev-part"
            :data-kind="p.kind"
            :data-held="partState(p).held || undefined"
            :style="[p.style, partState(p).style]"
          />
        </div>

        <span v-if="lower" class="dev-note" :style="place(lower)" :title="device.lower" />
        <span v-for="k in system" :key="`${device.id}-s-${k.name}`" class="dev-note" :style="place(k.rect)" :title="k.title" />

        <!-- iPod click wheel; the center button is a key over it -->
        <div
          v-if="wheelRect"
          class="dev-hit dev-wheel"
          :style="place(wheelRect)"
          role="slider"
          aria-label="Click wheel: drag around to scroll, click the edges for MENU, previous, next and play"
          @pointerdown="wheelDown"
          @mousedown.prevent
          @pointermove="wheelMove"
          @pointerup="wheelUp"
          @pointercancel="wheelUp"
        />

        <!-- BlackBerry trackpad -->
        <div
          v-if="trackpad"
          class="dev-hit dev-trackpad"
          :style="place(grow(trackpad.rect, 0.15))"
          role="slider"
          aria-label="Trackpad: drag to move focus, click to press"
          @pointerdown="trackDown"
          @mousedown.prevent
          @pointermove="trackMove"
          @pointerup="trackUp"
          @pointercancel="trackUp"
        />

        <div
          v-if="pad"
          class="dev-hit"
          :style="place(pad)"
          role="group"
          aria-label="D-pad"
          @pointerdown="padDown"
          @mousedown.prevent
          @pointermove="padMove"
          @pointerup="padUp"
          @pointercancel="padUp"
          @lostpointercapture="padUp"
        />

        <button
          v-for="k in keys"
          :key="`${device.id}-${k.button}`"
          type="button"
          tabindex="-1"
          class="dev-hit"
          :class="k.part !== null ? '' : device.keys[k.button]?.caption ? 'dev-named' : 'dev-flat'"
          :data-control="k.button"
          :data-held="held.has(k.button) || undefined"
          :style="place(k.rect)"
          :aria-label="device.keys[k.button]?.label ?? k.button.toUpperCase()"
          :disabled="!target(k.button)"
          @pointerdown="
            capture($event);
            hold(k.button, true);
          "
          @mousedown.prevent
          @pointerup="hold(k.button, false)"
          @pointercancel="hold(k.button, false)"
          @lostpointercapture="hold(k.button, false)"
        >
          <template v-if="k.part === null">{{ device.keys[k.button]?.caption }}</template>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.device-area {
  touch-action: none;
}
.dev-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 calc(var(--unit) * 18) calc(var(--unit) * 28) rgb(0 0 0 / 0.55));
  transition: opacity 0.2s;
}
.dev-parts {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}
.dev-loading .dev-art,
.dev-loading .dev-parts {
  opacity: 0;
}
/* A moving part: a window on the parts' sheet. Held, a key goes down into its socket, a shoulder key in from its
   edge, a moulded cross leans */
.dev-part {
  position: absolute;
  background-repeat: no-repeat;
  transition:
    transform 70ms ease-out,
    filter 70ms ease-out;
}
.dev-part[data-held][data-kind="key"] {
  transform: translateY(1.5%) scale(0.95);
  filter: brightness(0.68);
}
.dev-part[data-held][data-kind="shoulder"] {
  transform: translateY(6%);
  filter: brightness(0.78);
}
.dev-part[data-held][data-kind="rocker"] {
  transform: translate(calc(var(--lean-x, 0) * 1.4%), calc(var(--lean-y, 0) * 1.4%)) scale(0.985);
  filter: brightness(0.93);
}
/* Where a pointer takes a control: nothing is drawn, the part under it is the picture */
.dev-hit {
  all: unset;
  position: absolute;
  box-sizing: border-box;
  border-radius: 50%;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.dev-hit:disabled {
  cursor: default;
}
.dev-wheel {
  cursor: grab;
}
.dev-wheel:active {
  cursor: grabbing;
}
.dev-trackpad {
  border-radius: 22%;
  cursor: move;
}
/* A key out of sight from the front (the 3DS's L and R, behind the hinge) has no part: its caption stands where a finger reaches it */
.dev-named {
  display: grid;
  place-items: center;
  border-radius: 22%;
  color: rgb(60 60 66 / 0.55);
  font: 700 calc(var(--unit) * 40) / 1 var(--font-round);
}
/* (the left one's caption toward the left edge, the right one's toward the right: what is in the middle of a case's corner stays in sight) */
.dev-named[data-control="l"] {
  justify-items: start;
  padding-left: 22%;
}
.dev-named[data-control="r"] {
  justify-items: end;
  padding-right: 22%;
}
.dev-named[data-held] {
  background: rgb(0 0 0 / 0.14);
  color: rgb(30 30 34 / 0.9);
}
/* A key with no part of its own (printed on the face, or a shoulder key that wraps the case): lit while held */
.dev-flat {
  border-radius: 22%;
}
.dev-flat[data-held] {
  background: rgb(255 255 255 / 0.16);
}
.dev-note {
  position: absolute;
  cursor: help;
}
/* A custom size: a plain dark bezel about the screen */
.dev-plain {
  border-radius: calc(var(--unit) * 26);
  background: linear-gradient(180deg, #2a2633 0%, #15131b 100%);
  box-shadow:
    inset 0 0 0 calc(var(--unit) * 1.5) rgb(255 255 255 / 0.1),
    inset 0 calc(var(--unit) * 2) 0 rgb(255 255 255 / 0.06),
    0 calc(var(--unit) * 18) calc(var(--unit) * 28) rgb(0 0 0 / 0.55);
}
</style>
