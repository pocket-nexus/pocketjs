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
  <header class="sticky top-0 z-40 border-b border-line bg-[rgba(11,10,16,0.72)] backdrop-blur-[14px]">
    <nav class="flex h-[60px] items-center gap-6 max-[640px]:gap-3" :class="fluid() ? 'w-full px-4' : 'wrap'">
      <RouterLink to="/" class="flex items-center gap-2.5" aria-label="MicroTS home">
        <MicroTSMark :size="28" />
        <span class="font-disp text-[17px] leading-none font-bold tracking-[-0.01em]">MicroTS</span>
        <span class="badge hidden md:inline-flex">by PocketJS</span>
      </RouterLink>
      <div class="ml-auto flex items-center gap-6 text-[14.5px] text-ink-2 max-[640px]:gap-4 max-[640px]:text-[14px]">
        <RouterLink to="/docs/microts" class="hover:text-ink" :class="{ 'text-ink': isDocs() }" :aria-current="isDocs() ? 'page' : undefined">Docs</RouterLink>
        <RouterLink to="/playground" class="hover:text-ink" :class="{ 'text-ink': isPlayground() }" :aria-current="isPlayground() ? 'page' : undefined">
          Playground
        </RouterLink>
        <div ref="menuRoot" class="relative" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave" @focusout="onFocusOut">
          <button
            type="button"
            class="flex items-center gap-1.5 hover:text-ink"
            :class="{ 'text-ink': menuOpen }"
            :aria-expanded="menuOpen"
            aria-haspopup="true"
            @click="onToggle"
          >
            Family
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <div v-show="menuOpen" class="absolute top-full right-0 z-50 pt-4">
            <div class="grid w-[18rem] gap-0.5 rounded-[18px] bg-card p-2 shadow-[0_0_0_1px_var(--color-line-2),0_30px_60px_-20px_rgba(0,0,0,0.8)]">
              <a
                v-for="item in FAMILY"
                :key="item.name"
                :href="item.href"
                target="_blank"
                rel="noopener"
                class="group flex items-center gap-3 rounded-[12px] px-2.5 py-2 hover:bg-[rgba(255,255,255,0.06)]"
              >
                <span class="grid size-9 flex-none place-items-center rounded-[10px] bg-bg shadow-[0_0_0_1px_var(--color-line)]" v-html="item.icon" />
                <span class="grid gap-0.5">
                  <b class="text-[0.92rem] leading-tight font-semibold text-ink">{{ item.name }}</b>
                  <small class="text-[0.78rem] leading-snug text-ink-2">{{ item.tagline }}</small>
                </span>
              </a>
            </div>
          </div>
        </div>
        <a :href="GITHUB_MICROTS" target="_blank" rel="noopener" class="pill-white max-[640px]:hidden" aria-label="MicroTS on GitHub">GitHub</a>
      </div>
    </nav>
  </header>
</template>
