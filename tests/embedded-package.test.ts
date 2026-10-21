import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";

const root = resolve(import.meta.dir, "..");
test("raw-JavaScript embedding uses the compiler's exact package encoding", () => {
  const out = resolve(root, `.pocket-build/validation/embedded-package/${Date.now()}-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.success, `${command.join(" ")} (signal=${result.signalCode})\n${result.stderr}`).toBe(true);
  };
  const module = (name: string, file: string) => `#[path=${JSON.stringify(resolve(root, file))}] mod ${name};`;
  writeFileSync(resolve(out, "main.rs"), `extern crate alloc;
${module("package_format", "engine/package/src/package_format.rs")}
${module("package", "engine/package/src/package.rs")}
${module("embedded", "engine/package/src/embedded.rs")}
fn main() {
  let args: Vec<_> = std::env::args().collect();
  let identity = embedded::identity("embedded", "test.app", "嵌入").unwrap();
  let code = std::fs::read(&args[1]).unwrap();
  let pak = std::fs::read(&args[2]).unwrap();
  let bytes = embedded::encode(embedded::EmbeddedPackage { target: "test", host_abi: 7, profile_hash: [0x11;32], identity: &identity, plan: b"{}", code: &code, pak: &pak }).unwrap();
  std::fs::write(&args[3], bytes).unwrap();
}`);
  run(["rustc", "+stable", "--edition=2021", "-Adead_code", "-Aunused_imports", resolve(out, "main.rs"), "-o", resolve(out, "encode")]);
  const text = new TextEncoder();
  const identity = encodeIdentity({ output: "embedded", id: "test.app", title: "嵌入" });
  for (const code of ["", "hello", "hello\0", "console.log('你好')"]) {
    for (const pak of [new Uint8Array(), Uint8Array.from({ length: 257 }, (_, n) => n & 255)]) {
      writeFileSync(resolve(out, "code"), text.encode(code));
      writeFileSync(resolve(out, "pak"), pak);
      run([resolve(out, "encode"), resolve(out, "code"), resolve(out, "pak"), resolve(out, "app.pocket")]);
      const expected = encodePocketPackage({ manifest: new Uint8Array(), variants: [{ target: "test", hostAbi: 7, profileHash: "sha256:" + "11".repeat(32), sections: [
        { kind: 1, bytes: identity }, { kind: 2, bytes: text.encode("{}") },
        { kind: 3, bytes: text.encode(code.replace(/\0$/, "") + "\0") }, { kind: 4, bytes: pak },
      ] }] });
      expect(new Uint8Array(readFileSync(resolve(out, "app.pocket")))).toEqual(new Uint8Array(expected));
    }
  }
}, 60_000);
