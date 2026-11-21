<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SiteNav from "./components/SiteNav.vue";
import SiteFooter from "./components/SiteFooter.vue";

const route = useRoute();
// The playground workspace fills the viewport with no footer; the start page is a regular page
const fullscreen = computed(() => route.name === "playground" || route.name === "playground-project");
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <SiteNav />
    <main class="flex-1" :class="fullscreen ? 'flex flex-col' : ''">
      <RouterView />
    </main>
    <SiteFooter v-if="!fullscreen" />
  </div>
</template>
