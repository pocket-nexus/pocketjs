<script setup lang="ts">
// Playground start page: pick where to start (a new project, one of your projects, or an example).
import { onMounted } from "vue";
import CandyText from "../components/CandyText.vue";
import PlaygroundPicker from "../playground/PlaygroundPicker.vue";
import { warmCompiler } from "../playground/ui/UiPreview";

// The compiler is about 2.9 MB; load it in the background before the workspace opens
onMounted(warmCompiler);
</script>

<template>
  <div class="wrap pt-[clamp(2.2rem,6vw,4rem)] pb-16">
    <header class="mb-12 max-w-[46rem]">
      <span class="kicker hue-cyan">MicroTS playground</span>
      <CandyText tag="h1" text="Playground" :start="2" class="drop-in mt-4 block text-[clamp(1.4rem,3.6vw,2.4rem)] leading-[1.45]" />
      <p class="mt-5 text-[1.06rem] leading-relaxed text-ink-2">
        Start a project from a template or open an example. Previews run the TypeScript as JavaScript in this tab; the native build
        compiles the same source to Rust (see
        <RouterLink to="/docs/typescript-support#execution-modes" class="olink hue-cyan text-cyan">execution modes</RouterLink>).
      </p>
    </header>
    <PlaygroundPicker />
  </div>
</template>
