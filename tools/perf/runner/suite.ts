import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseScenarioV1 } from "../core/index.ts";
import type { FrameworkId, ScenarioV1 } from "../core/types.ts";
import { isDamageScenario, runNativeDamageScenario } from "../executors/damage.ts";
import { runNativeVaporScenario } from "../executors/vapor.ts";
import {
  loadScenario,
  runNativeQuick,
  type NativeRunOptions,
  type NativeRunResult,
} from "./native.ts";

export interface NativeSuiteResult {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.native-suite-result";
  readonly suite: string;
  readonly estimatedSeconds: number;
  readonly results: readonly NativeRunResult[];
}

export interface NativeSuiteAdapters {
  readonly damage: (
    scenario: ScenarioV1,
    options: { readonly sourceRoot: string; readonly harnessRoot: string; readonly outDir?: string },
  ) => Promise<NativeRunResult>;
  readonly vapor: (
    scenario: ScenarioV1,
    options: { readonly sourceRoot: string; readonly harnessRoot: string; readonly outDir?: string },
  ) => Promise<NativeRunResult>;
}

const DEFAULT_SUITE_ADAPTERS: NativeSuiteAdapters = {
  damage: runNativeDamageScenario,
  vapor: runNativeVaporScenario,
};

export function loadScenarioSuite(
  suite: string,
  scenarioDir = new URL("../scenarios", import.meta.url).pathname,
): ScenarioV1[] {
  return readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => loadScenario(join(scenarioDir, file)))
    .filter((scenario) => scenario.suite === suite);
}

export function estimatedSuiteSeconds(scenarios: readonly ScenarioV1[]): number {
  return scenarios.reduce((total, scenario) => {
    const estimate = scenario.params.estimatedSeconds;
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) {
      throw new Error(`${scenario.id}: params.estimatedSeconds must be a non-negative number`);
    }
    return total + estimate;
  }, 0);
}

/** Expand only manifests that explicitly request a framework matrix. */
export function expandScenarioFrameworks(scenario: ScenarioV1): ScenarioV1[] {
  const configured = scenario.params.frameworks;
  if (configured === undefined) return [scenario];
  if (scenario.subject.family !== "guest-app" || !Array.isArray(configured) || configured.length === 0) {
    throw new Error(`${scenario.id}: params.frameworks requires a non-empty guest-app framework list`);
  }
  const allowed = new Set<FrameworkId>(["solid", "vue-vapor", "octane"]);
  const artifactSuffix: Readonly<Record<Exclude<FrameworkId, "core">, string>> = {
    solid: "",
    "vue-vapor": ".vue-vapor",
    octane: ".octane",
  };
  const configuredSubjects = scenario.params.frameworkSubjects;
  if (configuredSubjects !== undefined &&
      (typeof configuredSubjects !== "object" || configuredSubjects === null ||
        Array.isArray(configuredSubjects))) {
    throw new Error(`${scenario.id}: params.frameworkSubjects must be an object`);
  }
  const subjectOverrides = configuredSubjects as Record<string, unknown> | undefined;
  for (const framework of Object.keys(subjectOverrides ?? {})) {
    if (!allowed.has(framework as FrameworkId) || !configured.includes(framework)) {
      throw new Error(`${scenario.id}: frameworkSubjects has unconfigured framework ${framework}`);
    }
  }
  const seen = new Set<string>();
  return configured.map((framework) => {
    if (typeof framework !== "string" || !allowed.has(framework as FrameworkId)) {
      throw new Error(`${scenario.id}: unknown params.frameworks entry ${JSON.stringify(framework)}`);
    }
    if (seen.has(framework)) throw new Error(`${scenario.id}: duplicate framework ${framework}`);
    seen.add(framework);
    const override = subjectOverrides?.[framework];
    if (override !== undefined &&
        (typeof override !== "object" || override === null || Array.isArray(override))) {
      throw new Error(`${scenario.id}: frameworkSubjects.${framework} must be an object`);
    }
    const subject = override as Record<string, unknown> | undefined;
    const unknownSubjectKeys = Object.keys(subject ?? {}).filter((key) => key !== "id" && key !== "entry");
    if (unknownSubjectKeys.length > 0) {
      throw new Error(
        `${scenario.id}: frameworkSubjects.${framework} has unknown fields ${unknownSubjectKeys.join(", ")}`,
      );
    }
    const id = subject?.id ?? scenario.subject.id;
    const entry = subject?.entry ??
      `${scenario.subject.entry}${artifactSuffix[framework as Exclude<FrameworkId, "core">]}`;
    if (typeof id !== "string" || id.length === 0 || typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${scenario.id}: frameworkSubjects.${framework} requires non-empty id and entry`);
    }
    return parseScenarioV1({
      ...scenario,
      subject: {
        ...scenario.subject,
        framework,
        id,
        entry,
      },
    });
  });
}

export function expandSuiteFrameworks(scenarios: readonly ScenarioV1[]): ScenarioV1[] {
  return scenarios.flatMap(expandScenarioFrameworks);
}

/** Run serially: every sim boot temporarily owns process-wide guest globals. */
export async function runNativeSuite(
  suite: string,
  options: NativeRunOptions & {
    readonly scenarioDir?: string;
    readonly maxEstimatedSeconds?: number;
    readonly harnessRoot?: string;
    /** Tests may replace the two specialized, expensive adapters. */
    readonly suiteAdapters?: NativeSuiteAdapters;
  },
): Promise<NativeSuiteResult> {
  const scenarios = expandSuiteFrameworks(loadScenarioSuite(suite, options.scenarioDir));
  if (scenarios.length === 0) throw new Error(`no performance scenarios in suite ${JSON.stringify(suite)}`);
  const estimatedSeconds = estimatedSuiteSeconds(scenarios);
  if (
    options.maxEstimatedSeconds !== undefined &&
    estimatedSeconds > options.maxEstimatedSeconds
  ) {
    throw new Error(
      `${suite} suite estimate ${estimatedSeconds}s exceeds the ${options.maxEstimatedSeconds}s limit`,
    );
  }
  const results: NativeRunResult[] = [];
  const sourceRoot = resolve(options.sourceRoot);
  const harnessRoot = resolve(
    options.harnessRoot ?? new URL("../../..", import.meta.url).pathname,
  );
  const adapters = options.suiteAdapters ?? DEFAULT_SUITE_ADAPTERS;
  for (const scenario of scenarios) {
    if (isDamageScenario(scenario)) {
      results.push(await adapters.damage(scenario, {
        sourceRoot,
        harnessRoot,
        outDir: options.outDir,
      }));
    } else if (scenario.subject.family === "vapor") {
      results.push(await adapters.vapor(scenario, {
        sourceRoot,
        harnessRoot,
        outDir: options.outDir,
      }));
    } else {
      results.push(await runNativeQuick(scenario, {
        sourceRoot,
        outDir: options.outDir,
        bootAdapter: options.bootAdapter,
      }));
    }
  }
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.native-suite-result",
    suite,
    estimatedSeconds,
    results,
  };
}
