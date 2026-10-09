<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef } from "vue";
import CandyText from "../components/CandyText.vue";
import CodeTabs from "../components/CodeTabs.vue";
import SectionHead from "../components/SectionHead.vue";
import MicroTSMark from "../components/MicroTSMark.vue";
import counterTabs from "../../content/home/counter.md?tabs";
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

const bindings = [
  ["<View> and <Text>", "Create nodes with ui.create_node(...) and attach them with ui.insert_before(...)"],
  ['class="p-4 ..."', "Use a compiled style table entry through ui.set_style(...)"],
  ["{{ count }}", "Read vm.count(); format the text when the value changes and send it through ui.set_text(...)"],
  ['@press="count++"', "On a matching press, call vm.set_count(vm.count().wrapping_add(1i32))"],
  ["v-if and v-for", "Choose mounted branches and reconcile list rows by key"],
];
</script>

<template>
  <div>
    <!-- ================= hero ================= -->
    <section class="hue-pink wrap grid items-center gap-12 pt-[clamp(2.5rem,7vw,5rem)] pb-[clamp(3rem,7vw,5rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
      <div>
        <div class="mb-6 flex flex-wrap items-center gap-2.5">
          <span class="kicker">PocketJS · ahead-of-time mode</span>
          <span class="badge text-orange-l">In development</span>
        </div>
        <div class="plate px-[clamp(1.2rem,2.8vw,2rem)] pt-[clamp(1.3rem,2.8vw,2rem)] pb-[clamp(1.9rem,3.4vw,2.5rem)]">
          <span class="spark twinkle absolute -top-[19px] -right-[15px] z-10 !size-[35px] !bg-yellow max-[700px]:!size-7" aria-hidden="true" />
          <CandyText
            tag="h1"
            :text="'TypeScript\nto native code'"
            class="drop-in relative z-10 block text-[clamp(1.15rem,3.3vw,2.4rem)] leading-[1.45]"
          />
          <div class="bulbs bulbs-run absolute right-6 bottom-[15px] left-6" aria-hidden="true" />
        </div>
        <p class="mt-8 max-w-[36rem] text-[1.08rem] leading-relaxed text-ink-2">
          MicroTS compiles Vue single-file components, Solid TSX views and TypeScript models into Rust.
          <b class="font-semibold text-ink">The native app runs its view and model without a JavaScript engine.</b>
        </p>
        <div class="mt-8 flex flex-wrap gap-4">
          <RouterLink to="/playground" class="btn btn-primary">Open the playground</RouterLink>
          <RouterLink to="/docs/microts" class="btn">Read the guide</RouterLink>
          <a :href="GITHUB_MICROTS" target="_blank" rel="noopener" class="btn btn-heart">GitHub</a>
        </div>
      </div>

      <!-- Handheld: cycles Pocket Retro screenshots -->
      <figure class="mx-auto w-full max-w-[420px]" aria-label="Pocket Retro game screenshots">
        <div
          class="hue-lilac relative rounded-[34px] border-[3px] border-out px-5 pt-5 pb-6"
          style="
            background: linear-gradient(180deg, #3a2d63, #2b2148 60%);
            box-shadow: inset 0 3px 0 rgba(255, 255, 255, 0.12), inset 0 -6px 0 rgba(0, 0, 0, 0.25), 0 8px 0 #7155d8, 0 8px 0 3px #0a0614, 0 30px 50px -20px rgba(0, 0, 0, 0.8);
          "
        >
          <div class="rounded-[18px] bg-shade p-3 shadow-[inset_0_0_0_2px_#0a0614]">
            <div class="mb-2 flex items-center justify-between px-1">
              <span class="font-px text-[0.5rem] tracking-[0.08em] text-muted">POCKET RETRO</span>
              <span class="flex items-center gap-1.5" aria-hidden="true">
                <i v-for="(id, i) in showcase" :key="id" class="inline-block size-1.5 rounded-[1px] transition-colors" :class="i === shown ? 'bg-pink' : 'bg-out'" />
              </span>
            </div>
            <div class="scanlines relative overflow-hidden rounded-[10px] bg-black shadow-[0_0_0_2px_#0a0614]" style="aspect-ratio: 4 / 3">
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
          </div>
          <div class="mt-5 flex items-center justify-between px-2">
            <div class="relative size-[68px]" aria-hidden="true">
              <span class="absolute top-[22px] left-0 h-6 w-[68px] rounded-[6px] bg-out shadow-[0_3px_0_#0a0614]" />
              <span class="absolute top-0 left-[22px] h-[68px] w-6 rounded-[6px] bg-out shadow-[0_3px_0_#0a0614]" />
            </div>
            <div class="text-center">
              <div class="font-round text-[1.02rem] font-semibold text-ink">{{ gameById(showcase[shown]!).title }}</div>
              <div class="font-mono text-[0.7rem] text-soft">{{ gameById(showcase[shown]!).width }}×{{ gameById(showcase[shown]!).height }} · by {{ gameById(showcase[shown]!).author }}</div>
            </div>
            <div class="flex items-end gap-2" aria-hidden="true">
              <span class="size-8 rounded-full bg-pink shadow-[0_3px_0_#c23a73,0_3px_0_2px_#0a0614]" />
              <span class="mb-3 size-8 rounded-full bg-yellow shadow-[0_3px_0_#c99400,0_3px_0_2px_#0a0614]" />
            </div>
          </div>
        </div>
      </figure>
    </section>

    <!-- ================= write ================= -->
    <section class="hue-cyan wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="One source"
        :start="2"
        lede="Write a screen as a Vue single-file component or a Solid TSX view, with its state and actions typed in a TypeScript module. <b>The same source runs in a browser, in QuickJS on a device, or as native Rust.</b>"
      />
      <div class="grid items-start gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div class="grid gap-4">
          <div v-for="(row, i) in [
            { k: 'Browser preview', v: 'Edit the view and run it in a browser on the PocketJS web host. The playground on this site runs this build.' },
            { k: 'QuickJS guest', v: 'Bundle the same source as JavaScript for a device that runs the QuickJS engine.' },
            { k: 'Native AOT', v: 'Compile the view to Rust and build it with Cargo, together with your model. The app ships without a JavaScript engine.' },
          ]" :key="row.k" class="shell px-5 py-4" :class="['hue-cyan', 'hue-lilac', 'hue-yellow'][i]">
            <div class="label mb-2">{{ row.k }}</div>
            <p class="text-[0.95rem] leading-relaxed text-soft">{{ row.v }}</p>
          </div>
        </div>
        <CodeTabs :tabs="counterTabs" />
      </div>
    </section>

    <!-- ================= compile ================= -->
    <section class="hue-lilac wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="How it compiles"
        :start="4"
        lede="The MicroTS compiler turns each component into Rust source and a compiled style table, and Cargo builds them into your native app. <b>You edit the TypeScript; the compiler maintains <code>gen/</code>.</b>"
      />
      <ol class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <li v-for="(step, i) in pipeline" :key="step.n" class="shell card-hover relative px-4 pt-4 pb-5" :class="['hue-pink', 'hue-yellow', 'hue-cyan', 'hue-lilac', 'hue-orange'][i]">
          <div class="mb-3 flex items-center justify-between">
            <span class="font-px text-[0.7rem] text-[var(--hue)]">{{ step.n }}</span>
            <span v-if="i < pipeline.length - 1" class="font-px text-[0.7rem] text-dim max-lg:hidden" aria-hidden="true">→</span>
          </div>
          <h3 class="font-round text-[1.18rem] leading-tight font-semibold">{{ step.title }}</h3>
          <p class="mt-2 text-[0.88rem] leading-relaxed text-soft [&_code]:font-mono [&_code]:text-[0.8em] [&_code]:text-[var(--hue-l)]" v-html="step.body" />
        </li>
      </ol>
      <div class="mt-10 overflow-hidden rounded-[22px] border-[3px] border-lilac bg-panel shadow-[0_6px_0_#7155d8,0_24px_40px_-22px_rgba(0,0,0,0.85)]">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
          <span class="label">Follow one binding</span>
          <span class="font-mono text-[0.75rem] text-muted">Counter.vue → gen/counter.rs</span>
        </div>
        <div class="overflow-x-auto px-3 pb-3">
          <table class="w-full min-w-[560px] border-separate border-spacing-y-1.5 text-left text-[0.9rem]">
            <thead>
              <tr class="font-round text-[0.82rem] text-pink-l">
                <th class="px-3 font-semibold">Template</th>
                <th class="px-3 font-semibold">Generated Rust behavior</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="[t, r] in bindings" :key="t">
                <td class="screen rounded-l-[10px] px-3 py-2.5 align-top font-mono text-[0.82rem] whitespace-nowrap text-yellow">{{ t }}</td>
                <td class="rounded-r-[10px] bg-[rgba(18,12,33,0.55)] px-3 py-2.5 text-soft">{{ r }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ================= model ================= -->
    <section class="hue-yellow wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="Pick a model"
        :start="1"
        lede="Write the app logic in Rust, or write it in TypeScript and compile it to Rust as well. <code>app.model</code> in <code>pocket.json</code> selects the mode; the view stays the same."
      />
      <div class="grid gap-6 md:grid-cols-2">
        <div class="shell hue-yellow px-6 pt-5 pb-6">
          <div class="flex items-center justify-between">
            <span class="label">"rust" · default</span>
            <span class="font-mono text-[0.75rem] text-muted">src/lib.rs</span>
          </div>
          <h3 class="mt-4 font-round text-[1.3rem] font-semibold">Handwritten Rust model</h3>
          <p class="mt-2 leading-relaxed text-soft">
            Implement the generated trait's methods and computed getters in Rust. The <code class="font-mono text-[0.85em] text-yellow-l">.ts</code> module runs the
            browser preview, and its types define the native contract.
          </p>
        </div>
        <div class="shell hue-cyan px-6 pt-5 pb-6">
          <div class="flex items-center justify-between">
            <span class="label">"compiled"</span>
            <span class="font-mono text-[0.75rem] text-muted">app.ts → Model IR → Rust</span>
          </div>
          <h3 class="mt-4 font-round text-[1.3rem] font-semibold">TypeScript model, compiled</h3>
          <p class="mt-2 leading-relaxed text-soft">
            Write state, computed values, reactions and tasks in the <code class="font-mono text-[0.85em] text-cyan-l">.ts</code> module. Model AOT compiles
            them to <code class="font-mono text-[0.85em] text-cyan-l">gen/app_model.rs</code>, and the browser preview runs the same bodies.
            <b class="font-semibold text-ink">Admission errors report <code class="font-mono text-[0.85em]">file:line:column</code></b> and do not fall back to the Rust mode.
          </p>
        </div>
      </div>
    </section>

    <!-- ================= retro ================= -->
    <section class="hue-pink wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="Made with MicroTS"
        :start="0"
        lede="<b>Pocket Retro</b> builds Game Boy Advance ROMs from games written in TypeScript against a Pyxel-compatible SDK. MicroTS compiles each game and the SDK into one Rust model, and <b>no Python or JavaScript runs on the console</b>. Pick a game to read its source."
      />
      <div class="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <button
            v-for="(id, i) in showcase"
            :key="id"
            type="button"
            class="shell card-hover block cursor-pointer overflow-hidden text-left"
            :class="id === picked ? 'hue-yellow -translate-y-1' : ['hue-pink', 'hue-cyan', 'hue-lilac', 'hue-orange', 'hue-pink', 'hue-cyan'][i]"
            :aria-pressed="id === picked"
            @click="pick(id)"
            @pointerenter="load(id)"
            @focus="load(id)"
          >
            <div class="scanlines relative m-2 overflow-hidden rounded-[12px] bg-black shadow-[0_0_0_2px_#0a0614]" style="aspect-ratio: 1">
              <img :src="`/retro/${id}/poster.png`" :alt="gameById(id).title" loading="lazy" class="h-full w-full object-contain [image-rendering:pixelated]" />
            </div>
            <div class="px-3 pt-1 pb-3">
              <div class="font-round text-[0.98rem] leading-tight font-bold">{{ gameById(id).title }}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <span class="tag">{{ gameById(id).fps }} fps</span>
                <span class="badge">{{ gameById(id).lines }} lines</span>
              </div>
            </div>
          </button>
        </div>
        <!-- From lg up the panel takes the grid's height, so a long game.ts does not stretch the row -->
        <div ref="codePanel" class="relative h-[30rem] scroll-mb-6 lg:h-auto">
          <CodeTabs class="absolute inset-0" fill :tabs="pickedTabs" :loading="!code[picked]">
            <template #actions>
              <RouterLink
                :to="`/playground/${presetId(picked)}`"
                class="ml-auto font-round text-[0.84rem] font-semibold text-soft underline decoration-dotted underline-offset-4 hover:text-yellow"
              >
                Edit {{ gameById(picked).title }} in the playground
              </RouterLink>
            </template>
          </CodeTabs>
        </div>
        <a
          :href="GITHUB_RETRO"
          target="_blank"
          rel="noopener"
          class="flex items-center gap-4 rounded-2xl border-2 border-[rgba(255,95,158,0.6)] bg-[rgba(255,95,158,0.09)] px-4 py-3.5 shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5 lg:col-span-2"
        >
          <span class="grid size-11 flex-none place-items-center rounded-xl bg-bg-2 [&_svg]:size-9" v-html="ICON_RETRO" />
          <span class="grid gap-0.5">
            <strong class="font-round text-[1.08rem] font-semibold">pocket-nexus/pocket-retro</strong>
            <span class="text-[0.9rem] text-soft">{{ games.length }} games in the playground, each one editable. The ROM build needs Bun and Rust nightly.</span>
          </span>
        </a>
      </div>
    </section>

    <!-- ================= start ================= -->
    <section class="hue-orange wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead title="Start here" :start="3" lede="Install Bun and a Rust toolchain, then build the supplied Vue lab from a PocketJS checkout." />
      <div class="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div
          class="overflow-hidden rounded-[22px] border-[3px] border-pink bg-panel"
          style="box-shadow: 0 6px 0 var(--color-pink-d), 0 24px 40px -22px rgba(0, 0, 0, 0.85)"
        >
          <div class="flex items-center gap-1.5 px-3.5 pt-3 pb-1" aria-hidden="true">
            <i class="size-3 rounded-[3px] bg-yellow shadow-[0_2px_0_#0a0614]" />
            <i class="size-3 rounded-[3px] bg-pink shadow-[0_2px_0_#0a0614]" />
            <i class="size-3 rounded-[3px] bg-cyan shadow-[0_2px_0_#0a0614]" />
          </div>
          <div class="screen mx-3 mt-2 mb-3.5 overflow-x-auto" v-html="startTabs[0]?.html" />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <RouterLink
            v-for="d in DOC_ITEMS"
            :key="d.slug"
            :to="`/docs/${d.slug}`"
            class="group rounded-[18px] border-[2.5px] border-[rgba(169,139,255,0.32)] bg-panel px-4 py-3.5 shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5 hover:border-yellow"
          >
            <div class="font-round text-[1rem] font-semibold text-ink group-hover:text-yellow">{{ d.title }}</div>
            <p class="mt-1 text-[0.84rem] leading-snug text-soft">{{ d.blurb }}</p>
          </RouterLink>
        </div>
      </div>
      <div class="mt-14 flex flex-wrap items-center justify-center gap-4 text-center">
        <MicroTSMark :size="40" />
        <span class="font-round text-[1.1rem] font-semibold text-ink-2">Edit a counter, a feature lab or a GBA game, and watch it run.</span>
        <RouterLink to="/playground" class="btn btn-primary">Open the playground</RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
:deep(.screen pre.shiki) {
  margin: 0;
  padding: 1rem 1.1rem;
  background: transparent !important;
  font: 400 12.5px/1.65 var(--font-mono);
}
</style>
