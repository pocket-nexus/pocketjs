<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CandyText from "../components/CandyText.vue";
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
    <aside class="hidden lg:block" style="border-right: 3px dotted rgba(203, 189, 226, 0.12)">
      <nav class="sticky top-[calc(3.6rem+3px)] max-h-[calc(100vh-3.6rem)] overflow-y-auto px-5 py-8">
        <div v-for="sec in DOC_NAV" :key="sec.title" class="mb-6">
          <div class="mb-2 px-2.5 font-round text-[0.86rem] font-semibold tracking-[0.02em] text-pink-l">{{ sec.title }}</div>
          <RouterLink
            v-for="item in sec.items"
            :key="item.slug"
            :to="`/docs/${item.slug}`"
            class="block rounded-[9px] px-2.5 py-1.5 text-[0.9rem] leading-snug text-[#ab9ccb] transition-colors hover:text-ink"
            :class="item.slug === slug ? '!text-out bg-yellow font-medium shadow-[0_2px_0_#0a0614]' : ''"
          >
            {{ item.title }}
          </RouterLink>
        </div>
        <div class="mt-8 grid gap-2 px-2.5 text-[0.84rem]">
          <RouterLink to="/playground" class="font-round font-semibold text-cyan hover:text-yellow">Open the playground →</RouterLink>
          <a href="https://pocketjs.pocket.nexus/docs/styling/" target="_blank" rel="noopener" class="font-round font-semibold text-[#ab9ccb] hover:text-yellow">
            PocketJS styling ↗
          </a>
        </div>
      </nav>
    </aside>

    <!-- Mobile docs index -->
    <details ref="mobileNav" class="sticky top-[calc(3.6rem+3px)] z-30 border-b-[3px] border-drop bg-[rgba(20,14,34,0.97)] lg:hidden">
      <summary class="wrap flex cursor-pointer items-center justify-between py-3 font-round text-[0.98rem] font-semibold">
        <span><span class="text-pink-l">Docs</span> · {{ current?.title ?? "MicroTS" }}</span>
        <span class="text-muted">▾</span>
      </summary>
      <div class="wrap grid gap-1 pb-4">
        <template v-for="sec in DOC_NAV" :key="sec.title">
          <div class="mt-2 font-round text-[0.8rem] font-semibold text-pink-l">{{ sec.title }}</div>
          <RouterLink
            v-for="item in sec.items"
            :key="item.slug"
            :to="`/docs/${item.slug}`"
            class="rounded-[9px] px-2.5 py-1.5 text-[0.92rem] text-ink-2"
            :class="item.slug === slug ? 'bg-yellow !text-out' : ''"
          >
            {{ item.title }}
          </RouterLink>
        </template>
      </div>
    </details>

    <!-- Article -->
    <article class="min-w-0 px-[clamp(1.25rem,4vw,3rem)] pt-10 pb-20">
      <div v-if="missing" class="py-20">
        <CandyText tag="h1" text="Page not found" class="text-[1.6rem] leading-[1.45]" :start="1" />
        <p class="mt-6 text-soft">
          There is no MicroTS page at this address. Start from
          <RouterLink to="/docs/microts" class="olink text-cyan">Build a native Vue app</RouterLink>.
        </p>
      </div>
      <template v-else-if="doc">
        <div class="mb-5 flex flex-wrap items-center gap-2">
          <span class="badge">{{ DOC_NAV.find((s) => s.items.some((i) => i.slug === slug))?.title }}</span>
          <a :href="editUrl" target="_blank" rel="noopener" class="badge hover:text-yellow">Source · pocketjs@{{ COMMIT.slice(0, 7) }}</a>
        </div>
        <CandyText
          :key="slug"
          tag="h1"
          :text="doc.title"
          :start="1"
          class="drop-in block pb-2 text-[1.9rem] leading-[1.5] max-[620px]:text-[1.35rem]"
        />
        <div ref="body" class="doc mt-8 max-w-[52rem]" @click="onClick" v-html="doc.html" />

        <nav class="mt-14 grid max-w-[52rem] gap-4 pt-8 sm:grid-cols-2" style="border-top: 3px dotted rgba(203, 189, 226, 0.14)">
          <RouterLink
            v-if="prev"
            :to="`/docs/${prev.slug}`"
            class="group grid gap-1 rounded-2xl border-[2.5px] border-[rgba(169,139,255,0.4)] bg-panel px-5 py-4 shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5 hover:border-yellow"
          >
            <span class="font-round text-[0.8rem] font-semibold tracking-[0.02em] text-lilac-l">← Previous</span>
            <span class="font-round text-[1.05rem] font-semibold text-ink">{{ prev.title }}</span>
          </RouterLink>
          <span v-else />
          <RouterLink
            v-if="next"
            :to="`/docs/${next.slug}`"
            class="group grid gap-1 rounded-2xl border-[2.5px] border-[rgba(169,139,255,0.4)] bg-panel px-5 py-4 text-right shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5 hover:border-yellow"
          >
            <span class="font-round text-[0.8rem] font-semibold tracking-[0.02em] text-lilac-l">Next →</span>
            <span class="font-round text-[1.05rem] font-semibold text-ink">{{ next.title }}</span>
          </RouterLink>
        </nav>
      </template>
    </article>

    <!-- On this page -->
    <aside class="hidden xl:block">
      <nav v-if="toc.length" class="sticky top-[calc(3.6rem+3px)] max-h-[calc(100vh-3.6rem)] overflow-y-auto py-10 pr-5">
        <div class="mb-3 font-mono text-[0.72rem] font-medium tracking-[0.09em] text-muted uppercase">On this page</div>
        <a
          v-for="t in toc"
          :key="t.id"
          :href="`#${t.id}`"
          class="block border-l-[3px] py-1 pl-3 text-[0.84rem] leading-snug transition-colors"
          :class="activeId === t.id ? 'border-yellow text-ink' : 'border-[rgba(203,189,226,0.12)] text-muted hover:text-ink-2'"
          @click.prevent="onClick($event)"
        >
          {{ t.text }}
        </a>
      </nav>
    </aside>
  </div>
</template>
