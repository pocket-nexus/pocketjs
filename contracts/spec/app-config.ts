// The application a host config builds: the `app` section of
// pocket.host.config.ts (framework/src/host-config.ts). The build resolver
// (framework/compiler/app-plan.ts) turns it into the build plan for one of
// the config's hosts; the plan, not this section, is the compiler's input.
import type { AnimationTheme } from "./animation-theme.ts";
import { animationThemeSchema } from "./animation-theme.ts";
import { validateSchema, type ContractDiagnostic, type JsonSchema } from "./json-schema.ts";
import { appViewportSchema, surfacesSchema, type AppViewport, type SurfacesSpec } from "./viewport.ts";
import { workerDeclarationSchema, type WorkerDeclarationSource } from "./worker.ts";

export const POCKET_FRAMEWORKS = ["solid", "vue-vapor", "octane"] as const;
export type PocketFramework = (typeof POCKET_FRAMEWORKS)[number];

export interface AppConfig {
  /** The mounted module, relative to the config file. */
  readonly entry: string;
  readonly framework: PocketFramework;
  readonly viewport: AppViewport;
  /** Artifact name; absent, the entry's file name without its extension. */
  readonly output?: string;
  /** Reverse-DNS application id the device packagers stamp (PSP title,
   *  Vita title id, bundle id, SMDH). Absent, `local.<output>`. */
  readonly id?: string;
  /** Absent, the output name. */
  readonly title?: string;
  /** `major.minor.patch`. Absent, `0.1.0`. */
  readonly version?: string;
  readonly author?: string;
  /** A square PNG, relative to the config file. `pocket compile` stores it as
   *  the variant's cover section. */
  readonly icon?: string;
  /** Host capabilities this build turns on. Each must be registered; the
   *  plan's `features[name]` is true when the selected host provides it. */
  readonly features?: readonly string[];
  /** Additional UI outputs; `surfaces.auxiliary` comes with the
   *  `display.auxiliary` feature. */
  readonly surfaces?: SurfacesSpec;
  /** Animation content baked into the style table. */
  readonly theme?: AnimationTheme;
  /** Admit the complete Solid component graph to the AOT view subset. */
  readonly aot?: boolean;
  readonly model?: "rust" | "compiled";
  readonly recursionLimit?: number;
  /**
   * Core ticks per virtual second the package is compiled at, 1 through 60;
   * absent, 60. A host runs it at the largest cadence the rate is a whole
   * multiple of (contracts/spec/admission.ts).
   */
  readonly tickHz?: number;
  /** A second QuickJS runtime beside the UI realm (contracts/spec/worker.ts);
   *  its entry is relative to the config file. */
  readonly worker?: WorkerDeclarationSource;
  /** Companion service names the application's svc adapters speak (the
   *  exact strings it passes to `svcOpen`). Hosts derive their svc allowlist
   *  from the plan's copy of this list. */
  readonly companions?: readonly string[];
}

/** A registered capability id: dot-separated lowercase labels. */
const capabilityIdSchema = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$",
} as const satisfies JsonSchema;

/** A relative module path without `..` segments or backslashes. */
const entrySchema = {
  type: "string",
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.tsx?$",
} as const satisfies JsonSchema;

export const APP_OUTPUT_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const APP_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$";
export const APP_VERSION_PATTERN = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";

const outputSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: APP_OUTPUT_PATTERN,
} as const satisfies JsonSchema;

export const appConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entry", "framework", "viewport"],
  properties: {
    entry: entrySchema,
    framework: { enum: POCKET_FRAMEWORKS },
    viewport: appViewportSchema,
    output: outputSchema,
    id: { type: "string", minLength: 3, pattern: APP_ID_PATTERN },
    title: { type: "string", minLength: 1, maxLength: 128 },
    version: { type: "string", pattern: APP_VERSION_PATTERN },
    author: { type: "string", minLength: 1, maxLength: 128 },
    icon: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.png$" },
    features: { type: "array", items: capabilityIdSchema, uniqueItems: true },
    surfaces: surfacesSchema,
    theme: animationThemeSchema,
    aot: { type: "boolean" },
    model: { enum: ["rust", "compiled"] },
    recursionLimit: { type: "integer", minimum: 1, default: 256 },
    tickHz: { type: "integer", minimum: 1, maximum: 60, default: 60 },
    worker: workerDeclarationSchema,
    companions: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64, pattern: APP_OUTPUT_PATTERN },
      uniqueItems: true,
    },
  },
} as const satisfies JsonSchema;

/** Check an `app` section's shape. Paths are JSON Pointers under `/app`. */
export function validateAppConfig(app: unknown): readonly ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  let value: unknown;
  try {
    // A config is a module: the section must be JSON data.
    value = JSON.parse(JSON.stringify(app ?? null));
  } catch {
    return [{ code: "app.notJson", path: "/app", message: "the app section must be JSON data" }];
  }
  validateSchema(value, appConfigSchema, "/app", diagnostics);
  return diagnostics;
}
