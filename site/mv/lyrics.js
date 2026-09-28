// site/mv/lyrics.js — the words, on the same bar grid as score.js.
//
// Original lyric for the PocketJS film. `bar` is the downbeat the line lands
// on and `bars` is how long it stays up, so retiming the song retimes the
// words. `slam` lines are the chorus: set large, centred, hit on the beat.
// `code` lines are set in the mono face, the way the app source is.

export const TITLE_JA = "ポケットに空を";
export const TITLE_EN = "A Sky in Your Pocket";

export const LYRICS = [
  // Verse 1 — what everyone says about the small screen.
  { bar: 8, bars: 2, ja: "ちいさな画面は もう終わりだって", en: "They said the small screen was finished" },
  { bar: 10, bars: 2, ja: "誰かが言った 夜の隅で", en: "someone said it, in a corner of the night" },
  { bar: 12, bars: 2, ja: "それでも指は 覚えてる", en: "and still my thumbs remember" },
  { bar: 14, bars: 2, ja: "あの重さと あの光を", en: "that weight, and that light" },

  // Verse 2 — what is actually running on it.
  { bar: 16, bars: 2, ja: "十三万画素の 星空へ", en: "Into a sky of a hundred and thirty thousand pixels" },
  { bar: 18, bars: 2, ja: "書いたコードが 息をする", en: "the code I wrote starts breathing" },
  { bar: 20, bars: 2, ja: "DOMもない CSSもない", en: "No DOM. No CSS.", code: true },
  { bar: 22, bars: 2, ja: "ひとつの糸で 描き切る", en: "One thread draws every pixel of it" },

  // Pre-chorus — the old machine, powered on.
  { bar: 24, bars: 2, ja: "捨てられた機械の 電源を入れて", en: "Power on the machine they threw away" },
  { bar: 26, bars: 2, ja: "まだ動くよって 笑ってみせる", en: "and grin — it still runs" },
  { bar: 28, bars: 2, ja: "一秒に六十回 世界が", en: "Sixty times a second, a world" },
  { bar: 30, bars: 2, ja: "ひらいていく", en: "opens up" },

  // Chorus.
  { bar: 32, bars: 2, ja: "ポケットに空を入れて", en: "Put a sky in your pocket", slam: true },
  { bar: 34, bars: 2, ja: "どこまでも持っていける", en: "and carry it anywhere", slam: true },
  { bar: 36, bars: 2, ja: "手のひらの中の宇宙は", en: "The universe in your palm", slam: true },
  { bar: 38, bars: 2, ja: "誰にも小さくない", en: "is small to nobody", slam: true },
  { bar: 40, bars: 2, ja: "好きだと言えばいい", en: "Just say that you love it", slam: true },
  { bar: 42, bars: 2, ja: "古い画面の前で", en: "in front of an old screen", slam: true },
  { bar: 44, bars: 2, ja: "まだ描けるよ ここから", en: "We can still draw. From here.", slam: true },
  { bar: 46, bars: 2, ja: "瑠璃色の夜に", en: "on a night the colour of lapis", slam: true },

  // Outro.
  { bar: 48, bars: 2, ja: "ちいさな画面の中に", en: "Inside the small screen" },
  { bar: 50, bars: 2, ja: "ぜんぶ、ある", en: "everything is here" },
];

/** The line on screen at bar `b`, or null. */
export function lyricAt(b) {
  for (const l of LYRICS) if (b >= l.bar && b < l.bar + l.bars) return l;
  return null;
}

// Source that scrolls in the verse. Real PocketJS: Solid primitives from
// solid-js, runtime and host components from @pocketjs/framework.
export const SOURCE = [
  'import { createSignal } from "solid-js";',
  'import { mount } from "@pocketjs/framework/solid";',
  'import { Text, View } from "@pocketjs/framework/solid/components";',
  "",
  "function Sky() {",
  "  const [pixels, lit] = createSignal(0);",
  "  useFrame(() => lit(pixels() + 1));",
  "  return (",
  '    <View class="flex-1 items-center justify-center">',
  '      <Text class="text-2xl">{pixels()}</Text>',
  "    </View>",
  "  );",
  "}",
  "",
  "mount(Sky);",
];

// The claims the film makes, one per chorus cut, each of them a fact about the
// runtime rather than a slogan.
export const FACTS = [
  "one thread",
  "one process",
  "no DOM",
  "no CSS engine",
  "no WebView",
  "QuickJS guest",
  "Rust core",
  "flexbox layout",
  "60 FPS",
  "Solid · Vue Vapor · Octane",
];

export const DEVICES = [
  "PSP", "PS VITA", "GBA", "NDS", "3DS", "iPOD TOUCH", "iPHONE 2G",
  "SYMBIAN", "ESP32", "PLAYDATE", "NES", "POCKETBOOK", "MEIZU M8", "BLACKBERRY",
];
