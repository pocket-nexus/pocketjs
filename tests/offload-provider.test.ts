import {expect, test} from "bun:test";
import {createServer, type Socket} from "node:net";
import {connectOffloadProvider} from "../tools/offload-provider.ts";
import {OffloadDecoder, encodeOffloadRecord} from "../tools/offload-wire.ts";

test("offload worker readiness survives shared sessions and reconnect creates a fresh worker", async () => {
  const key = "ab".repeat(32), sockets = new Set<Socket>();
  const replies: unknown[] = [];
  let connections = 0, finish!: () => void;
  const done = new Promise<void>(resolve => {finish = resolve;});
  const server = createServer(socket => {
    const generation = ++connections;
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let auth = Buffer.alloc(0), paired = false;
    const decoder = new OffloadDecoder();
    socket.on("data", rawChunk => {
      let chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
      if (!paired) {
        auth = Buffer.concat([auth, chunk]);
        if (auth.length < 64) return;
        expect(auth.subarray(0,64).toString()).toBe(key);
        chunk = auth.subarray(64); paired = true;
        socket.write(encodeOffloadRecord(JSON.stringify({v:1,id:1,method:"test.echo",payload:`session-${generation}`})));
      }
      decoder.push(chunk, raw => {
        replies.push(JSON.parse(raw));
        if (generation === 1) socket.destroy(); else finish();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const provider = connectOffloadProvider({address:"127.0.0.1",port:address.port,key,
    worker:new URL("./fixtures/offload-ready-worker.ts",import.meta.url)});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("provider reconnect timeout")),4500)})]);
    expect(connections).toBe(2);
    expect(replies).toEqual([{id:1,payload:"1:session-1"},{id:1,payload:"1:session-2"}]);
  } finally {
    clearTimeout(timer);provider.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(()=>resolve()));
  }
}, 6000);
