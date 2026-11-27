// The application a host config builds: the `app` section of
// pocket.host.config.ts (framework/src/host-config.ts). The build resolver
// (framework/compiler/app-plan.ts) turns it into the build plan for one of
// the config's hosts; the plan, not this section, is the compiler's input.
import type { AnimationTheme } from "./animation-theme.ts";
import { animationThemeSchema } from "./animation-theme.ts";
import { validateSchema, type ContractDiagnostic, type JsonSchema } from "./json-schema.ts";
import type { FeatureId } from "./capabilities.ts";
import { appViewportSchema, surfacesSchema, type AppViewport, type SurfacesSpec } from "./viewport.ts";
import { workerDeclarationSchema, type WorkerDeclarationSource } from "./worker.ts";

/** A package specifier: a package name and an optional subpath, never a
 *  relative or absolute path (`three`, `three/webgpu`, `@scope/pkg/sub`). */
const PACKAGE_SPECIFIER_PATTERN = "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:/[A-Za-z0-9._-]+)*$";

export const POCKET_FRAMEWORKS = ["solid", "vue-vapor", "octane"] as const;
export type PocketFramework = (typeof POCKET_FRAMEWORKS)[number];

/** The faces the build bakes for each kind of font slot, each a TTF or OTF
 *  file relative to the config file. An absent field keeps the default
 *  face: Inter Regular, Inter Bold, JetBrains Mono. */
export interface AppFonts {
  /** The regular-weight proportional slots. */
  readonly regular?: string;
  /** The `font-bold` slots. */
  readonly bold?: string;
  /** The `font-mono` slots. */
  readonly mono?: string;
  /** Named faces, each a TTF or OTF file: `font-<name>` selects one for the
   *  slots in `slots` that name it. Names are lower-case letters and digits
   *  and cannot be `regular`, `bold`, `mono` or `normal`. */
  readonly faces?: Readonly<Record<string, string>>;
  /** Slots beyond the built-in type ramp (slots 0..20): each binds a slot
   *  index from APP_FONT_SLOT_FIRST to MAX_FONT_SLOTS - 1 to a size and a
   *  face. `text-[Npx]` with `font-bold`, `font-mono` or `font-<name>`
   *  selects it; a declared (px, face) pair wins over a built-in slot of the
   *  same pair. */
  readonly slots?: readonly AppFontSlot[];
}

/** One application font slot (`app.fonts.slots`). */
export interface AppFontSlot {
  /** Slot index, APP_FONT_SLOT_FIRST..MAX_FONT_SLOTS - 1. */
  readonly slot: number;
  /** Text size in logical px. */
  readonly px: number;
  /** `regular`, `bold`, `mono` or a name from `app.fonts.faces`. */
  readonly face: string;
  /** Default line height in logical px; absent, the face's ascent +
   *  descent + line gap at `px`. */
  readonly lineHeight?: number;
}

export const APP_FONT_FACES = ["regular", "bold", "mono"] as const;
/** The first slot index `app.fonts.slots` may bind. Slots 21 and 22 are
 *  PocketUI's run-time faces; 23 stays free. */
export const APP_FONT_SLOT_FIRST = 24;
/** Mirrors spec.ts MAX_FONT_SLOTS (this module stays free of spec imports). */
const APP_FONT_SLOT_END = 64;
/** A named face: lower-case letters and digits, not a built-in kind. */
export const APP_FONT_FACE_NAME = "^(?!(?:regular|bold|mono|normal)$)[a-z][a-z0-9]{0,23}$";

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
   *  the bundle's icon section. */
  readonly icon?: string;
  /** Host capabilities this build turns on. Each is registered or defined by
   *  the selected host's contract; the plan's `features[name]` is true when
   *  that host provides it. */
  readonly features?: readonly FeatureId[];
  /** Additional UI outputs; `surfaces.auxiliary` comes with the
   *  `display.auxiliary` feature. */
  readonly surfaces?: SurfacesSpec;
  /** Animation content baked into the style table. */
  readonly theme?: AnimationTheme;
  /** The font faces the glyph atlases are baked from. */
  readonly fonts?: AppFonts;
  /** Package specifiers the bundle resolves as other package specifiers, for
   *  every importer including dependencies: `{ three: "three/webgpu" }`. */
  readonly alias?: Readonly<Record<string, string>>;
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

