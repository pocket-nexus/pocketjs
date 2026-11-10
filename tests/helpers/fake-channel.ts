// A scripted `globalThis.link.channel` for tests of framework/src/channel.ts.
//
// It models a host WITHOUT the generation in its handles: ids come from one
// counter that starts again at every connection, as the wire's ids do
// (docs/POCKET-LINK.md §5.1), and nothing here refuses a handle of an earlier
// generation. What the tests then see refused is the framework's own check.
// The 3DS bindings add the host's check on top (link2_channel_qjs.c).
//
//   - read: bytes, 0 pending, -6 at the end, -7 once after a reset, -4 for an
//     id that names no stream or a zero capacity;
//   - write: -2 while the channel is not open, -4 for an id that names no
//     stream, -5 before the head step, else the bytes `writeRoom` has room for;
//   - close(id, outbound) abandons one side of the id;
//   - reply: -2 not open, -4 unknown id, -3 over LINK_APP_MSG.
export const APP_MSG = 8192;
type Entry = { k: number; id: number; s: number; e: boolean; m: unknown };
export class FakeChannel {
  state: "open" | "opening" | "closed" = "open";
  reason = "";
  generation = 1;
  nextId = 3;
  nextHubId = 0x80000001;
  inbox: Entry[] = [];
  /** the applet's open requests */
  out = new Map<number, { json: string; body: boolean; cancelled: boolean }>();
  /** streams toward the applet */
  inStreams = new Map<number, { data: number[]; ended: boolean; failed: boolean; label: string }>();
  /** streams toward the daemon */
  outStreams = new Map<number, { bytes: number[]; ended: boolean; label: string }>();
  /** the daemon's requests handed to the guest */
  handed = new Map<number, { t: string; head: boolean }>();
  replies: { id: number; json: string; error: boolean; generation: number }[] = [];
  events: string[] = [];
  log: string[] = [];
  writeRoom = 16;
  replyFull = 0;
  calls = { poll: 0, state: 0, read: 0, write: 0 };

  ops = {
    state: () => {
      this.calls.state += 1;
      return JSON.stringify({ state: this.state, reason: this.reason, generation: this.state === "open" ? this.generation : 0 });
    },
    poll: () => {
      this.calls.poll += 1;
      if (this.state !== "open") return undefined;
      const entry = this.inbox.shift();
      if (!entry) return undefined;
      if (entry.k === 4) this.handed.set(entry.id, { t: String((entry.m as { t?: string }).t ?? ""), head: false });
      return JSON.stringify(entry);
    },
    request: (json: string, body: boolean) => {
      if (this.state !== "open") return -2;
      if (json.length > APP_MSG) return -3;
      const id = this.nextId++;
      this.out.set(id, { json, body, cancelled: false });
      if (body) this.outStreams.set(id, { bytes: [], ended: false, label: `body of request ${id} gen ${this.generation}` });
      return id;
    },
    cancel: (id: number) => {
      const request = this.out.get(id);
      if (!request) return -4;
      request.cancelled = true;
      this.log.push(`cancel ${id}`);
      return 0;
    },
    emit: (json: string, stream: boolean) => {
      if (this.state !== "open") return -2;
      if (json.length > APP_MSG) return -3;
      this.events.push(json);
      if (!stream) return 0;
      const id = this.nextId++;
      this.outStreams.set(id, { bytes: [], ended: false, label: `stream of ${JSON.parse(json).t} gen ${this.generation}` });
      return id;
    },
    progress: (id: number, _json: string) => {
      if (this.state !== "open") return -2;
      const request = this.handed.get(id);
      if (!request) return -4;
      request.head = true;
      return 0;
    },
    reply: (id: number, json: string, error: boolean) => {
      if (this.state !== "open") return -2;
      if (!this.handed.has(id)) return -4;
      if (json.length > APP_MSG) return -3;
      if (this.replyFull > 0) {
        this.replyFull -= 1;
        return -1;
      }
      this.handed.delete(id);
      this.inStreams.delete(id);
      this.replies.push({ id, json, error, generation: this.generation });
      return 0;
    },
    read: (id: number, into: Uint8Array) => {
      this.calls.read += 1;
      const stream = this.inStreams.get(id);
      if (!stream || into.length === 0) return -4;
      if (stream.failed) {
        this.inStreams.delete(id);
        return -7;
      }
      if (stream.data.length > 0) {
        const n = Math.min(into.length, stream.data.length);
        into.set(stream.data.splice(0, n));
        return n;
      }
      if (stream.ended) {
        this.inStreams.delete(id);
        return -6;
      }
      return 0;
    },
    write: (id: number, bytes: Uint8Array) => {
      this.calls.write += 1;
      if (this.state !== "open") return -2;
      let stream = this.outStreams.get(id);
      if (!stream) {
        const request = this.handed.get(id);
        if (!request) return -4;
        if (!request.head) return -5;
        stream = { bytes: [], ended: false, label: `response of ${id} gen ${this.generation}` };
        this.outStreams.set(id, stream);
      }
      if (stream.ended) return -4;
      const n = Math.min(bytes.length, this.writeRoom);
      for (let i = 0; i < n; i += 1) stream.bytes.push(bytes[i]!);
      return n;
    },
    end: (id: number) => {
      const stream = this.outStreams.get(id);
      if (!stream) return -4;
      stream.ended = true;
      return 0;
    },
    close: (id: number, outbound?: boolean) => {
      const side = outbound ? this.outStreams : this.inStreams;
      this.log.push(`close ${outbound ? "out" : "in"} ${id}${side.has(id) ? ` [${side.get(id)!.label}]` : ""}`);
      side.delete(id);
    },
  };

