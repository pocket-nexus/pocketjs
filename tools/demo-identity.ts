import { existsSync, readFileSync } from "node:fs";

export interface DemoIdentity {
  readonly id: string;
  readonly name: string;
  readonly title: string;
}

/** Stable manifest identity used by every stock-demo entry point. */
export function demoIdentity(demo: string): DemoIdentity {
  const normalized = demo.replace(/-main$/, "");
  return {
    id: `dev.pocket-nexus.${normalized.replace(/-/g, ".")}`,
    name: `pocketjs-${normalized}`,
    title: `PocketJS ${normalized}`,
  };
}

/**
 * The manifest a stock demo builds with: its own apps/<name>/pocket.json
 * when committed (the truthful capability declaration), else the legacy
 * synthesis — the repo-root template with this demo's identity spliced in.
 * `framework` overrides only apply to the synthesized path; a real manifest
 * owns its framework.
 */
export function demoManifestFor(
  root: string,
  demo: string,
  framework?: string,
): Record<string, unknown> {
  const own = `${root}apps/${demo}/pocket.json`;
  if (existsSync(own)) {
    return JSON.parse(readFileSync(own, "utf8")) as Record<string, unknown>;
  }
  const manifest = JSON.parse(readFileSync(`${root}pocket.json`, "utf8")) as Record<string, any>;
  const identity = demoIdentity(demo);
  manifest.id = identity.id;
  manifest.name = identity.name;
  manifest.title = identity.title;
  manifest.app.entry = `apps/${demo}/main.tsx`;
  manifest.app.output = `${demo}-main`;
  if (framework) manifest.app.framework = framework;
  return manifest;
}
