<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import MicroTSMark from "./MicroTSMark.vue";
import { FAMILY, GITHUB_MICROTS } from "../site";

const route = useRoute();
const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let hoverOpenedAt = 0;

// Only mouse hover opens: a touch tap emulates a hover before it fires the click
// Close after a short delay on leave, so a diagonal move toward the menu does not close it
function onPointerEnter(e: PointerEvent) {
  if (e.pointerType !== "mouse") return;
  clearTimeout(closeTimer);
  if (!menuOpen.value) hoverOpenedAt = performance.now();
  menuOpen.value = true;
}
function onPointerLeave(e: PointerEvent) {
  if (e.pointerType !== "mouse") return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => (menuOpen.value = false), 180);
}
// Touch tap and keyboard Enter/Space toggle; a click right after hover opened the menu does not close it
function onToggle() {
  clearTimeout(closeTimer);
  if (menuOpen.value && performance.now() - hoverOpenedAt < 800) return;
  menuOpen.value = !menuOpen.value;
}
function close() {
  clearTimeout(closeTimer);
  menuOpen.value = false;
}
// Close on a press outside the menu, on Esc, or when keyboard focus leaves it
function onPointerDown(e: PointerEvent) {
  if (menuOpen.value && !menuRoot.value?.contains(e.target as Node)) close();
}
function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && menuOpen.value) close();
}
function onFocusOut(e: FocusEvent) {
  if (!menuRoot.value?.contains(e.relatedTarget as Node | null)) close();
}
onMounted(() => {
  addEventListener("pointerdown", onPointerDown);
  addEventListener("keydown", onKeyDown);
});
onBeforeUnmount(() => {
  clearTimeout(closeTimer);
  removeEventListener("pointerdown", onPointerDown);
  removeEventListener("keydown", onKeyDown);
});
watch(() => route.fullPath, close);
const isDocs = () => route.path.startsWith("/docs");
const isPlayground = () => route.path.startsWith("/playground");
// The playground workspace fills the window: the nav bar goes full width too, with the same 16px side padding as the workspace toolbar
const fluid = () => route.name === "playground" || route.name === "playground-project";
</script>

<template>
  <header class="sticky top-0 z-40" style="background: rgba(20, 14, 34, 0.92); box-shadow: 0 3px 0 var(--color-drop)">
    <nav class="flex h-[3.6rem] items-center justify-between gap-3" :class="fluid() ? 'w-full px-4' : 'wrap'">
      <RouterLink to="/" class="flex items-center gap-[0.55rem]" aria-label="MicroTS home">
        <MicroTSMark :size="28" class="drop-shadow-[0_2px_0_#0a0614]" />
        <span class="font-round text-[1.34rem] leading-none font-semibold max-[350px]:text-base">MicroTS</span>
        <span class="badge hidden md:inline-flex">by PocketJS</span>
      </RouterLink>
      <div class="flex items-center gap-2 max-[620px]:gap-1.5">
        <RouterLink to="/docs/microts" class="key max-[620px]:h-8 max-[620px]:px-2 max-[620px]:text-[0.84rem]" :class="{ on: isDocs() }">Docs</RouterLink>
        <RouterLink to="/playground" class="key max-[620px]:h-8 max-[620px]:px-2 max-[620px]:text-[0.84rem]" :class="{ on: isPlayground() }">Playground</RouterLink>
        <div ref="menuRoot" class="relative" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave" @focusout="onFocusOut">
          <button
            type="button"
            class="key max-[620px]:h-8 max-[620px]:px-2 max-[620px]:text-[0.84rem]"
            :aria-expanded="menuOpen"
            aria-haspopup="true"
            @click="onToggle"
          >
            Family
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" class="max-[620px]:hidden">
              <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <div v-show="menuOpen" class="absolute top-full right-0 z-50 pt-3">
            <div
              class="grid w-[17.5rem] gap-1 rounded-[14px] border-[3px] border-lilac bg-panel p-1.5"
              style="box-shadow: 0 5px 0 var(--color-lilac-d), 0 22px 40px -18px rgba(0, 0, 0, 0.75)"
            >
              <a
                v-for="item in FAMILY"
                :key="item.name"
                :href="item.href"
                target="_blank"
                rel="noopener"
                class="group flex items-center gap-3 rounded-[9px] px-2.5 py-2 hover:bg-[rgba(169,139,255,0.18)]"
              >
                <span class="grid size-9 flex-none place-items-center rounded-[10px] bg-bg-2" v-html="item.icon" />
                <span class="grid gap-0.5">
                  <b class="font-round text-[0.95rem] leading-tight font-semibold text-ink group-hover:text-yellow">{{ item.name }}</b>
                  <small class="text-[0.78rem] leading-snug text-soft">{{ item.tagline }}</small>
                </span>
              </a>
            </div>
          </div>
        </div>
        <a :href="GITHUB_MICROTS" target="_blank" rel="noopener" class="key key-ico max-[620px]:hidden" aria-label="MicroTS on GitHub">
          <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </div>
    </nav>
    <!-- The decorative strip ignores pointer events; otherwise crossing it counts as leaving the Family menu -->
    <div class="marquee pointer-events-none absolute inset-x-0 -bottom-[3px]" aria-hidden="true" />
  </header>
</template>
