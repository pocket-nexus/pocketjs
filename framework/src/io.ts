import { FactKind, ResourceKind, ResourceStatus, WORKER_LIMITS } from "../../contracts/spec/worker.ts";
import { ResourceError, settle, workerDeclaration, workerHost, type FactRecord } from "./worker.ts";
import { createTimer, observeChannel, observeResource, releaseResource, snapshotOf, type Timer } from "./worker-runtime.ts";
import { encodeI2CScript, integer, type I2CStep } from "./io/i2c.ts";
import {
  decodeMqttConnack, decodeMqttError, encodeMqttDisconnect, encodeMqttOpen, encodeMqttPublish, encodeMqttSubscribe,
  encodeMqttUnsubscribe, MQTT_LIMITS, MqttOpcode, MqttRecordAssembler, type MqttBytes, type MqttDisconnectOptions,
  type MqttEvent, type MqttOptions, type MqttPublishOptions, type MqttSubscribeOptions, type MqttSubscription,
  type MqttUserProperties, type MqttVersion,
} from "./io/mqtt.ts";
import { utf8, utf8Text } from "./io/utf8.ts";

export { ResourceStatus, FactKind } from "../../contracts/spec/worker.ts";
export { ResourceError } from "./worker.ts";
export type { FactRecord, TimerTick } from "./worker.ts";
export type { Timer } from "./worker-runtime.ts";
export { utf8, utf8Text } from "./io/utf8.ts";
export type {
  MqttConnack, MqttDisconnectOptions, MqttEvent, MqttMessage, MqttOptions, MqttPublishOptions, MqttQos,
  MqttSubscribeOptions, MqttSubscription, MqttTlsOptions, MqttUserProperties, MqttVersion, MqttWill,
} from "./io/mqtt.ts";

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
  /** Whether a device acknowledges the address: an address-only
   *  transaction (opcode 2, the timeout as two little-endian bytes) that
   *  writes no register byte, so it reads and changes nothing. Rejects with
   *  a ResourceError when the host accepts nothing. */
  async probe(options?: { readonly timeoutMillis?: number }): Promise<boolean> {
    const timeout = options?.timeoutMillis ?? this.timeoutMillis;
    integer(timeout, 1, 65535, "I2C timeoutMillis");
    const request = this.host().submit(this.handle, 2, Uint8Array.of(timeout & 0xff, timeout >> 8), 0);
    if (request < 0) throw new ResourceError(request, -1, `${this.node} did not accept the I2C probe: ${request}`);
    return (await settle(request)).status === ResourceStatus.ok;
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
/** Events an MQTT client holds for a reader that has not taken them. A
 *  message beyond either bound is dropped and counted in a `lost` event;
 *  connection events are always kept. */
export const MQTT_QUEUE = { events: 64, bytes: 256 * 1024 } as const;

/** One MQTT session (contracts/spec/mqtt.ts). The client reads its own
 *  stream from open, joins message records and queues the events for
 *  `events()`, so a reader that awaits a publish or a subscribe inside its
 *  loop loses no stream records; use `events()`, not `observe()`. */
export class MqttClient extends Resource {
  private readonly queue: MqttEvent[] = [];
  private queuedBytes = 0;
  private waiter: { resolve(result: IteratorResult<MqttEvent>): void; reject(error: unknown): void } | undefined;
  private reading = false;
  private finished = false;
  private failure: unknown;
  private staging: Promise<void> = Promise.resolve();
  constructor(handle: number, node: string, readonly protocol: MqttVersion, maxRecordBytes: number) {
    super(handle, node);
    void this.pump(new MqttRecordAssembler(maxRecordBytes));
  }
  private get v5(): boolean { return this.protocol === "5"; }
  private async pump(assembler: MqttRecordAssembler): Promise<void> {
    try {
      for await (const fact of super.observe()) {
        if (fact.kind === FactKind.headers) this.deliver({ type: "connected", ...decodeMqttConnack(fact.data) });
        else if (fact.kind === FactKind.data) {
          const message = assembler.push(fact.offset, fact.data);
          if (message) this.deliver({ type: "message", ...message });
        } else if (fact.kind === FactKind.gap) { assembler.reset(); this.lose(fact.request); }
        else if (fact.kind === FactKind.error) this.deliver({ type: "disconnected", ...decodeMqttError(fact.data) });
        else if (fact.kind === FactKind.end) this.deliver({ type: "ended", status: fact.status });
        else if (fact.kind === FactKind.closed) break;
      }
    } catch (error) {
      this.failure = error;
    }
    this.finished = true;
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) this.next().then(waiter.resolve, waiter.reject);
  }
  private lose(count: number): void {
    const last = this.queue[this.queue.length - 1];
    if (last?.type === "lost") this.queue[this.queue.length - 1] = { type: "lost", count: last.count + count };
    else this.deliver({ type: "lost", count });
  }
  private deliver(event: MqttEvent): void {
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ value: event, done: false }); return; }
    if (event.type === "message") {
      const size = event.payload.length + event.topic.length;
      if (this.queue.length >= MQTT_QUEUE.events || this.queuedBytes + size > Math.max(MQTT_QUEUE.bytes, size)) { this.lose(1); return; }
      this.queuedBytes += size;
    }
    this.queue.push(event);
  }
  /** Not available: the client reads its stream itself. */
  override observe(): AsyncIterable<never> { throw new Error(`MQTT client ${this.node} reads its own stream; use events()`); }
  /** The session's events in arrival order, for one reader at a time. The
   *  iteration ends when the resource closes. */
  events(): AsyncIterable<MqttEvent> {
    if (this.reading) throw new Error(`MQTT client ${this.node} already has an events reader`);
    this.reading = true;
    const iterator: AsyncIterator<MqttEvent> = {
      next: () => this.next(),
      return: () => {
        this.reading = false;
        const waiter = this.waiter; this.waiter = undefined;
        waiter?.resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
  private next(): Promise<IteratorResult<MqttEvent>> {
    const event = this.queue.shift();
    if (event) {
      if (event.type === "message") this.queuedBytes -= event.payload.length + event.topic.length;
      return Promise.resolve({ value: event, done: false });
    }
    if (this.finished) {
      this.reading = false;
      if (this.failure !== undefined) { const failure = this.failure; this.failure = undefined; return Promise.reject(failure); }
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.waiter) return Promise.reject(new Error(`MQTT client ${this.node} has a read in progress`));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  private async run(opcode: number, payload: Uint8Array, what: string): Promise<Uint8Array> {
    const request = this.host().submit(this.handle, opcode, payload, MQTT_LIMITS.resultBytes);
    if (request < 0) throw new ResourceError(request, -1, `${this.node} did not accept the MQTT ${what}: ${request}`);
    const record = await settle(request);
    if (record.status !== ResourceStatus.ok) {
      const detail = record.data.length ? `: ${utf8Text(record.data)}` : "";
      throw new ResourceError(record.status, request, `${this.node} MQTT ${what} ended with status ${record.status}${detail}`);
    }
    return record.data;
  }
  /** Publishes and resolves with the PUBACK or PUBCOMP reason code (0 under
   *  MQTT 3.1.1 and for QoS 0) once the broker acknowledged a QoS 1 or 2
   *  message, or the host wrote a QoS 0 message. A payload that does not
   *  fit the 1024-byte request is written first and published from the
   *  session's staging buffer, one such payload at a time. Rejects with a
   *  ResourceError when the session is not connected (QoS 0), the outbox
   *  is full, the broker refused it or the message expired in the outbox. */
  async publish(topic: string, payload?: MqttBytes, options: MqttPublishOptions = {}): Promise<number> {
    const { request, staged } = encodeMqttPublish(topic, payload, options, this.v5);
    if (!staged) return (await this.run(MqttOpcode.publish, request, "publish"))[0] ?? 0;
    const previous = this.staging;
    let release!: () => void;
    this.staging = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      const host = this.host();
      host.write(this.handle, new Uint8Array(0));
      for (let at = 0; at < staged.length; at += WORKER_LIMITS.payloadBytes) {
        const chunk = staged.subarray(at, at + WORKER_LIMITS.payloadBytes);
        const written = host.write(this.handle, chunk);
        if (written !== chunk.length) throw new ResourceError(written < 0 ? written : ResourceStatus.busy, -1, `${this.node} took ${written} of ${chunk.length} staged MQTT payload bytes`);
      }
      return (await this.run(MqttOpcode.publish, request, "publish"))[0] ?? 0;
    } finally {
      release();
    }
  }
  /** Subscribes and resolves with the SUBACK code of each filter: the
   *  granted QoS, or 0x80 and above for a refused filter. Rejects when the
   *  session is not connected; subscribe again after a `connected` event
   *  whose sessionPresent is false. */
  async subscribe(filters: string | MqttSubscription | readonly (string | MqttSubscription)[], options: MqttSubscribeOptions = {}): Promise<number[]> {
    const { request } = encodeMqttSubscribe(filters, options, this.v5);
    return Array.from(await this.run(MqttOpcode.subscribe, request, "subscribe"));
  }
  /** Unsubscribes and resolves with a code per filter (MQTT 5; 0 under 3.1.1). */
  async unsubscribe(filters: string | readonly string[], options: { readonly userProperties?: MqttUserProperties } = {}): Promise<number[]> {
    const { request } = encodeMqttUnsubscribe(filters, options, this.v5);
    return Array.from(await this.run(MqttOpcode.unsubscribe, request, "unsubscribe"));
  }
  /** Sets the DISCONNECT the session sends (MQTT 5 reason code, session
   *  expiry, user properties), then closes the resource. */
  async disconnect(options: MqttDisconnectOptions = {}): Promise<number> {
    await this.run(MqttOpcode.disconnect, encodeMqttDisconnect(options, this.v5), "disconnect");
    return this.close();
  }
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
  /** An MQTT session with one broker. The host connects after open (after
   *  the TLS material when `tls` names any), reconnects after
   *  `reconnectMs`, and streams CONNACKs, disconnections and messages as
   *  `events()`. */
  mqtt(name = "mqtt") {
    return { open(options: MqttOptions): MqttClient {
      const { descriptor, credentials } = encodeMqttOpen(options);
      const maxMessage = options.maxMessageBytes ?? MQTT_LIMITS.defaultMessageBytes;
      const client = new MqttClient(open("mqtt", name, descriptor), name, options.protocol ?? "3.1.1", 9 + 2 * 0xffff + maxMessage);
      for (let at = 0; at < credentials.length; at += WORKER_LIMITS.payloadBytes) {
        const chunk = credentials.subarray(at, at + WORKER_LIMITS.payloadBytes);
        const written = workerHost().write(client.handle, chunk);
        if (written !== chunk.length) {
          client.close();
          throw new Error(`MQTT node ${name} took ${written} of ${chunk.length} TLS bytes`);
        }
      }
      return client;
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
