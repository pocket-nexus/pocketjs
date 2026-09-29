// apps/sortie — POCKET SORTIE, a 40-second music video that is itself a
// PocketJS application. It runs at 480x272 on the same runtime as every other
// demo in apps/, and `bun tools/sortie.ts` records it headlessly into an mp4.
//
// The cut list (CUTS below) is 100 beats at 150 BPM — 40.000 s at 60 Hz, the
// same grid ./gen-score.ts writes the soundtrack on. Cuts are scheduled on the
// virtual clock (`after`, framework/src/clock.ts), so the picture is a pure
// function of the frame index on every host: 22 timer callbacks in 2400 frames
// and not one line of per-frame layout code. Everything between two cuts is a
// baked keyframe timeline sampled in the Rust core (./pocket.config.ts).
//
// Type above 54 px cannot come from the font atlas, so the Japanese title cards
// are artwork baked by ./gen-assets.ts; every Latin readout on screen is live
// text through the ordinary atlas path.
//
// Controls: CIRCLE or START replays from the top.

import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { after } from "@pocketjs/framework/clock";
import { createWavPlayer } from "@pocketjs/framework/audio";
import { BEAT_SECONDS, TOTAL_BEATS } from "./timing.ts";

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

/** The field ring, used as a shockwave on hits and as a halo under readouts. */
function Field(props: { class: string }) {
  return <Image debugName="Field" class={props.class} src="at-field.png" />;
}

/** Hazard belt: one 256x64 tile, scrolling exactly one stripe pitch per cycle. */
function Hazard(props: { class: string }) {
  return (
    <View debugName="HazardClip" class={props.class}>
      <Image class="absolute left-0 top-[-24] w-[256] h-[64] animate-sv-belt" src="hazard.png" />
      <Image class="absolute left-[256] top-[-24] w-[256] h-[64] animate-sv-belt" src="hazard.png" />
    </View>
  );
}

/** Corner ticks — the frame the whole MV is composed inside. */
function Reticle() {
  return (
    <>
      <View class="absolute left-[10] top-[10] w-[14] h-[1] bg-[#565d68]" />
      <View class="absolute left-[10] top-[10] w-[1] h-[14] bg-[#565d68]" />
      <View class="absolute right-[10] top-[10] w-[14] h-[1] bg-[#565d68]" />
      <View class="absolute right-[10] top-[10] w-[1] h-[14] bg-[#565d68]" />
      <View class="absolute left-[10] bottom-[10] w-[14] h-[1] bg-[#565d68]" />
      <View class="absolute left-[10] bottom-[10] w-[1] h-[14] bg-[#565d68]" />
      <View class="absolute right-[10] bottom-[10] w-[14] h-[1] bg-[#565d68]" />
      <View class="absolute right-[10] bottom-[10] w-[1] h-[14] bg-[#565d68]" />
    </>
  );
}

/** A Japanese title card: 512x128 artwork, full-bleed, 1:1 texels. */
function Card(props: { src: string; class: string }) {
  return <Image debugName="Card" class={props.class} src={props.src} />;
}

const READOUT_ANIM = [
  "flex-row items-center animate-sv-line-1",
  "flex-row items-center animate-sv-line-2",
  "flex-row items-center animate-sv-line-3",
  "flex-row items-center animate-sv-line-4",
  "flex-row items-center animate-sv-line-5",
  "flex-row items-center animate-sv-line-6",
  "flex-row items-center animate-sv-line-7",
  "flex-row items-center animate-sv-line-8",
];

