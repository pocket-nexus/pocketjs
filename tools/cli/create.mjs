// tools/cli/create.mjs — `pocket create`: scaffold an application, a
// pocket.host.config.ts whose `app` section names its entry, framework,
// viewport and features, and whose `host` names the host it builds for.
//
// Inside a PocketJS checkout the app lands in apps/<name> and resolves the
// framework from the checkout. Anywhere else the result is a standalone
// project: its package.json depends on @pocketjs/framework and pins
// @pocketjs/cli, so `bun install && bun run build` is the whole flow.
// `--target esp-idf` creates a product-owned host contract and one host
// config with its `host` and `app`, with application sources in app/.
// Native firmware builds consume those inputs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const FRAMEWORKS = ["solid", "vue-vapor", "octane"];
export const TARGETS = ["psp", "vita", "web-app", "esp-idf"];

// Runtime dependencies a standalone project declares next to the framework.
// tests/cli.test.ts keeps these equal to the framework package.json.
export const FRAMEWORK_DEPENDENCIES = {
  solid: { "solid-js": "1.9.14" },
  "vue-vapor": { vue: "3.6.0-rc.1" },
  octane: { octane: "0.1.26" },
};

export const CREATE_USAGE =
  "usage: pocket create <kebab-case-name> [--target psp|vita|web-app|esp-idf] " +
  "[--framework solid|vue-vapor|octane]";

export class CreateUsageError extends Error {}

export function parseCreateArgs(argv) {
  const options = { name: undefined, framework: "solid", target: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = (flag) => {
      const inline = argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : argv[++index];
      if (!inline || inline.startsWith("-")) throw new CreateUsageError(`${flag} requires a value`);
      return inline;
    };
    if (argument === "--framework" || argument.startsWith("--framework=")) options.framework = value("--framework");
    else if (argument === "--target" || argument.startsWith("--target=")) options.target = value("--target");
    else if (argument.startsWith("-")) throw new CreateUsageError(`unknown option ${argument}`);
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
  return { ...options, target: options.target ?? "psp" };
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
// The generic root resolves to the framework app.framework names at build
// time; its mount accepts a JSX component. The /octane subpath types mount
// for compiled universal components, which app sources are not yet.
import { mount } from "@pocketjs/framework";

// Pass the component itself: in Octane, JSX inside a call-argument arrow
// (mount(() => <App />)) is a compile error.
mount(App);
`,
};

const literal = (value) => JSON.stringify(value).replace(/,/g, ", ").replace(/"(\w+)":/g, "$1: ").replace(/\{/g, "{ ").replace(/\}/g, " }");

/** The host config: the host the application builds for and its `app` section. */
function hostConfig({ name, title, framework, viewport, features, host, entry }) {
  return `import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: ${JSON.stringify(host)},
  app: {
    id: ${JSON.stringify(`dev.example.${name.replace(/-/g, ".")}`)},
    title: ${JSON.stringify(title)},
    version: "0.1.0",
    entry: ${JSON.stringify(entry)},
    output: ${JSON.stringify(`${name}-main`)},
    framework: ${JSON.stringify(framework)},
    viewport: ${literal(viewport)},
    features: ${literal(features)},
  },
});
`;
}

// A new product starts with a 320x240 display, buttons and baked glyphs,
// presented by a CPU rasterizer at 60 or 30 frames per second.
function defaultProfile(name) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-host-2.json",
    format: "pocket-host/2",
    id: `product-${name}`,
    platform: "esp-idf",
    form: "takeover",
    cadences: [60, 30],
    display: {
      logicalViewports: [[320, 240]],
      presentations: ["native"],
      rasterDensity: 1,
      animation: "repaint",
    },
    panel: { primary: [320, 240] },
    capabilities: ["input.buttons", "text.glyphs.baked"],
  };
}

/** The commands that check and compile a scaffolded application. The host
 *  config names the one host; `config` is its path when the commands run
 *  outside the application's directory. */
export function pocketCommands({ name, config }) {
  const input = config ? ` --config ${config}` : "";
  const compile = `pocket compile${input} --output dist/${name}.pkb`;
  return {
    check: `pocket check${input}`,
    compile,
    build: compile,
  };
}

function packageJson({ name, framework, target, cliVersion }) {
  return {
    name,
    private: true,
    type: "module",
    scripts: {
      ...pocketCommands({ name }),
      ...(target === "esp-idf" ? { "host:export": "pocket host export --out dist/profile" } : {}),
    },
    dependencies: {
      "@pocketjs/framework": `^${cliVersion}`,
      ...FRAMEWORK_DEPENDENCIES[framework],
    },
    devDependencies: { "@pocketjs/cli": `^${cliVersion}` },
  };
}

function tsconfig(framework, embedded) {
  const declarations = ["node_modules/@pocketjs/framework/framework/src/jsx.d.ts"];
  if (framework === "vue-vapor") declarations.push("node_modules/@pocketjs/framework/framework/src/vue-sfc.d.ts");
  return {
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: [],
      jsx: "preserve", strict: true, noEmit: true, allowImportingTsExtensions: true,
      verbatimModuleSyntax: true, skipLibCheck: true,
    },
    include: embedded ? ["app/**/*.ts", "app/**/*.tsx", "pocket.host.config.ts", ...declarations]
      : ["*.ts", "*.tsx", ...declarations],
  };
}

function readme({ name, title, target }) {
  let text = `# ${title}

