<script setup lang="ts">
// Candy pixel heading: one span per letter, colors cycling pink/yellow/cyan/lilac/orange.
// Screen readers read the full text once.
import { computed } from "vue";

const props = withDefaults(defineProps<{ text: string; start?: number; tag?: string }>(), { start: 0, tag: "span" });
const HUES = ["p", "y", "c", "l", "o"];

const lines = computed(() => {
  let hue = props.start;
  let index = 0;
  return props.text.split("\n").map((line) =>
    line
      .trim()
      .split(/\s+/)
      .map((word) => [...word].map((ch) => ({ ch, cls: `ch c-${HUES[hue++ % HUES.length]}`, i: index++ }))),
  );
});
</script>

<template>
  <component :is="tag" class="candy">
    <span class="sr-only-text">{{ text.replace(/\s+/g, " ") }}</span>
    <span aria-hidden="true">
      <template v-for="(line, li) in lines" :key="li">
        <br v-if="li > 0" />
        <template v-for="(word, wi) in line" :key="wi">
          <template v-if="wi > 0">{{ " " }}</template>
          <span class="w"><span v-for="c in word" :key="c.i" :class="c.cls" :style="{ '--i': c.i }">{{ c.ch }}</span></span>
        </template>
      </template>
    </span>
  </component>
</template>
