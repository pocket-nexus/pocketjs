<script setup lang="ts">
// Code panel: arcade keys as tabs, inner screen with scanlines.
// A new tab list (another game on the home page) returns to the first tab and the top.
import { ref, useTemplateRef, watch } from "vue";

const props = defineProps<{
  tabs: { title: string; html: string }[];
  initial?: number;
  /** Fill the parent's height; the code screen scrolls */
  fill?: boolean;
  /** Covers the screen while the next tab list loads */
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
  <div
    class="overflow-hidden rounded-[22px] border-[3px] border-[var(--hue)] bg-panel"
    :class="fill && 'flex flex-col'"
    style="box-shadow: 0 6px 0 var(--hue-d), 0 24px 40px -22px rgba(0, 0, 0, 0.85)"
  >
    <div class="flex flex-wrap items-center gap-2 px-3 pt-3 pb-3" role="tablist">
      <button
        v-for="(t, i) in tabs"
        :key="t.title"
        type="button"
        role="tab"
        :aria-selected="active === i"
        class="rounded-[10px] border-2 px-[0.8rem] pt-[0.62rem] pb-[0.6rem] font-px text-[0.6rem] leading-none tracking-[0.02em] transition"
        :class="
          active === i
            ? 'translate-y-[2px] border-[var(--hue)] bg-[var(--hue)] text-out shadow-[0_1px_0_#0a0614,inset_0_-2px_0_rgba(0,0,0,0.18)]'
            : 'border-[rgba(203,189,226,0.18)] bg-key text-ink-2 shadow-[0_3px_0_#0a0614] hover:bg-key-hi hover:text-ink'
        "
        @click="active = i"
      >
        {{ t.title }}
      </button>
      <slot name="actions" />
    </div>
    <div class="relative mx-3 mb-3.5" :class="fill && 'min-h-0 flex-1'">
      <div ref="screen" class="screen overflow-x-auto" :class="fill && 'h-full overflow-y-auto'" :aria-busy="loading || undefined">
        <div class="tab-code" v-html="tabs[active]?.html" />
      </div>
      <div
        v-if="loading"
        class="absolute inset-0 grid place-items-center rounded-[14px] bg-[rgba(14,9,26,0.72)] font-px text-[0.7rem] tracking-[0.08em] text-ink-2"
      >
        LOADING
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-code :deep(pre.shiki) {
  margin: 0;
  padding: 1rem 1.1rem;
  background: transparent !important;
  font: 400 12.5px/1.65 var(--font-mono);
  min-height: 100%;
}
</style>