/** A capability id, registered or host-defined: dot-separated lowercase
 *  labels. */
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

/** A relative TTF or OTF path without `..` segments or backslashes. */
const fontFileSchema = {
  type: "string",
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.(?:ttf|otf)$",
} as const satisfies JsonSchema;

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
    alias: {
      type: "object",
      additionalProperties: { type: "string", pattern: PACKAGE_SPECIFIER_PATTERN },
    },
    fonts: {
      type: "object",
      additionalProperties: false,
      properties: {
        regular: fontFileSchema,
        bold: fontFileSchema,
        mono: fontFileSchema,
        faces: { type: "object", additionalProperties: fontFileSchema },
        slots: {
          type: "array",
          maxItems: APP_FONT_SLOT_END - APP_FONT_SLOT_FIRST,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["slot", "px", "face"],
            properties: {
              slot: { type: "integer", minimum: APP_FONT_SLOT_FIRST, maximum: APP_FONT_SLOT_END - 1 },
              px: { type: "integer", minimum: 6, maximum: 200 },
              face: { type: "string", pattern: "^[a-z][a-z0-9]{0,23}$" },
              lineHeight: { type: "integer", minimum: 1, maximum: 255 },
            },
          },
        },
      },
    },
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
  if (diagnostics.length === 0) validateFontSlots((value as AppConfig).fonts, diagnostics);
  if (diagnostics.length === 0) validateAlias((value as AppConfig).alias, diagnostics);
  return diagnostics;
}

/** `app.alias` keys are package specifiers too, and none maps to itself. */
function validateAlias(alias: AppConfig["alias"], diagnostics: ContractDiagnostic[]): void {
  for (const [from, to] of Object.entries(alias ?? {})) {
    if (!new RegExp(PACKAGE_SPECIFIER_PATTERN).test(from)) {
      diagnostics.push({ code: "app.aliasSpecifier", path: `/app/alias/${from}`, message: `${JSON.stringify(from)} is not a package specifier` });
    } else if (from === to) {
      diagnostics.push({ code: "app.aliasSelf", path: `/app/alias/${from}`, message: `${JSON.stringify(from)} maps to itself` });
    }
  }
}

/** Face names, slot indices and (px, face) pairs of `app.fonts`. */
function validateFontSlots(fonts: AppFonts | undefined, diagnostics: ContractDiagnostic[]): void {
  if (!fonts) return;
  const named = Object.keys(fonts.faces ?? {});
  for (const name of named) {
    if (!new RegExp(APP_FONT_FACE_NAME).test(name)) {
      diagnostics.push({ code: "app.fontFaceName", path: `/app/fonts/faces/${name}`, message: `face name ${JSON.stringify(name)} must be lower-case letters and digits and not regular, bold, mono or normal` });
    }
  }
  const faces = new Set<string>([...APP_FONT_FACES, ...named]);
  const slots = new Set<number>(), pairs = new Set<string>();
  (fonts.slots ?? []).forEach((slot, index) => {
    const at = `/app/fonts/slots/${index}`;
    if (!faces.has(slot.face)) diagnostics.push({ code: "app.fontSlotFace", path: `${at}/face`, message: `face ${JSON.stringify(slot.face)} is not regular, bold, mono or a name in app.fonts.faces` });
    if (slots.has(slot.slot)) diagnostics.push({ code: "app.fontSlotIndex", path: `${at}/slot`, message: `slot ${slot.slot} is bound twice` });
    const pair = `${slot.px}/${slot.face}`;
    if (pairs.has(pair)) diagnostics.push({ code: "app.fontSlotPair", path: at, message: `${slot.px}px ${slot.face} is bound twice` });
    slots.add(slot.slot);
    pairs.add(pair);
  });
}
