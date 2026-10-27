// Pocket Applet: the contract for the programs a launcher runs on behalf of
// the system (docs/APPLETS.md). An applet is a Pocket app that declares the
// manifest section `applet` and accepts stronger rules than an app, so that
//
//   - one program runs on every launcher host: one touch surface that admits
//     the 320x240 baseline (fixed at it, or adaptive across a range holding
//     it), no primary display, input the host maps to its own buttons;
//   - the system agent can read and operate it: system.agent is declared,
//     the UI is Solid on the PocketJS components, so the agent's text capture
//     and played input reach every control;
//   - a generated (UGC, model-written) applet can be admitted by checks
//     alone: a capability allowlist, declared network destinations, no
//     native code, no code evaluation, size budgets.
//
// The manifest rules below are checked when a plan resolves (framework/src/
// manifest/resolve.ts); the source and bundle rules when the build runs
// (tools/applet-check.ts, called by tools/build.ts).

import type { JsonSchema, PocketManifestV2 } from "./pocket-manifest.ts";

const APPLET_VERSION = 1 as const;

/** The manifest section. */
export interface AppletDeclaration {
  readonly version: typeof APPLET_VERSION;
  /** Companion services the applet fetches (`companionService(name, …)`,
   *  contracts/spec/link.ts LINK_SERVICES_ORIGIN). */
  readonly services?: readonly string[];
  /** Hosts the applet fetches directly through net.http. */
  readonly hosts?: readonly string[];
  /** Persistent state: required to declare data.fs; the host
   *  confines the store to the applet and to this many bytes. */
  readonly store?: { readonly maxBytes: number };
}

/** The largest store an applet may declare: 4 MiB. */
export const APPLET_STORE_MAX_BYTES = 4 * 1024 * 1024;

const serviceNameSchema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" } as const satisfies JsonSchema;
const hostSchema = {
  type: "string",
  maxLength: 253,
  pattern: "^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$",
} as const satisfies JsonSchema;

export const appletSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { const: APPLET_VERSION },
    services: { type: "array", items: serviceNameSchema, uniqueItems: true, maxItems: 8 },
    hosts: { type: "array", items: hostSchema, uniqueItems: true, maxItems: 8 },
    store: {
      type: "object",
      additionalProperties: false,
      required: ["maxBytes"],
      properties: { maxBytes: { type: "integer", minimum: 1, maximum: APPLET_STORE_MAX_BYTES } },
    },
  },
} as const satisfies JsonSchema;

/** The baseline surface every applet runs on: the 3DS touch screen, 320x240
 *  logical. An adaptive surface's range holds it. */
const APPLET_SURFACE = [320, 240] as const;

/** The longest title: what a springboard label and the agent's app list show. */
const APPLET_TITLE_MAX = 24;

/** Capabilities every applet requires: its surface and its input. */
const APPLET_REQUIRED = ["display.auxiliary", "input.touch.auxiliary"] as const;
/** Capabilities every applet enhances: the system agent operates it. */
const APPLET_ENHANCED = ["system.agent"] as const;

/** Every capability an applet may declare, required or enhanced. System
 *  capabilities (pairing, Wi-Fi, offload workers, launcher control) stay
 *  with the launcher. Any `camera.*` capability is allowed as well. */
const APPLET_CAPABILITIES = [
  "text.glyphs.baked",
  "text.glyphs.runtime",
  "input.buttons",
  "input.analog.left",
  "input.text",
  "display.auxiliary",
  "input.touch.auxiliary",
  "net.http",
  "ui.physics",
  "audio.pcm",
  "media.playback",
  "data.fs",
  "system.agent",
] as const;
const APPLET_CAPABILITY_PREFIXES = ["camera."] as const;
/** Capabilities that need `applet.store`. */
const APPLET_STORE_CAPABILITIES = ["data.fs"] as const;

/** Size budgets of a built applet (the guest bundle and its pak). */
export const APPLET_BUDGET = { jsBytes: 640 * 1024, pakBytes: 3 * 1024 * 1024 } as const;

/** `@pocketjs/framework/<subpath>` modules an applet may import. */
export const APPLET_MODULES = [
  "solid",
  "components",
  "lifecycle",
  "input",
  "animation",
  "clock",
  "host",
  "renderer",
  "net",
  "link",
  "gesture",
  "kinetics",
  "osk",
  "classic",
  "touch",
  "virtual-list",
  "physics",
  "media",
  "audio",
  "display",
  "platform",
] as const;
/** Modules allowed when the manifest declares the capability that gates them. */
export const APPLET_GATED_MODULES: Readonly<Record<string, readonly string[]>> = {
  camera: APPLET_CAPABILITY_PREFIXES,
  fs: ["data.fs"],
};
/** Exports of @pocketjs/framework/link that act for the system: installing,
 *  removing and pairing belong to the launcher. */
