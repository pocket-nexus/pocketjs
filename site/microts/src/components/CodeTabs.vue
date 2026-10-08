<script setup lang="ts">
// Code panel: arcade keys as tabs, inner screen with scanlines
import { ref } from "vue";

const props = defineProps<{ tabs: { title: string; html: string }[]; initial?: number }>();
const active = ref(props.initial ?? 0);
</script>

<template>
  <div
    class="overflow-hidden rounded-[22px] border-[3px] border-[var(--hue)] bg-panel"
    style="box-shadow: 0 6px 0 var(--hue-d), 0 24px 40px -22px rgba(0, 0, 0, 0.85)"
  >
    <div class="flex flex-wrap gap-2 px-3 pt-3 pb-3" role="tablist">
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
    </div>
    <div class="screen mx-3 mb-3.5 overflow-x-auto">
      <div class="tab-code" v-html="tabs[active]?.html" />
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
