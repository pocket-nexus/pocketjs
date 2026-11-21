<script setup lang="ts">
import MicroTSMark from "./MicroTSMark.vue";
import { GITHUB_POCKETJS, GITHUB_RETRO, NEXUS_SITE, POCKETJS_SITE } from "../site";
import { COMMIT } from "microts:build";

const links = [
  { label: "Docs", to: "/docs/microts" },
  { label: "Playground", to: "/playground" },
  { label: "PocketJS", href: POCKETJS_SITE },
  { label: "Pocket Retro", href: GITHUB_RETRO },
  { label: "GitHub", href: GITHUB_POCKETJS },
];
</script>

<template>
  <footer class="relative mt-[14px] bg-floor pt-[2.7rem] pb-[3.4rem]">
    <div class="candy-floor absolute inset-x-0 -top-[14px]" aria-hidden="true" />
    <div class="wrap grid gap-6 md:grid-cols-[auto_1fr] md:items-start">
      <div class="flex items-center gap-2">
        <MicroTSMark :size="24" />
        <span class="font-round text-[1.16rem] font-semibold">MicroTS</span>
      </div>
      <nav class="flex flex-wrap items-center gap-x-3 gap-y-2 font-round text-[0.95rem] font-semibold md:justify-end">
        <template v-for="(l, i) in links" :key="l.label">
          <span v-if="i > 0" class="text-pink" aria-hidden="true">·</span>
          <RouterLink v-if="l.to" :to="l.to" class="text-ink-2 hover:text-yellow">{{ l.label }}</RouterLink>
          <a v-else :href="l.href" target="_blank" rel="noopener" class="text-ink-2 hover:text-yellow">{{ l.label }}</a>
        </template>
      </nav>
      <p class="font-round text-[0.84rem] leading-relaxed font-medium text-soft md:col-span-2">
        © 2026 Pocket Nexus · MicroTS is part of <a :href="GITHUB_POCKETJS" class="text-yellow underline decoration-[rgba(255,210,63,.5)] underline-offset-2">PocketJS</a>, MIT ·
        a <a :href="NEXUS_SITE" class="text-yellow underline decoration-[rgba(255,210,63,.5)] underline-offset-2">Pocket Nexus</a> project
        <br />
        <span class="font-mono text-[0.76rem] tracking-[0.06em] text-muted">
          built from pocketjs@{{ COMMIT.slice(0, 8) }}
        </span>
      </p>
    </div>
  </footer>
</template>
