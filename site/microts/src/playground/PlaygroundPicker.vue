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
    <section :class="compact ? 'mb-8' : 'mb-14'">
      <SectionHead v-if="!compact" title="New project" :start="1" lede="A project keeps its files in this browser. Add, rename and delete files, and share it as a link." />
      <h3 v-else class="mb-3 flex items-center gap-2 font-round text-[1.05rem] font-semibold text-ink">
        <span class="spark hue-yellow !size-3.5" aria-hidden="true" /> New project
        <span class="text-[0.82rem] font-medium text-muted">saved in this browser</span>
      </h3>
      <div class="grid md:grid-cols-3" :class="compact ? 'gap-3' : 'gap-5'">
        <RouterLink
          v-for="t in TEMPLATES"
          :key="t.id"
          :to="`/playground/new/${t.id}`"
          class="shell card-hover group flex flex-col"
          :class="[t.hue, compact ? 'px-4 pt-3.5 pb-4 max-md:py-3' : 'px-5 pt-5 pb-5']"
          @click="emit('pick')"
        >
          <div class="flex items-center gap-3">
            <span
              class="grid flex-none place-items-center rounded-xl border-2 border-drop bg-bg-2 font-px text-[0.6rem] text-[var(--hue)] shadow-[0_3px_0_#0a0614]"
              :class="compact ? 'size-9 [&_svg]:size-7' : 'size-11 [&_svg]:size-8'"
              v-html="t.id === 'retro' ? ICON_RETRO : t.id === 'solid' ? 'TSX' : 'VUE'"
            />
            <!-- Compact mode: title on the same row as the icon -->
            <h4 v-if="compact" class="min-w-0 truncate font-round text-[1.08rem] font-semibold">{{ t.title }}</h4>
            <span class="ml-auto font-px text-[1.1rem] text-[var(--hue)] transition-transform group-hover:rotate-90" aria-hidden="true">+</span>
          </div>
          <h4 v-if="!compact" class="mt-4 font-round text-[1.25rem] font-semibold">{{ t.title }}</h4>
          <p v-if="!compact" class="mt-1.5 flex-1 text-[0.9rem] leading-relaxed text-soft">{{ t.blurb }}</p>
          <div class="flex flex-wrap gap-1.5" :class="compact ? 'mt-3 max-md:hidden' : 'mt-4'">
            <span v-for="f in templateFiles(t)" :key="f" class="badge font-mono">{{ f }}</span>
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- Your projects -->
    <section v-if="projects.length" :class="compact ? 'mb-8' : 'mb-14'">
      <SectionHead v-if="!compact" title="Your projects" :start="3" />
      <h3 v-else class="mb-3 flex items-center gap-2 font-round text-[1.05rem] font-semibold text-ink">
        <span class="spark hue-lilac !size-3.5" aria-hidden="true" /> Your projects
      </h3>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li
          v-for="p in projects"
          :key="p.id"
          class="flex items-center gap-3 rounded-[16px] border-[2.5px] bg-panel py-3 pr-3 pl-4 shadow-[0_4px_0_#0a0614] transition hover:border-yellow"
          :class="isCurrent(p.id) ? 'border-yellow' : 'border-[rgba(169,139,255,0.32)]'"
        >
          <RouterLink :to="`/playground/p/${p.id}`" class="min-w-0 flex-1" @click="emit('pick')">
            <div class="flex items-center gap-2">
              <span class="truncate font-round text-[1.02rem] font-semibold text-ink">{{ p.name }}</span>
              <span v-if="isCurrent(p.id)" class="tag hue-yellow flex-none">open</span>
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
        title="Examples"
        :start="0"
        lede="Open an example to read and edit its source. <b>Copy to project</b> in the toolbar turns it into a project of your own."
      />
      <h3 v-else class="mb-3 flex items-center gap-2 font-round text-[1.05rem] font-semibold text-ink">
        <span class="spark hue-cyan !size-3.5" aria-hidden="true" /> Examples
      </h3>
      <div v-for="group in PRESET_GROUPS" :key="group.title" :class="[group.hue, compact ? 'mb-6' : 'mb-10']">
        <h4 class="flex items-center gap-2 font-round font-semibold text-[var(--hue-l)]" :class="compact ? 'mb-2.5 text-[0.9rem]' : 'mb-4 text-[1.05rem]'">
          <span v-if="!compact" class="spark !size-3.5" aria-hidden="true" /> {{ group.title }}
        </h4>
        <div v-if="group.items[0]?.kind === 'ui'" class="grid sm:grid-cols-2 lg:grid-cols-4" :class="compact ? 'gap-3' : 'gap-4'">
          <RouterLink
            v-for="p in group.items"
            :key="p.id"
            :to="`/playground/${p.id}`"
            class="rounded-[18px] border-[2.5px] bg-panel px-4 shadow-[0_4px_0_#0a0614] transition hover:-translate-y-0.5 hover:border-yellow"
            :class="[isCurrent(p.id) ? 'border-yellow' : 'border-[rgba(63,208,232,0.35)]', compact ? 'pt-3 pb-3' : 'pt-3.5 pb-4']"
            @click="emit('pick')"
          >
            <div class="flex items-center gap-2">
              <span
                class="grid h-6 flex-none place-items-center rounded-md border-2 border-drop px-1.5 font-px text-[0.5rem]"
                :class="p.framework === 'solid' ? 'bg-[#2c4f7c] text-cyan-l' : 'bg-[#1f4a3c] text-[#7ee2b8]'"
              >
                {{ p.framework === "solid" ? "TSX" : "VUE" }}
              </span>
              <span class="truncate font-round text-[1rem] font-semibold">{{ p.title }}</span>
              <span v-if="isCurrent(p.id)" class="tag hue-yellow ml-auto flex-none">open</span>
            </div>
            <p class="mt-2 text-[0.84rem] leading-snug text-soft" :class="compact ? 'line-clamp-2' : ''">{{ p.blurb }}</p>
          </RouterLink>
        </div>
        <div v-else class="grid" :class="compact ? 'grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8' : 'grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6'">
          <RouterLink v-for="p in group.items" :key="p.id" :to="`/playground/${p.id}`" class="group block" @click="emit('pick')">
            <div
              class="scanlines relative overflow-hidden rounded-[14px] border-[3px] bg-black transition group-hover:-translate-y-1"
              :class="isCurrent(p.id) ? 'border-yellow shadow-[0_4px_0_#c99400]' : 'border-[var(--hue)] shadow-[0_4px_0_var(--hue-d)]'"
              style="aspect-ratio: 1"
            >
              <img :src="p.poster" :alt="p.title" loading="lazy" class="h-full w-full object-contain [image-rendering:pixelated]" />
              <span v-if="isCurrent(p.id)" class="tag hue-yellow absolute top-1.5 left-1.5">open</span>
            </div>
            <div class="mt-2 truncate font-round font-semibold group-hover:text-yellow" :class="compact ? 'text-[0.84rem]' : 'text-[0.92rem]'">{{ p.title }}</div>
            <div v-if="!compact" class="truncate text-[0.74rem] text-muted">by {{ p.credit }}</div>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>
