<script setup lang="ts">
// Playground start page: pick where to start (a new project, one of your projects, or an example).
import { onMounted } from "vue";
import PlaygroundPicker from "../playground/PlaygroundPicker.vue";
import { warmCompiler } from "../playground/ui/UiPreview";

// The compiler is about 2.9 MB; load it in the background before the workspace opens
onMounted(warmCompiler);
</script>

<template>
  <div class="relative">
    <div class="glow !h-[520px]" aria-hidden="true" />
    <div class="wrap relative pt-[88px] max-[640px]:pt-14">
      <header class="mb-16 max-w-[46rem] max-[640px]:mb-12">
        <div class="kick">MicroTS playground</div>
        <h1 class="h-page mt-4">Playground</h1>
        <p class="intro mt-5">
          Start a project from a template or open an example. Previews run the TypeScript as JavaScript in this tab; the native build compiles the same
          source to Rust (see
          <RouterLink to="/docs/typescript-support#execution-modes" class="olink text-cyan">execution modes</RouterLink>).
        </p>
      </header>
      <PlaygroundPicker />
    </div>
  </div>
</template>
