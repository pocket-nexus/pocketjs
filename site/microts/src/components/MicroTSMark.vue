<script setup lang="ts">
// MicroTS mark: /favicon.svg, which `bun tools/icons.ts microts` copies from site/microts/mark.svg.
// pocket.nexus draws the same shapes in its Technology menu.
withDefaults(defineProps<{ size?: number }>(), { size: 28 });
</script>

<template>
  <img src="/favicon.svg" :width="size" :height="size" alt="" />
</template>
