import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "darwin")("legacy Apple wire yields during bulk input and survives a disconnected peer", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-svcwire-"));
  try {
    const source = join(root, "probe.c");
    writeFileSync(source, `#define POCKET_SVC_WIRE
#include ${JSON.stringify(resolve(import.meta.dir, "../programs/shared/ios-legacy/svcwire.c"))}
#include <assert.h>
#include <signal.h>
int main(void) {
  int pair[2];
  char bulk[8192] = {0};
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  tcp_fd = pair[0];
  assert(set_nonblocking(tcp_fd));
  state = SVC_STATE_UP;
  skip_remaining = 65536;
  assert(send(pair[1], bulk, sizeof bulk, 0) == sizeof bulk);
  pump_rx();
  assert(skip_remaining == 65536 - 4096);
  signal(SIGPIPE, SIG_DFL);
  assert(disable_sigpipe(tcp_fd));
  close(pair[1]);
  tx_buffer[0] = 0;
  tx_length = 1;
  tx_offset = 0;
  pump_tx();
  assert(state == SVC_STATE_BACKOFF);
  assert(tcp_fd == -1);
  return 0;
}
`);
    const binary = join(root, "probe");
    const build = Bun.spawnSync(["xcrun", "clang", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    expect(Bun.spawnSync([binary]).exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
