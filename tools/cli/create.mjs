// tools/cli/create.mjs — `pocket create`: scaffold a pocket.json v2 application.
//
// Inside a PocketJS checkout the app lands in apps/<name> and resolves the
// framework from the checkout. Anywhere else the result is a standalone
// project: its package.json depends on @pocketjs/framework and pins
// @pocketjs/cli, so `bun install && bun run build` is the whole flow.
// `--host-profile` (or `--target esp-idf`) derives the manifest from an ESP-IDF
// host contract, so a firmware repository owns the app as a subdirectory and
// `pocketjs_compile_app` / `pocketjs_embed_package` consume the result.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

export const FRAMEWORKS = ["solid", "vue-vapor", "octane"];
export const TARGETS = ["psp", "vita", "pocketbook", "web-app", "macos-app", "linux-app", "esp-idf"];

// Runtime dependencies a standalone project declares next to the framework.
// tests/cli.test.ts keeps these equal to the framework package.json.
export const FRAMEWORK_DEPENDENCIES = {
  solid: { "solid-js": "1.9.14" },
  "vue-vapor": { vue: "3.6.0-rc.1" },
  octane: { octane: "0.1.26" },
};

export const CREATE_USAGE =
  "usage: pocket create <kebab-case-name> [--target psp|vita|pocketbook|web-app|macos-app|linux-app|esp-idf] " +
  "[--framework solid|vue-vapor|octane] [--host-profile pocket.host.json]";

export class CreateUsageError extends Error {}

