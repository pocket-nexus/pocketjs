<script setup lang="ts">
// Section heading: candy pixel text + twinkling pixel star + a row of pellets
import CandyText from "./CandyText.vue";

defineProps<{ title: string; start?: number; lede?: string }>();
</script>

<template>
  <div class="hop-group mb-7">
    <div class="flex items-center gap-[1.6rem]">
      <div class="relative pb-[0.55rem]">
        <CandyText tag="h2" :text="title" :start="start ?? 0" class="block text-[clamp(1.05rem,2.45vw,1.9rem)] leading-[1.4]" />
        <span class="spark twinkle absolute -top-[0.7rem] -right-[1.45rem] max-[620px]:size-[15px]" aria-hidden="true" />
      </div>
      <span class="pellets -mt-[0.45rem] max-[620px]:hidden" aria-hidden="true" />
    </div>
    <p
      v-if="lede"
      class="mt-3 max-w-[46rem] text-[1.04rem] leading-relaxed text-soft [&_b]:font-semibold [&_b]:text-ink [&_code]:rounded-md [&_code]:bg-[rgba(var(--hue-rgb),0.1)] [&_code]:px-[0.35em] [&_code]:py-[0.05em] [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-[var(--hue-l)]"
      v-html="lede"
    />
  </div>
</template>
