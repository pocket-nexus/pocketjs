<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef } from "vue";
import CodeTabs from "../components/CodeTabs.vue";
import SectionHead from "../components/SectionHead.vue";
import counterSolid from "../../content/home/counter-solid.md?tabs";
import counterVue from "../../content/home/counter-vue.md?tabs";
import counterRust from "../../content/home/counter-rust.md?tabs";
import startTabs from "../../content/home/start.md?tabs";
import { DOC_ITEMS } from "../docs/nav";
import retroCatalog from "microts:retro-catalog";
import retroCode from "microts:retro-code";
import { GITHUB_MICROTS, GITHUB_RETRO, ICON_RETRO } from "../site";

document.title = "MicroTS · TypeScript compiled ahead of time to native code";

// The hero handheld cycles through these retro game screenshots; the Made with
// MicroTS grid shows the same games, and picking one loads its code panel.
const showcase = ["mega_wing", "platformer", "daylight", "cursed_caverns", "jump", "laser_jetman"];
const games = retroCatalog.games;
const shown = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => (shown.value = (shown.value + 1) % showcase.length), 2600);
  void load(picked.value);
});
onBeforeUnmount(() => clearInterval(timer));
const gameById = (id: string) => games.find((g) => g.id === id)!;
const presetId = (id: string) => `retro-${id.replace(/_/g, "-")}`;

type Tabs = { title: string; html: string }[];

// One source: the counter in each front end, view file first, then the Rust program that runs either
// one. Both generate the same gen/counter.rs; the view and model files are the playground starters.
const frameworks = [
  { title: "Solid", color: "#4f88c6", preset: "counter-solid", tabs: [...counterSolid, ...counterRust] },
  { title: "Vue", color: "#42b883", preset: "counter-vue", tabs: [...counterVue, ...counterRust] },
];
const framework = ref(0);
const current = computed(() => frameworks[framework.value]!);
const oneSourceLede =
  'Write a screen as a <a class="olink" href="https://www.solidjs.com" target="_blank" rel="noreferrer">Solid</a> TSX view ' +
  'or a <a class="olink" href="https://vuejs.org" target="_blank" rel="noreferrer">Vue</a> single-file component, ' +
  "with its state and actions typed in a TypeScript module. Both front ends produce the same View IR: " +
  "<b>the Solid and Vue counters generate the same <code>gen/counter.rs</code> and run on the same Rust model.</b> " +
  "Either source runs in a browser, in QuickJS on a device, or as native Rust.";

// Three build paths for the same source
const buildPaths = [
  { k: "Browser preview", hue: "hue-cyan", v: "Edit the view and run it in a browser on the PocketJS web host. The playground on this site runs this build." },
  { k: "QuickJS guest", hue: "hue-lilac", v: "Bundle the same source as JavaScript for a device that runs the QuickJS engine." },
  { k: "Native AOT", hue: "hue-pink", v: "Compile the view to Rust and build it with Cargo, together with your model. The app ships without a JavaScript engine." },
];

// The hero's three facts, colored with the mark's hues
const proof = [
  { dt: "Vue SFC · Solid TSX", dd: "Two front ends, one View IR", color: "var(--color-cyan)" },
  { dt: "Rust", dd: "View and model compiled ahead of time", color: "var(--color-lilac)" },
  { dt: "No JavaScript engine", dd: "in the native app", color: "var(--color-pink)" },
];

const picked = ref(showcase[0]!);
const code = reactive<Record<string, Tabs>>({});
// The panel keeps the last loaded game on screen until the picked one arrives.
const lastShown = ref<Tabs>([{ title: "game.ts", html: "" }]);
const pickedTabs = computed(() => code[picked.value] ?? lastShown.value);
// A failed chunk load leaves the game unloaded, so the next hover or pick retries it.
async function load(id: string) {
  if (code[id]) return;
  try {
    const tabs = (await retroCode[id]!()).default;
    code[id] = tabs;
    if (id === picked.value) lastShown.value = tabs;
  } catch (e) {
    console.error(`MicroTS home: could not load the code for ${id}`, e);
  }
}
const codePanel = useTemplateRef<HTMLElement>("codePanel");
function pick(id: string) {
  picked.value = id;
  if (code[id]) lastShown.value = code[id];
  else void load(id);
  // Below the lg breakpoint the panel sits under the grid
  if (!matchMedia("(min-width: 64rem)").matches) {
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    codePanel.value?.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
  }
}

