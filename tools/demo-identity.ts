import { existsSync } from "node:fs";
import { readPocketManifest } from "../framework/src/manifest/load.ts";

export interface DemoIdentity {
  readonly id: string;
  readonly title: string;
}

/** Stable manifest identity used by every stock-demo entry point. */
export function demoIdentity(demo: string): DemoIdentity {
  const normalized = demo.replace(/-main$/, "");
  return {
    id: `dev.pocket-nexus.${normalized.replace(/-/g, ".")}`,
    title: `PocketJS ${normalized}`,
  };
}

/**
 * The manifest a stock demo builds with: its own apps/<name>/pocket.app.json
 * when committed (the truthful capability declaration), else the legacy
 * synthesis — the hero manifest with this demo's identity spliced in.
 * `framework` overrides only apply to the synthesized path; a real manifest
 * owns its framework.
 */
export function demoManifestFor(
  root: string,
  demo: string,
  framework?: string,
): Record<string, unknown> {
  const own = `${root}apps/${demo}/pocket.app.json`;
  if (existsSync(own)) {
    return readPocketManifest(own).manifest as Record<string, unknown>;
  }
  // The hero manifest is the template; its AOT settings are its own.
  const manifest = readPocketManifest(`${root}apps/hero/pocket.app.json`).manifest as Record<string, any>;
  delete manifest.app.aot;
  delete manifest.app.model;
  const identity = demoIdentity(demo);
  manifest.id = identity.id;
  manifest.title = identity.title;
  manifest.app.entry = `apps/${demo}/main.tsx`;
  manifest.app.output = `${demo}-main`;
  if (framework) manifest.app.framework = framework;
  return manifest;
}