/** A left-hand HUD column: label, leader dots, value — one line per beat-half. */
function Readouts(props: { class: string; rows: readonly (readonly [string, string])[] }) {
  return (
    <View debugName="Readouts" class={props.class}>
      <For each={props.rows}>
        {(row, i) => (
          <View class={READOUT_ANIM[i()]}>
            <View class="w-[4] h-[4] bg-[#d8232a] mr-[6]" />
            <Text class="text-xs font-mono text-[#7f8891] w-[96]">{row[0]}</Text>
            <Text class="text-xs font-mono text-[#e6e4db]">{row[1]}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Act I — boot and countdown
// ---------------------------------------------------------------------------

const BOOT_ROWS = [
  ["GUEST", "QUICKJS"],
  ["CORE", "RUST"],
  ["LAYOUT", "FLEXBOX / TAFFY"],
  ["RASTER", "SOFTWARE"],
  ["THREADS", "1"],
  ["PROCESSES", "1"],
  ["DOM", "ABSENT"],
  ["WEBVIEW", "ABSENT"],
] as const;

function Boot() {
  return (
    <>
      <Image class="absolute left-[-16] top-[8] w-[512] h-[256] opacity-20" src="grid.png" />
      <View class="absolute left-[24] top-[38] w-[120] h-[1] bg-[#d8232a] origin-left animate-sv-rule" />
      <Text class="absolute left-[24] top-[24] text-xs font-mono text-[#d8232a] tracking-wide animate-sv-quick">
        MAGI / 00 — COLD BOOT
      </Text>
      <Readouts class="absolute left-[24] top-[52] flex-col gap-[6]" rows={BOOT_ROWS} />
      <View class="absolute right-[34] top-[74] w-[96] h-[96] bg-[#3c4652] arc-start-[-90] arc-sweep-[0] arc-width-[3] animate-sv-lock" />
      <View class="absolute right-[50] top-[90] w-[64] h-[64] bg-[#d8232a] arc-start-[0] arc-sweep-[70] arc-width-[2] animate-sv-radar" />
      <Text class="absolute right-[34] bottom-[52] w-[96] text-right text-xs font-mono text-[#7f8891] animate-sv-late">
        T-MINUS 04
      </Text>
      <View class="absolute left-0 top-0 w-full h-[1] bg-[#d8232a] opacity-40 animate-sv-scanline" />
    </>
  );
}

/** 参 / 弐 / 壱 / 零 — one numeral, one shockwave, one beat. */
function Count(props: { src: string; label: string }) {
  return (
    <>
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-55 animate-sv-ping-out" />
      <Image debugName="Numeral" class="absolute left-[112] top-[8] w-[256] h-[256] animate-sv-numeral" src={props.src} />
      <View class="absolute left-[24] top-[40] w-[432] h-[1] bg-[#d8232a] origin-left animate-sv-rule" />
      <View class="absolute left-[24] bottom-[40] w-[432] h-[1] bg-[#d8232a] origin-left animate-sv-rule" />
      <Text class="absolute left-[24] bottom-[52] text-xs font-mono text-[#d8232a] animate-sv-quick">
        {props.label}
      </Text>
    </>
  );
}

/** The zero beat: the numeral, then a cross of light, then the blowout. */
function Zero() {
  return (
    <>
      <Count src="count-0.png" label="T-MINUS 00 — SORTIE" />
      <View class="absolute left-0 top-[133] w-full h-[6] bg-[#f2f0e6] origin-center animate-sv-cross-h" />
      <View class="absolute left-[237] top-0 w-[6] h-full bg-[#f2f0e6] origin-center animate-sv-cross-v" />
      <View class="absolute left-0 top-0 w-full h-full bg-[#f2f0e6] opacity-0 animate-sv-blowout" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Act II — the title, and what the runtime does not contain
// ---------------------------------------------------------------------------

function TitleBoot() {
  return (
    <>
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-14 animate-sv-field" />
      <Card src="title-boot.png" class="absolute left-[-16] top-[66] w-[512] h-[128] animate-sv-card" />
      <View class="absolute left-[120] top-[196] w-[240] h-[2] bg-[#d8232a] origin-left animate-sv-rule-late" />
      <Text class="absolute left-0 top-[46] w-full text-center text-xs font-mono text-[#7f8891] tracking-wide animate-sv-quick">
        SORTIE 00
      </Text>
      <Text class="absolute left-0 top-[206] w-full text-center text-sm font-bold text-[#e6e4db] tracking-wide animate-sv-late">
        POCKETJS — A PORTABLE APPLICATION RUNTIME
      </Text>
    </>
  );
}

/** One negation per half-beat: the claim, inverted against the one before it. */
function Negation(props: { line: string; sub: string; invert?: boolean; alert?: boolean }) {
  return (
    <>
      <Show when={props.invert}>
        <View class="absolute left-0 top-0 w-full h-full bg-[#f2f0e6]" />
      </Show>
      <Show when={props.alert}>
        <View class="absolute left-0 top-0 w-full h-full bg-[#b2151c]" />
      </Show>
      <View class="absolute left-0 top-0 w-full h-full bg-[#f2f0e6] animate-sv-cut-flash" />
      <View class="absolute left-0 top-0 w-full h-full animate-sv-interference">
        <Show
          when={props.invert}
          fallback={
            <Text class="absolute left-0 top-[100] w-full text-center text-5xl font-bold text-[#f2f0e6] animate-sv-quick">
              {props.line}
            </Text>
          }
        >
          <Text class="absolute left-0 top-[100] w-full text-center text-5xl font-bold text-[#0b0b0d] animate-sv-quick">
            {props.line}
          </Text>
        </Show>
        <Show
          when={props.invert}
          fallback={
            <Text class="absolute left-0 top-[168] w-full text-center text-xs font-mono text-[#8f9aa4] animate-sv-mid">
              {props.sub}
            </Text>
          }
        >
          <Text class="absolute left-0 top-[168] w-full text-center text-xs font-mono text-[#4a4f57] animate-sv-mid">
            {props.sub}
          </Text>
        </Show>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Act III — the stack
// ---------------------------------------------------------------------------

const SLAB_ANIM = [
  "absolute left-[40] top-[54] w-[400] h-[36] border-2 border-[#3c4652] bg-[#12151a] animate-sv-slab-1",
  "absolute left-[40] top-[98] w-[400] h-[36] border-2 border-[#3c4652] bg-[#12151a] animate-sv-slab-2",
  "absolute left-[40] top-[142] w-[400] h-[36] border-2 border-[#d8232a] bg-[#1a1113] animate-sv-slab-3",
  "absolute left-[40] top-[186] w-[400] h-[36] border-2 border-[#3c4652] bg-[#12151a] animate-sv-slab-4",
];

const SLABS = [
  ["01", "TSX", "SOLID · VUE VAPOR · OCTANE"],
  ["02", "GUEST", "QUICKJS — ONE ENGINE BUNDLE"],
  ["03", "CORE", "RUST — LAYOUT · RASTER · TEXT"],
  ["04", "OUT", "480 × 272 — EVERY PIXEL"],
] as const;

function Stack() {
  return (
    <>
      <Image class="absolute left-[-16] top-[8] w-[512] h-[256] opacity-20 animate-sv-parallax" src="grid.png" />
      <Text class="absolute left-[40] top-[30] text-xs font-mono text-[#d8232a] tracking-wide animate-sv-quick">
        ONE NATIVE TREE — NO INTERMEDIATE
      </Text>
      <For each={SLABS}>
        {(slab, i) => (
          <View class={SLAB_ANIM[i()]}>
            <View class="absolute left-0 top-0 w-[34] h-full bg-[#d8232a] flex-row justify-center items-center">
              <Text class="text-sm font-bold text-[#0b0b0d]">{slab[0]}</Text>
            </View>
            <Text class="absolute left-[46] top-[8] text-base font-bold text-[#f2f0e6] w-[88]">
              {slab[1]}
            </Text>
            <Text class="absolute left-[140] top-[11] text-xs font-mono text-[#8f9aa4]">
              {slab[2]}
            </Text>
          </View>
        )}
      </For>
      <View class="absolute left-0 top-0 w-full h-[1] bg-[#d8232a] opacity-30 animate-sv-scanline" />
    </>
  );
}

/** A title card with a Latin gloss under it — the MV's basic sentence. */
function Titled(props: { src: string; gloss: string }) {
  return (
    <>
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-14 animate-sv-field" />
      <Card src={props.src} class="absolute left-[-16] top-[60] w-[512] h-[128] animate-sv-card" />
      <View class="absolute left-[140] top-[198] w-[200] h-[1] bg-[#d8232a] origin-left animate-sv-rule-late" />
      <Text class="absolute left-0 top-[208] w-full text-center text-xs font-mono text-[#8f9aa4] tracking-wide animate-sv-late">
        {props.gloss}
      </Text>
    </>
  );
}

// ---------------------------------------------------------------------------
// Act IV — sync
// ---------------------------------------------------------------------------

const PATTERN_ANIM = [
  "flex-row items-center animate-sv-rise-1",
  "flex-row items-center animate-sv-rise-2",
  "flex-row items-center animate-sv-rise-3",
];

const PATTERNS = ["SOLID", "VUE VAPOR", "OCTANE"] as const;

function Sync() {
  return (
    <>
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-16 animate-sv-field" />
      <Text class="absolute left-[30] top-[28] text-xs font-mono text-[#d8232a] tracking-wide animate-sv-quick">
        SYNC RATIO
      </Text>
      <Text class="absolute left-[30] top-[44] text-5xl font-bold text-[#f2f0e6] animate-sv-card">
        60.0
      </Text>
      <Text class="absolute left-[196] top-[82] text-xl font-bold text-[#e8c31a] animate-sv-late">
        FPS
      </Text>
      <View class="absolute left-[30] top-[116] w-[420] h-[10] bg-[#1b2027]" />
      <View class="absolute left-[30] top-[116] w-[420] h-[10] bg-[#e8c31a] origin-left animate-sv-gauge" />
      <Text class="absolute left-[30] top-[134] text-xs font-mono text-[#7f8891] animate-sv-late">
        FIXED dt — THE SAME PIXELS ON EVERY RUN
      </Text>
      <View class="absolute left-[30] top-[168] flex-col gap-[6]">
        <For each={PATTERNS}>
          {(pattern, i) => (
            <View class={PATTERN_ANIM[i()]}>
              <View class="w-[4] h-[4] bg-[#e8c31a] mr-[6]" />
              <Text class="text-xs font-mono text-[#7f8891] w-[76]">PATTERN</Text>
              <Text class="text-xs font-mono text-[#f2f0e6]">{pattern}</Text>
            </View>
          )}
        </For>
      </View>
      <View class="absolute right-[34] top-[150] w-[80] h-[80] bg-[#3c4652] arc-start-[-90] arc-sweep-[0] arc-width-[3] animate-sv-lock" />
      <View class="absolute left-0 top-0 w-full h-[1] bg-[#e8c31a] opacity-30 animate-sv-scanline" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Act V — the fleet
// ---------------------------------------------------------------------------

function Alert() {
  return (
    <>
      <View class="absolute left-0 top-0 w-full h-full bg-[#2a0d10]" />
      <View class="absolute left-0 top-0 w-full h-full bg-[#b2151c] animate-sv-alarm" />
      <Hazard class="absolute left-0 top-[30] w-full h-[16] overflow-hidden" />
      <Hazard class="absolute left-0 bottom-[30] w-full h-[16] overflow-hidden" />
      <Card src="title-alert.png" class="absolute left-[-16] top-[72] w-[512] h-[128] animate-sv-card" />
      <Text class="absolute left-0 bottom-[62] w-full text-center text-xs font-mono text-[#f2f0e6] animate-sv-warn">
        ALL UNITS — STAND BY
      </Text>
    </>
  );
}

/** The verified-hardware roll call, one machine per beat. */
const FLEET = [
  ["SONY PSP", "2004", "MIPS · 32 MB"],
  ["PS VITA", "2011", "ARM · GXM"],
  ["iPHONE", "2007", "ARMv6 · GL ES 1.1"],
  ["iPHONE 4S", "2011", "ARMv7"],
  ["iPOD TOUCH 6", "2015", "arm64"],
  ["NOKIA E7", "2011", "SYMBIAN · QT"],
  ["MEIZU M8", "2009", "WINDOWS CE 6"],
  ["BLACKBERRY CLASSIC", "2014", "QNX · NATIVE ELF"],
  ["POCKETBOOK", "E-INK", "INKVIEW · PARTIAL REFRESH"],
  ["ESP32-P4", "DEVKIT", "PPA · RGB565"],
  ["MAC", "APPLE SILICON", "METAL"],
  ["THE BROWSER", "WASM", "ONE CORE, COMPILED"],
] as const;

function Unit(props: { index: number }) {
  const unit = () => FLEET[props.index];
  const ordinal = () => `${String(props.index + 1).padStart(2, "0")} / 12`;
  return (
    <>
      <Image class="absolute left-[-16] top-[8] w-[512] h-[256] opacity-20" src="grid.png" />
      <View class="absolute left-0 top-0 w-full h-full bg-[#f2f0e6] animate-sv-unit-flash" />
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-45 animate-sv-ping-out" />
      <Text class="absolute left-0 top-[96] w-full text-center text-4xl font-bold text-[#f2f0e6] animate-sv-quick">
        {unit()[0]}
      </Text>
      <View class="absolute left-[120] top-[142] w-[240] h-[1] bg-[#d8232a] origin-left animate-sv-rule" />
      <Text class="absolute left-0 top-[152] w-full text-center text-sm font-bold text-[#d8232a] tracking-wide animate-sv-quick">
        {unit()[1]}
      </Text>
      <Text class="absolute left-0 top-[176] w-full text-center text-xs font-mono text-[#8f9aa4] animate-sv-mid">
        {unit()[2]}
      </Text>
      <Text class="absolute left-[24] bottom-[44] text-xs font-mono text-[#7f8891] animate-sv-quick">
        {ordinal()}
      </Text>
      <Text class="absolute right-[24] bottom-[44] text-xs font-mono text-[#7f8891] animate-sv-quick">
        BOOTED ON THE REAL MACHINE
      </Text>
    </>
  );
}

// ---------------------------------------------------------------------------
// Act VI — end card
// ---------------------------------------------------------------------------

function End() {
  return (
    <>
      <Field class="absolute left-[112] top-[8] w-[256] h-[256] opacity-14 animate-sv-field" />
      <Text class="absolute left-0 top-[78] w-full text-center text-5xl font-bold text-[#f2f0e6] animate-sv-card">
        POCKETJS
      </Text>
      <View class="absolute left-[120] top-[142] w-[240] h-[2] bg-[#d8232a] origin-left animate-sv-rule-late" />
      <Text class="absolute left-0 top-[154] w-full text-center text-base font-bold text-[#e6e4db] tracking-wide animate-sv-late">
        pocketjs.dev
      </Text>
      <Text class="absolute left-0 top-[186] w-full text-center text-xs font-mono text-[#8f9aa4] animate-sv-late">
        TYPESCRIPT SOURCES · QUICKJS GUEST · RUST CORE · MIT
      </Text>
      <View class="absolute left-0 top-0 w-full h-[1] bg-[#d8232a] opacity-30 animate-sv-scanline" />
    </>
  );
}

// ---------------------------------------------------------------------------
// The cut list — 100 beats at 150 BPM = 40.000 s
// ---------------------------------------------------------------------------

interface Cut {
  /** Length in beats; 1 beat = 24 frames at 60 Hz. */
  beats: number;
  /** Bottom-strip caption for this cut — the MV's own slug line. */
  slug: string;
  view: () => JSX.Element;
}

const CUTS: readonly Cut[] = [
  { beats: 10, slug: "COLD BOOT", view: () => <Boot /> },
  { beats: 2, slug: "T-MINUS 03", view: () => <Count src="count-3.png" label="T-MINUS 03" /> },
  { beats: 2, slug: "T-MINUS 02", view: () => <Count src="count-2.png" label="T-MINUS 02" /> },
  { beats: 2, slug: "T-MINUS 01", view: () => <Count src="count-1.png" label="T-MINUS 01" /> },
  { beats: 2, slug: "SORTIE", view: () => <Zero /> },
  { beats: 8, slug: "KIDOU — BOOT", view: () => <TitleBoot /> },
  {
    beats: 2,
    slug: "NO DOM",
    view: () => <Negation line="NO DOM" sub="THERE IS NO DOCUMENT TO MUTATE" />,
  },
  {
    beats: 2,
    slug: "NO CSS ENGINE",
    view: () => <Negation invert line="NO CSS" sub="CLASSES ARE RESOLVED AT BUILD TIME" />,
  },
  {
    beats: 2,
    slug: "NO WEBVIEW",
    view: () => <Negation line="NO WEBVIEW" sub="THE CORE DRAWS EVERY PIXEL ITSELF" />,
  },
  {
    beats: 2,
    slug: "NO VIRTUAL DOM",
    view: () => <Negation invert line="NO VDOM" sub="COMPONENTS COMPILE TO NATIVE OPS" />,
  },
  {
    beats: 2,
    slug: "NO PER-FRAME JS",
    view: () => <Negation alert line="NO TIMERS" sub="THE CORE OWNS EVERY TWEENED FRAME" />,
  },
  {
    beats: 4,
    slug: "DOM — ABSENT",
    view: () => <Titled src="title-nodom.png" gloss="NO DOM · NO CSS ENGINE · NO WEBVIEW" />,
  },
  { beats: 8, slug: "THE STACK", view: () => <Stack /> },
  {
    beats: 4,
    slug: "THE RUST CORE",
    view: () => <Titled src="title-core.png" gloss="THE CORE IS RUST — LAYOUT, RASTER, TEXT" />,
  },
  {
    beats: 4,
    slug: "ONE THREAD",
    view: () => <Titled src="title-thread.png" gloss="ONE THREAD · ONE PROCESS" />,
  },
  { beats: 8, slug: "SYNC RATIO", view: () => <Sync /> },
  {
    beats: 6,
    slug: "SYNC RATIO 60",
    view: () => <Titled src="title-sync.png" gloss="SIXTY FRAMES, DETERMINISTIC" />,
  },
  { beats: 2, slug: "WARNING", view: () => <Alert /> },
  ...FLEET.map((unit, index) => ({
    beats: 1,
    slug: unit[0],
    view: () => <Unit index={index} />,
  })),
  {
    beats: 4,
    slug: "ALL UNITS LAUNCH",
    view: () => <Titled src="title-launch.png" gloss="ALL UNITS — LAUNCH" />,
  },
  { beats: 8, slug: "POCKETJS", view: () => <End /> },
  {
    beats: 4,
    slug: "TO BE CONTINUED",
    view: () => <Titled src="title-end.png" gloss="TO BE CONTINUED" />,
  },
];

const BEATS = CUTS.reduce((total, cut) => total + cut.beats, 0);
if (BEATS !== TOTAL_BEATS) {
  throw new Error(`sortie: cut list is ${BEATS} beats, ./timing.ts declares ${TOTAL_BEATS}`);
}

/** Cut start times in seconds — also the bottom strip's timecode. */
const STARTS: number[] = CUTS.map(
  (() => {
    let elapsed = 0;
    return (cut: Cut) => {
      const start = elapsed;
      elapsed += cut.beats * BEAT_SECONDS;
      return start;
    };
  })(),
);

// ---------------------------------------------------------------------------

export default function Sortie() {
  const [cut, setCut] = createSignal(0);
  let cancels: Array<() => void> = [];

  // One virtual-clock deadline per cut, scheduled once. No frame counter, no
  // polling: between two cuts the guest does nothing at all.
  const run = () => {
    for (const cancel of cancels) cancel();
    cancels = CUTS.slice(1).map((_, i) => after(STARTS[i + 1], () => setCut(i + 1)));
    setCut(0);
  };

  // The soundtrack rides the same clock on hosts that mount the audio module
  // (contracts/spec/audio.ts); headless recording and the goldens see none of
  // it and render byte-identically either way.
  const player = createWavPlayer();
  player.load("sortie");
  player.play();
  onFrame(() => player.pump());

  onButtonPress(BTN.CIRCLE | BTN.START, () => {
    player.load("sortie");
    player.play();
    run();
  });
  onCleanup(() => {
    for (const cancel of cancels) cancel();
  });
  run();

  const scene = () => CUTS[cut()];
  const timecode = () => `T+${STARTS[cut()].toFixed(1).padStart(4, "0")}`;

  return (
    <View debugName="Sortie" class="w-full h-full bg-[#0b0b0d]">
      <Show when={scene()} keyed>
        {(current) => current.view()}
      </Show>
      <Reticle />
      <View class="absolute left-0 bottom-[5] w-full flex-row justify-between px-[24]">
        <Text class="text-xs font-mono text-[#565d68]">POCKET//SORTIE</Text>
        <Text class="text-xs font-mono text-[#565d68]">{scene().slug}</Text>
        <Text class="text-xs font-mono text-[#565d68]">{timecode()}</Text>
      </View>
    </View>
  );
}
