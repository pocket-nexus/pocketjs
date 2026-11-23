<script setup lang="ts">
// 404: the router renders this for any path without a route.
</script>

<template>
  <section class="relative">
    <div class="glow" aria-hidden="true" />
    <div class="wrap relative grid place-items-center py-32 text-center max-[640px]:py-24">
      <div class="kick">Error 404</div>
      <h1 class="h-hero grad mt-5 pb-[0.06em]">404</h1>
      <p class="mt-6 text-[19px] text-ink-2">This page compiled to nothing.</p>
      <div class="mt-9 flex flex-wrap justify-center gap-3">
        <RouterLink to="/" class="btn btn-pri">Home</RouterLink>
        <RouterLink to="/docs/microts" class="btn">Docs</RouterLink>
      </div>
    </div>
  </section>
</template>
