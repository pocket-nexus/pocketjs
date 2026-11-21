// Playground presets: MicroTS apps for Vue and Solid, and Pocket Retro games.
// Each preset's sources are a separate chunk, loaded when the preset opens.
import retroCatalog from "microts:retro-catalog";
import retroSources from "microts:retro-sources";
import { COMMIT } from "microts:build";
import { GITHUB_POCKETJS, GITHUB_RETRO } from "../site";

export type PresetKind = "ui" | "retro";
export type PresetFramework = "vue-vapor" | "solid" | "retro";

export interface Preset {
  id: string;
  kind: PresetKind;
  framework: PresetFramework;
  title: string;
  blurb: string;
  /** The file shown when the preset opens */
  open: string;
  /** The compile entry (game.ts for retro) */
  entry: string;
  /** Editor tab order */
  order: string[];
  load: () => Promise<Record<string, string>>;
  viewport?: { width: number; height: number };
  poster?: string;
  controls: string;
  source: { label: string; href: string };
  credit?: string;
  tags: string[];
}

type Files = Promise<{ default: Record<string, string> }>;
const loader = (load: () => Files) => () => load().then((m) => m.default);

const UI_CONTROLS = "Arrows move focus · Z or Enter presses";
const PSP = { width: 480, height: 272 };
const pocketjsAt = (path: string) => `${GITHUB_POCKETJS}/tree/${COMMIT.slice(0, 12)}/${path}`;

const UI_PRESETS: Preset[] = [
  {
    id: "counter-vue",
    kind: "ui",
    framework: "vue-vapor",
    title: "Counter · Vue",
    blurb: "The counter from the MicroTS guide: one ref<i32>, one template, one press handler.",
    open: "Counter.vue",
    entry: "main.ts",
    order: ["Counter.vue", "Counter.ts", "main.ts"],
    load: loader(() => import("microts:files/starter/counter-vue")),
    viewport: PSP,
    controls: UI_CONTROLS,
    source: { label: "docs/microts", href: "/docs/microts#2-create-a-counter" },
    tags: ["Vue SFC", "Rust mode"],
  },
  {
    id: "counter-solid",
    kind: "ui",
    framework: "solid",
    title: "Counter · Solid",
    blurb: "The same counter as a Solid TSX view over a createSignal<i32> model.",
    open: "Counter.tsx",
    entry: "main.tsx",
    order: ["Counter.tsx", "Counter.ts", "main.tsx"],
    load: loader(() => import("microts:files/starter/counter-solid")),
    viewport: PSP,
    controls: UI_CONTROLS,
    source: { label: "docs/microts-solid", href: "/docs/microts-solid#files-and-ownership" },
    tags: ["Solid TSX"],
  },
  {
    id: "vue-sfc-lab",
    kind: "ui",
    framework: "vue-vapor",
    title: "Vue SFC Feature Lab",
    blurb: "defineModel, v-if chains, template fragments, named and scoped slots, a generic component and provide/inject.",
    open: "app.vue",
    entry: "main.ts",
    order: ["app.vue", "app.ts", "ModelButton.vue", "FeatureCard.vue", "FeatureList.vue", "FeatureToggle.vue", "FeatureToggle.ts", "main.ts"],
    load: loader(() => import("microts:files/example/vue-sfc-lab")),
    viewport: PSP,
    controls: UI_CONTROLS + " · X resets the value",
    source: { label: "apps/vue-sfc-lab", href: pocketjsAt("apps/vue-sfc-lab") },
    tags: ["Vue SFC", "multi-file"],
  },
  {
    id: "solid-aot-lab",
    kind: "ui",
    framework: "solid",
    title: "Solid AOT Feature Lab",
    blurb: "Props and callbacks, Switch/Match/Show, keyed For rows with instance state, slots and context.",
    open: "app.tsx",
    entry: "main.tsx",
    order: ["app.tsx", "app.ts", "ModelButton.tsx", "FeatureCard.tsx", "FeatureList.tsx", "FeatureToggle.tsx", "FeatureToggle.ts", "main.tsx"],
    load: loader(() => import("microts:files/example/solid-aot-lab")),
    viewport: PSP,
    controls: UI_CONTROLS + " · X resets the value",
    source: { label: "apps/solid-aot-lab", href: pocketjsAt("apps/solid-aot-lab") },
    tags: ["Solid TSX", "compiled model", "multi-file"],
  },
];

const RETRO_PRESETS: Preset[] = retroCatalog.games.map((g) => ({
  id: `retro-${g.id.replace(/_/g, "-")}`,
  kind: "retro" as const,
  framework: "retro" as const,
  title: g.title,
  blurb: g.blurb,
  open: "game.ts",
  entry: "game.ts",
  order: ["game.ts"],
  load: loader(retroSources[g.id]!),
  viewport: { width: g.width, height: g.height },
  poster: `/retro/${g.id}/poster.png`,
  controls: g.controls,
  source: { label: `pocket-retro/games/${g.id}`, href: `${GITHUB_RETRO}/blob/${retroCatalog.commit.slice(0, 12)}/games/${g.id}/game.ts` },
  credit: g.author,
  tags: [`${g.width}×${g.height}`, `${g.fps} fps`],
}));

export const PRESETS: Preset[] = [...UI_PRESETS, ...RETRO_PRESETS];
export const DEFAULT_PRESET = "counter-vue";

export function findPreset(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The /retro/<id>/ asset directory of a retro preset */
export function retroAssetId(preset: Preset): string {
  return preset.id.replace(/^retro-/, "").replace(/-/g, "_");
}

export const PRESET_GROUPS = [
  { title: "MicroTS apps", hue: "hue-cyan", items: UI_PRESETS },
  { title: "Pocket Retro games", hue: "hue-pink", items: RETRO_PRESETS },
];
