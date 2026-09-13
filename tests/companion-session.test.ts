import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { connectCompanionSession } from "../tools/companion-session.ts";
import { OffloadDecoder, encodeOffloadRecord } from "../tools/offload-wire.ts";

test("paired sessions exchange records, fence reconnect and never retry application sends", async () => {
  const key = "ab".repeat(32), sockets = new Set<Socket>();
  let connections = 0;
  const commands: string[] = [], received: string[] = [];
  let finish!: () => void;
  const complete = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(socket => {
    connections++; sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let auth = Buffer.alloc(0), paired = false;
    const decoder = new OffloadDecoder();
    socket.on("data", rawChunk => {
      let chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
      if (!paired) {
        auth = Buffer.concat([auth, chunk]);
        if (auth.length < 64) return;
        expect(auth.subarray(0, 64).toString()).toBe(key);
        chunk = auth.subarray(64); paired = true;
        const record = encodeOffloadRecord(`session-${connections}`);
        socket.write(record.subarray(0, 3)); socket.write(record.subarray(3));
      }
      decoder.push(chunk, raw => {
        commands.push(raw);
        socket.write(encodeOffloadRecord(`ack-${raw}`));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const session = connectCompanionSession({ address: "127.0.0.1", port: address.port, key, retryMs: 5,
    record(raw) {
      received.push(raw);
      if (raw === "session-1") expect(session.send("move-once")).toBe(true);
      if (raw === "ack-move-once") session.disconnect();
      if (raw === "session-2") finish();
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([complete, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("session test timeout")), 3000); })]);
    expect(received).toEqual(["session-1", "ack-move-once", "session-2"]);
    expect(commands).toEqual(["move-once"]);
  } finally {
    clearTimeout(timer); session.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  expect(session.send("after-close")).toBe(false);
});