export function parseCreateArgs(argv) {
  const options = { name: undefined, framework: "solid", target: undefined, hostProfile: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = (flag) => {
      const inline = argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : argv[++index];
      if (!inline || inline.startsWith("-")) throw new CreateUsageError(`${flag} requires a value`);
      return inline;
    };
    if (argument === "--framework" || argument.startsWith("--framework=")) options.framework = value("--framework");
    else if (argument === "--target" || argument.startsWith("--target=")) options.target = value("--target");
    else if (argument === "--host-profile" || argument.startsWith("--host-profile=")) {
      options.hostProfile = value("--host-profile");
    } else if (argument.startsWith("-")) throw new CreateUsageError(`unknown option ${argument}`);
    else if (options.name === undefined) options.name = argument;
    else throw new CreateUsageError(`unexpected argument ${argument}`);
  }
  if (!options.name || !/^[a-z][a-z0-9-]*$/.test(options.name)) {
    throw new CreateUsageError("the app name is a kebab-case identifier such as my-app");
  }
  if (!FRAMEWORKS.includes(options.framework)) {
    throw new CreateUsageError(`--framework is one of ${FRAMEWORKS.join(", ")}`);
  }
  if (options.target !== undefined && !TARGETS.includes(options.target)) {
    throw new CreateUsageError(
      `--target is one of ${TARGETS.join(", ")} (macos-widget hosts dynamic viewports only; edit app.viewport after scaffolding)`,
    );
  }
  if (options.hostProfile && options.target !== undefined && options.target !== "esp-idf") {
    throw new CreateUsageError("--host-profile selects the ESP-IDF flow; drop --target or pass --target esp-idf");
  }
  return { ...options, target: options.target ?? (options.hostProfile ? "esp-idf" : "psp") };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const json = (document) => JSON.stringify(document, null, 2) + "\n";

const SCREEN = (headline, hint) =>
  `    <View class="w-full h-full flex-col items-center justify-center gap-4 bg-slate-950">
      <View class="w-[48] h-[48] rounded-[12px] bg-indigo-500 animate-spin" />
      <Text class="text-xl text-white font-bold">${headline}</Text>
      <Text class="text-sm text-slate-400">${hint}</Text>
    </View>`;

const COUNT_HINT = "Press CROSS to count";
const STATIC_HINT = "Edit app.tsx and rebuild";

const APP = {
  solid: ({ title, buttons }) => buttons
    ? `// ${title} — scaffolded by \`pocket create\`.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { onButtonPress } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";

export default function App() {
  const [count, setCount] = createSignal(0);
  onButtonPress(BTN.CROSS, () => setCount((n) => n + 1));
  return (
${SCREEN("{`Count: ${count()}`}", COUNT_HINT)}
  );
}
`
    : `// ${title} — scaffolded by \`pocket create\`.
import { Text, View } from "@pocketjs/framework/solid/components";

export default function App() {
  return (
${SCREEN(title, STATIC_HINT)}
  );
}
`,
  "vue-vapor": ({ title, buttons }) => buttons
    ? `// ${title} — scaffolded by \`pocket create\`.
import { ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { onButtonPress } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";

export default function App() {
  const count = ref(0);
  onButtonPress(BTN.CROSS, () => {
    count.value++;
  });
  return () => (
${SCREEN("{`Count: ${count.value}`}", COUNT_HINT)}
  );
}
`
    : `// ${title} — scaffolded by \`pocket create\`.
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

export default function App() {
  return () => (
${SCREEN(title, STATIC_HINT)}
  );
}
`,
  octane: ({ title, buttons }) => buttons
    ? `// ${title} — scaffolded by \`pocket create\`.
import { useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";
import { useButtonPress } from "@pocketjs/framework/octane/lifecycle";
import { BTN } from "@pocketjs/framework/octane/input";

export default function App() {
  const [count, setCount] = useState(0);
  useButtonPress(BTN.CROSS, () => setCount(count + 1));
  return (
${SCREEN("{`Count: ${count}`}", COUNT_HINT)}
  );
}
`
    : `// ${title} — scaffolded by \`pocket create\`.
import { Text, View } from "@pocketjs/framework/octane/components";

export default function App() {
  return (
${SCREEN(title, STATIC_HINT)}
  );
}
`,
};

const MAIN = {
  solid: (title) => `// @title PocketJS: ${title}
import App from "./app.tsx";
import { mount } from "@pocketjs/framework/solid";

mount(() => <App />);
`,
  "vue-vapor": (title) => `// @title PocketJS: ${title}
import App from "./app.tsx";
import { mount } from "@pocketjs/framework/vue-vapor";

mount(App);
`,
  octane: (title) => `// @title PocketJS: ${title}
import App from "./app.tsx";
// The generic root resolves to the framework named in pocket.json at build
// time; its mount accepts a JSX component. The /octane subpath types mount
// for compiled universal components, which app sources are not yet.
import { mount } from "@pocketjs/framework";

// Pass the component itself: in Octane, JSX inside a call-argument arrow
// (mount(() => <App />)) is a compile error.
mount(App);
`,
};

function manifest({ name, title, framework, viewport, requires }) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: `dev.example.${name.replace(/-/g, ".")}`,
    name,
    title,
    version: "0.1.0",
    engine: { capabilities: { requires } },
    app: { entry: "main.tsx", output: `${name}-main`, framework, viewport },
  };
}

// A starting host contract for a product that has none yet: 320×240 at native
// scale, buttons and baked glyphs. The firmware repository owns the file from
// here on; `id` is stored in the .pocket variant table, hence 15 bytes.
function defaultHostProfile(name) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-idf-host-1.json",
    version: 1,
    id: name.slice(0, 15).replace(/-+$/, ""),
    platform: "esp-idf",
    form: "takeover",
    tickHz: 60,
    display: {
      physicalViewport: [320, 240],
      logicalViewports: [[320, 240]],
      presentations: ["native"],
      rasterDensity: 1,
    },
    capabilities: ["input.buttons", "text.glyphs.baked"],
  };
}

// The manifest fields a host profile decides: the first logical viewport at
// the host's native presentation when it has one, and whether the template
// may register button handlers. Full schema validation stays with
// `pocket check --host-profile`.
function hostContract(profile, source) {
  const logical = profile?.display?.logicalViewports?.[0];
  const presentations = profile?.display?.presentations;
  const capabilities = profile?.capabilities;
  if (
    !Array.isArray(logical) || logical.length !== 2 ||
    !Array.isArray(presentations) || presentations.length === 0 ||
    !Array.isArray(capabilities)
  ) {
    throw new CreateUsageError(
      `${source} is not a pocket-idf-host-1 profile: display.logicalViewports, display.presentations and capabilities are required`,
    );
  }
  return {
    viewport: {
      logical: [logical[0], logical[1]],
      presentation: presentations.includes("native") ? "native" : presentations[0],
    },
    buttons: capabilities.includes("input.buttons"),
  };
}

