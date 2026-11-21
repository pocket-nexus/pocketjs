// "New project" templates. The files are small and ship in the main bundle.
import vueFiles from "microts:files/template/vue";
import solidFiles from "microts:files/template/solid";
import retroFiles from "microts:files/template/retro";
import type { PresetFramework } from "./presets";

export type TemplateId = "vue" | "solid" | "retro";

export interface Template {
  id: TemplateId;
  title: string;
  framework: PresetFramework;
  blurb: string;
  entry: string;
  open: string;
  files: Record<string, string>;
  /** Extensions allowed for new files */
  extensions: string[];
  hue: string;
}


export const TEMPLATES: Template[] = [
  {
    id: "vue",
    title: "Vue SFC app",
    framework: "vue-vapor",
    blurb: "A Vue single-file component and its basename TypeScript module, mounted on a 480 × 272 screen.",
    entry: "main.ts",
    open: "App.vue",
    files: vueFiles,
    extensions: [".vue", ".ts"],
    hue: "hue-cyan",
  },
  {
    id: "solid",
    title: "Solid TSX app",
    framework: "solid",
    blurb: "A Solid TSX view over a createSignal model, mounted on a 480 × 272 screen.",
    entry: "main.tsx",
    open: "App.tsx",
    files: solidFiles,
    extensions: [".tsx", ".ts"],
    hue: "hue-lilac",
  },
  {
    id: "retro",
    title: "Pocket Retro game",
    framework: "retro",
    blurb: "setup(), update() and draw() against the Pyxel-compatible SDK. The same file builds a GBA ROM.",
    entry: "game.ts",
    open: "game.ts",
    files: retroFiles,
    extensions: [".ts"],
    hue: "hue-pink",
  },
];

export function findTemplate(id: string | undefined): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateFor(framework: PresetFramework): Template {
  return TEMPLATES.find((t) => t.framework === framework)!;
}

/** Initial contents of a new file */
export function stubFor(file: string, framework: PresetFramework): string {
  const base = file.split("/").pop()!.replace(/\.(vue|tsx?|ts)$/, "");
  if (file.endsWith(".vue"))
    return `<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
</script>

<template>
  <View class="p-2 rounded-lg bg-slate-800">
    <Text class="text-sm text-white">${base}</Text>
  </View>
</template>
`;
  if (file.endsWith(".tsx"))
    return `import { Text, View } from "@pocketjs/framework/solid/components";

export default function ${base.replace(/[^A-Za-z0-9_]/g, "") || "Component"}() {
  return (
    <View class="p-2 rounded-lg bg-slate-800">
      <Text class="text-sm text-white">${base}</Text>
    </View>
  );
}
`;
  if (framework === "retro")
    return `import type { i32 } from "@pocketjs/framework/solid/std";

export function clampToScreen(v: i32, size: i32, limit: i32): i32 {
  return v < 0 ? 0 : v + size > limit ? limit - size : v;
}
`;
  return `import type { i32 } from "@pocketjs/framework/${framework === "solid" ? "solid" : "vue-vapor"}/std";

export const answer: i32 = 42;
`;
}
