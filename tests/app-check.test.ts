import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkAppTypes, checkProjectTypes, frameworkPaths } from "../framework/compiler/app-check.ts";

const FIXTURES = new URL("fixtures/app-check/", import.meta.url).pathname;
const ROOT_TSCONFIG = new URL("../tsconfig.json", import.meta.url).pathname;
const JSX_DECLARATIONS = new URL("../framework/src/jsx.d.ts", import.meta.url).pathname;
const VUE_SFC_DECLARATIONS = new URL("../framework/src/vue-sfc.d.ts", import.meta.url).pathname;
const SOLID_CONTROL_FLOW_ENTRY = new URL("../apps/cards/main.tsx", import.meta.url).pathname;

function entry(fixture: string): string {
  const sourceDirectory = resolve(FIXTURES, fixture);
  const directory = mkdtempSync(resolve(tmpdir(), `pocketjs-${fixture}-fixture-`));
  mkdirSync(directory, { recursive: true });
  for (const source of readdirSync(sourceDirectory)) {
    if (!source.endsWith(".txt")) continue;
    writeFileSync(
      resolve(directory, source.slice(0, -".txt".length)),
      readFileSync(resolve(sourceDirectory, source)),
    );
  }
  return resolve(directory, "main.ts");
}

function checkFixture(fixture: string, tsconfigPath?: string): ReturnType<typeof checkAppTypes> {
  const fixtureEntry = entry(fixture);
  try {
    return checkAppTypes({ entry: fixtureEntry, tsconfigPath });
  } finally {
    rmSync(dirname(fixtureEntry), { recursive: true, force: true });
  }
}

function errors(result: ReturnType<typeof checkAppTypes>): string {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("\n");
}

