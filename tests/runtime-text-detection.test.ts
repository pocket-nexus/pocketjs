import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");

const accessCases = [
  [
    "shorthand destructuring",
    "const { svcPoll } = getOps();\nvoid svcPoll;",
  ],
  [
    "renamed destructuring",
    "const ops = getOps();\nconst { svcPoll: poll } = ops;\nvoid poll;",
  ],
  [
    "nested destructuring",
    "const { bridge: { svcPoll: poll } } = { bridge: getOps() };\nvoid poll;",
  ],
  [
    "default-value destructuring",
    "const { svcPoll: poll = () => undefined } = getOps();\nvoid poll;",
  ],
  [
    "nested default-value destructuring",
    "const { bridge: { svcPoll: poll = () => undefined } = getOps() } = { bridge: getOps() };\nvoid poll;",
  ],
  [
    "string-literal bracket access",
    "const ops = getOps();\nvoid ops[\"svcPoll\"];",
  ],
  [
    "dynamic HostOps key",
    "const ops = getOps();\nconst key = \"svcPoll\";\nvoid ops[key];",
  ],
  [
    "dynamic key on direct getOps call",
    "const key = Math.random() > 0.5 ? \"svcPoll\" : \"svcSend\";\nvoid getOps()[key];",
  ],
  [
    "dynamic HostOps destructuring key",
    "const ops = getOps();\nconst key = Math.random() > 0.5 ? \"svcPoll\" : \"svcSend\";\n" +
      "const { [key]: operation } = ops;\nvoid operation;",
  ],
] as const;

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "pocketjs-runtime-text-detection-"));
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function manifest(runtimeText: boolean): string {
  return JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket-stack.runtime-text-detection",
    name: "runtime-text-detection",
    title: "Runtime Text Detection",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: {
      entry: "main.ts",
      framework: "solid",
      ...(runtimeText ? { runtimeText: { charset: "custom", extraChars: "" } } : {}),
      viewport: { logical: [480, 272], presentation: "integer-fit" },
    },
  });
}

function buildCase(
  name: string,
  body: string,
  runtimeText: boolean,
  extraArgs: string[] = [],
): { exitCode: number; output: string } {
  const directory = join(fixtureRoot, name.replaceAll(" ", "-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "main.ts"),
    ["import { getOps } from \"@pocketjs/framework\";", body, ""].join("\n"),
  );
  writeFileSync(join(directory, "pocket.json"), manifest(runtimeText));
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/build.ts",
      join(directory, "main.ts"),
      "--no-config",
      "--outdir=" + join(directory, runtimeText ? "declared" : "undeclared"),
      ...extraArgs,
    ],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

for (const [name, body] of accessCases) {
  test(name + " requires runtimeText and passes once declared", () => {
    const missing = buildCase(name, body, false);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("runtime text source requires app.runtimeText in pocket.json");

    const declared = buildCase(name, body, true);
    if (declared.exitCode !== 0) throw new Error(declared.output);
    expect(declared.exitCode).toBe(0);
  }, 120_000);
}

test("dynamic HostOps diagnostics state the conservative criterion", () => {
  const dynamic = accessCases.find(([name]) => name === "dynamic HostOps key")!;
  const result = buildCase("dynamic diagnostic", dynamic[1], false);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "every non-literal key on getOps() or a same-file local variable initialized from it " +
      "is treated as runtime text",
  );
});

test("--extra-chars failure points to the pocket.json declaration", () => {
  const result = buildCase(
    "extra chars",
    "const ops = getOps();\nvoid ops.svcPoll;",
    false,
    ["--extra-chars=abc"],
  );
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    '{ "app": { "runtimeText": { "charset": "ascii" } } }',
  );
  expect(result.output).toContain(
    "--extra-chars only adds baked glyphs and does not declare a runtime text source",
  );
});

test("svcPoll in TypeScript type positions is not a runtime source", () => {
  const result = buildCase(
    "type only",
    "interface HostShape { svcPoll?(): string | undefined }\n" +
      "type PollKey = keyof Pick<HostShape, \"svcPoll\">;\n" +
      "const marker: PollKey | undefined = undefined;\nvoid marker;",
    false,
  );
  if (result.exitCode !== 0) throw new Error(result.output);
  expect(result.exitCode).toBe(0);
});

test("unrelated dynamic keys and literal non-svcPoll HostOps keys do not trigger", () => {
  const result = buildCase(
    "non runtime keys",
    "const map = { value: 1 };\nconst key = \"value\";\nvoid map[key];\n" +
      "const ops = getOps();\nvoid ops[\"svcSend\"];",
    false,
  );
  if (result.exitCode !== 0) throw new Error(result.output);
  expect(result.exitCode).toBe(0);
});
