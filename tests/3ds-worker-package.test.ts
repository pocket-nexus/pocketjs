import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

test("3DS native admission requires a declared, nonempty worker section", () => {
  const root = resolve(import.meta.dir, "..");
  const output = resolve(root, ".pocket-build/validation/worker/network");
  mkdirSync(output, { recursive: true });
  const executable = resolve(output, "package-worker-test");
  const harness = resolve(output, "package-worker-test.rs");
  writeFileSync(harness, `
#[path = ${JSON.stringify(resolve(root, "engine/package/src/plan_facts.rs"))}]
mod plan_facts;
#[path = ${JSON.stringify(resolve(root, "products/3ds/core/src/worker_section.rs"))}]
mod worker_section;
#[test]
fn capability_availability_does_not_require_an_undeclared_worker() {
    let plan = br#"{"features":{"runtime.worker":true}}"#;
    let declared = plan_facts::worker_declared(plan).unwrap();
    assert!(!declared);
    assert_eq!(worker_section::select(declared, None), Ok(&[][..]));
    assert_eq!(worker_section::select(declared, Some(b"turn();\\0")), Err(18));
    let declared_plan = br#"{"app":{"worker":{"entry":"worker.ts"}},"features":{"runtime.worker":true}}"#;
    assert_eq!(worker_section::select(plan_facts::worker_declared(declared_plan).unwrap(), None), Err(18));
}
`);
  const compile = Bun.spawnSync(["rustc", "--edition=2021", "--test", harness, "-o", executable]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([executable]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
});