\`pocket.host.config.ts\` names the host the application builds for (\`host\`)
and the application (\`app\`): its entry, framework, viewport and features.
**Application compilation produces the bundle \`dist/${name}.pkb\`.** The
program's native build consumes that bundle or installs it beside a compatible
runtime.

\`\`\`sh
bun install
bun run check
bun run compile
\`\`\`
`;
  if (target === "esp-idf") {
    const cmakeName = name.replace(/-/g, "_");
    text += `
## Firmware integration

\`pocket.host.json\` is the product's host contract (\`pocket-host/2\`).
\`pocket.host.config.ts\` names it as \`host\` and holds the application as
\`app\`, with its sources in \`app/\`.
**Native firmware compilation belongs to ESP-IDF.**

Run after \`idf_component_register\` in the consuming component:

\`\`\`cmake
pocketjs_compile_app(
    TARGET \${COMPONENT_LIB}
    NAME ${cmakeName}
    HOST_CONFIG "\${PROJECT_DIR}/pocket.host.config.ts"
    PROJECT_ROOT "\${PROJECT_DIR}"
)
\`\`\`

To embed without Bun during the firmware build, export the host contract and
compile once before invoking ESP-IDF:

\`\`\`sh
bun run host:export
bun run compile
\`\`\`

\`\`\`cmake
pocketjs_embed_bundle(
    TARGET \${COMPONENT_LIB}
    NAME ${cmakeName}
    BUNDLE "\${PROJECT_DIR}/dist/${name}.pkb"
    HOST_CONFIG "\${PROJECT_DIR}/pocket.host.config.ts"
    PROFILE_EXPORT_DIR "\${PROJECT_DIR}/dist/profile"
)
\`\`\`
`;
  }
  return text;
}

/** Scaffold an application, or an ESP-IDF product with its application in app/. */
export function create(argv, { checkoutRoot, cliVersion, cwd = process.cwd() }) {
  const { name, framework, target } = parseCreateArgs(argv);
  const standalone = !checkoutRoot;
  const directory = standalone ? resolve(cwd, name) : join(checkoutRoot, "apps", name);
  if (existsSync(directory)) throw new CreateUsageError(`${directory} already exists`);
  const title = name.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  const embedded = target === "esp-idf";
  const appDirectory = embedded ? "app/" : "";
  const viewport = embedded ? { logical: [320, 240], presentation: "native" }
    : { logical: [480, 272], presentation: "integer-fit" };
  const files = {
    [`${appDirectory}app.tsx`]: APP[framework]({ title, buttons: true }),
    [`${appDirectory}main.tsx`]: MAIN[framework](title),
    "pocket.host.config.ts": hostConfig({
      name, title, framework, viewport, features: ["text.glyphs.baked", "input.buttons"],
      host: embedded ? "./pocket.host.json" : target, entry: `${appDirectory}main.tsx`,
    }),
  };
  if (embedded) files["pocket.host.json"] = json(defaultProfile(name));
  if (standalone) {
    files["package.json"] = json(packageJson({ name, framework, target, cliVersion }));
    files["tsconfig.json"] = json(tsconfig(framework, embedded));
    files[".gitignore"] = "node_modules/\ndist/\n.pocket-build/\n";
    files["README.md"] = readme({ name, title, target });
  }
  mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  return {
    name, directory, standalone, target, framework,
    hostConfigPath: "pocket.host.config.ts", files: Object.keys(files),
  };
}
