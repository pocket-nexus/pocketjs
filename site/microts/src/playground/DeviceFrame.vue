<script setup lang="ts">
// Device shape: body, screen and controls are drawn at the design coordinates from devices.ts and scaled uniformly
// to fit, so the screen and buttons stay fully visible. The parent passes screen content through the default slot;
// the screen element survives device switches, so the slotted iframe / canvas is not recreated.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { BodyPart, Control, DeviceSpec } from "./devices";

type ButtonControl = Extract<Control, { kind: "button" }>;

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

/** Design-unit → pixel scale: fits the whole device, capped at 2× */
const s = computed(() => {
  const d = props.device;
  if (!size.value.w || !size.value.h) return 0;
  return Math.min(size.value.w / d.w, size.value.h / d.h, 2);
});
const u = (n: number) => `${n * s.value}px`;
const box = (x: number, y: number, w: number, h: number) => ({ left: u(x), top: u(y), width: u(w), height: u(h) });
const frameStyle = computed(() => ({
  width: u(props.device.w),
  height: u(props.device.h),
  left: `${(size.value.w - props.device.w * s.value) / 2}px`,
  top: `${(size.value.h - props.device.h * s.value) / 2}px`,
}));

const isShoulder = (c: Control): c is ButtonControl => c.kind === "button" && c.shape === "shoulder";
const shoulders = computed(() => props.device.controls.filter(isShoulder));
// Annotated as Control[]: otherwise TS infers a type predicate from !isShoulder(c) and excludes every button
const others = computed<Control[]>(() => props.device.controls.filter((c) => !isShoulder(c)));

/** Body corner radius: numbers scale as design units; px values inside strings scale too */
function radiusOf(b: BodyPart): string {
  if (typeof b.radius === "number") return u(b.radius);
  return b.radius.replace(/(\d+(?:\.\d+)?)px/g, (_m: string, n: string) => `${Number(n) * s.value}px`);
}

/** Button name the control maps to in the current mode; unmapped controls do not respond */
function target(c: ButtonControl): string | undefined {
  return props.mode === "ui" ? c.ui : c.retro;
}

// ---------- Held buttons ----------

function down(e: PointerEvent, id: string | undefined) {
  if (!id) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  emit("press", id, true);
}
function up(id: string | undefined) {
  if (id) emit("press", id, false);
}
/** Press and release at once: pulses from the wheel and trackpad (the preview holds a press between frames until the next frame) */
function pulse(id: string) {
  emit("press", id, true);
  emit("press", id, false);
}

// ---------- iPod wheel: drag around → UP / DOWN; tap the four edges → MENU ⏭ ⏯ ⏮ ----------

const WHEEL_STEP = 20; // degrees
let wheel: { cx: number; cy: number; last: number; travel: number; acc: number; zone: string } | null = null;
const angleOf = (e: PointerEvent, cx: number, cy: number) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;

function wheelDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const a = angleOf(e, cx, cy);
  const zone = a >= -135 && a < -45 ? "TRIANGLE" : a >= -45 && a < 45 ? "RIGHT" : a >= 45 && a < 135 ? "START" : "LEFT";
  el.setPointerCapture(e.pointerId);
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

// ---------- BlackBerry trackpad: drag → direction pulses; tap → CIRCLE ----------

const PAD_STEP = 10; // design units
let pad: { x: number; y: number; ax: number; ay: number; moved: boolean } | null = null;
function padDown(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pad = { x: e.clientX, y: e.clientY, ax: 0, ay: 0, moved: false };
}
function padMove(e: PointerEvent) {
  if (!pad || !s.value) return;
  pad.ax += (e.clientX - pad.x) / s.value;
  pad.ay += (e.clientY - pad.y) / s.value;
  pad.x = e.clientX;
  pad.y = e.clientY;
  if (Math.abs(pad.ax) >= PAD_STEP) {
    pulse(pad.ax > 0 ? "RIGHT" : "LEFT");
    pad.ax = 0;
    pad.moved = true;
  }
  if (Math.abs(pad.ay) >= PAD_STEP) {
    pulse(pad.ay > 0 ? "DOWN" : "UP");
    pad.ay = 0;
    pad.moved = true;
  }
}
function padUp() {
  if (pad && !pad.moved) pulse("CIRCLE");
  pad = null;
}

/** BlackBerry keyboard: only space (START) and enter (CIRCLE) are in the portable button contract */
const keyTarget = (k: string) => (props.mode === "ui" ? ({ space: "START", "↵": "CIRCLE" } as Record<string, string>)[k] : undefined);
</script>