export const APPLET_SYSTEM_LINK_EXPORTS = ["installApp", "removeApp", "pairCompanion", "forgetCompanion", "requestCatalog"] as const;
/** Bare packages an applet may import besides @pocketjs/framework. */
export const APPLET_PACKAGES = ["solid-js", "solid-js/store"] as const;

/** A broken contract rule in a manifest, a platform registry or an applet's
 *  code (framework/src/manifest/validate.ts re-exports it). */
export interface ContractDiagnostic {
  readonly code: string;
  /** RFC 6901 JSON Pointer into the manifest (the root is the empty
   *  string), or a source path. */
  readonly path: string;
  readonly message: string;
}

/** Whether capability `id` is `pattern`, or in its family when the pattern
 *  ends in "." ("camera." matches "camera.qr"). */
export function capabilityMatches(id: string, pattern: string): boolean {
  return pattern.endsWith(".") ? id.startsWith(pattern) : id === pattern;
}

function appletCapabilityAllowed(id: string): boolean {
  return [...APPLET_CAPABILITIES, ...APPLET_CAPABILITY_PREFIXES].some((pattern) => capabilityMatches(id, pattern));
}

/** The manifest rules for a manifest that declares `applet`. */
export function appletManifestDiagnostics(manifest: PocketManifestV2): ContractDiagnostic[] {
  const applet = manifest.applet;
  if (!applet) return [];
  const out: ContractDiagnostic[] = [];
  const push = (code: string, path: string, message: string) => out.push({ code: `applet.${code}`, path, message });
  const requires = manifest.engine.capabilities.requires;
  const enhances = manifest.engine.capabilities.enhances ?? [];
  const declared = [...requires, ...enhances];

  if (manifest.title.length > APPLET_TITLE_MAX) {
    push("title", "/title", `an applet title has at most ${APPLET_TITLE_MAX} characters; ${JSON.stringify(manifest.title)} has ${manifest.title.length}`);
  }
  if (manifest.app.framework !== "solid") push("framework", "/app/framework", "an applet is a Solid app");
  if (manifest.app.model === "rust") push("nativeModel", "/app/model", "an applet ships no native code: model \"rust\" is not allowed");
  if (manifest.app.companions?.length) push("companions", "/app/companions", "an applet reaches the companion through applet.services, not svc companions");
  if (manifest.app.presentations?.length) push("presentations", "/app/presentations", "an applet has one presentation: its touch surface");
  const surface = manifest.app.surfaces?.auxiliary;
  const [baseW, baseH] = APPLET_SURFACE;
  const admitsBaseline = surface?.adaptive
    ? surface.adaptive.min[0] <= baseW && surface.adaptive.min[1] <= baseH &&
      surface.adaptive.max[0] >= baseW && surface.adaptive.max[1] >= baseH
    : surface?.fixed?.logical[0] === baseW && surface.fixed.logical[1] === baseH;
  if (!admitsBaseline) {
    push(
      "surface",
      "/app/surfaces/auxiliary",
      `an applet draws one touch surface (app.surfaces.auxiliary) that admits ${baseW}x${baseH}: fixed at it, or adaptive across a range holding it`,
    );
  }
  for (const id of APPLET_REQUIRED) {
    if (!requires.includes(id)) push("required", "/engine/capabilities/requires", `an applet requires ${id}`);
  }
  for (const id of APPLET_ENHANCED) {
    if (!declared.includes(id)) push("agent", "/engine/capabilities/enhances", `an applet enhances ${id}, so the system agent can operate it`);
  }
  declared.forEach((id) => {
    if (!appletCapabilityAllowed(id)) {
      const kind = requires.includes(id) ? "requires" : "enhances";
      push("capability", `/engine/capabilities/${kind}/${(kind === "requires" ? requires : enhances).indexOf(id)}`, `${id} is not available to applets`);
    }
  });
  const usesStore = declared.some((id) => (APPLET_STORE_CAPABILITIES as readonly string[]).includes(id));
  if (usesStore && !applet.store) push("store", "/applet/store", "data.fs needs applet.store with maxBytes");
  const network = (applet.services?.length ?? 0) + (applet.hosts?.length ?? 0) > 0;
  if (network && !declared.includes("net.http")) push("network", "/engine/capabilities", "applet.services and applet.hosts need net.http");
  return out;
}