const pipeline = [
  { n: "01", title: "Write", body: "Write Vue templates with <code>v-if</code>, <code>v-for</code> and <code>@press</code>, or Solid TSX with <code>&lt;Show&gt;</code> and <code>&lt;For&gt;</code>." },
  { n: "02", title: "Type", body: "Type state with <code>i32</code>, <code>f32</code>, <code>string</code>, arrays and interfaces. <code>ref&lt;i32&gt;(0)</code> becomes a Rust <code>i32</code>." },
  { n: "03", title: "Check", body: "Run <code>check</code> to find syntax outside the supported subset, reported with its source location." },
  { n: "04", title: "Generate", body: "Run <code>build</code> to write the view to <code>gen/*.rs</code> and the styles to <code>gen/styles.bin</code>." },
  { n: "05", title: "Cargo", body: "Build the generated view with your model and the <code>microts</code> crate. Your host supplies input, fonts and presentation." },
];

const stepHues = ["hue-cyan", "hue-lilac", "hue-pink", "hue-yellow", "hue-cyan"];

// A row without a Vue form is written the same way in both front ends.
const bindings: { solid: string; vue?: string; rust: string }[] = [
  { solid: "<View> and <Text>", rust: "Create nodes with ui.create_node(...) and attach them with ui.insert_before(...)" },
  { solid: 'class="p-4 ..."', rust: "Use a compiled style table entry through ui.set_style(...)" },
  { solid: "{count()}", vue: "{{ count }}", rust: "Read vm.count(); format the text when the value changes and send it through ui.set_text(...)" },
  { solid: "onPress={() => setCount(count() + 1)}", vue: '@press="count++"', rust: "On a matching press, call vm.set_count(vm.count().wrapping_add(1i32))" },
  { solid: "<Show> and <For>", vue: "v-if and v-for", rust: "Choose mounted branches and reconcile list rows by key" },
];
</script>

