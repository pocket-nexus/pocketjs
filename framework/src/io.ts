import { ResourceKind, ResourceStatus, WORKER_LIMITS } from "../../contracts/spec/worker.ts";
import { ResourceError, settle, workerDeclaration, workerHost, type FactRecord } from "./worker.ts";
import { createTimer, observeChannel, observeResource, releaseResource, snapshotOf, type Timer } from "./worker-runtime.ts";
import { encodeI2CScript, integer, type I2CStep } from "./io/i2c.ts";

export { ResourceStatus, FactKind } from "../../contracts/spec/worker.ts";
export { ResourceError } from "./worker.ts";
export type { FactRecord, TimerTick } from "./worker.ts";
export type { Timer } from "./worker-runtime.ts";

export class Resource {
  private closed = false;
  constructor(readonly handle: number, readonly node: string) {}
  protected host() {
    if (this.closed) throw new Error("Resource is closed");
    return workerHost();
  }
  /** The resource's stream facts in arrival order: ready, headers, data, end,
   *  gap, error, credit and closed. A completion settles its request instead.
   *  Records that arrive while no loop reads the stream expire with their
   *  turn; a loop that falls OBSERVER_LIMIT records behind faults the realm.
   *  The stream ends when the resource closes. */
  observe(): AsyncIterable<FactRecord> { this.host(); return observeResource(this.handle, `${this.node} stream`); }
  cancel(request: number): number { return this.host().cancel(request); }
  close(): number {
    if (this.closed) return ResourceStatus.ok;
    const result = workerHost().close(this.handle);
    if (result === ResourceStatus.ok || result === ResourceStatus.busy) { this.closed = true; releaseResource(this.handle); }
    return result;
  }
}
export class I2CDevice extends Resource {
  constructor(handle: number, node: string, private readonly timeoutMillis: number) { super(handle, node); }
  /** Reserves a request slot and result capacity; -1 when nothing was accepted. */
  submit<const S extends readonly I2CStep[]>(script: S, options?: { readonly timeoutMillis?: number }): number {
    const request = this.accept(script, options);
    return request < 0 ? -1 : request;
  }
  /** Submits the script and resolves with the concatenated read results once
   *  the completion arrives. Rejects with a ResourceError when the host does
   *  not accept the script or the transaction ends with another status. */
  async run<const S extends readonly I2CStep[]>(script: S, options?: { readonly timeoutMillis?: number }): Promise<Uint8Array> {
    const request = this.accept(script, options);
    if (request < 0) throw new ResourceError(request, -1, `${this.node} did not accept the I2C script: ${request}`);
    const record = await settle(request);
    if (record.status !== ResourceStatus.ok) throw new ResourceError(record.status, request, `${this.node} request ${request} ended with status ${record.status}`);
    return record.data;
  }
  private accept(script: readonly I2CStep[], options?: { readonly timeoutMillis?: number }): number {
    const { payload, resultBytes } = encodeI2CScript(script, options?.timeoutMillis ?? this.timeoutMillis);
    return this.host().submit(this.handle, 1, payload, resultBytes);
  }
}
export class ByteStream extends Resource {
  /** Accepted bytes are copied by the host before this call returns. */
  write(data: Uint8Array): number { return this.host().write(this.handle, data); }
}
export interface UartOptions {
  readonly baudRate: number;
  readonly dataBits?: 5 | 6 | 7 | 8;
  readonly stopBits?: 1 | 2;
  readonly parity?: "none" | "odd" | "even";
  readonly flowControl?: "none" | "rts-cts";
}
export interface HttpOptions {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Version 1 accepts a bounded UTF-8 request body. */
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}
export class HttpRequest extends Resource {
  /** Starts the request; -1 when the host did not accept it. The response
   *  streams through observe(); the completion settles the request id. */
  submit(): number { const request = this.host().submit(this.handle, 1, new Uint8Array(0), 0); return request < 0 ? -1 : request; }
}
function open(kind: keyof typeof ResourceKind, name: string, config: Uint8Array): number {
  const declaration = workerDeclaration();
  if (declaration && !declaration.nodes.some(node => node.name === name && node.kind === kind)) throw new Error(`Undeclared ${kind} node: ${name}`);
  const handle = workerHost().open(ResourceKind[kind], name, config);
  if (handle < 0) throw new Error(`Cannot open ${kind} node ${name}: ${handle}`);
  return handle;
}
/** QuickJS does not require the Web TextEncoder global. */
export function utf8(text: string): Uint8Array {
  const values: number[] = [];
  for (const char of text) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) values.push(cp);
    else if (cp < 0x800) values.push(0xc0 | cp >> 6, 0x80 | cp & 63);
    else if (cp < 0x10000) values.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    else values.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
  }
  return Uint8Array.from(values);
}
export const io = {
  i2c(name: string) {
    return { open(options: { readonly address: number; readonly timeoutMillis?: number }): I2CDevice {
      integer(options.address, 8, 0x77, "I2C address");
      const timeout = options.timeoutMillis ?? 100;
      integer(timeout, 1, 65535, "I2C timeoutMillis");
      return new I2CDevice(open("i2c", name, Uint8Array.of(1, options.address)), name, timeout);
    } };
  },
  uart(name: string) {
    return { open(options: UartOptions): ByteStream {
      integer(options.baudRate, 1, 0xffff_ffff, "UART baudRate");
      const dataBits = options.dataBits ?? 8, stopBits = options.stopBits ?? 1;
      integer(dataBits, 5, 8, "UART dataBits"); integer(stopBits, 1, 2, "UART stopBits");
      const parity = ["none", "odd", "even"].indexOf(options.parity ?? "none");
      const flow = ["none", "rts-cts"].indexOf(options.flowControl ?? "none");
      if (parity < 0 || flow < 0) throw new RangeError("Invalid UART parity or flow control");
      const config = new Uint8Array(9);
      config.set([1, dataBits, stopBits, parity]);
      new DataView(config.buffer).setUint32(4, options.baudRate, true); config[8] = flow;
      return new ByteStream(open("uart", name, config), name);
    } };
  },
  http(name = "http") {
    return { open(options: HttpOptions): HttpRequest {
      if (!/^https?:\/\//.test(options.url)) throw new TypeError("HTTP requires an http or https URL");
      if (options.body !== undefined && typeof options.body !== "string") throw new TypeError("HTTP body must be UTF-8 text");
      if (options.timeoutMs !== undefined) integer(options.timeoutMs, 1, 0x7fff_ffff, "HTTP timeoutMs");
      if (options.maxBytes !== undefined) integer(options.maxBytes, 1, 0x7fff_ffff, "HTTP maxBytes");
      const config = utf8(JSON.stringify(options));
      if (config.length > WORKER_LIMITS.payloadBytes) throw new RangeError("HTTP descriptor exceeds 1024 bytes");
      return new HttpRequest(open("http", name, config), name);
    } };
  },
  /** A periodic deadline read with `for await`. Each tick carries its planned
   *  deadline and the periods that passed unobserved; the deadline advances
   *  by whole periods, so the schedule does not drift with turn latency.
   *  The first tick is due after `firstMicros` (default: one period). */
  timer(periodMicros: number, options?: { readonly firstMicros?: number }): Timer {
    return createTimer(periodMicros, options?.firstMicros);
  },
  /** A declared channel's worker side. */
  channel(name: string) {
    const channels = workerDeclaration()?.channels ?? [];
    const id = channels.findIndex(channel => channel.name === name);
    if (id < 0) throw new Error(`Undeclared worker channel: ${name}`);
    const channel = channels[id]!;
    return {
      /** Worker-to-UI: copies one record toward the UI; false when a ring is full. */
      publish(data: Uint8Array): boolean {
        if (channel.direction !== "worker-to-ui") throw new Error(`Channel ${name} is receive-only in the worker domain; read it with observe()`);
        if (data.length > channel.recordBytes) throw new RangeError(`Channel ${name} record exceeds ${channel.recordBytes} bytes`);
        return workerHost().publish(id + 1, data) === ResourceStatus.ok;
      },
      /** UI-to-worker: each arriving record, as a retained copy. */
      observe(): AsyncIterable<Uint8Array> {
        if (channel.direction !== "ui-to-worker") throw new Error(`Channel ${name} is publish-only in the worker domain`);
        return observeChannel(id + 1, `channel ${name}`);
      },
      /** UI-to-worker snapshot: the retained newest record, or undefined before the first one. */
      snapshot(): Uint8Array | undefined {
        if (channel.kind !== "snapshot" || channel.direction !== "ui-to-worker") throw new Error(`No inbound snapshot channel: ${name}`);
        return snapshotOf(id + 1);
      },
    };
  },
};