  /** Connection loss: everything of the channel goes, nothing is sent (§7.5). */
  drop(reason = "connection"): void {
    this.state = "closed";
    this.reason = reason;
    this.inbox = [];
    this.out.clear();
    this.inStreams.clear();
    this.outStreams.clear();
    this.handed.clear();
  }
  /** The next `ready` and its channel.open: a new generation, ids from the start. */
  reopen(): void {
    this.state = "open";
    this.reason = "";
    this.generation += 1;
    this.nextId = 3;
    this.nextHubId = 0x80000001;
  }
  /** Hub closes the channel and the device opens it again on the same connection. */
  reopenSameConnection(): void {
    this.drop("daemon");
    this.state = "open";
    this.reason = "";
    this.generation += 1;
  }
  reply(id: number, m: unknown, error = false): void {
    this.out.delete(id);
    this.inbox.push({ k: 3, id, s: 0, e: error, m });
  }
  progress(id: number, m: unknown, label?: string): void {
    const first = label !== undefined;
    if (first) this.inStreams.set(id, { data: [], ended: false, failed: false, label });
    this.inbox.push({ k: 2, id, s: first ? id : 0, e: false, m });
  }
  event(m: unknown, streamLabel?: string): number {
    const id = streamLabel !== undefined ? this.nextHubId++ : 0;
    if (id) this.inStreams.set(id, { data: [], ended: false, failed: false, label: streamLabel! });
    this.inbox.push({ k: 1, id: 0, s: id, e: false, m });
    return id;
  }
  daemonRequest(m: unknown, bodyLabel?: string): number {
    const id = this.nextHubId++;
    if (bodyLabel !== undefined) this.inStreams.set(id, { data: [], ended: false, failed: false, label: bodyLabel });
    this.inbox.push({ k: 4, id, s: bodyLabel !== undefined ? id : 0, e: false, m });
    return id;
  }
  feed(id: number, text: string, end = false): void {
    const stream = this.inStreams.get(id)!;
    for (const c of text) stream.data.push(c.charCodeAt(0));
    if (end) stream.ended = true;
  }
}

export const text = (bytes: Iterable<number>) => String.fromCharCode(...bytes);
export const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
