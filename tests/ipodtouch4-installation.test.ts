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
    expect(userDeploymentScript({ ...base, files: { "maps/de_dust2.p3d": hash("map") } })).toContain("maps/de_dust2.p3d");
    for (const name of ["/maps/data", "maps//data", "maps/../data", "maps/./data", "maps/data/", "maps/$(id)"])
      expect(() => userDeploymentScript({ ...base, files: { [name]: hash("map") } })).toThrow();
  });

  // A stub digest command lets a test control both stdout and the exit status.
  // Real OpenSSL 3 prints SHA2-256(file)=; OpenSSL 0.9/1.0 and LibreSSL print SHA256(file)=.
  type DigestFault = "wrong" | "empty-success" | "fail-empty" | "fail-correct-archive" | "fail-correct-installed"
    | "malformed" | "bare" | "suffix" | "uppercase" | "two-line";
  type DigestStub = { readonly kind: "prefix"; readonly prefix: "SHA2-256" | "SHA256" }
    | { readonly kind: "fault"; readonly fault: DigestFault };

  function writeDigestStub(root: string, stub: DigestStub) {
    const body = stub.kind === "prefix"
      ? `*) printf '${stub.prefix}(%s)= %s\\n' "$file" "$digest" ;;`
      : {
        "wrong": `*) printf 'SHA2-256(%s)= %064d\\n' "$file" 0 ;;`,
        "empty-success": `*) ;;`,
        "fail-empty": `*) exit 37 ;;`,
        "fail-correct-archive":
          `app.ipa) printf 'SHA2-256(%s)= %s\\n' "$file" "$digest"; exit 37 ;;
*) printf 'SHA2-256(%s)= %s\\n' "$file" "$digest" ;;`,
        "fail-correct-installed":
          `App) printf 'SHA2-256(%s)= %s\\n' "$file" "$digest"; exit 38 ;;
*) printf 'SHA2-256(%s)= %s\\n' "$file" "$digest" ;;`,
        "malformed": `*) printf 'not-an-openssl-digest = %s\\n' "$digest" ;;`,
        "bare": `*) printf '%s\\n' "$digest" ;;`,
        "suffix": `*) printf 'SHA2-256(%s)= %sx\\n' "$file" "$digest" ;;`,
        "uppercase":
          `*) upper=$(printf '%s' "$digest" | tr 'a-f' 'A-F'); printf 'SHA2-256(%s)= %s\\n' "$file" "$upper" ;;`,
        "two-line": `*) printf 'warning\\nSHA2-256(%s)= %s\\n' "$file" "$digest" ;;`,
      }[stub.fault];
    writeFileSync(join(root, "openssl"), `#!/bin/sh
file=
for arg in "$@"; do
  case "$arg" in -*) ;; *) file="$arg" ;; esac
done
line=$(/usr/bin/openssl dgst -sha256 "$file")
digest=\${line#*= }
base=\${file##*/}
case "$base" in
${body}
esac
`, { mode: 0o755 });
  }

  function fixture(
    run: (f: { root: string; execute: () => ReturnType<typeof Bun.spawnSync>; digestStub: (stub: DigestStub) => void }) => void,
    stub?: DigestStub,
  ) {
    const root = mkdtempSync(join(tmpdir(), "pocket-user-install-"));
    try {
      mkdirSync(join(root, "legacy"));
      writeFileSync(join(root, "legacy/old-code"), "old");
      writeFileSync(join(root, "app.ipa"), "ipa");
      if (stub) writeDigestStub(root, stub);
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
      const openssl = stub ? join(root, "openssl") : "/usr/bin/openssl";
      const script = userDeploymentScript({ bundleId, bundleName, archive: `${root}/app.ipa`, archiveHash: hash("ipa"), files: { App: hash("new") } })
        .replace("/var/root/Library/PocketJS/ipodtouch4-installer", `${root}/installer`)
        .replaceAll("/usr/bin/openssl", openssl)
        .replace(`/Applications/${bundleName}`, `${root}/legacy`)
        .replace(`/var/root/Library/PocketJS/${bundleId}.migration`, `${root}/journal`)
        .replace(/refresh\(\) \{[^}]+\}/, `refresh() { echo refresh >> '${root}/refreshes'; }`);
      writeFileSync(join(root, "deploy.sh"), script);
      run({ root, execute: () => Bun.spawnSync(["sh", join(root, "deploy.sh")]), digestStub: (next) => writeDigestStub(root, next) });
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

  test("accepts digests printed with either the SHA2-256( or SHA256( prefix", () => {
    for (const prefix of ["SHA2-256", "SHA256"] as const) {
      fixture(({ execute }) => {
        expect(execute().exitCode).toBe(0);
      }, { kind: "prefix", prefix });
    }
  });

  test("fails before migration when the archive digest command exits nonzero after the correct digest", () => {
    fixture(({ root, execute }) => {
      expect(execute().exitCode).not.toBe(0);
      // The failed pre-move check leaves the legacy bundle, journal, and registration untouched.
      expect(existsSync(join(root, "legacy/old-code"))).toBe(true);
      expect(existsSync(join(root, "journal"))).toBe(false);
      expect(existsSync(join(root, "registered"))).toBe(false);
    }, { kind: "fault", fault: "fail-correct-archive" });
  });

  test("keeps the recovery journal when an installed-file digest command exits nonzero, then completes on retry", () => {
    fixture(({ root, execute, digestStub }) => {
      expect(execute().exitCode).not.toBe(0);
      expect(existsSync(join(root, "journal/legacy.app/old-code"))).toBe(true);
      expect(existsSync(join(root, "legacy"))).toBe(false);
      digestStub({ kind: "prefix", prefix: "SHA2-256" });
      expect(execute().exitCode).toBe(0);
      expect(existsSync(join(root, "journal"))).toBe(false);
    }, { kind: "fault", fault: "fail-correct-installed" });
  });

  test("rejects empty, wrong, and malformed digest output at the archive boundary", () => {
    const faults: DigestFault[] = ["wrong", "empty-success", "fail-empty", "malformed", "bare", "suffix", "uppercase", "two-line"];
    for (const fault of faults) {
      fixture(({ root, execute }) => {
        expect(execute().exitCode).not.toBe(0);
        expect(existsSync(join(root, "legacy/old-code"))).toBe(true);
        expect(existsSync(join(root, "journal"))).toBe(false);
        expect(existsSync(join(root, "registered"))).toBe(false);
      }, { kind: "fault", fault });
    }
  });
});
