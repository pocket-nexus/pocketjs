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
  <footer class="mt-32 border-t border-line pt-14 pb-16 text-[14px] text-muted max-[640px]:mt-24">
    <div class="wrap flex flex-wrap items-center gap-x-7 gap-y-4">
      <span class="flex items-center gap-2.5 text-ink">
        <MicroTSMark :size="26" />
        <span class="font-disp text-[17px] font-bold tracking-[-0.01em]">MicroTS</span>
      </span>
      <nav class="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
        <template v-for="l in links" :key="l.label">
          <RouterLink v-if="l.to" :to="l.to" class="hover:text-ink">{{ l.label }}</RouterLink>
          <a v-else :href="l.href" target="_blank" rel="noopener" class="hover:text-ink">{{ l.label }}</a>
        </template>
      </nav>
      <span class="ml-auto max-[640px]:ml-0">
        © 2026 Pocket Nexus · MicroTS is part of <a :href="GITHUB_POCKETJS" class="border-b border-line-2 hover:text-ink">PocketJS</a>, MIT · a
        <a :href="NEXUS_SITE" class="border-b border-line-2 hover:text-ink">Pocket Nexus</a> project
      </span>
      <span class="w-full font-mono text-[12px] tracking-[0.04em] text-dim">built from pocketjs@{{ COMMIT.slice(0, 8) }}</span>
    </div>
  </footer>
</template>
