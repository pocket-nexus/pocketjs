<script setup lang="ts">
import CandyText from "../components/CandyText.vue";
</script>

<template>
  <section class="wrap grid place-items-center py-28 text-center">
    <div class="hue-pink plate px-10 pt-9 pb-12">
      <CandyText tag="h1" text="404" class="block text-[3rem] leading-none" />
      <p class="relative z-10 mt-6 font-round text-lg font-semibold text-ink-2">This page compiled to nothing.</p>
    </div>
    <div class="mt-12 flex flex-wrap justify-center gap-4">
      <RouterLink to="/" class="btn btn-primary">Home</RouterLink>
      <RouterLink to="/docs/microts" class="btn">Docs</RouterLink>
    </div>
  </section>
</template>
