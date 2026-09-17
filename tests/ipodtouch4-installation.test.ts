import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipodAppReceiptPaths, parseInstalledIPodApp, shellQuote, userDeploymentScript, type UserDeployment } from "../tools/ipodtouch4-installation.ts";

const bundleId = "dev.pocket-stack.clear";
const bundleName = "PocketJSiPodTouch4.app";
const container = "/private/var/mobile/Applications/236A6F72-07C7-4C2F-B00B-DDC8704E9A06";
const record = { CFBundleIdentifier: bundleId, ApplicationType: "User", Path: `${container}/${bundleName}`, Container: container };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("iPod User application installation", () => {
  test("resolves container-owned receipts and rejects absent, System, or mismatched apps", () => {
    const app = parseInstalledIPodApp(JSON.stringify(record), bundleId, bundleName);
    expect(ipodAppReceiptPaths(app).status).toBe(`${container}/tmp/pocketjs.status`);
    for (const invalid of [null, { ...record, ApplicationType: "System" }, { ...record, CFBundleIdentifier: "another.app" },
      { ...record, Container: "/var/mobile" }, { ...record, Path: `${container}/../another.app` },
      { ...record, Path: `${container}/Other.app` }]) {
      expect(() => parseInstalledIPodApp(JSON.stringify(invalid), bundleId, bundleName)).toThrow();
    }
    expect(() => parseInstalledIPodApp(JSON.stringify(record), "app;id", bundleName)).toThrow();
  });

  test("quotes shell data without evaluating substitutions", () => {
    const value = "one ' two $(exit 31) `exit 32`\nthree";
    const result = Bun.spawnSync(["sh", "-c", `printf '%s' ${shellQuote(value)}`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(value);
  });

  test("rejects unsafe bundle names and receipt file names before generating a transaction", () => {
    const base = { bundleId, bundleName, archive: "/tmp/app.ipa", archiveHash: hash("ipa"), files: { App: hash("app") } };
    const invalid: UserDeployment[] = [{ ...base, bundleName: "../Other.app" }, { ...base, files: { "../data": hash("data") } },
      { ...base, files: { ".": hash("data") } }, { ...base, archiveHash: "bad" }];
    for (const value of invalid) {
      expect(() => userDeploymentScript(value)).toThrow();
    }
  });

  function fixture(run: (f: { root: string; execute: () => ReturnType<typeof Bun.spawnSync> }) => void) {
    const root = mkdtempSync(join(tmpdir(), "pocket-user-install-"));
    try {
      mkdirSync(join(root, "legacy"));
      writeFileSync(join(root, "legacy/old-code"), "old");
      writeFileSync(join(root, "app.ipa"), "ipa");
      // The device's OpenSSL prints SHA256(...); Linux OpenSSL 3 prints
      // SHA2-256(...). Model the device command while hashing the real bytes.
      const digest = join(root, "device-digest.ts");
      writeFileSync(digest, `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const path = process.argv[2];
console.log("SHA256(" + path + ")= " + createHash("sha256").update(readFileSync(path)).digest("hex"));
`);
      writeFileSync(join(root, "installer"), `#!/bin/sh
case "$1" in
  bundle-id) echo '${bundleId}' ;;
  user-path) test -f '${root}/registered' || exit 1; echo '${root}/container/${bundleName}' ;;
  install)
    test ! -f '${root}/fail' || exit 25
    mkdir -p '${root}/container/${bundleName}'
    printf '%s' new > '${root}/container/${bundleName}/App'
    touch '${root}/registered'
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
      const script = userDeploymentScript({ bundleId, bundleName, archive: `${root}/app.ipa`, archiveHash: hash("ipa"), files: { App: hash("new") } })
        .replaceAll("/usr/bin/openssl dgst -sha256", `${shellQuote(process.execPath)} ${shellQuote(digest)}`)
        .replace("/var/root/Library/PocketJS/ipodtouch4-installer", `${root}/installer`)
        .replace(`/Applications/${bundleName}`, `${root}/legacy`)
        .replace(`/var/root/Library/PocketJS/${bundleId}.migration`, `${root}/journal`)
        .replace(/refresh\(\) \{[^}]+\}/, `refresh() { echo refresh >> '${root}/refreshes'; }`);
      writeFileSync(join(root, "deploy.sh"), script);
      run({ root, execute: () => Bun.spawnSync(["sh", join(root, "deploy.sh")]) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test("commits migration only after installed bytes match and preserves existing data on update", () => {
    fixture(({ root, execute }) => {
      mkdirSync(join(root, "container/Documents"), { recursive: true });
      writeFileSync(join(root, "container/Documents/list"), "user data");
      expect(execute().exitCode).toBe(0);
      expect(existsSync(join(root, "legacy"))).toBe(false);
      expect(existsSync(join(root, "journal"))).toBe(false);
      expect(execute().exitCode).toBe(0);
      expect(readFileSync(join(root, "container/Documents/list"), "utf8")).toBe("user data");
      expect(readFileSync(join(root, "refreshes"), "utf8").trim()).toBe("refresh");
    });
  });

  test("restores the System app when the native installer fails", () => {
    fixture(({ root, execute }) => {
      writeFileSync(join(root, "fail"), "");
      expect(execute().exitCode).not.toBe(0);
      expect(readFileSync(join(root, "legacy/old-code"), "utf8")).toBe("old");
      expect(existsSync(join(root, "registered"))).toBe(false);
      rmSync(join(root, "fail"));
      expect(execute().exitCode).toBe(0);
    });
  });

  test("recovers a migration interrupted after the legacy bundle moved", () => {
    fixture(({ root, execute }) => {
      mkdirSync(join(root, "journal"));
      renameSync(join(root, "legacy"), join(root, "journal/legacy.app"));
      writeFileSync(join(root, "fail"), "");
      expect(execute().exitCode).not.toBe(0);
      expect(readFileSync(join(root, "legacy/old-code"), "utf8")).toBe("old");
      rmSync(join(root, "fail"));
      expect(execute().exitCode).toBe(0);
    });
  });

  test("rejects transfer corruption before moving the existing app", () => {
    fixture(({ root, execute }) => {
      writeFileSync(join(root, "app.ipa"), "corrupt");
      expect(execute().exitCode).not.toBe(0);
      expect(existsSync(join(root, "legacy/old-code"))).toBe(true);
      expect(existsSync(join(root, "journal"))).toBe(false);
    });
  });

  test("keeps a recovery backup if installed byte verification fails, then completes on retry", () => {
    fixture(({ root, execute }) => {
      const installer = join(root, "installer");
      const code = readFileSync(installer, "utf8");
      writeFileSync(installer, code.replace("printf '%s' new", "printf '%s' broken"));
      expect(execute().exitCode).not.toBe(0);
      expect(existsSync(join(root, "journal/legacy.app/old-code"))).toBe(true);
      expect(existsSync(join(root, "legacy"))).toBe(false);
      writeFileSync(installer, code);
      expect(execute().exitCode).toBe(0);
      expect(existsSync(join(root, "journal"))).toBe(false);
    });
  });
});