describe("per-app TypeScript checks", () => {
  test("checks only the entry import graph", () => {
    const result = checkFixture("baseline");

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/main.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/controls.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
  });

  test("inherits app compiler options without broadening to the app include set", () => {
    const result = checkFixture("baseline", ROOT_TSCONFIG);

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
    expect(result.artifacts.tsconfig).toContain(`"extends": ${JSON.stringify(ROOT_TSCONFIG)}`);
  });

  test("resolves the public manifest and platform subpaths from the app config", () => {
    const result = checkFixture("framework-import", ROOT_TSCONFIG);

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  test("keeps Solid control-flow children contextually typed without lib.dom", () => {
    const result = checkAppTypes({
      entry: SOLID_CONTROL_FLOW_ENTRY,
      tsconfigPath: ROOT_TSCONFIG,
      declarationFiles: [JSX_DECLARATIONS],
    });

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  test("accepts a Vue SFC import at a Vue Vapor app entry", () => {
    const fixtureEntry = entry("vue-sfc");
    try {
      const result = checkAppTypes({
        entry: fixtureEntry,
        tsconfigPath: ROOT_TSCONFIG,
        declarationFiles: [JSX_DECLARATIONS, VUE_SFC_DECLARATIONS],
      });

      expect(errors(result)).toBe("");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dirname(fixtureEntry), { recursive: true, force: true });
    }
  });

  test("reports reachable TypeScript errors", () => {
    const result = checkFixture("error");

    expect(result.ok).toBe(false);
    expect(errors(result)).toContain("Type 'string' is not assignable to type 'number'");
  });
});

describe("a project with no tsconfig and no packages", () => {
  const FRAMEWORK_ROOT = new URL("..", import.meta.url).pathname;

  function project(files: Record<string, string>): string {
    const directory = mkdtempSync(resolve(tmpdir(), "pocketjs-project-check-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(resolve(directory, name), text);
    return directory;
  }

  const located = (result: ReturnType<typeof checkProjectTypes>, directory: string): string =>
    result.diagnostics.map((item) => `${item.file?.replace(/^\/private/, "").replace(directory.replace(/^\/private/, "") + "/", "")}:${item.line} TS${item.code}`).join("\n");

  test("resolves the framework and solid-js from the PocketJS root alone", () => {
    const directory = project({
      "main.tsx": [
        'import { createSignal, Show } from "solid-js";',
        'import { mount } from "@pocketjs/framework/solid";',
        'import { Text, View } from "@pocketjs/framework/components";',
        'import { animate } from "@pocketjs/framework/animation";',
        'import { onFrame } from "@pocketjs/framework/lifecycle";',
        'import { score } from "./game.ts";',
        "function App() {",
        "  const [on, setOn] = createSignal(false);",
        "  onFrame(() => void setOn(score(1) > 0));",
        "  console.log(typeof animate);",
        '  return <View class="flex-col" style={{ width: 120, translateX: 4, bgColor: "#231b3b" }}><Show when={on()}><Text class="text-xl">go</Text></Show></View>;',
        "}",
        "mount(() => <App />);",
        "",
      ].join("\n"),
      "game.ts": "export const score = (n: number): number => n + 1;\n",
    });
    try {
      const result = checkProjectTypes({ entry: resolve(directory, "main.tsx"), frameworkRoot: FRAMEWORK_ROOT });
      expect(located(result, directory)).toBe("");
      expect(result.ok).toBe(true);
      expect(result.checkedFiles.map((file) => file.slice(file.lastIndexOf("/") + 1))).toEqual(["game.ts", "main.tsx"]);
      // The check leaves nothing behind in the project.
      expect(readdirSync(directory).sort()).toEqual(["game.ts", "main.tsx"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports a style prop that is no PocketJS prop, a wrong import and a wrong call, with file and line", () => {
    const directory = project({
      "main.tsx": [
        'import { mount } from "@pocketjs/framework/solid";',
        'import { Text, View, type NodeMirror } from "@pocketjs/framework/components";',
        'import { animate } from "@pocketjs/framework/animation";',
        'import { virtualFrames } from "@pocketjs/framework/clock";',
        'import { BTN } from "@pocketjs/framework/inputs";',
        "let node: NodeMirror | undefined;",
        'const go = () => node && animate(node, "scal", 1, { dur: 100 });',
        "void [go, virtualFrames, BTN];",
        "mount(() => (",
        "  <View ref={(n) => (node = n)} style={{ widht: 10 }}>",
        '    <Text style={{ color: "#ffffff" }}>x</Text>',
        "  </View>",
        "));",
        "",
      ].join("\n"),
    });
    try {
      const result = checkProjectTypes({ entry: resolve(directory, "main.tsx"), frameworkRoot: FRAMEWORK_ROOT });
      expect(result.ok).toBe(false);
      expect(located(result, directory).split("\n").sort()).toEqual([
        "main.tsx:10 TS2561",
        "main.tsx:11 TS2561",
        "main.tsx:4 TS2724",
        "main.tsx:5 TS2307",
        "main.tsx:7 TS2769",
      ]);
      const text = result.diagnostics.map((item) => item.message).join("\n");
      expect(text).toContain("'widht' does not exist in type 'StyleObject'. Did you mean to write 'width'?");
      expect(text).toContain("'color' does not exist in type 'StyleObject'");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("frameworkPaths follows the subpath registry for the framework", () => {
    const solid = frameworkPaths("/pocketjs");
    expect(solid["@pocketjs/framework"]).toEqual(["/pocketjs/framework/src/index.ts"]);
    expect(solid["@pocketjs/framework/clock"]).toEqual(["/pocketjs/framework/src/clock.ts"]);
    expect(solid["@pocketjs/framework/solid/components"]).toEqual(["/pocketjs/framework/src/components.ts"]);
    expect(frameworkPaths("/pocketjs", "vue-vapor")["@pocketjs/framework/components"]).toEqual(["/pocketjs/framework/src/components-vue-vapor.ts"]);
    // osk is Solid-only: a Vue Vapor project that imports it gets the build's own error.
    expect(frameworkPaths("/pocketjs", "vue-vapor")["@pocketjs/framework/osk"]).toBeUndefined();
  });
});
