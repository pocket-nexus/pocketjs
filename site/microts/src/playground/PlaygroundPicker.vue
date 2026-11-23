<script setup lang="ts">
// Starting-point picker: new project, your projects, examples. Full page on the start screen; inside the Browse popover in the workspace (compact).
import { onMounted, ref } from "vue";
import SectionHead from "../components/SectionHead.vue";
import { PRESET_GROUPS } from "./presets";
import { TEMPLATES, type Template } from "./templates";
import { deleteProject, listProjects, timeAgo, type Project } from "./projects";
import { ICON_RETRO } from "../site";

const props = defineProps<{
  compact?: boolean;
  /** Id of the open example or project, for highlighting */
  current?: string;
}>();
const emit = defineEmits<{ pick: []; deleted: [id: string] }>();

const projects = ref<Project[]>([]);
onMounted(() => (projects.value = listProjects()));

function remove(p: Project) {
  if (!confirm(`Delete "${p.name}"? It is stored only in this browser.`)) return;
  deleteProject(p.id);
  projects.value = listProjects();
  emit("deleted", p.id);
}

// Main file first, entry last
const templateFiles = (t: Template) => [...new Set([t.open, ...Object.keys(t.files).sort(), t.entry])];
const FRAMEWORK_LABEL: Record<string, string> = { "vue-vapor": "Vue SFC", solid: "Solid TSX", retro: "Pocket Retro" };
const isCurrent = (id: string) => props.current === id;
</script>

