<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { DOC_ITEMS, DOC_NAV, loadDoc } from "../docs/nav";
import { GITHUB_POCKETJS } from "../site";
import { COMMIT } from "microts:build";

type Doc = Awaited<NonNullable<ReturnType<typeof loadDoc>>>;

const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params.slug));
const doc = ref<Doc | null>(null);
const missing = ref(false);
const activeId = ref("");
const body = ref<HTMLElement | null>(null);
const mobileNav = ref<HTMLDetailsElement | null>(null);

const index = computed(() => DOC_ITEMS.findIndex((d) => d.slug === slug.value));
const current = computed(() => DOC_ITEMS[index.value]);
const prev = computed(() => (index.value > 0 ? DOC_ITEMS[index.value - 1] : undefined));
const next = computed(() => (index.value >= 0 && index.value < DOC_ITEMS.length - 1 ? DOC_ITEMS[index.value + 1] : undefined));
const toc = computed(() => doc.value?.toc.filter((t) => t.depth === 2) ?? []);
const editUrl = computed(() => `${GITHUB_POCKETJS}/blob/main/site/content/docs/${slug.value}.md`);

let observer: IntersectionObserver | null = null;

async function load() {
  const load = loadDoc(slug.value);
  missing.value = !load;
  if (!load) {
    doc.value = null;
    document.title = "Not found · MicroTS";
    return;
  }
  doc.value = await load;
  document.title = `${doc.value.title} · MicroTS`;
  if (mobileNav.value) mobileNav.value.open = false;
  await nextTick();
  if (route.hash) document.getElementById(decodeURIComponent(route.hash.slice(1)))?.scrollIntoView();
  spy();
}

function spy() {
  observer?.disconnect();
  if (!body.value) return;
  const heads = [...body.value.querySelectorAll("h2[id]")];
  activeId.value = heads[0]?.id ?? "";
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activeId.value = e.target.id;
    },
    { rootMargin: "-80px 0px -70% 0px" },
  );
  heads.forEach((h) => observer!.observe(h));
}

// Internal links in docs go through the router to avoid a full page reload
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute("href") ?? "";
  if (a.hasAttribute("data-internal") || href.startsWith("#")) {
    e.preventDefault();
    if (href.startsWith("#")) {
      router.replace({ hash: href });
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: "smooth" });
    } else router.push(href);
  }
}

