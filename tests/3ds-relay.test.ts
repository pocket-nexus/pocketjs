import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the 3DS native Relay worker pairs, frames and reconnects over TCP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-3ds-relay-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const binary = join(directory, "native");
    const compile = Bun.spawnSync([
      "cc", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-pthread",
      "-fsanitize=address,undefined", "-Itests/fixtures/offload-native",
      `-DPOCKETJS_RELAY_KEY="${join(directory, "pairing.key")}"`,
      `-DPOCKETJS_RELAY_HOST="${join(directory, "device.host")}"`,
      "tests/fixtures/3ds-relay-native/main.c", "hosts/3ds/src/relay.c", "-o", binary,
    ]);
    if (compile.exitCode) throw new Error(compile.stderr.toString());
    child = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    if (status) throw new Error(error);
    expect(output).toContain("native Relay pairing, framing, frame credit and realm-reset reconnect passed");
  } finally {
    child?.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
