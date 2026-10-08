<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import CandyText from "../components/CandyText.vue";
import CodeTabs from "../components/CodeTabs.vue";
import SectionHead from "../components/SectionHead.vue";
import MicroTSMark from "../components/MicroTSMark.vue";
import counterTabs from "../../content/home/counter.md?tabs";
import retroTabs from "../../content/home/retro.md?tabs";
import startTabs from "../../content/home/start.md?tabs";
import { DOC_ITEMS } from "../docs/nav";
import retroCatalog from "microts:retro-catalog";
import { GITHUB_MICROTS, GITHUB_RETRO, ICON_RETRO } from "../site";

document.title = "MicroTS · TypeScript compiled ahead of time to native code";

// The home page handheld cycles through retro game screenshots
const showcase = ["mega_wing", "platformer", "daylight", "cursed_caverns", "jump", "laser_jetman"];
const games = retroCatalog.games;
const shown = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => (shown.value = (shown.value + 1) % showcase.length), 2600);
});
onBeforeUnmount(() => clearInterval(timer));
const gameById = (id: string) => games.find((g) => g.id === id)!;
const presetId = (id: string) => `retro-${id.replace(/_/g, "-")}`;

const pipeline = [
  { n: "01", title: "Parse", body: "Vue's template parser and Vapor transforms, or the Solid front end, find the elements, bindings, conditions and loops." },
  { n: "02", title: "Type", body: "The TypeScript checker supplies each value's type: <code>ref&lt;i32&gt;(0)</code> exposes an <code>i32</code> named <code>count</code>." },
  { n: "03", title: "View IR", body: "Both front ends produce one typed View IR. Admission rejects syntax outside the supported subset." },
  { n: "04", title: "Rust", body: "The IR becomes a Rust syntax tree, printed to <code>gen/*.rs</code> with a compiled style table in <code>styles.bin</code>." },
  { n: "05", title: "Cargo", body: "Cargo builds the generated view with your model and the <code>microts</code> crate. The host owns input, fonts and presentation." },
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
      <RouterLink
        :to="`/playground/${presetId(showcase[shown]!)}`"
        class="group mx-auto block w-full max-w-[420px]"
        :aria-label="`Play ${gameById(showcase[shown]!).title} in the playground`"
      >
        <div
          class="hue-lilac relative rounded-[34px] border-[3px] border-out px-5 pt-5 pb-6 transition-transform duration-200 group-hover:-translate-y-1 group-hover:-rotate-1"
          style="
            background: linear-gradient(180deg, #3a2d63, #2b2148 60%);
            box-shadow: inset 0 3px 0 rgba(255, 255, 255, 0.12), inset 0 -6px 0 rgba(0, 0, 0, 0.25), 0 8px 0 #7155d8, 0 8px 0 3px #0a0614, 0 30px 50px -20px rgba(0, 0, 0, 0.8);
          "
        >
          <div class="rounded-[18px] bg-shade p-3 shadow-[inset_0_0_0_2px_#0a0614]">
            <div class="mb-2 flex items-center justify-between px-1">
              <span class="font-px text-[0.5rem] tracking-[0.08em] text-muted">POCKET RETRO</span>
              <span class="flex items-center gap-1.5 font-mono text-[0.62rem] text-muted"><i class="blink inline-block size-1.5 rounded-full bg-pink" />LIVE IN PLAYGROUND</span>
            </div>
            <div class="scanlines relative overflow-hidden rounded-[10px] bg-black shadow-[0_0_0_2px_#0a0614]" style="aspect-ratio: 4 / 3">
              <img
                v-for="(id, i) in showcase"
                :key="id"
                :src="`/retro/${id}/poster.png`"
                :alt="gameById(id).title"
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
        <p class="mt-6 text-center font-round text-[0.86rem] font-semibold text-soft group-hover:text-yellow">Press start → play it in the browser</p>
      </RouterLink>
    </section>

    <!-- ================= write ================= -->
    <section class="hue-cyan wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="One source"
        :start="2"
        lede="A template describes nodes, the values they display and the actions that change them. <b>The TypeScript checker gives every binding a Rust type</b>; the generated view calls your model through a Rust trait."
      />
      <div class="grid items-start gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div class="grid gap-4">
          <div v-for="(row, i) in [
            { k: 'Browser preview', v: 'The Vue or Solid build runs as JavaScript against the PocketJS web host. This is what the playground runs.' },
            { k: 'QuickJS guest', v: 'The same source bundled for an embedded JavaScript engine on the device.' },
            { k: 'Native AOT', v: 'The compiler writes gen/*.rs. Cargo links it with your model; no JavaScript engine ships.' },
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
        lede="Build time does the work a JavaScript framework does at run time. <b>The native view stores node IDs and previous binding values</b>; it runs without refs, effects or a render function."
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
        lede="<code>app.model</code> in <code>pocket.json</code> chooses who implements the generated view-model trait. The view compiler emits the same calls either way."
      />
      <div class="grid gap-6 md:grid-cols-2">
        <div class="shell hue-yellow px-6 pt-5 pb-6">
          <div class="flex items-center justify-between">
            <span class="label">"rust" · default</span>
            <span class="font-mono text-[0.75rem] text-muted">src/lib.rs</span>
          </div>
          <h3 class="mt-4 font-round text-[1.3rem] font-semibold">Handwritten Rust model</h3>
          <p class="mt-2 leading-relaxed text-soft">
            You implement each trait method and computed getter in Rust. The <code class="font-mono text-[0.85em] text-yellow-l">.ts</code> module supplies the
            browser preview, so the template and types are shared while the native business logic stays in Rust.
          </p>
        </div>
        <div class="shell hue-cyan px-6 pt-5 pb-6">
          <div class="flex items-center justify-between">
            <span class="label">"compiled"</span>
            <span class="font-mono text-[0.75rem] text-muted">app.ts → Model IR → Rust</span>
          </div>
          <h3 class="mt-4 font-round text-[1.3rem] font-semibold">TypeScript model, compiled</h3>
          <p class="mt-2 leading-relaxed text-soft">
            Model AOT translates state seeds, computed values, reactions and tasks from the
            <code class="font-mono text-[0.85em] text-cyan-l">.ts</code> module. The same bodies run in the browser preview.
            <b class="font-semibold text-ink">An admission failure does not fall back</b> to the Rust mode.
          </p>
        </div>
      </div>
    </section>

    <!-- ================= retro ================= -->
    <section class="hue-pink wrap py-[clamp(2.6rem,6.5vw,4.2rem)]">
      <SectionHead
        title="Made with MicroTS"
        :start="0"
        lede="<b>Pocket Retro</b> runs Pyxel games on a Game Boy Advance. Each game is TypeScript against a Pyxel-compatible SDK; MicroTS compiles the game, the SDK and a root module into one Rust model, linked with a bare-metal runtime into a ROM. No Python or JavaScript runs on the console."
      />
      <div class="grid items-start gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <RouterLink
            v-for="(id, i) in showcase"
            :key="id"
            :to="`/playground/${presetId(id)}`"
            class="shell card-hover block overflow-hidden"
            :class="['hue-pink', 'hue-cyan', 'hue-yellow', 'hue-lilac', 'hue-orange', 'hue-pink'][i]"
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
          </RouterLink>
        </div>
        <div class="grid gap-5">
          <CodeTabs :tabs="retroTabs" />
          <a
            :href="GITHUB_RETRO"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-4 rounded-2xl border-2 border-[rgba(255,95,158,0.6)] bg-[rgba(255,95,158,0.09)] px-4 py-3.5 shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5"
          >
            <span class="grid size-11 flex-none place-items-center rounded-xl bg-bg-2 [&_svg]:size-9" v-html="ICON_RETRO" />
            <span class="grid gap-0.5">
              <strong class="font-round text-[1.08rem] font-semibold">pocket-nexus/pocket-retro</strong>
              <span class="text-[0.9rem] text-soft">{{ games.length }} games in the playground, each one editable. The ROM build needs Bun and Rust nightly.</span>
            </span>
          </a>
        </div>
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
