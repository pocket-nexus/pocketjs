import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jsxPlugin,
  packagePath,
  transformFile,
  type PocketFramework,
} from "../framework/compiler/jsx-plugin.ts";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { SUBPATHS, resolvesIn } from "../framework/compiler/subpaths.ts";
import type { HostOps } from "../framework/src/host.ts";

async function bundlePlatform(defines: Record<string, string> = {}) {
  const result = await Bun.build({
    entrypoints: [new URL("../framework/src/platform.ts", import.meta.url).pathname],
    format: "esm",
    target: "bun",
    define: defines,
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]!.text();
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as Promise<{
    platform: { target: string; pixelRatio: number; features: Record<string, boolean> };
    hasFeature: (feature: "input.buttons") => boolean;
  }>;
}

describe("platform feature availability", () => {
  test("embeds the resolved feature map in manifest builds", async () => {
    const runtime = await bundlePlatform({
      __POCKET_TARGET__: JSON.stringify("psp"),
      __POCKET_FEATURES__: JSON.stringify({ "input.buttons": true }),
      __POCKET_PIXEL_RATIO__: "1",
    });
    expect(runtime.platform).toEqual({
      target: "psp",
      pixelRatio: 1,
      features: { "input.buttons": true },
    });
    expect(runtime.hasFeature("input.buttons")).toBe(true);
  });

  test("legacy builds have an unknown target and no feature claims", async () => {
    const runtime = await bundlePlatform();
    expect(runtime.platform).toEqual({ target: "unknown", pixelRatio: 1, features: {} });
    expect(runtime.hasFeature("input.buttons")).toBe(false);
  });

  test("exposes the resolved raster density to dynamic texture producers", async () => {
    const runtime = await bundlePlatform({
      __POCKET_TARGET__: JSON.stringify("vita-test"),
      __POCKET_FEATURES__: "{}",
      __POCKET_PIXEL_RATIO__: "2",
    });
    expect(runtime.platform.pixelRatio).toBe(2);
  });
});

const featureSource = `
  import { hasFeature as supports } from "@pocketjs/framework/platform";
  export const renderer = supports("text.glyphs.baked")
    ? "BAKED_TEXT_SENTINEL"
    : "HOST_TEXT_SENTINEL";
`;

describe.each(["solid", "vue-vapor"] as const)("%s feature specialization", (framework) => {
  test("cache keys include the resolved feature map", async () => {
    const path = `/virtual/${framework}/feature-cache.ts`;
    const available = await transformFile(path, featureSource, framework, {
      features: { "text.glyphs.baked": true },
    });
    const unavailable = await transformFile(path, featureSource, framework, {
      features: { "text.glyphs.baked": false },
    });
    expect(available.code).toContain("true");
    expect(unavailable.code).toContain("false");
    expect(available.code).not.toBe(unavailable.code);
  });

  test("Bun removes the unavailable branch even without minification", async () => {
    const available = await bundleFeatureBranch(framework, true);
    expect(available).toContain("BAKED_TEXT_SENTINEL");
    expect(available).not.toContain("HOST_TEXT_SENTINEL");

    const unavailable = await bundleFeatureBranch(framework, false);
    expect(unavailable).not.toContain("BAKED_TEXT_SENTINEL");
    expect(unavailable).toContain("HOST_TEXT_SENTINEL");
  });
});

test("feature folding rejects dynamic and shadowed calls", async () => {
  const source = `
    import { hasFeature } from "@pocketjs/framework/platform";
    const feature = "text.glyphs.baked" as const;
    export const dynamic = hasFeature(feature);
    export function choose(hasFeature: (id: string) => boolean) {
      return hasFeature("text.glyphs.baked");
    }
  `;
  const result = await transformFile("/virtual/feature-dynamic.ts", source, "solid", {
    features: { "text.glyphs.baked": true },
  });
  expect(result.code.match(/hasFeature\(/g)).toHaveLength(2);
});

test("the build resolver owns every published framework export", async () => {
  const packageJson = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json() as { exports: Record<string, string> };
  for (const exported of Object.keys(packageJson.exports)) {
    const spec = exported === "."
      ? "@pocketjs/framework"
      : `@pocketjs/framework${exported.slice(1)}`;
    const framework = exported === "./vue-vapor" ||
        exported.startsWith("./vue-vapor/")
      ? "vue-vapor"
      : "solid";
    const key = exported === "." ? "" : exported.slice(2);
    const row = SUBPATHS[key] ?? SUBPATHS[key.replace(/^(?:solid|vue-vapor|octane)(?:\/|$)/, "")];
    // The UI compiler resolves its own domain's rows and refuses the rest by name.
    if (resolvesIn(row, "ui")) expect(packagePath(spec, framework), spec).not.toBeNull();
    else expect(() => packagePath(spec, framework), spec).toThrow(/worker domain/);
  }
});

test("external apps share PocketJS's Solid runtime identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-external-solid-"));
  const entry = join(directory, "main.ts");
  const duplicatePackage = join(directory, "node_modules", "solid-js");
  try {
    await Bun.write(join(duplicatePackage, "package.json"), JSON.stringify({
      name: "solid-js",
      version: "0.0.0-duplicate",
      type: "module",
      exports: "./index.js",
    }));
    await Bun.write(
      join(duplicatePackage, "index.js"),
      'export const createSignal = () => "DUPLICATE_SOLID_RUNTIME";\n',
    );
    await Bun.write(entry, `
      import { createSignal } from "solid-js";
      import { render } from "@pocketjs/framework/solid";
      globalThis.__externalSolidProbe = [createSignal, render];
    `);
    const result = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"',
        __POCKET_TARGET__: '"symbian-e7-dev"',
        __POCKET_HOST_ABI__: String(POCKET_BINDING_GENERATION),
        __POCKET_FEATURES__: "{}",
        __POCKET_PIXEL_RATIO__: "1",
      },
      plugins: [jsxPlugin("solid", { entry })],
    });
    expect(result.success).toBe(true);
    expect(await result.outputs[0]!.text()).not.toContain(
      "DUPLICATE_SOLID_RUNTIME",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parallel bundles receive their own generated style table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-parallel-styles-"));
  const entry = join(directory, "main.ts");
  try {
    await Bun.write(entry, `
      import { render } from "@pocketjs/framework/solid";
      globalThis.__parallelStyleProbe = render;
    `);
    const bundle = async (marker: string): Promise<string> => {
      const result = await Bun.build({
        entrypoints: [entry],
        format: "iife",
        target: "browser",
        conditions: ["browser"],
        define: {
          "process.env.NODE_ENV": '"production"',
          __POCKET_TARGET__: '"symbian-e7-dev"',
          __POCKET_HOST_ABI__: String(POCKET_BINDING_GENERATION),
          __POCKET_FEATURES__: "{}",
          __POCKET_PIXEL_RATIO__: "1",
        },
        plugins: [jsxPlugin("solid", {
          entry,
          generatedStyles:
            `globalThis.__pocketStyleBuildMarker = ${JSON.stringify(marker)};\n` +
            `export const STYLE_IDS: Record<string, number> = ${JSON.stringify({ [marker]: 1 })};`,
        })],
      });
      expect(result.success).toBe(true);
      return await result.outputs[0]!.text();
    };
    const [first, second] = await Promise.all([
      bundle("STYLE_BUILD_ALPHA"),
      bundle("STYLE_BUILD_BETA"),
    ]);
    expect(first).toContain("STYLE_BUILD_ALPHA");
    expect(first).not.toContain("STYLE_BUILD_BETA");
    expect(second).toContain("STYLE_BUILD_BETA");
    expect(second).not.toContain("STYLE_BUILD_ALPHA");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function bundleFeatureBranch(
  framework: PocketFramework,
  available: boolean,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pocketjs-feature-fold-"));
  const entry = join(directory, "main.ts");
  try {
    await Bun.write(entry, featureSource);
    const result = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      target: "browser",
      minify: false,
      plugins: [
        jsxPlugin(framework, {
          features: { "text.glyphs.baked": available },
        }),
      ],
    });
    expect(result.success).toBe(true);
    return result.outputs[0]!.text();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type AnalogSample = readonly [x: number, y: number, packed: number];

interface AnalogProbeGlobals {
  ui?: HostOps;
  frame?: (buttons: number, analog?: number) => void;
  __pocketAnalogSamples?: AnalogSample[];
  __disposePocketAnalogProbe?: () => void;
}

function analogProbeHost(): HostOps {
  let nextId = 2;
  const noop = () => {};
  return {
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 1,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: () => 0,
  };
}

async function bundleAnalogProbe(framework: PocketFramework): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pocketjs-${framework}-analog-`));
  const entry = join(directory, "main.tsx");
  const runtime = framework === "solid"
    ? "@pocketjs/framework/solid"
    : "@pocketjs/framework/vue-vapor";
  try {
    await Bun.write(entry, `
      import { render } from "${runtime}";
      import { View } from "${runtime}/components";
      import { analogRaw, analogX, analogY, onFrame } from "${runtime}/lifecycle";

      globalThis.__pocketAnalogSamples = [];
      globalThis.__disposePocketAnalogProbe = render(() => {
        onFrame(() => {
          globalThis.__pocketAnalogSamples.push([analogX(), analogY(), analogRaw()]);
        });
        return <View />;
      }, { ops: globalThis.ui, styles: {} });
    `);
    const result = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"',
        __POCKET_TARGET__: '"vita"',
        __POCKET_HOST_ABI__: String(POCKET_BINDING_GENERATION),
        __POCKET_FEATURES__: JSON.stringify({ "input.analog.left": true }),
        __POCKET_PIXEL_RATIO__: "2",
      },
      plugins: [jsxPlugin(framework, { entry })],
    });
    expect(result.success).toBe(true);
    return result.outputs[0]!.text();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.each(["solid", "vue-vapor"] as const)("%s input capability contract", (framework) => {
  test("delivers the advertised Vita left analog sample and centers legacy frames", async () => {
    expect(POCKET_TARGETS.vita.capabilities).toContain("input.analog.left");

    const globals = globalThis as typeof globalThis & AnalogProbeGlobals;
    globals.ui = analogProbeHost();
    try {
      const bundle = await bundleAnalogProbe(framework);
      (0, eval)(bundle);
      expect(typeof globals.frame).toBe("function");

      globals.frame!(0, 0xff80);
      globals.frame!(0, 0x80ff);
      globals.frame!(0, 0x0080);
      globals.frame!(0, 0x8000);
      globals.frame!(0); // PSP and pre-analog hosts still call frame(buttons).

      expect(globals.__pocketAnalogSamples).toEqual([
        [1, 0, 0xff80],
        [0, 1, 0x80ff],
        [-1, 0, 0x0080],
        [0, -1, 0x8000],
        [0, 0, 0x8080],
      ]);
    } finally {
      globals.__disposePocketAnalogProbe?.();
      delete globals.__disposePocketAnalogProbe;
      delete globals.__pocketAnalogSamples;
      delete globals.frame;
      delete globals.ui;
    }
  });
});
