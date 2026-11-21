import { createRouter, createWebHistory } from "vue-router";
import { createProject, uniqueName } from "./playground/projects";
import { findTemplate } from "./playground/templates";
import { decodeShare } from "./playground/share";

const playground = () => import("./pages/PlaygroundPage.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("./pages/HomePage.vue") },
    { path: "/docs", redirect: "/docs/microts" },
    { path: "/docs/:slug", name: "docs", component: () => import("./pages/DocsPage.vue") },
    // Start page: new project, your projects, examples
    { path: "/playground", name: "playground-home", component: () => import("./pages/PlaygroundHome.vue") },
    // Create a project from a template, save it, then redirect to the project page
    {
      path: "/playground/new/:template",
      name: "playground-new",
      component: playground,
      beforeEnter: (to) => {
        const t = findTemplate(String(to.params.template));
        if (!t) return { name: "playground-home" };
        const project = createProject({
          name: uniqueName(t.title),
          template: t.id,
          framework: t.framework,
          entry: t.entry,
          open: t.open,
          files: { ...t.files },
          retroAssets: null,
        });
        return { name: "playground-project", params: { id: project.id }, replace: true };
      },
    },
    // Shared project: imported as a new local project
    {
      path: "/playground/import",
      name: "playground-import",
      component: playground,
      beforeEnter: async (to) => {
        const token = to.hash.match(/^#s=(.+)$/)?.[1];
        const data = token ? await decodeShare(token) : null;
        if (!data) return { name: "playground-home" };
        if ("preset" in data) return { name: "playground", params: { preset: data.preset }, hash: to.hash, replace: true };
        const project = createProject({ ...data.project, name: uniqueName(data.project.name) });
        return { name: "playground-project", params: { id: project.id }, replace: true };
      },
    },
    { path: "/playground/p/:id", name: "playground-project", component: playground },
    { path: "/playground/:preset", name: "playground", component: playground },
    { path: "/:rest(.*)*", name: "not-found", component: () => import("./pages/NotFoundPage.vue") },
  ],
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash && !to.hash.startsWith("#s=")) return { el: decodeURIComponent(to.hash), top: 88 };
    return { top: 0 };
  },
});

const TITLE = "MicroTS";
router.afterEach((to) => {
  if (to.name === "home") document.title = `${TITLE} · TypeScript compiled ahead of time to native code`;
  else if (to.name === "playground-home") document.title = `Playground · ${TITLE}`;
  else if (to.name === "not-found") document.title = `Not found · ${TITLE}`;
});
