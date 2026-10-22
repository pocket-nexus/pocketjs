import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pocketjs-iphone2g-transaction-"));
const applications = join(root, "Applications");
const app = join(applications, "PocketJSDemo.app");
const stage = join(applications, ".PocketJSDemo.app.pocketjs-stage");
const backup = join(applications, ".PocketJSDemo.app.pocketjs-backup");
const privateTmp = join(root, "private/var/tmp");
const transaction = join(privateTmp, "pocketjs-iphone2g.transaction");
const transactionTemp = `${transaction}.new`;
const acceptance = join(privateTmp, "pocketjs-iphone2g.status");
const helper = join(root, "pocketjs-device-test");
const bundleFiles = [
  "PocketJSDemo",
  "Info.plist",
  "PkgInfo",
  "Icon.png",
  "build-receipt.json",
];

setDefaultTimeout(15_000);

function define(name: string, value: string): string {
  return `-D${name}="${value}"`;
}

function run(args: readonly string[], input?: Uint8Array) {
  return Bun.spawnSync({
    cmd: [helper, ...args],
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeBundle(directory: string, label: string): void {
  mkdirSync(directory, { recursive: true });
  for (const name of bundleFiles) {
    const path = join(directory, name);
    writeFileSync(path, `${label}:${name}\n`);
    chmodSync(path, name === "PocketJSDemo" ? 0o755 : 0o644);
  }
}

function packageBytes(identifier: string, label: string): Buffer {
  const parts = [
    Buffer.from("PJS2G003", "ascii"),
    Buffer.from(identifier, "ascii"),
  ];
  for (const name of bundleFiles) {
    const bytes = Buffer.from(`${label}:${name}\n`);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function appLabel(): string {
  return readFileSync(join(app, "PocketJSDemo"), "utf8").split(":", 1)[0];
}

function state(): string {
  const result = run(["transaction-state"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

beforeAll(() => {
  const compile = Bun.spawnSync({
    cmd: [
      "cc",
      // The gnu dialect, not strict c99, because that is what actually builds
      // this file for the device. Under -std=c99 glibc defines __STRICT_ANSI__
      // and hides the POSIX declarations device_tool.c legitimately uses
      // (sigaction, lstat, fchmod, sync), so the test passed on macOS — whose
      // headers expose them regardless — and failed only on Linux CI.
      "-std=gnu99",
      // Stated explicitly as well, so the POSIX surface does not depend on a
      // dialect side-effect. glibc needs this for sync(); macOS ignores it.
      "-D_DEFAULT_SOURCE",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-DPOCKETJS_DEVICE_TEST=1",
      define("APP_DIRECTORY", app),
      define("STAGE_DIRECTORY", stage),
      define("BACKUP_DIRECTORY", backup),
      define("TRANSACTION_FILE", transaction),
      define("TRANSACTION_TEMP", transactionTemp),
      define("ACCEPTANCE_RECORD", acceptance),
      join(repository, "programs/iphone2g/device_tool.c"),
      "-o",
      helper,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

beforeEach(() => {
  for (const path of [
    app,
    stage,
    backup,
    transaction,
    transactionTemp,
    acceptance,
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(applications, { recursive: true });
  mkdirSync(privateTmp, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("iPhone 2G device transaction helper", () => {
  test("commits a fresh bundle only after a pending transaction", () => {
    const identifier = "1".repeat(32);
    const install = run(["install"], packageBytes(identifier, "fresh"));
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    expect(appLabel()).toBe("fresh");
    expect(state()).toBe(
      `state=pending\nphase=I\nhad_previous=0\nid=${identifier}\n`,
    );

    const commit = run(["commit", identifier]);
    expect(commit.exitCode, commit.stderr.toString()).toBe(0);
    expect(state()).toBe("state=none\n");
    expect(run(["mount-state"]).stdout.toString()).toBe(
      "root_readwrite=1\ndata_readwrite=1\n",
    );
    expect(run(["version"]).stdout.toString()).toBe(
      "pocketjs-iphone2g-device 4\n",
    );
  });

  test("rejects a foreign transaction id and restores the previous app", () => {
    const identifier = "2".repeat(32);
    writeBundle(app, "old");
    expect(run(["install"], packageBytes(identifier, "new")).exitCode).toBe(0);
    expect(appLabel()).toBe("new");
    expect(run(["rollback", "3".repeat(32)]).exitCode).not.toBe(0);
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("old");
    expect(state()).toBe("state=none\n");
  });

  test("automatically rolls back a truncated transfer", () => {
    const identifier = "4".repeat(32);
    writeBundle(app, "old");
    const complete = packageBytes(identifier, "broken");
    const install = run(["install"], complete.subarray(0, complete.length - 7));
    expect(install.exitCode).not.toBe(0);
    expect(appLabel()).toBe("old");
    expect(state()).toBe("state=none\n");
  });

  test("recovers prepared, installed, and rolled-back replacement phases idempotently", () => {
    const identifier = "5".repeat(32);
    writeBundle(app, "old");
    writeBundle(stage, "new");
    writeFileSync(transaction, `P1${identifier}\n`);
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("old");

    writeBundle(stage, "new");
    renameSync(app, backup);
    renameSync(stage, app);
    writeFileSync(transaction, `I1${identifier}\n`);
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("old");

    writeFileSync(transaction, `R1${identifier}\n`);
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("old");
    expect(state()).toBe("state=none\n");
  });

  test("recovers a complete backup and resumes partial committed-backup cleanup", () => {
    const identifier = "6".repeat(32);
    writeBundle(backup, "recovered");
    expect(run(["install"], packageBytes(identifier, "new")).exitCode).toBe(0);
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("recovered");

    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "Info.plist"), "partial\n");
    expect(run(["install"], packageBytes(identifier, "newer")).exitCode).toBe(
      0,
    );
    expect(run(["rollback", identifier]).exitCode).toBe(0);
    expect(appLabel()).toBe("recovered");
  });

  test("serializes concurrent installers before either touches the root volume", async () => {
    const firstId = "7".repeat(32);
    const secondId = "8".repeat(32);
    const firstPackage = packageBytes(firstId, "first");
    const first = Bun.spawn({
      cmd: [helper, "install"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    first.stdin.write(firstPackage.subarray(0, 40));
    await first.stdin.flush();

    let pending = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      pending = state();
      if (pending.includes(`id=${firstId}\n`)) break;
      await Bun.sleep(10);
    }
    expect(pending).toContain(`id=${firstId}\n`);

    const second = run(["install"], packageBytes(secondId, "second"));
    expect(second.exitCode).not.toBe(0);
    expect(state()).toContain(`id=${firstId}\n`);

    first.stdin.write(firstPackage.subarray(40));
    first.stdin.end();
    expect(await first.exited).toBe(0);
    expect(appLabel()).toBe("first");
    expect(run(["commit", firstId]).exitCode).toBe(0);
  });
});