function readHostProfile(path) {
  let profile;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CreateUsageError(`cannot read host profile ${path}: ${error.message}`);
  }
  return hostContract(profile, path);
}

/** The `pocket` invocations for a scaffolded app; `manifest` is set when they run from outside its directory. */
/** The `pocket` invocations for a scaffolded app. pocket.config.ts names the
 *  target, so they carry no selection; `manifest` is set when they run from
 *  outside the app directory. */
export function pocketCommands({ name, target, manifest: manifestPath }) {
  const manifestFlag = manifestPath ? ` --manifest ${manifestPath}` : "";
  const build = target === "esp-idf"
    ? ` --output dist/${name}.pocket`
    : target === "psp" || target === "vita" ? " -- --release" : "";
  return {
    check: `pocket check${manifestFlag}`,
    compile: `pocket compile${manifestFlag}`,
    build: `pocket build${manifestFlag}${build}`,
  };
}

/** pocket.config.ts listing the app's target: a catalog id, or the host profile. */
function pocketConfig({ target, hostProfilePath }) {
  const entry = target === "esp-idf" ? `{ hostProfile: ${JSON.stringify(hostProfilePath)} }` : JSON.stringify(target);
  return `import { definePocketConfig } from "@pocketjs/framework/config";

// The first entry of \`targets\` is the target \`pocket check\`, \`compile\` and
// \`build\` use when the command names none.
export default definePocketConfig({
  targets: [${entry}],
});
`;
}

const ARTIFACT = {
  psp: "an EBOOT.PBP from the pinned PSP toolchain (`pocket target add psp` installs it)",
  vita: "a VPK; needs VitaSDK (`VITASDK`) and cargo-vita",
  pocketbook: "dist/<output>.js + .pak, loaded by the PocketBook host",
  "web-app": "dist/<output>.js + .pak, served by the browser host",
  "macos-app": "dist/<output>.js + .pak, loaded by the desktop host",
  "linux-app": "dist/<output>.js + .pak, loaded by the desktop host",
  "esp-idf": "dist/<name>.pocket for the firmware build",
};

function packageJson({ name, framework, target, hostProfilePath, cliVersion }) {
  return {
    name,
    private: true,
    type: "module",
    scripts: pocketCommands({ name, target, hostProfilePath }),
    dependencies: {
      "@pocketjs/framework": `^${cliVersion}`,
      ...FRAMEWORK_DEPENDENCIES[framework],
    },
    devDependencies: { "@pocketjs/cli": `^${cliVersion}` },
  };
}

// Editor typecheck only; `pocket check` extends this file and owns the
// entry/import graph. JSX stays "preserve": the framework's Babel preset
// performs the transform. No `lib`: TypeScript's default library for the
// target declares the console and microtask globals the framework sources
// use, the same environment `pocket check` has without a tsconfig.
function tsconfig(framework) {
  const declarations = ["node_modules/@pocketjs/framework/framework/src/jsx.d.ts"];
  if (framework === "vue-vapor") declarations.push("node_modules/@pocketjs/framework/framework/src/vue-sfc.d.ts");
  return {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      types: [],
      jsx: "preserve",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
    },
    include: ["*.ts", "*.tsx", ...declarations],
  };
}

