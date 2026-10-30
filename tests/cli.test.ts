import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { validatePocketProfile } from "../framework/src/profile.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { FRAMEWORK_DEPENDENCIES } from "../tools/cli/create.mjs";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "tools/cli/bin.mjs");
const cliVersion = JSON.parse(readFileSync(join(root, "tools/cli/package.json"), "utf8")).version as string;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function checkout(): string {
  const path = `/tmp/pocketjs-cli-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@pocketjs/framework", pocketjs: { protocol: 1 } }));
  temporary.push(path);
  return path;
}

// Every CLI run gets its own settings directory and no POCKET_TARGET, so the
// machine's settings never reach a test.
const settingsHome = `/tmp/pocketjs-cli-settings-${process.pid}`;
mkdirSync(settingsHome, { recursive: true });
temporary.push(settingsHome);

/** A directory no PocketJS checkout owns: `pocket create` writes a standalone project here. */
function scratch(): string {
  const path = `/tmp/pocketjs-cli-standalone-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Resolve an application against the generated product's software profile. */
function resolveAgainstProfile(manifest: unknown, profile: unknown) {
  const validated = validatePocketProfile(profile);
  expect(validated.ok, JSON.stringify(validated)).toBe(true);
  if (!validated.ok) throw new Error("unreachable");
  return validateAndResolveBuildPlan(manifest, { target: validated.value.id }, profileRegistry(validated.value));
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: settingsHome, POCKET_TARGET: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("published PocketJS CLI", () => {
  test("create emits one portable pocket.app.json v2 source of truth", async () => {
    const cwd = checkout();
    const result = runCli(cwd, ["create", "portable-counter"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const app = join(cwd, "apps/portable-counter");
    const manifest = JSON.parse(readFileSync(join(app, "pocket.app.json"), "utf8"));
    expect(manifest).toMatchObject({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "dev.example.portable.counter",
      version: "0.1.0",
      app: {
        entry: "main.tsx",
        output: "portable-counter-main",
        framework: "solid",
        viewport: { logical: [480, 272], presentation: "integer-fit" },
      },
    });
    expect(existsSync(join(app, "pocket.config.ts"))).toBe(false);
    expect(readFileSync(join(app, "main.tsx"), "utf8"))
      .toContain('from "@pocketjs/framework/solid"');

    for (const target of ["psp", "vita"] as const) {
      const resolution = validateAndResolveBuildPlan(manifest, { target });
      expect(resolution.ok, target).toBe(true);
    }
  });

  test("target commands delegate to canonical checkout scripts", () => {
    const cwd = checkout();
    const scripts = join(cwd, "tools");
    const log = join(cwd, "cli-log.json");
    mkdirSync(scripts);
    const recorder = `if (Bun.argv[2] === "project") {
  console.log(JSON.stringify({ ok: true, project: { config: null, targets: [] } }));
  process.exit(0);
}
await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
  script: import.meta.url,
  args: Bun.argv.slice(2),
}));\n`;
    for (const name of ["pocket", "play", "symbian", "vita", "ios"]) {
      writeFileSync(join(scripts, `${name}.ts`), recorder);
    }

    const cases = [
      { cliArgs: ["sdk", "export", "--triple", "aarch64-apple-darwin", "--out", "sdk"], script: "pocket.ts", args: ["sdk", "export", "--triple", "aarch64-apple-darwin", "--out", "sdk", "--cli-protocol", "1"] },
      { cliArgs: ["check", "--target", "psp"], script: "pocket.ts", args: ["check", "--target", "psp", "--cli-protocol", "1"] },
      { cliArgs: ["compile", "--target", "vita"], script: "pocket.ts", args: ["compile", "--target", "vita", "--cli-protocol", "1"] },
      { cliArgs: ["build", "--target", "vita", "--", "--release"], script: "pocket.ts", args: ["build", "--target", "vita", "--cli-protocol", "1", "--", "--release"] },
      { cliArgs: ["play", "vita", "hero"], script: "play.ts", args: ["vita", "hero"] },
      { cliArgs: ["vita", "hero", "--release"], script: "vita.ts", args: ["hero", "--release"] },
      { cliArgs: ["symbian", "doctor", "--device"], script: "symbian.ts", args: ["doctor", "--device"] },
      { cliArgs: ["symbian", "coda", "usb"], script: "symbian.ts", args: ["coda", "usb"] },
      { cliArgs: ["symbian", "coda", "usb", "launch"], script: "symbian.ts", args: ["coda", "usb", "launch"] },
      { cliArgs: ["ios", "play", "nsengine"], script: "ios.ts", args: ["play", "nsengine"] },
      { cliArgs: ["play", "ios", "nsengine"], script: "play.ts", args: ["ios", "nsengine"] },
    ];

    for (const fixture of cases) {
      rmSync(log, { force: true });
      const result = runCli(cwd, fixture.cliArgs, { POCKET_CLI_TEST_LOG: log });
      expect(result.success, `${fixture.cliArgs.join(" ")}\n${result.stderr}`).toBe(true);
      const recorded = JSON.parse(readFileSync(log, "utf8"));
      expect(basename(new URL(recorded.script).pathname)).toBe(fixture.script);
      expect(recorded.args).toEqual(fixture.args);
    }
  });

  test("manifest commands resolve a project-local published framework", () => {
    const cwd = `/tmp/pocketjs-cli-external-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const framework = join(cwd, "node_modules/@pocketjs/framework");
    const log = join(cwd, "cli-log.json");
    mkdirSync(join(framework, "tools"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "external-pocket-app" }));
    writeFileSync(join(framework, "package.json"), JSON.stringify({ name: "@pocketjs/framework", pocketjs: { protocol: 1 } }));
    writeFileSync(join(framework, "tools/pocket.ts"), `if (Bun.argv[2] === "project") {
  console.log(JSON.stringify({ ok: true, project: { config: null, targets: [] } }));
  process.exit(0);
}
await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
  args: Bun.argv.slice(2),
  cwd: process.cwd(),
}));\n`);
    temporary.push(cwd);

    const result = runCli(cwd, [
      "build",
      "--host-config",
      "firmware/pocket.host.config.ts",
      "--manifest",
      "app/pocket.app.json",
    ], { POCKET_CLI_TEST_LOG: log });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({
      args: [
        "build",
        "--cli-protocol",
        "1",
        "--host-config",
        "firmware/pocket.host.config.ts",
        "--manifest",
        "app/pocket.app.json",
      ],
      cwd: realpathSync(cwd),
    });
  });

  test("runs on Bun and says so under Node", () => {
    const node = Bun.which("node");
    if (!node) return;
    const result = Bun.spawnSync({ cmd: [node, cli, "show"], stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("runs on Bun");
    expect(readJson(join(root, "tools/cli/package.json")).engines).toEqual({ bun: ">=1.2" });
  });

  test("standalone create writes a project that depends on the published framework", () => {
    const cwd = scratch();
    const result = runCli(cwd, ["create", "counter", "--target", "vita", "--framework", "vue-vapor"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("bun install");

    const app = join(cwd, "counter");
    for (const file of ["package.json", "tsconfig.json", "pocket.app.json", "main.tsx", "app.tsx", "README.md", ".gitignore"]) {
      expect(existsSync(join(app, file)), file).toBe(true);
    }
    expect(existsSync(join(app, "pocket.host.json"))).toBe(false);

    const pkg = readJson(join(app, "package.json"));
    expect(pkg.dependencies).toEqual({ "@pocketjs/framework": `^${cliVersion}`, vue: FRAMEWORK_DEPENDENCIES["vue-vapor"].vue });
    expect(pkg.devDependencies).toEqual({ "@pocketjs/cli": `^${cliVersion}` });
    expect(pkg.scripts).toEqual({
      check: "pocket check --target vita --manifest pocket.app.json --project-root .",
      compile: "pocket compile --target vita --manifest pocket.app.json --project-root . --output dist/counter.pocket",
      build: "pocket compile --target vita --manifest pocket.app.json --project-root . --output dist/counter.pocket",
    });
    expect(existsSync(join(app, "pocket.config.ts"))).toBe(false);
    expect(readFileSync(join(app, "main.tsx"), "utf8")).toContain('from "@pocketjs/framework/vue-vapor"');
    expect(readFileSync(join(app, "app.tsx"), "utf8")).toContain('from "@pocketjs/framework/vue-vapor/lifecycle"');
    expect(readJson(join(app, "tsconfig.json")).include).toEqual([
      "*.ts",
      "*.tsx",
      "node_modules/@pocketjs/framework/framework/src/jsx.d.ts",
      "node_modules/@pocketjs/framework/framework/src/vue-sfc.d.ts",
    ]);

    const manifest = readJson(join(app, "pocket.app.json"));
    expect(manifest.app.framework).toBe("vue-vapor");
    expect(validateAndResolveBuildPlan(manifest, { target: "vita" }).ok).toBe(true);
  });

  test("standalone dependency pins match the framework package.json", () => {
    const framework = readJson(join(root, "package.json")).dependencies as Record<string, string>;
    for (const dependencies of Object.values(FRAMEWORK_DEPENDENCIES)) {
      for (const [name, version] of Object.entries(dependencies)) {
        expect(framework[name], name).toBe(version);
      }
    }
  });

  test("create --target esp-idf writes a host contract, host config and app contract", () => {
    const cwd = scratch();
    const name = "a-very-long-product-name";
    const result = runCli(cwd, ["create", name, "--target", "esp-idf"]);
    expect(result.success, result.stderr.toString()).toBe(true);
    const app = join(cwd, name);
    for (const file of ["pocket.host.config.ts", "pocket.host.json", "app/pocket.app.json", "app/main.tsx", "app/app.tsx"]) {
      expect(existsSync(join(app, file)), file).toBe(true);
    }
    expect(existsSync(join(app, "pocket.config.ts"))).toBe(false);
    expect(readJson(join(app, "pocket.host.json"))).not.toHaveProperty("hostAbi");
    const exported = runCli(app, ["host", "export", "--out", "exported"], { POCKETJS_FRAMEWORK_ROOT: root });
    expect(exported.success, exported.stderr.toString()).toBe(true);
    const sidecar = readJson(join(app, "exported/pocket.host.json"));
    expect(sidecar.id).toBe(`product-${name}`);
    expect(sidecar.hostAbi).toBe(POCKET_BINDING_GENERATION);
    const manifest = readJson(join(app, "app/pocket.app.json"));
    expect(manifest.app.entry).toBe("app/main.tsx");
    expect(manifest.app.viewport).toEqual({ logical: [320, 240], presentation: "native" });
    expect(resolveAgainstProfile(manifest, sidecar).ok).toBe(true);
    const pkg = readJson(join(app, "package.json"));
    expect(pkg.scripts.check).toBe("pocket check --manifest app/pocket.app.json --project-root .");
    expect(pkg.scripts.compile).toBe("pocket compile --manifest app/pocket.app.json --project-root . --output dist/" + name + ".pocket");
    expect(pkg.scripts["host:export"]).toBe("pocket host export --out dist/profile");
    const readme = readFileSync(join(app, "README.md"), "utf8");
    expect(readme).toContain("pocketjs_compile_app(");
    expect(readme).toContain("pocketjs_embed_package(");
    expect(readme).toContain('HOST_CONFIG "' + String.fromCharCode(36) + '{PROJECT_DIR}/pocket.host.config.ts"');
    expect(readme).toContain('PROFILE_EXPORT_DIR "' + String.fromCharCode(36) + '{PROJECT_DIR}/dist/profile"');
    expect(readme).not.toContain("HOST_PROFILE");
  });

  test("ESP product host ids cannot collide with commands or built-ins", () => {
    const cwd = scratch();
    for (const name of ["build", "psp"]) {
      const created = runCli(cwd, ["create", name, "--target", "esp-idf"]);
      expect(created.success, created.stderr.toString()).toBe(true);
      const app = join(cwd, name);
      const exported = runCli(app, ["host", "export", "--out", "exported"], { POCKETJS_FRAMEWORK_ROOT: root });
      expect(exported.success, exported.stderr.toString()).toBe(true);
      expect(readJson(join(app, "exported/pocket.host.json")).id).toBe(`product-${name}`);
    }
  });

  test("create rejects the removed JSON host profile selector before writing files", () => {
    const cwd = scratch();
    const result = runCli(cwd, ["create", "app", "--host-profile", "firmware/pocket.host.json"]);
    expect(result.success).toBe(false);
    expect(result.stderr.toString()).toContain("unknown option --host-profile");
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  test("create rejects a target that needs a dynamic viewport and a mixed selector", () => {
    const cwd = scratch();
    for (const args of [
      ["create", "Widget"],
      ["create", "widget", "--target", "macos-widget"],
      ["create", "widget", "--target", "psp", "--host-profile", "pocket.host.json"],
      ["create", "widget", "--framework", "react"],
    ]) {
      const result = runCli(cwd, args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stderr.toString()).toContain("usage: pocket create");
    }
    expect(existsSync(join(cwd, "widget"))).toBe(false);
  });

  test("scaffolded projects pass `pocket check` against a linked framework", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(root, join(cwd, "node_modules/@pocketjs/framework"), "dir");
    for (const dependency of ["solid-js", "vue", "octane"]) {
      symlinkSync(join(root, "node_modules", dependency), join(cwd, "node_modules", dependency), "dir");
    }

    const projects = [
      ["solid-psp", "--target", "psp"],
      ["vue-vita", "--target", "vita", "--framework", "vue-vapor"],
      ["octane-web", "--target", "web-app", "--framework", "octane"],
      ["idf-app", "--target", "esp-idf"],
    ];
    for (const [name, ...flags] of projects) {
      const created = runCli(cwd, ["create", name, ...flags]);
      expect(created.exitCode, created.stderr.toString()).toBe(0);
      const app = join(cwd, name);
      const check = (readJson(join(app, "package.json")).scripts.check as string).split(" ").slice(1);
      const result = runCli(app, check);
      expect(result.exitCode, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.toString()).toContain("✓ TypeScript");
    }
  }, 180_000);
});

describe("profile selection", () => {
  function fakeFramework(protocol = 1) {
    const cwd = checkout();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "9.9.9", pocketjs: { protocol } }));
    mkdirSync(join(cwd, "tools"));
    writeFileSync(join(cwd, "tools/pocket.ts"), `const command=Bun.argv[2];
if(command==="project"){console.log(process.env.FAKE_PROJECT);process.exit(0);}
if(command==="status"){console.log("[]");process.exit(0);}
const log=process.env.POCKET_CLI_TEST_LOG;const previous=(await Bun.file(log).exists())?await Bun.file(log).json():[];
await Bun.write(log,JSON.stringify([...previous,Bun.argv.slice(2)]));`);
    return {cwd,log:join(cwd,"log.json")};
  }
  const project = (profiles: {id:string}[]) => ({config:"/work/game/pocket.host.config.ts",profiles,build:false});
  function pocket(framework: ReturnType<typeof fakeFramework>, args:string[], configuration: {config:string|null;profiles:{id:string}[];build:boolean}={config:null,profiles:[],build:false}, env:Record<string,string>={}) {
    rmSync(framework.log,{force:true});
    const result=runCli(framework.cwd,args,{POCKET_CLI_TEST_LOG:framework.log,FAKE_PROJECT:JSON.stringify({ok:true,project:configuration}),...env});
    return {code:result.exitCode,out:result.stdout.toString(),err:result.stderr.toString(),calls:existsSync(framework.log)?readJson(framework.log) as string[][]:[]};
  }
  test("missing or multiple profiles are delegated to the resolver without choosing a first entry",()=>{
    const framework=fakeFramework();
    expect(pocket(framework,["check"]).calls).toEqual([["check","--cli-protocol","1"]]);
    expect(pocket(framework,["compile"],project([{id:"psp"},{id:"vita"}])).calls).toEqual([["compile","--cli-protocol","1"]]);
  });
  test("CLI overrides env, which overrides the single runtime profile",()=>{
    const framework=fakeFramework();
    const first=pocket(framework,["check"],project([{id:"vita"}]));
    expect(first.calls[0]).toEqual(["check","--target","vita","--host-config","/work/game/pocket.host.config.ts","--cli-protocol","1"]);
    expect(pocket(framework,["check"],project([{id:"vita"}]),{POCKET_TARGET:"psp"}).calls[0]?.slice(1,3)).toEqual(["--target","psp"]);
    for(const args of [["+psp","check"],["check","+psp"],["check","--target","psp"],["check","--target=psp"]]) {
      expect(pocket(framework,args,project([{id:"vita"}]),{POCKET_TARGET:"web-app"}).calls[0]?.slice(1,3)).toEqual(["--target","psp"]);
    }
  });
  test("module paths and explicit config options are forwarded unchanged",()=>{
    const framework=fakeFramework();
    expect(pocket(framework,["compile","--target","../board.ts","--manifest","app/pocket.app.json","--output","out/app.pocket"]).calls).toEqual([["compile","--target","../board.ts","--cli-protocol","1","--manifest","app/pocket.app.json","--output","out/app.pocket"]]);
    expect(pocket(framework,["compile","--host-config","firmware/pocket.host.config.ts"],project([{id:"board"}])).calls).toEqual([["compile","--target","board","--cli-protocol","1","--host-config","firmware/pocket.host.config.ts"]]);
  });
  test("conflicting, empty and misplaced selections fail",()=>{
    const framework=fakeFramework();
    expect(pocket(framework,["+psp","check","--target","vita"]).err).toContain("conflicting targets");
    expect(pocket(framework,["check","--target=psp","--target=vita"]).err).toContain("conflicting targets");
    expect(pocket(framework,["check","--target="]).err).toContain("requires a value");
    expect(pocket(framework,["check","--manifest","pocket.app.json","+psp"]).err).toContain("must come right after");
    expect(pocket(framework,["+psp","create","x"]).err).toContain("selects a target for check, compile, build, pack or show");
  });
  test("retired matrix and JSON host-profile options fail before execution",()=>{
    const framework=fakeFramework();
    expect(pocket(framework,["build","--all"]).err).toContain("enumerate profiles in scripts or CI");
    expect(pocket(framework,["check","--host-profile","old.json"]).err).toContain("replaced by host contracts");
    expect(pocket(framework,["default","psp"]).code).toBe(1);
    expect(pocket(framework,["override","set","psp"]).code).toBe(1);
  });
  test("a different framework protocol stops before execution",()=>{
    const result=pocket(fakeFramework(2),["check","--target","psp"]);
    expect(result.code).toBe(1);expect(result.err).toContain("speaks protocol 2");expect(result.calls).toEqual([]);
  });
  test("show reports the runtime profile and source",()=>{
    const framework=fakeFramework();
    const result=pocket(framework,["show","--json"],project([{id:"vita"}]));
    expect(result.code,result.err).toBe(0);
    expect(JSON.parse(result.out).selection).toEqual({id:"vita",source:"project",origin:"/work/game/pocket.host.config.ts"});
    expect(JSON.parse(pocket(framework,["+psp","show","--json"],project([{id:"vita"}])).out).selection.source).toBe("explicit");
  });
  test("host export, target and SDK commands reach the framework",()=>{
    const framework=fakeFramework();
    for(const args of [["target","add","psp"],["target","list","--check"],["host","export","--config","runtime.ts","--out","generated"],["sdk","export","--out","sdk"]]) {
      const result=pocket(framework,args);expect(result.code,result.err).toBe(0);expect(result.calls).toEqual([[...args,"--cli-protocol","1"]]);
    }
  });
});

describe("framework resolution", () => {
  test("the marker identifies a framework under any package name, and the nearest candidate wins", async () => {
    const { resolveFramework } = await import("../tools/cli/framework.mjs");
    const base = scratch();
    const fork = join(base, "fork");
    mkdirSync(fork);
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "@me/pocketjs-fork", version: "1.0.0", pocketjs: { protocol: 1 } }));
    expect(resolveFramework({ cwd: fork, env: {} })).toMatchObject({ root: fork, source: "checkout", name: "@me/pocketjs-fork" });

    const app = join(fork, "apps", "game");
    mkdirSync(join(app, "node_modules/@pocketjs/framework"), { recursive: true });
    writeFileSync(join(app, "node_modules/@pocketjs/framework/package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "2.0.0", pocketjs: { protocol: 1 } }));
    expect(resolveFramework({ cwd: app, env: {} })).toMatchObject({ source: "project", version: "2.0.0", origin: "registry" });

    const unmarked = join(base, "unmarked");
    mkdirSync(join(unmarked, "node_modules/@pocketjs/framework"), { recursive: true });
    writeFileSync(join(unmarked, "node_modules/@pocketjs/framework/package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "0.14.0" }));
    expect(resolveFramework({ cwd: unmarked, env: {} }).error).toContain("no \"pocketjs\": { \"protocol\": … } marker");

    expect(resolveFramework({ cwd: base, env: { POCKETJS_FRAMEWORK_ROOT: unmarked } }).error).toContain("is not a PocketJS framework");
  });

  test("a linked install reports where it points", async () => {
    const { resolveFramework } = await import("../tools/cli/framework.mjs");
    const base = scratch();
    const fork = join(base, "fork");
    mkdirSync(fork);
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "@me/fork", version: "1.0.0", pocketjs: { protocol: 1 } }));
    const app = join(base, "app");
    mkdirSync(join(app, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(fork, join(app, "node_modules/@pocketjs/framework"), "dir");
    expect(resolveFramework({ cwd: app, env: {} })).toMatchObject({ root: realpathSync(fork), source: "project", origin: `link → ${realpathSync(fork)}` });
  });
});

