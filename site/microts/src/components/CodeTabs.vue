<script setup lang="ts">
// Code panel: a tab bar of file names above the highlighted code.
// A new tab list (another game or framework on the home page) returns to the first tab and the top.
// The head slot sits above the file tabs; the home page puts its framework tabs there.
import { ref, useTemplateRef, watch } from "vue";

const props = defineProps<{
  tabs: { title: string; html: string }[];
  initial?: number;
  /** Fill the parent's height; the code scrolls */
  fill?: boolean;
  /** Covers the code while the next tab list loads */
  loading?: boolean;
}>();
const active = ref(props.initial ?? 0);
const screen = useTemplateRef<HTMLElement>("screen");
watch(
  () => props.tabs,
  () => {
    active.value = props.initial ?? 0;
    screen.value?.scrollTo({ top: 0, left: 0 });
  },
);
</script>

<template>
  <div class="codepanel min-w-0" :class="fill && 'flex flex-col'">
    <slot name="head" />
    <div class="codetabs" role="tablist" aria-label="Files">
      <button v-for="(t, i) in tabs" :key="t.title" type="button" role="tab" :aria-selected="active === i" class="codetab" @click="active = i">
        {{ t.title }}
      </button>
      <slot name="actions" />
    </div>
    <div class="relative" :class="fill && 'min-h-0 flex-1'">
      <div ref="screen" class="overflow-x-auto" :class="fill && 'h-full overflow-y-auto'" :aria-busy="loading || undefined">
        <div class="tab-code" v-html="tabs[active]?.html" />
      </div>
      <div
        v-if="loading"
        class="absolute inset-0 grid place-items-center bg-[rgba(13,12,18,0.72)] font-mono text-[0.75rem] tracking-[0.12em] text-ink-2 uppercase"
      >
        Loading
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-code :deep(pre.shiki) {
  margin: 0;
  padding: 1.25rem 1.4rem 1.5rem;
  background: transparent !important;
  font: 400 13px/1.75 var(--font-mono);
  min-height: 100%;
}
</style>
