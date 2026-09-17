import type { ScenarioV1 } from "./types.ts";

export const DEFAULT_BUILD_RENDER_CONFIG = Object.freeze({
  width: 480,
  height: 272,
  rasterDensity: 1,
  renderScale: 1,
});

export const BUILD_RENDER_LIMITS = Object.freeze({
  width: 32_000,
  height: 32_000,
  rasterDensity: 255,
  renderScale: 4,
});

export interface BuildRenderConfig {
  readonly width: number;
  readonly height: number;
  readonly rasterDensity: number;
  readonly renderScale: number;
}

export interface BuildRenderConfigIssue {
  /** Path relative to the scenario params object. */
  readonly path: readonly string[];
  readonly message: string;
}

export class BuildRenderConfigError extends TypeError {
  readonly issues: readonly BuildRenderConfigIssue[];

  constructor(issues: readonly BuildRenderConfigIssue[]) {
    super(issues.map(({ path, message }) => (
      `${path.length > 0 ? path.join(".") : "params"}: ${message}`
    )).join("; "));
    this.name = "BuildRenderConfigError";
    this.issues = issues;
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/**
 * Resolve the build/raster contract shared by Native and QEMU perf adapters.
 *
 * The bounds intentionally match the host ABI: logical dimensions are
 * limited by `createWasmUi`, density by the asset builder, and render scale by
 * the core software rasterizer.
 */
export function buildRenderConfig(params: unknown): BuildRenderConfig {
  const issues: BuildRenderConfigIssue[] = [];
  if (!isPlainRecord(params)) {
    throw new BuildRenderConfigError([{ path: [], message: "expected an object" }]);
  }

  if (!Object.hasOwn(params, "viewport")) return { ...DEFAULT_BUILD_RENDER_CONFIG };
  const viewport = params.viewport;
  if (!isPlainRecord(viewport)) {
    throw new BuildRenderConfigError([{
      path: ["viewport"],
      message: "expected an object",
    }]);
  }

  const allowed = new Set<keyof BuildRenderConfig>([
    "width",
    "height",
    "rasterDensity",
    "renderScale",
  ]);
  for (const key of Object.keys(viewport)) {
    if (!allowed.has(key as keyof BuildRenderConfig)) {
      issues.push({ path: ["viewport", key], message: "unexpected property" });
    }
  }

  const integer = <K extends keyof BuildRenderConfig>(key: K): number => {
    const fallback = DEFAULT_BUILD_RENDER_CONFIG[key];
    if (!Object.hasOwn(viewport, key)) return fallback;
    const value = viewport[key];
    const maximum = BUILD_RENDER_LIMITS[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      issues.push({
        path: ["viewport", key],
        message: `expected an integer from 1 through ${maximum}`,
      });
      return fallback;
    }
    return value;
  };

  const config: BuildRenderConfig = {
    width: integer("width"),
    height: integer("height"),
    rasterDensity: integer("rasterDensity"),
    renderScale: integer("renderScale"),
  };
  if (issues.length > 0) throw new BuildRenderConfigError(issues);
  return config;
}

/** Build output varies with the resolved entry, framework and asset density. */
export function artifactBuildVariantKey(
  scenario: Pick<ScenarioV1, "subject" | "params">,
): string {
  const { rasterDensity } = buildRenderConfig(scenario.params);
  return `${scenario.subject.id}\0${scenario.subject.entry}\0${scenario.subject.framework}\0density=${rasterDensity}`;
}

export function rgbaFramebufferByteLength(config: BuildRenderConfig): number {
  const width = config.width * config.renderScale;
  const height = config.height * config.renderScale;
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RangeError("scaled framebuffer dimensions overflow");
  }
  return bytes;
}