watch(slug, load, { immediate: true });
watch(
  () => route.hash,
  (h) => {
    if (h) nextTick(() => document.getElementById(decodeURIComponent(h.slice(1)))?.scrollIntoView());
  },
);
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="mx-auto w-full max-w-[84rem] lg:grid lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_210px]">
    <!-- Sidebar -->
    <aside class="hidden border-r border-line lg:block">
      <nav class="sticky top-[61px] max-h-[calc(100vh-61px)] overflow-y-auto px-5 py-9">
        <div v-for="sec in DOC_NAV" :key="sec.title" class="mb-7">
          <div class="kick mb-2 px-2.5 !text-[11.5px]">{{ sec.title }}</div>
          <RouterLink
            v-for="item in sec.items"
            :key="item.slug"
            :to="`/docs/${item.slug}`"
            class="block rounded-[9px] px-2.5 py-1.5 text-[0.9rem] leading-snug text-ink-2 transition-colors hover:text-ink"
            :class="item.slug === slug ? 'bg-[rgba(255,255,255,0.08)] font-medium !text-ink' : ''"
          >
            {{ item.title }}
          </RouterLink>
        </div>
        <div class="mt-8 grid gap-2 border-t border-line px-2.5 pt-6 text-[0.86rem]">
          <RouterLink to="/playground" class="font-semibold text-cyan hover:text-cyan-l">Open the playground →</RouterLink>
          <a href="https://pocketjs.pocket.nexus/docs/styling/" target="_blank" rel="noopener" class="font-semibold text-ink-2 hover:text-ink">
            PocketJS styling ↗
          </a>
        </div>
      </nav>
    </aside>

    <!-- Mobile docs index -->
    <details ref="mobileNav" class="sticky top-[61px] z-30 border-b border-line bg-[rgba(11,10,16,0.92)] backdrop-blur-[14px] lg:hidden">
      <summary class="wrap flex cursor-pointer items-center justify-between gap-3 py-3 text-[0.95rem] font-semibold">
        <span class="min-w-0 truncate"><span class="text-muted">Docs</span> · {{ current?.title ?? "MicroTS" }}</span>
        <span class="text-muted">▾</span>
      </summary>
      <div class="wrap grid gap-1 pb-4">
        <template v-for="sec in DOC_NAV" :key="sec.title">
          <div class="kick mt-3 mb-1 !text-[11.5px]">{{ sec.title }}</div>
          <RouterLink
            v-for="item in sec.items"
            :key="item.slug"
            :to="`/docs/${item.slug}`"
            class="rounded-[9px] px-2.5 py-1.5 text-[0.92rem] text-ink-2"
            :class="item.slug === slug ? 'bg-[rgba(255,255,255,0.08)] !text-ink' : ''"
          >
            {{ item.title }}
          </RouterLink>
        </template>
      </div>
    </details>

    <!-- Article -->
    <article class="min-w-0 px-[clamp(18px,4vw,3rem)] pt-12 pb-20">
      <div v-if="missing" class="py-20">
        <h1 class="h-page">Page not found</h1>
        <p class="mt-6 text-ink-2">
          There is no MicroTS page at this address. Start from
          <RouterLink to="/docs/microts" class="olink text-cyan">Build a native Vue app</RouterLink>.
        </p>
      </div>
      <template v-else-if="doc">
        <div class="mb-5 flex flex-wrap items-center gap-2">
          <span class="badge">{{ DOC_NAV.find((s) => s.items.some((i) => i.slug === slug))?.title }}</span>
          <a :href="editUrl" target="_blank" rel="noopener" class="badge hover:border-[rgba(255,255,255,0.35)] hover:text-ink">Source · pocketjs@{{ COMMIT.slice(0, 7) }}</a>
        </div>
        <h1 class="h-page max-w-[52rem] !text-[clamp(34px,4.2vw,50px)] !leading-[1.05]">{{ doc.title }}</h1>
        <div ref="body" class="doc mt-8 max-w-[52rem]" @click="onClick" v-html="doc.html" />

        <nav class="mt-14 grid max-w-[52rem] gap-[14px] border-t border-line pt-8 sm:grid-cols-2">
          <RouterLink
            v-if="prev"
            :to="`/docs/${prev.slug}`"
            class="card card-link grid gap-1 px-5 py-4"
          >
            <span class="text-[0.8rem] font-semibold text-muted">← Previous</span>
            <span class="font-disp text-[1.08rem] font-bold tracking-[-0.01em] text-ink">{{ prev.title }}</span>
          </RouterLink>
          <span v-else />
          <RouterLink
            v-if="next"
            :to="`/docs/${next.slug}`"
            class="card card-link grid gap-1 px-5 py-4 text-right"
          >
            <span class="text-[0.8rem] font-semibold text-muted">Next →</span>
            <span class="font-disp text-[1.08rem] font-bold tracking-[-0.01em] text-ink">{{ next.title }}</span>
          </RouterLink>
        </nav>
      </template>
    </article>

    <!-- On this page -->
    <aside class="hidden xl:block">
      <nav v-if="toc.length" class="sticky top-[61px] max-h-[calc(100vh-61px)] overflow-y-auto py-12 pr-5">
        <div class="kick mb-3 !text-[11.5px]">On this page</div>
        <a
          v-for="t in toc"
          :key="t.id"
          :href="`#${t.id}`"
          class="block border-l-2 py-1 pl-3 text-[0.84rem] leading-snug transition-colors"
          :class="activeId === t.id ? 'border-cyan text-ink' : 'border-line text-muted hover:text-ink-2'"
          @click.prevent="onClick($event)"
        >
          {{ t.text }}
        </a>
      </nav>
    </aside>
  </div>
</template>