<template>
  <div>
    <!-- ================= hero ================= -->
    <section class="relative pt-[110px] max-[640px]:pt-16">
      <div class="glow" aria-hidden="true" />
      <div class="wrap relative grid items-center gap-14 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <span class="kick">PocketJS · ahead-of-time mode</span>
            <span class="tag hue-yellow">In development</span>
          </div>
          <h1 class="h-hero mt-6">
            <span class="block">TypeScript</span>
            <span class="grad block pb-[0.08em]">to native code.</span>
          </h1>
          <p class="intro mt-7 !max-w-[600px] !text-[20px] max-[640px]:!text-[17.5px]">
            MicroTS compiles Vue single-file components, Solid TSX views and TypeScript models into Rust.
            <b>The native app runs its view and model without a JavaScript engine.</b>
          </p>
          <div class="mt-9 flex flex-wrap gap-3">
            <RouterLink to="/playground" class="btn btn-pri">Open the playground</RouterLink>
            <RouterLink to="/docs/microts" class="btn">Read the guide</RouterLink>
            <a :href="GITHUB_MICROTS" target="_blank" rel="noopener" class="btn">GitHub</a>
          </div>
        </div>

        <!-- Cycles Pocket Retro screenshots -->
        <figure class="frame mx-auto w-full max-w-[460px]" aria-label="Pocket Retro game screenshots">
          <div class="relative bg-black" style="aspect-ratio: 4 / 3">
            <img
              v-for="(id, i) in showcase"
              :key="id"
              :src="`/retro/${id}/poster.png`"
              :alt="gameById(id).title"
              :aria-hidden="i !== shown"
              class="absolute inset-0 h-full w-full object-contain [image-rendering:pixelated] transition-opacity duration-300"
              :class="i === shown ? 'opacity-100' : 'opacity-0'"
            />
          </div>
          <figcaption class="flex items-center justify-between gap-4 border-t border-line px-5 py-4">
            <div class="min-w-0">
              <div class="kick !text-[11px]">Pocket Retro</div>
              <div class="h-card mt-1.5 truncate !text-[17px]">{{ gameById(showcase[shown]!).title }}</div>
              <div class="truncate text-[13px] text-ink-2">
                {{ gameById(showcase[shown]!).width }}×{{ gameById(showcase[shown]!).height }} · by {{ gameById(showcase[shown]!).author }}
              </div>
            </div>
            <span class="flex flex-none items-center gap-1.5" aria-hidden="true">
              <i v-for="(id, i) in showcase" :key="id" class="block h-1.5 rounded-full transition-all" :class="i === shown ? 'w-4 bg-ink' : 'w-1.5 bg-line-2'" />
            </span>
          </figcaption>
        </figure>
      </div>
      <div class="wrap relative">
        <dl class="mt-16 grid rounded-[20px] bg-[rgba(23,21,31,0.7)] shadow-[0_0_0_1px_var(--color-line)] md:grid-cols-3">
          <div v-for="(p, i) in proof" :key="p.dt" class="px-6 py-5" :class="i > 0 && 'border-line max-md:border-t md:border-l'">
            <dt class="font-disp text-[22px] leading-tight font-bold tracking-[-0.02em]" :style="{ color: p.color }">{{ p.dt }}</dt>
            <dd class="mt-1 text-[14.5px] text-ink-2">{{ p.dd }}</dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- ================= one source ================= -->
    <section class="pt-[136px] max-[640px]:pt-24">
      <div class="wrap">
        <SectionHead kick="One source" title="Solid or Vue. The same Rust." :lede="oneSourceLede" />
        <div class="grid items-start gap-[18px] lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <CodeTabs :tabs="current.tabs">
            <template #head>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-bg-2 p-2.5">
                <div class="flex gap-1" role="tablist" aria-label="Framework">
                  <button
                    v-for="(f, i) in frameworks"
                    :key="f.title"
                    type="button"
                    role="tab"
                    :aria-selected="framework === i"
                    class="codetab codetab-fw"
                    @click="framework = i"
                  >
                    <i :style="{ background: f.color }" />{{ f.title }}
                  </button>
                </div>
                <RouterLink :to="`/playground/${current.preset}`" class="arrow-link ml-auto px-2"> Edit the {{ current.title }} counter in the playground → </RouterLink>
              </div>
            </template>
          </CodeTabs>
          <div class="grid gap-[18px]">
            <div v-for="row in buildPaths" :key="row.k" class="card px-6 pt-5 pb-6" :class="row.hue">
              <div class="flex items-center gap-2.5">
                <i class="size-2 flex-none rounded-full bg-[var(--hue)]" aria-hidden="true" />
                <h3 class="h-card !text-[18px]">{{ row.k }}</h3>
              </div>
              <p class="mt-2 text-[15px] leading-relaxed text-ink-2">{{ row.v }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ================= compile ================= -->
    <section class="pt-[136px] max-[640px]:pt-24">
      <div class="wrap">
        <SectionHead
          kick="How it compiles"
          title="TypeScript in. Rust and a style table out."
          lede="The MicroTS compiler turns each component into Rust source and a compiled style table, and Cargo builds them into your native app. <b>You edit the TypeScript; the compiler maintains <code>gen/</code>.</b>"
        />
        <ol class="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-5">
          <li v-for="(step, i) in pipeline" :key="step.n" class="card px-6 pt-6 pb-7" :class="stepHues[i]">
            <span class="num">{{ step.n }}</span>
            <h3 class="h-card mt-5">{{ step.title }}</h3>
            <p class="inline-code mt-2.5 text-[14.5px] leading-relaxed text-ink-2" v-html="step.body" />
          </li>
        </ol>
        <div class="card mt-[18px] overflow-hidden">
          <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-6 pt-5 pb-4">
            <h3 class="h-card">Follow one binding</h3>
            <span class="font-mono text-[12.5px] text-muted">Counter.tsx · Counter.vue → gen/counter.rs</span>
          </div>
          <div class="overflow-x-auto px-4 pt-2 pb-4">
            <table class="w-full min-w-[760px] border-separate border-spacing-x-1.5 border-spacing-y-1.5 text-left text-[14.5px]">
              <thead>
                <tr class="text-[13px] text-muted">
                  <th class="px-3 py-1.5 font-semibold">Solid TSX</th>
                  <th class="px-3 py-1.5 font-semibold">Vue template</th>
                  <th class="px-3 py-1.5 font-semibold">Generated Rust behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in bindings" :key="b.solid">
                  <td :colspan="b.vue ? 1 : 2" class="screen !rounded-[10px] px-3 py-2.5 align-top font-mono text-[13px] whitespace-nowrap text-cyan-l">{{ b.solid }}</td>
                  <td v-if="b.vue" class="screen !rounded-[10px] px-3 py-2.5 align-top font-mono text-[13px] whitespace-nowrap text-cyan-l">{{ b.vue }}</td>
                  <td class="px-3 py-2.5 text-ink-2">{{ b.rust }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <!-- ================= model ================= -->
    <section class="pt-[136px] max-[640px]:pt-24">
      <div class="wrap">
        <SectionHead
          kick="Pick a model"
          title="Rust by hand, or TypeScript compiled."
          lede="Write the app logic in Rust, or write it in TypeScript and compile it to Rust as well. <code>app.model</code> in <code>pocket.host.config.ts</code> selects the mode; the view stays the same."
        />
        <div class="grid gap-[18px] md:grid-cols-2">
          <div class="card card-top hue-lilac px-7 pt-7 pb-8 max-[640px]:px-6">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="tag">"rust" · default</span>
              <span class="font-mono text-[12.5px] text-muted">src/lib.rs</span>
            </div>
            <h3 class="h-sub mt-5">Handwritten Rust model</h3>
            <p class="inline-code mt-3 text-[16px] leading-relaxed text-ink-2">
              Implement the generated trait's methods and computed getters in Rust. The <code>.ts</code> module runs the browser preview, and its types define
              the native contract.
            </p>
          </div>
          <div class="card card-top hue-cyan px-7 pt-7 pb-8 max-[640px]:px-6">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="tag">"compiled"</span>
              <span class="font-mono text-[12.5px] text-muted">app.ts → Model IR → Rust</span>
            </div>
            <h3 class="h-sub mt-5">TypeScript model, compiled</h3>
            <p class="inline-code mt-3 text-[16px] leading-relaxed text-ink-2">
              Write state, computed values, reactions and tasks in the <code>.ts</code> module. Model AOT compiles them to <code>gen/app_model.rs</code>, and the
              browser preview runs the same bodies. <b class="font-semibold text-ink">Admission errors report <code>file:line:column</code></b> and do not fall
              back to the Rust mode.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- ================= retro ================= -->
    <section class="pt-[136px] max-[640px]:pt-24">
      <div class="wrap">
        <SectionHead
          kick="Made with MicroTS"
          title="Game Boy Advance games in TypeScript."
          lede="<b>Pocket Retro</b> builds Game Boy Advance ROMs from games written in TypeScript against a Pyxel-compatible SDK. MicroTS compiles each game and the SDK into one Rust model, and <b>no Python or JavaScript runs on the console</b>. Pick a game to read its source."
        />
        <div class="grid gap-[18px] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div class="grid min-w-0 grid-cols-2 gap-[14px] sm:grid-cols-3">
            <button
              v-for="id in showcase"
              :key="id"
              type="button"
              class="card card-link block min-w-0 cursor-pointer overflow-hidden text-left"
              :class="id === picked && '!shadow-[0_0_0_2px_var(--color-cyan)]'"
              :aria-pressed="id === picked"
              @click="pick(id)"
              @pointerenter="load(id)"
              @focus="load(id)"
            >
              <div class="p-2.5 pb-0">
                <div class="overflow-hidden rounded-[12px] bg-black shadow-[0_0_0_1px_var(--color-line)]" style="aspect-ratio: 1">
                  <img :src="`/retro/${id}/poster.png`" :alt="gameById(id).title" loading="lazy" class="h-full w-full object-contain [image-rendering:pixelated]" />
                </div>
              </div>
              <div class="px-3.5 pt-3 pb-4">
                <div class="truncate font-disp text-[16px] leading-tight font-bold tracking-[-0.01em]">{{ gameById(id).title }}</div>
                <div class="mt-2 flex flex-wrap gap-1">
                  <span class="tag hue-cyan">{{ gameById(id).fps }} fps</span>
                  <span class="badge">{{ gameById(id).lines }} lines</span>
                </div>
              </div>
            </button>
          </div>
          <!-- From lg up the panel takes the grid's height, so a long game.ts does not stretch the row -->
          <div ref="codePanel" class="relative h-[30rem] min-w-0 scroll-mb-6 lg:h-auto">
            <CodeTabs class="absolute inset-0" fill :tabs="pickedTabs" :loading="!code[picked]">
              <template #actions>
                <RouterLink :to="`/playground/${presetId(picked)}`" class="arrow-link ml-auto px-2"> Edit {{ gameById(picked).title }} in the playground → </RouterLink>
              </template>
            </CodeTabs>
          </div>
          <a :href="GITHUB_RETRO" target="_blank" rel="noopener" class="card card-link flex items-center gap-4 px-5 py-4 lg:col-span-2">
            <span class="grid size-11 flex-none place-items-center rounded-xl bg-bg shadow-[0_0_0_1px_var(--color-line)] [&_svg]:size-8" v-html="ICON_RETRO" />
            <span class="grid min-w-0 gap-0.5">
              <strong class="font-disp text-[17px] font-bold tracking-[-0.01em]">pocket-nexus/pocket-retro</strong>
              <span class="text-[14.5px] text-ink-2">{{ games.length }} games in the playground, each one editable. The ROM build needs Bun and Rust nightly.</span>
            </span>
            <span class="ml-auto text-ink-2 max-sm:hidden" aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ================= start ================= -->
    <section class="pt-[136px] max-[640px]:pt-24">
      <div class="wrap">
        <div
          class="grid items-center gap-12 rounded-[32px] px-14 py-16 shadow-[0_0_0_1px_var(--color-line)] max-lg:px-8 max-lg:py-12 max-[640px]:px-6 max-[640px]:py-10 lg:grid-cols-2"
          style="
            background:
              radial-gradient(500px 260px at 15% 0%, rgba(63, 208, 232, 0.16), transparent 70%),
              radial-gradient(500px 260px at 90% 100%, rgba(169, 139, 255, 0.16), transparent 70%),
              var(--color-bg-2);
          "
        >
          <div class="min-w-0">
            <div class="kick">Start here</div>
            <h2 class="h-sec mt-3.5">Build the Vue lab.</h2>
            <p class="intro mt-4">
              Install Bun and a Rust toolchain, then build the supplied Vue lab from a PocketJS checkout. Or edit a counter, a feature lab or a GBA game in
              the playground and watch it run.
            </p>
            <div class="mt-7 flex flex-wrap gap-3">
              <RouterLink to="/playground" class="btn btn-pri">Open the playground</RouterLink>
              <RouterLink to="/docs/microts" class="btn">Read the guide</RouterLink>
            </div>
          </div>
          <div class="start-cmd min-w-0 overflow-x-auto rounded-[16px] bg-[rgba(0,0,0,0.45)] shadow-[0_0_0_1px_var(--color-line)]" v-html="startTabs[0]?.html" />
        </div>
        <div class="mt-[18px] grid gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
          <RouterLink v-for="d in DOC_ITEMS" :key="d.slug" :to="`/docs/${d.slug}`" class="card card-link px-5 pt-4 pb-5">
            <div class="font-disp text-[16.5px] font-bold tracking-[-0.01em] text-ink">{{ d.title }}</div>
            <p class="mt-1.5 text-[14px] leading-snug text-ink-2">{{ d.blurb }}</p>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.start-cmd :deep(pre.shiki) {
  margin: 0;
  padding: 1.4rem 1.5rem;
  background: transparent !important;
  font: 400 13.5px/1.85 var(--font-mono);
}
</style>
