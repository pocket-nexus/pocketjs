<script setup lang="ts">
// Section heading: an uppercase kick label, the heading, and an optional lead paragraph (HTML).
// size "sm" is the smaller heading for groups inside a page (the playground start page).
withDefaults(defineProps<{ kick?: string; title: string; lede?: string; size?: "lg" | "sm" }>(), { size: "lg" });
</script>

<template>
  <div :class="size === 'lg' ? 'mb-12 max-[640px]:mb-9' : 'mb-6'">
    <div v-if="kick" class="kick">{{ kick }}</div>
    <h2 :class="[size === 'lg' ? 'h-sec' : 'h-sub', kick && 'mt-3.5']">{{ title }}</h2>
    <p v-if="lede" class="intro" :class="size === 'lg' ? 'mt-4' : 'mt-2.5 !text-[16px]'" v-html="lede" />
  </div>
</template>