function readme({ name, title, target, hostProfilePath }) {
  const artifact = ARTIFACT[target].replace("<output>", `${name}-main`).replace("<name>", name);
  let text = `# ${title}

A PocketJS application. \`pocket.json\` declares the entry, framework, viewport and
the engine capabilities the app requires; \`@pocketjs/framework\` compiles it and
\`@pocketjs/cli\` (\`pocket\`) drives the build. Both run on Bun.

\`\`\`sh
bun install
bun run check     # manifest, target capabilities, TypeScript
bun run compile   # dist/${name}-main.js + dist/${name}-main.pak
bun run build     # ${artifact}
\`\`\`
`;
  if (target === "esp-idf") {
    const cmakeName = name.replace(/-/g, "_");
    const profileFromFirmware = posix.normalize(posix.join(name, hostProfilePath));
    text += `
## Firmware integration

The firmware repository owns \`pocket.host.json\`; this app was generated against
\`${hostProfilePath}\` and \`pocket check\` validates the manifest against it. The
snippets below assume this directory sits at the firmware root as \`${name}/\`.
Both run after \`idf_component_register\` in the consumer component's
\`CMakeLists.txt\` and generate \`pocketjs_package_${cmakeName}.h\`.

Compile during \`idf.py build\` (\`pocket\` and Bun in \`PATH\`):

\`\`\`cmake
pocketjs_compile_app(
    TARGET \${COMPONENT_LIB}
    NAME ${cmakeName}
    MANIFEST "\${CMAKE_SOURCE_DIR}/${name}/pocket.json"
    HOST_PROFILE "\${CMAKE_SOURCE_DIR}/${profileFromFirmware}"
    PROJECT_ROOT "\${CMAKE_SOURCE_DIR}/${name}"
)
\`\`\`

Embed the package from \`bun run build\` (no Bun during \`idf.py build\`):

\`\`\`cmake
pocketjs_embed_package(
    TARGET \${COMPONENT_LIB}
    NAME ${cmakeName}
    PACKAGE "\${CMAKE_SOURCE_DIR}/${name}/dist/${name}.pocket"
    HOST_PROFILE "\${CMAKE_SOURCE_DIR}/${profileFromFirmware}"
)
\`\`\`
`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Scaffold an app. `checkoutRoot` set means apps/<name> inside that checkout;
 * otherwise a standalone project under the current directory. Returns what
 * was written so the caller can print the next commands.
 */
export function create(argv, { checkoutRoot, cliVersion, cwd = process.cwd() }) {
  const options = parseCreateArgs(argv);
  const { name, framework, target } = options;
  const standalone = !checkoutRoot;
  const directory = standalone ? resolve(cwd, name) : join(checkoutRoot, "apps", name);
  if (existsSync(directory)) {
    throw new CreateUsageError(`${standalone ? directory : `apps/${name}`} already exists`);
  }
  const title = name.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

  let viewport = { logical: [480, 272], presentation: "integer-fit" };
  let buttons = true;
  let hostProfilePath;
  let hostProfile;
  if (target === "esp-idf") {
    let contract;
    if (options.hostProfile) {
      const absolute = resolve(cwd, options.hostProfile);
      contract = readHostProfile(absolute);
      hostProfilePath = relative(directory, absolute).split(sep).join("/");
    } else {
      hostProfile = defaultHostProfile(name);
      contract = hostContract(hostProfile, "the default host profile");
      hostProfilePath = "pocket.host.json";
    }
    ({ viewport, buttons } = contract);
  }
  const requires = ["text.glyphs.baked", ...(buttons ? ["input.buttons"] : [])];

  const files = {
    "pocket.config.ts": pocketConfig({ target, hostProfilePath }),
    "app.tsx": APP[framework]({ title, buttons }),
    "main.tsx": MAIN[framework](title),
    "pocket.json": json(manifest({ name, title, framework, viewport, requires })),
  };
  if (hostProfile) files["pocket.host.json"] = json(hostProfile);
  if (standalone) {
    files["package.json"] = json(packageJson({ name, framework, target, hostProfilePath, cliVersion }));
    files["tsconfig.json"] = json(tsconfig(framework));
    files[".gitignore"] = "node_modules/\ndist/\n.pocket/\n";
    files["README.md"] = readme({ name, title, target, hostProfilePath });
  }

  mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
  return { name, directory, standalone, target, framework, hostProfilePath, files: Object.keys(files) };
}