<template>
  <div>
    <!-- New project -->
    <section :class="compact ? 'mb-8' : 'mb-16'">
      <SectionHead v-if="!compact" size="sm" title="New project" lede="A project keeps its files in this browser. Add, rename and delete files, and share it as a link." />
      <h3 v-else class="mb-3 flex items-baseline gap-2.5">
        <span class="h-card !text-[18px]">New project</span>
        <span class="text-[0.82rem] text-muted">saved in this browser</span>
      </h3>
      <div class="grid md:grid-cols-3" :class="compact ? 'gap-3' : 'gap-[18px]'">
        <RouterLink
          v-for="t in TEMPLATES"
          :key="t.id"
          :to="`/playground/new/${t.id}`"
          class="card card-top card-link group flex min-w-0 flex-col"
          :class="[t.hue, compact ? 'px-4 pt-4 pb-4 max-md:py-3.5' : 'px-6 pt-6 pb-6']"
          @click="emit('pick')"
        >
          <div class="flex items-center gap-3">
            <span
              class="grid flex-none place-items-center rounded-xl bg-bg font-mono text-[0.68rem] font-semibold text-[var(--hue)] shadow-[0_0_0_1px_var(--color-line)]"
              :class="compact ? 'size-9 [&_svg]:size-7' : 'size-11 [&_svg]:size-8'"
              v-html="t.id === 'retro' ? ICON_RETRO : t.id === 'solid' ? 'TSX' : 'VUE'"
            />
            <!-- Compact mode: title on the same row as the icon -->
            <h4 v-if="compact" class="h-card min-w-0 truncate !text-[17px]">{{ t.title }}</h4>
            <span class="ml-auto text-[1.4rem] leading-none font-light text-ink-2 transition-transform group-hover:rotate-90 group-hover:text-ink" aria-hidden="true">+</span>
          </div>
          <h4 v-if="!compact" class="h-card mt-5">{{ t.title }}</h4>
          <p v-if="!compact" class="mt-1.5 flex-1 text-[15px] leading-relaxed text-ink-2">{{ t.blurb }}</p>
          <div class="flex flex-wrap gap-1.5" :class="compact ? 'mt-3 max-md:hidden' : 'mt-5'">
            <span v-for="f in templateFiles(t)" :key="f" class="badge font-mono">{{ f }}</span>
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- Your projects -->
    <section v-if="projects.length" :class="compact ? 'mb-8' : 'mb-16'">
      <SectionHead v-if="!compact" size="sm" title="Your projects" />
      <h3 v-else class="h-card mb-3 !text-[18px]">Your projects</h3>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li
          v-for="p in projects"
          :key="p.id"
          class="card flex min-w-0 items-center gap-3 !rounded-[16px] py-3 pr-3 pl-4 transition-shadow hover:shadow-[0_0_0_1px_var(--color-line-2)]"
          :class="isCurrent(p.id) && '!shadow-[0_0_0_2px_var(--color-cyan)]'"
        >
          <RouterLink :to="`/playground/p/${p.id}`" class="min-w-0 flex-1" @click="emit('pick')">
            <div class="flex items-center gap-2">
              <span class="truncate text-[1rem] font-semibold text-ink">{{ p.name }}</span>
              <span v-if="isCurrent(p.id)" class="tag hue-cyan flex-none">open</span>
            </div>
            <div class="mt-0.5 truncate text-[0.78rem] text-muted">
              {{ FRAMEWORK_LABEL[p.framework] }} · {{ Object.keys(p.files).length }} {{ Object.keys(p.files).length === 1 ? "file" : "files" }} · edited
              {{ timeAgo(p.updatedAt) }}
            </div>
          </RouterLink>
          <button type="button" class="tool !min-h-8 !px-2.5 !text-[0.78rem]" :aria-label="`Delete ${p.name}`" @click="remove(p)">Delete</button>
        </li>
      </ul>
    </section>

    <!-- Examples -->
    <section>
      <SectionHead
        v-if="!compact"
        size="sm"
        title="Examples"
        lede="Open an example to read and edit its source. <b>Copy to project</b> in the toolbar turns it into a project of your own."
      />
      <h3 v-else class="h-card mb-3 !text-[18px]">Examples</h3>
      <div v-for="group in PRESET_GROUPS" :key="group.title" :class="[group.hue, compact ? 'mb-6' : 'mb-10']">
        <h4 class="kick flex items-center gap-2" :class="compact ? 'mb-2.5 !text-[11.5px]' : 'mb-4'">
          <i class="size-1.5 rounded-full bg-[var(--hue)]" aria-hidden="true" /> {{ group.title }}
        </h4>
        <div v-if="group.items[0]?.kind === 'ui'" class="grid sm:grid-cols-2 lg:grid-cols-4" :class="compact ? 'gap-3' : 'gap-[14px]'">
          <RouterLink
            v-for="p in group.items"
            :key="p.id"
            :to="`/playground/${p.id}`"
            class="card card-link min-w-0 !rounded-[18px] px-4"
            :class="[isCurrent(p.id) && '!shadow-[0_0_0_2px_var(--color-cyan)]', compact ? 'pt-3 pb-3' : 'pt-4 pb-4']"
            @click="emit('pick')"
          >
            <div class="flex items-center gap-2">
              <span
                class="grid h-6 flex-none place-items-center rounded-md px-1.5 font-mono text-[0.62rem] font-semibold"
                :class="p.framework === 'solid' ? 'bg-[rgba(79,136,198,0.2)] text-[#9cc3ee]' : 'bg-[rgba(66,184,131,0.18)] text-[#7ee2b8]'"
              >
                {{ p.framework === "solid" ? "TSX" : "VUE" }}
              </span>
              <span class="truncate font-disp text-[16px] font-bold tracking-[-0.01em]">{{ p.title }}</span>
              <span v-if="isCurrent(p.id)" class="tag hue-cyan ml-auto flex-none">open</span>
            </div>
            <p class="mt-2 text-[0.86rem] leading-snug text-ink-2" :class="compact ? 'line-clamp-2' : ''">{{ p.blurb }}</p>
          </RouterLink>
        </div>
        <div v-else class="grid" :class="compact ? 'grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8' : 'grid-cols-2 gap-[14px] sm:grid-cols-3 lg:grid-cols-6'">
          <RouterLink v-for="p in group.items" :key="p.id" :to="`/playground/${p.id}`" class="group block min-w-0" @click="emit('pick')">
            <div
              class="relative overflow-hidden rounded-[14px] bg-black transition group-hover:-translate-y-0.5"
              :class="isCurrent(p.id) ? 'shadow-[0_0_0_2px_var(--color-cyan)]' : 'shadow-[0_0_0_1px_var(--color-line)] group-hover:shadow-[0_0_0_1px_var(--color-line-2)]'"
              style="aspect-ratio: 1"
            >
              <img :src="p.poster" :alt="p.title" loading="lazy" class="h-full w-full object-contain [image-rendering:pixelated]" />
              <span v-if="isCurrent(p.id)" class="tag hue-cyan absolute top-1.5 left-1.5 !bg-[rgba(6,34,42,0.85)]">open</span>
            </div>
            <div class="mt-2 truncate font-semibold group-hover:text-ink" :class="compact ? 'text-[0.84rem] text-ink-2' : 'text-[0.94rem]'">{{ p.title }}</div>
            <div v-if="!compact" class="truncate text-[0.76rem] text-muted">by {{ p.credit }}</div>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>