<template>
  <div ref="area" class="device-area relative h-full w-full select-none" @contextmenu.prevent>
    <div class="absolute" :style="frameStyle">
      <!-- Shoulder buttons sit behind the body -->
      <button
        v-for="(c, i) in shoulders"
        :key="`sh${i}`"
        type="button"
        class="dev-key dev-shoulder absolute"
        :style="{ ...box(c.x, c.y, c.w, c.h ?? 26), fontSize: u(11), borderRadius: `${u(14)} ${u(14)} ${u(4)} ${u(4)}` }"
        :aria-label="c.label"
        :disabled="!target(c)"
        @pointerdown="down($event, target(c))"
            @mousedown.prevent
        @pointerup="up(target(c))"
        @pointercancel="up(target(c))"
        @lostpointercapture="up(target(c))"
      >
        <span :style="{ marginTop: u(-(((c.h ?? 26) - 12) / 1.6)) }">{{ c.label }}</span>
      </button>

      <!-- Body -->
      <div
        v-for="(b, i) in device.bodies"
        :key="`b${i}`"
        class="absolute"
        :style="{
          ...box(b.x, b.y, b.w, b.h),
          borderRadius: radiusOf(b),
          background: b.background,
          boxShadow: `inset 0 ${u(3)} 0 rgba(255,255,255,0.16), inset 0 ${u(-5)} 0 rgba(0,0,0,0.22), 0 ${u(7)} 0 ${b.lip}, 0 ${u(7)} 0 ${u(3)} #0a0614, 0 ${u(30)} ${u(40)} ${u(-16)} rgba(0,0,0,0.75)`,
        }"
      />

      <!-- Screen glass -->
      <div
        v-if="device.bezel"
        class="absolute"
        :style="{ ...box(device.bezel.x, device.bezel.y, device.bezel.w, device.bezel.h), borderRadius: u(device.bezel.radius), background: '#120c21', boxShadow: `inset 0 0 0 ${u(2)} #0a0614, inset 0 ${u(4)} 0 rgba(0,0,0,0.4)` }"
      />

      <!-- Screen: slot content (iframe or canvas). This element survives device switches -->
      <div
        class="absolute overflow-hidden bg-black"
        :style="{ ...box(device.screen.x, device.screen.y, device.screen.w, device.screen.h), borderRadius: u(device.screen.radius), boxShadow: `0 0 0 ${u(device.bezel ? 1 : 3)} #0a0614` }"
      >
        <slot />
      </div>

      <!-- Remaining controls -->
      <template v-for="(c, i) in others" :key="`${device.id}-${i}`">
        <!-- D-pad -->
        <div v-if="c.kind === 'dpad'" class="absolute" :style="box(c.x - c.size / 2, c.y - c.size / 2, c.size, c.size)" role="group" aria-label="D-pad">
          <span class="dev-key absolute" :style="{ ...box(c.size / 3, c.size / 3, c.size / 3, c.size / 3), borderRadius: '0', boxShadow: 'none' }" aria-hidden="true" />
          <button
            v-for="arm in [
              { id: 'UP', x: 1, y: 0, r: -90 },
              { id: 'DOWN', x: 1, y: 2, r: 90 },
              { id: 'LEFT', x: 0, y: 1, r: 180 },
              { id: 'RIGHT', x: 2, y: 1, r: 0 },
            ]"
            :key="arm.id"
            type="button"
            class="dev-key dev-arm absolute grid place-items-center"
            :style="{ ...box((arm.x * c.size) / 3, (arm.y * c.size) / 3, c.size / 3, c.size / 3), borderRadius: u(5) }"
            :aria-label="arm.id"
            @pointerdown="down($event, arm.id)"
            @mousedown.prevent
            @pointerup="up(arm.id)"
            @pointercancel="up(arm.id)"
            @lostpointercapture="up(arm.id)"
          >
            <svg :width="u(c.size / 9)" :height="u(c.size / 9)" viewBox="0 0 12 12" :style="{ transform: `rotate(${arm.r}deg)` }" aria-hidden="true">
              <path d="M3 1.5 9 6l-6 4.5z" fill="currentColor" />
            </svg>
          </button>
        </div>

        <!-- Buttons -->
        <template v-else-if="c.kind === 'button'">
          <button
            type="button"
            class="dev-key absolute grid place-items-center"
            :class="c.shape === 'round' ? 'rounded-full' : ''"
            :style="{
              ...(c.shape === 'round' ? box(c.x - c.w / 2, c.y - c.w / 2, c.w, c.w) : box(c.x, c.y, c.w, c.h ?? 14)),
              borderRadius: c.shape === 'round' ? '50%' : u((c.h ?? 14) / 2),
              fontSize: u(c.shape === 'round' ? c.w * 0.42 : 14),
              color: c.tint,
            }"
            :aria-label="c.label || c.caption?.text"
            :disabled="!target(c)"
            @pointerdown="down($event, target(c))"
            @mousedown.prevent
            @pointerup="up(target(c))"
            @pointercancel="up(target(c))"
            @lostpointercapture="up(target(c))"
          >
            {{ c.label }}
          </button>
          <span
            v-if="c.caption"
            class="dev-caption absolute whitespace-nowrap"
            :style="{ left: u(c.x + c.caption.dx), top: u(c.y + c.caption.dy), fontSize: u(9.5) }"
            aria-hidden="true"
          >
            {{ c.caption.text }}
          </span>
        </template>

        <!-- iPod click wheel -->
        <div v-else-if="c.kind === 'wheel'" class="absolute" :style="box(c.x - c.d / 2, c.y - c.d / 2, c.d, c.d)">
          <div
            class="dev-wheel absolute inset-0 cursor-grab rounded-full active:cursor-grabbing"
            role="slider"
            aria-label="Click wheel: drag around to scroll, click the edges for MENU, previous, next and play"
            :style="{ boxShadow: `inset 0 ${u(3)} ${u(5)} rgba(0,0,0,0.18), 0 ${u(3)} 0 rgba(0,0,0,0.25)` }"
            @pointerdown="wheelDown"
            @mousedown.prevent
            @pointermove="wheelMove"
            @pointerup="wheelUp"
            @pointercancel="wheelUp"
          >
            <span class="dev-wheel-label absolute left-1/2 -translate-x-1/2" :style="{ top: u(c.d * 0.08), fontSize: u(c.d * 0.075) }">MENU</span>
            <span class="dev-wheel-label absolute top-1/2 -translate-y-1/2" :style="{ left: u(c.d * 0.08), fontSize: u(c.d * 0.09) }">⏮</span>
            <span class="dev-wheel-label absolute top-1/2 -translate-y-1/2" :style="{ right: u(c.d * 0.08), fontSize: u(c.d * 0.09) }">⏭</span>
            <span class="dev-wheel-label absolute left-1/2 -translate-x-1/2" :style="{ bottom: u(c.d * 0.07), fontSize: u(c.d * 0.085) }">⏯</span>
          </div>
          <button
            type="button"
            class="dev-wheel-center absolute rounded-full"
            :style="box(c.d * 0.32, c.d * 0.32, c.d * 0.36, c.d * 0.36)"
            aria-label="Select"
            @pointerdown.stop="down($event, 'CIRCLE')"
            @mousedown.prevent
            @pointerup="up('CIRCLE')"
            @pointercancel="up('CIRCLE')"
            @lostpointercapture="up('CIRCLE')"
          />
        </div>

        <!-- BlackBerry trackpad -->
        <div
          v-else-if="c.kind === 'trackpad'"
          class="dev-trackpad absolute cursor-move"
          role="slider"
          aria-label="Trackpad: drag to move focus, click to press"
          :style="{ ...box(c.x, c.y, c.w, c.h), borderRadius: u(10) }"
          @pointerdown="padDown"
            @mousedown.prevent
          @pointermove="padMove"
          @pointerup="padUp"
          @pointercancel="padUp"
        />

        <!-- BlackBerry keyboard -->
        <div v-else-if="c.kind === 'keyboard'" class="absolute flex flex-col" :style="{ ...box(c.x, c.y, c.w, c.h), gap: u(6) }">
          <div v-for="(row, ri) in c.rows" :key="ri" class="flex flex-1" :style="{ gap: u(4) }">
            <button
              v-for="k in row"
              :key="k"
              type="button"
              class="dev-bbkey grid place-items-center"
              :class="keyTarget(k) ? 'dev-bbkey-live' : ''"
              :style="{ flex: k === 'space' ? 3.4 : 1, borderRadius: u(5), fontSize: u(k.length > 1 ? 9 : 12) }"
              :disabled="!keyTarget(k)"
              :title="keyTarget(k) ? undefined : 'Text input is not part of this preview'"
              @pointerdown="down($event, keyTarget(k))"
            @mousedown.prevent
              @pointerup="up(keyTarget(k))"
              @pointercancel="up(keyTarget(k))"
              @lostpointercapture="up(keyTarget(k))"
            >
              {{ k === "space" ? "" : k }}
            </button>
          </div>
        </div>

        <!-- Parts that produce no input -->
        <div
          v-else-if="c.kind === 'deco'"
          class="absolute grid place-items-center"
          :class="`dev-deco-${c.shape}`"
          :style="{
            ...box(c.x, c.y, c.w, c.h),
            borderRadius: c.shape === 'led' || c.shape === 'nub' || (c.shape === 'home' && c.w === c.h) ? '50%' : u(c.shape === 'screen-off' ? 3 : c.h / 2),
            fontSize: u(c.shape === 'screen-off' ? 13 : 9),
            ...(c.color ? { '--deco': c.color } : {}),
          }"
          :title="c.title"
        >
          <span v-if="c.shape === 'home' && c.w === c.h" class="dev-home-glyph" :style="{ width: u(c.w * 0.32), height: u(c.w * 0.32), borderRadius: u(4) }" />
          <span v-else-if="c.text">{{ c.text }}</span>
          <svg v-else-if="c.shape === 'phone'" :width="u(18)" :height="u(18)" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="var(--deco, currentColor)"
              d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"
            />
          </svg>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.device-area {
  touch-action: none;
}
.dev-key {
  background: linear-gradient(180deg, #3a2e66, #2b2148);
  color: var(--color-ink-2);
  border: 1.5px solid rgba(10, 6, 20, 0.85);
  box-shadow: 0 3px 0 #0a0614, inset 0 1.5px 0 rgba(255, 255, 255, 0.14);
  font-family: var(--font-round);
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}
.dev-key:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: 0 1px 0 #0a0614, inset 0 1.5px 0 rgba(255, 255, 255, 0.1);
  background: linear-gradient(180deg, #2b2148, #241c3d);
}
.dev-key:disabled {
  cursor: default;
  opacity: 0.55;
}
.dev-shoulder {
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, #4a3c7e, #31275a);
}
.dev-arm {
  box-shadow: 0 2px 0 #0a0614;
}
.dev-caption {
  font-family: var(--font-round);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgba(10, 6, 20, 0.62);
}
.dev-wheel {
  background: radial-gradient(circle at 50% 35%, #fbf8fd, #e7e1ee 70%, #d9d1e3);
  touch-action: none;
}
.dev-wheel-label {
  font-family: var(--font-round);
  font-weight: 700;
  color: #9b93a8;
  pointer-events: none;
  line-height: 1;
}
.dev-wheel-center {
  background: radial-gradient(circle at 50% 35%, #fbf8fd, #ebe5f1);
  box-shadow: inset 0 0 0 1.5px rgba(10, 6, 20, 0.12), 0 2px 0 rgba(0, 0, 0, 0.15);
  cursor: pointer;
}
.dev-wheel-center:active {
  background: #e2dbe9;
}
.dev-trackpad {
  background: radial-gradient(circle at 40% 30%, #4a4466, #24203a 70%);
  box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.12), 0 2px 0 #0a0614;
  touch-action: none;
}
.dev-trackpad:active {
  background: radial-gradient(circle at 40% 30%, #3a3456, #1c1830 70%);
}
.dev-bbkey {
  background: linear-gradient(180deg, #34304a, #22202f);
  color: #b9b4c9;
  font-family: var(--font-round);
  font-weight: 600;
  box-shadow: 0 2px 0 #0a0614;
  opacity: 0.75;
  cursor: default;
}
.dev-bbkey-live {
  opacity: 1;
  cursor: pointer;
  box-shadow: 0 2px 0 #0a0614, inset 0 0 0 1.5px rgba(63, 208, 232, 0.45);
}
.dev-bbkey-live:active {
  transform: translateY(1px);
  box-shadow: 0 1px 0 #0a0614, inset 0 0 0 1.5px rgba(63, 208, 232, 0.6);
}
.dev-deco-slot {
  background: var(--deco, #0a0614);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6);
}
.dev-deco-led {
  background: var(--deco, #3fd0e8);
  box-shadow: 0 0 6px var(--deco, #3fd0e8);
}
.dev-deco-home {
  background: linear-gradient(180deg, #2a2440, #15111f);
  box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.16), 0 2px 0 #0a0614;
  color: var(--color-muted);
  font-family: var(--font-round);
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: help;
}
.dev-home-glyph {
  border: 1.5px solid rgba(255, 255, 255, 0.4);
}
.dev-deco-grill {
  background: radial-gradient(circle, rgba(10, 6, 20, 0.55) 30%, transparent 34%) 0 0 / 11px 11px;
}
.dev-deco-nub {
  background: radial-gradient(circle at 50% 40%, #4a4466, #1c1830 70%);
  box-shadow: 0 2px 0 #0a0614, inset 0 0 0 2px rgba(10, 6, 20, 0.8);
  cursor: help;
}
.dev-deco-screen-off {
  background: #0e091a;
  box-shadow: inset 0 0 0 2px #0a0614;
  color: var(--color-dim);
  font-family: var(--font-mono);
  cursor: help;
}
.dev-deco-phone {
  background: linear-gradient(180deg, #34304a, #22202f);
  box-shadow: 0 2px 0 #0a0614;
  color: #b9b4c9;
  font-family: var(--font-round);
  font-weight: 700;
  cursor: help;
}
</style>
