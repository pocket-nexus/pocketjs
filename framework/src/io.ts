import { ResourceKind, ResourceStatus, WORKER_LIMITS } from "../../contracts/spec/worker.ts";
import { workerHost, workerDeclaration, type Inbox, type FactView } from "./worker.ts";
import { encodeI2CScript, integer, type I2CStep } from "./io/i2c.ts";

export { ResourceStatus, FactKind } from "../../contracts/spec/worker.ts";
export class Resource {
  private closed = false;
  constructor(readonly handle: number) {}
  protected host() {
    if (this.closed) throw new Error("Resource is closed");
    return workerHost();
  }
  observe(inbox: Inbox): readonly FactView[] { return inbox.events(this.handle); }
  cancel(request: number): number { return this.host().cancel(request); }
  close(): number {
    if (this.closed) return ResourceStatus.ok;
    const result = workerHost().close(this.handle);
    if (result === ResourceStatus.ok || result === ResourceStatus.busy) this.closed = true;
    return result;
  }
}
export class I2CDevice extends Resource {
  constructor(handle: number, private readonly timeoutMillis: number) { super(handle); }
  submit<const S extends readonly I2CStep[]>(script: S, options?: { readonly timeoutMillis?: number }): number {
    const { payload, resultBytes } = encodeI2CScript(script, options?.timeoutMillis ?? this.timeoutMillis);
    const request = this.host().submit(this.handle, 1, payload, resultBytes);
    return request < 0 ? -1 : request;
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
      return new I2CDevice(open("i2c", name, Uint8Array.of(1, options.address)), timeout);
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
      return new ByteStream(open("uart", name, config));
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
      return new HttpRequest(open("http", name, config));
    } };
  },
  timer(id: number, deadlineMicros: number, periodMicros = 0): boolean {
    integer(id, 1, WORKER_LIMITS.timers, "timer id");
    integer(deadlineMicros, 0, Number.MAX_SAFE_INTEGER, "timer deadline");
    integer(periodMicros, 0, Number.MAX_SAFE_INTEGER, "timer period");
    return workerHost().timer(id, deadlineMicros, periodMicros) === ResourceStatus.ok;
  },
  /** A declared channel's worker side: publish toward the UI. Inbound
   *  records arrive through the turn inbox. */
  channel(name: string) {
    const channels = workerDeclaration()?.channels ?? [];
    const id = channels.findIndex(channel => channel.name === name);
    if (id < 0) throw new Error(`Undeclared worker channel: ${name}`);
    const channel = channels[id];
    return { publish(data: Uint8Array): boolean {
      if (channel.direction !== "worker-to-ui") throw new Error(`Channel ${name} is receive-only in the worker domain; read it from the turn inbox`);
      if (data.length > channel.recordBytes) throw new RangeError(`Channel ${name} record exceeds ${channel.recordBytes} bytes`);
      return workerHost().publish(id + 1, data) === ResourceStatus.ok;
    } };
  },
};
