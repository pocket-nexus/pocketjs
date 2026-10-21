import { expect, test } from "bun:test";
import { OLD_RUNTIME_CANDIDATE, runRuntimeCompatibility } from "../tools/test-runtime-cabi-compat.ts";

test("old and new C headers link real archives from different revisions", async () => {
  const receipt = await runRuntimeCompatibility();
  expect(receipt.oldRevision).toBe(OLD_RUNTIME_CANDIDATE);
  expect(receipt.status).toBe("candidate");
  expect(receipt.abiFrozen).toBe(false);
  expect(receipt.result).toBe("passed");
  expect(receipt.cases).toEqual([
    "old-header-new-archive", "new-header-old-archive", "new-api-current-control", "new-api-old-archive-link-rejected",
  ]);
  expect(receipt.oldArchiveSha256).not.toBe(receipt.currentArchiveSha256);
  expect(receipt.headers.old.runtime).not.toBe(receipt.headers.current.runtime);
  expect(receipt.signalProbe).toEqual({ asynchronous: "SIGABRT", synchronous: "SIGABRT" });
}, 240_000);
