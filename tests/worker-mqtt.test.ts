import { afterEach, expect, test } from "bun:test";
import { bindWorker, FactKind, ResourceError, ResourceStatus, type HostFact, type WorkerHost } from "../framework/src/worker.ts";
import { io, type MqttEvent } from "../framework/src/io.ts";
import {
  decodeMqttConnack, decodeMqttError, decodeMqttRecord, encodeMqttDisconnect, encodeMqttOpen, encodeMqttPublish,
  encodeMqttSubscribe, encodeMqttUnsubscribe, MqttRecordAssembler, utf8, utf8Text,
} from "../framework/src/io/mqtt.ts";
import { MQTT_OPEN_FIXED_BYTES, MqttOpcode, MqttProperty } from "../contracts/spec/mqtt.ts";
import { ResourceKind } from "../contracts/spec/worker.ts";

const global = globalThis as any;
afterEach(() => { delete global.__pocketWorker; delete global.__pocketWorkerTurn; });
function host(overrides: Partial<WorkerHost> = {}): WorkerHost {
  return { open: () => 1, submit: () => 2, cancel: () => 0, close: () => 0, write: (_h, data) => data.length,
    publish: () => 0, timer: () => 0, declareChannel: () => 0, ...overrides };
}
const fact = (overrides: Partial<HostFact> = {}): HostFact => ({ kind: FactKind.data, handle: 1, request: 0, status: 0, offset: 0, data: new Uint8Array(0), timer: 0, channel: 0, deadline: 0, missed: 0, ...overrides });
const jobs = () => new Promise<void>(done => setTimeout(done, 0));
let sequence = 0;
const turn = (facts: HostFact[] = []) => global.__pocketWorkerTurn({ generation: 1, sequence: ++sequence, nowMicros: 1000 * sequence }, facts);
const u16 = (value: number) => [value & 0xff, value >> 8];
const u32 = (value: number) => [value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];
const field = (text: string) => [...u16(utf8(text).length), ...utf8(text)];

/** A message record as a host lays it out. */
function record(topic: string, payload: Uint8Array, flags = 0, properties: number[] = []): Uint8Array {
  return Uint8Array.from([flags, ...u32(payload.length), ...u16(utf8(topic).length), ...u16(properties.length), ...utf8(topic), ...properties, ...payload]);
}
function connack(sessionPresent: boolean, protocol = 4, properties: number[] = []): Uint8Array {
  return Uint8Array.from([1, sessionPresent ? 1 : 0, protocol, 2, ...u32(0), ...u16(65535), ...u16(0), 0x0f, 0, ...u16(properties.length), ...properties]);
}

test("utf8Text decodes what utf8 encodes and replaces malformed sequences", () => {
  for (const text of ["", "plain", "Grüße", "温度 21.5", "emoji 🌡️"]) expect(utf8Text(utf8(text))).toBe(text);
  expect(utf8Text(Uint8Array.of(0x61, 0xff, 0x62))).toBe("a�b");
  expect(utf8Text(Uint8Array.of(0xe6, 0xb8))).toBe("��");
  expect(utf8Text(Uint8Array.of(0xc0, 0x80))).toBe("��");
});

test("the open descriptor carries the fixed fields, strings, will and the TLS byte counts", () => {
  const { descriptor, credentials } = encodeMqttOpen({
    url: "mqtts://broker.local:8883", clientId: "tab5", username: "user", password: "secret",
    keepAliveSeconds: 30, reconnectMs: 2000, timeoutMs: 8000, maxMessageBytes: 4096, cleanStart: false,
    will: { topic: "tab5/status", payload: "offline", qos: 1, retain: true },
    tls: { ca: "CA", certificate: "CERT", key: "KEY", commonName: "broker", alpn: ["mqtt", "x-amzn-mqtt-ca"] },
  });
  const view = new DataView(descriptor.buffer);
  expect([descriptor[0], descriptor[1], descriptor[3]]).toEqual([1, 4, 0]);
  expect(descriptor[2]).toBe(0b0100_1110); // will, willRetain, will QoS 1, requestProblemInformation; no cleanStart
  expect([view.getUint16(4, true), view.getUint16(6, true)]).toEqual([30, 0]);
  expect([view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)]).toEqual([2000, 8000, 4096]);
  expect([view.getUint16(30, true), view.getUint16(32, true), view.getUint16(34, true)]).toEqual([2, 4, 3]);
  const tail = Array.from(descriptor.subarray(MQTT_OPEN_FIXED_BYTES));
  expect(tail).toEqual([
    ...field("mqtts://broker.local:8883"), ...field("tab5"), ...field("user"), ...field("secret"), ...field(""),
    ...field("broker"), ...field("mqtt,x-amzn-mqtt-ca"), ...field("tab5/status"), 0, 0, ...field("offline"), 0, 0,
  ]);
  expect(utf8Text(credentials)).toBe("CACERTKEY");
});

test("open refuses MQTT 5 options under 3.1.1 and TLS options without a secure scheme", () => {
  expect(() => encodeMqttOpen({ url: "mqtt://b", sessionExpirySeconds: 60 })).toThrow(/protocol "5"/);
  expect(() => encodeMqttOpen({ url: "mqtt://b", will: { topic: "t", contentType: "text/plain" } })).toThrow(/3.1.1/);
  expect(() => encodeMqttOpen({ url: "mqtt://b", tls: { ca: "x" } })).toThrow(/mqtts/);
  expect(() => encodeMqttOpen({ url: "http://b" })).toThrow(/url/);
  expect(() => encodeMqttOpen({ url: "mqtts://b", tls: { certificate: "c" } })).toThrow(/together/);
  expect(() => encodeMqttOpen({ url: "mqtt://b", clientId: null, cleanStart: false })).toThrow(/cleanStart/);
  expect(() => encodeMqttOpen({ url: "mqtt://b", username: "u".repeat(1000) })).toThrow(/1024/);
  expect(() => encodeMqttOpen({ url: "mqtt://b", will: { topic: "a/#" } })).toThrow(/\+ or #/);
});

test("MQTT 5 connect and will properties use the fixed-width property entries", () => {
  const { descriptor } = encodeMqttOpen({
    url: "ws://b/mqtt", protocol: "5", clientId: null, sessionExpirySeconds: 3600, receiveMaximum: 16, topicAliasMaximum: 8,
    requestResponseInformation: true, userProperties: [["a", "1"], ["a", "2"]],
    will: { topic: "w", payloadUtf8: true, delaySeconds: 5, correlationData: Uint8Array.of(9) },
  });
  const view = new DataView(descriptor.buffer);
  expect(descriptor[1]).toBe(5);
  expect(descriptor[2]).toBe(0b1110_0011); // nullClientId, problem, response, will, cleanStart
  expect([view.getUint16(6, true), view.getUint32(20, true), view.getUint16(28, true)]).toEqual([16, 3600, 8]);
  const tail = Array.from(descriptor.subarray(MQTT_OPEN_FIXED_BYTES + 2 + 11));
  expect(tail).toEqual([
    ...field(""), ...field(""), ...field(""), ...field(""), ...field(""), ...field(""), ...field("w"),
    ...u16(11), MqttProperty.payloadFormat, 1, MqttProperty.correlationData, ...u16(1), 9, MqttProperty.willDelay, ...u32(5),
    ...u16(0),
    ...u16(14), MqttProperty.userProperty, ...field("a"), ...field("1"), MqttProperty.userProperty, ...field("a"), ...field("2"),
  ]);
});

test("publish requests carry the payload inline up to 1024 bytes and stage a larger one", () => {
  const inline = encodeMqttPublish("t/1", "hi", { qos: 2, retain: true }, false);
  expect(Array.from(inline.request)).toEqual([1, 2 | 4, ...u16(3), ...u32(2), ...utf8("t/1"), 0, 0, ...utf8("hi")]);
  expect(inline.staged).toBeUndefined();
  const big = new Uint8Array(5000).fill(7);
  const staged = encodeMqttPublish("t/1", big, { qos: 1 }, false);
  expect(Array.from(staged.request)).toEqual([1, 1 | 8, ...u16(3), ...u32(5000), ...utf8("t/1"), 0, 0]);
  expect(staged.staged).toBe(big);
  const v5 = encodeMqttPublish("t", undefined, { contentType: "a", messageExpirySeconds: 10, topicAlias: 3, userProperties: { k: "v" } }, true);
  expect(Array.from(v5.request)).toEqual([1, 0, ...u16(1), ...u32(0), ...utf8("t"), ...u16(19),
    MqttProperty.messageExpiry, ...u32(10), MqttProperty.contentType, ...field("a"), MqttProperty.topicAlias, ...u16(3),
    MqttProperty.userProperty, ...field("k"), ...field("v")]);
  expect(() => encodeMqttPublish("t", "x", { contentType: "a" }, false)).toThrow(/3.1.1/);
  expect(() => encodeMqttPublish("t/+", "x", {}, false)).toThrow(/\+ or #/);
  expect(() => encodeMqttPublish("t", "x", { qos: 3 as 0 }, false)).toThrow(/qos/);
  expect(() => encodeMqttPublish("t", new Uint8Array(300 * 1024), {}, false)).toThrow(/limit/);
});

test("subscribe, unsubscribe and disconnect requests", () => {
  const sub = encodeMqttSubscribe(["a/+/c", { filter: "d/#", qos: 1 }], { noLocal: true, retainHandling: 2, subscriptionIdentifier: 7 }, true);
  expect(sub.count).toBe(2);
  expect(Array.from(sub.request)).toEqual([1, 2, 1 | 2 << 2, 0, ...u32(7), 0, 0, 0, ...field("a/+/c"), 1, ...field("d/#")]);
  expect(() => encodeMqttSubscribe("a/#/b", {}, false)).toThrow(/last level/);
  expect(() => encodeMqttSubscribe("a/b+", {}, false)).toThrow(/whole level/);
  expect(() => encodeMqttSubscribe("a", { noLocal: true }, false)).toThrow(/protocol "5"/);
  expect(() => encodeMqttSubscribe(Array(9).fill("a"), {}, false)).toThrow(/filter count/);
  const unsub = encodeMqttUnsubscribe(["a", "b/#"], {}, false);
  expect(Array.from(unsub.request)).toEqual([1, 2, 0, 0, ...field("a"), ...field("b/#")]);
  expect(Array.from(encodeMqttDisconnect({ reasonCode: 4, sessionExpirySeconds: 0 }, true))).toEqual([1, 4, 1, 0, ...u32(0), 0, 0]);
  expect(() => encodeMqttDisconnect({ reasonCode: 4 }, false)).toThrow(/protocol "5"/);
});

test("CONNACK, message and error records decode", () => {
  const ack = decodeMqttConnack(connack(true, 5, [MqttProperty.responseInformation, ...field("resp/"), MqttProperty.userProperty, ...field("k"), ...field("v")]));
  expect(ack).toEqual({
    sessionPresent: true, protocol: "5", maximumQos: 2, maximumPacketSize: 0, receiveMaximum: 65535, topicAliasMaximum: 0,
    retainAvailable: true, wildcardAvailable: true, subscriptionIdentifiersAvailable: true, sharedAvailable: true,
    responseInformation: "resp/", userProperties: [["k", "v"]],
  });
  const message = decodeMqttRecord(record("a/b", utf8("21.5"), 1 | 4 | 8, [MqttProperty.payloadFormat, 1, MqttProperty.subscriptionIdentifier, ...u32(7)]));
  expect(message).toEqual({ topic: "a/b", payload: utf8("21.5"), qos: 1, retain: true, dup: true, properties: { payloadUtf8: true, subscriptionIdentifier: 7, userProperties: [] } });
  expect(decodeMqttError(utf8("refused: bad username or password"))).toEqual({ code: "refused", message: "bad username or password" });
  expect(decodeMqttError(utf8("no code"))).toEqual({ code: "other", message: "no code" });
});

test("the assembler joins a record split across data facts and discards a broken one", () => {
  const payload = new Uint8Array(2500).map((_, i) => i & 0xff);
  const whole = record("big", payload);
  const assembler = new MqttRecordAssembler(1 << 20);
  expect(assembler.push(0, whole.subarray(0, 1024))).toBeUndefined();
  expect(assembler.push(1024, whole.subarray(1024, 2048))).toBeUndefined();
  const done = assembler.push(2048, whole.subarray(2048));
  expect(done?.topic).toBe("big");
  expect(Array.from(done!.payload)).toEqual(Array.from(payload));
  expect(assembler.push(0, whole.subarray(0, 1024))).toBeUndefined();
  expect(assembler.push(2048, whole.subarray(2048))).toBeUndefined(); // a skipped slice
  expect(assembler.push(1024, whole.subarray(1024, 2048))).toBeUndefined();
  expect(new MqttRecordAssembler(100).push(0, whole.subarray(0, 1024))).toBeUndefined();
});

test("an MQTT client writes its TLS material, queues events and settles requests", async () => {
  const opened: [number, string, number[]][] = [], writes: number[][] = [], submits: [number, number, number[], number][] = [];
  let next = 10;
  global.__pocketWorker = host({
    open(kind, node, config) { opened.push([kind, node, Array.from(config.subarray(0, 2))]); return 1; },
    write(_handle, data) { writes.push(Array.from(data)); return data.length; },
    submit(_handle, opcode, payload, capacity) { submits.push([opcode, payload.length, Array.from(payload.subarray(0, 2)), capacity]); return next++; },
  });
  bindWorker({ entry: "worker.ts", nodes: [{ name: "mqtt", kind: "mqtt" }] });
  const client = io.mqtt().open({ url: "mqtts://b", tls: { ca: "x".repeat(1500) } });
  expect(opened).toEqual([[ResourceKind.mqtt, "mqtt", [1, 4]]]);
  expect(writes.map(chunk => chunk.length)).toEqual([1024, 476]);
  expect(() => client.observe()).toThrow(/events/);

  // Records that arrive before the reader starts wait in the client's queue.
  const big = record("t", new Uint8Array(1500).fill(5));
  turn([fact({ kind: FactKind.ready }), fact({ kind: FactKind.headers, data: connack(false) }),
    fact({ offset: 0, data: big.subarray(0, 1024) }), fact({ offset: 1024, data: big.subarray(1024) }),
    fact({ kind: FactKind.gap, request: 2 }), fact({ kind: FactKind.error, status: ResourceStatus.failed, data: utf8("closed: the broker closed the connection") })]);
  await jobs();
  const seen: MqttEvent[] = [];
  const reading = (async () => { for await (const event of client.events()) seen.push(event); })();
  await jobs();
  expect(seen.map(event => event.type)).toEqual(["connected", "message", "lost", "disconnected"]);
  expect(seen[1]!.type === "message" && seen[1]!.payload.length).toBe(1500);
  expect(seen[2]).toEqual({ type: "lost", count: 2 });
  expect(seen[3]).toEqual({ type: "disconnected", code: "closed", message: "the broker closed the connection" });
  expect(() => client.events()).toThrow(/already has an events reader/);

  const subscribed = client.subscribe([{ filter: "t/#", qos: 1 }, "u"]);
  expect(submits.at(-1)).toEqual([MqttOpcode.subscribe, submits.at(-1)![1], [1, 2], 128]);
  turn([fact({ kind: FactKind.complete, request: 10, data: Uint8Array.of(1, 0x80) })]);
  expect(await subscribed).toEqual([1, 0x80]);

  const published = client.publish("t/1", "x", { qos: 1 });
  turn([fact({ kind: FactKind.complete, request: 11, status: ResourceStatus.failed, data: utf8("unavailable: the session is not connected") })]);
  await expect(published).rejects.toBeInstanceOf(ResourceError);

  const staged = client.publish("t/big", new Uint8Array(3000).fill(1), { qos: 1 });
  await jobs();
  expect(writes.slice(2).map(chunk => chunk.length)).toEqual([0, 1024, 1024, 952]);
  expect(submits.at(-1)!.slice(0, 3)).toEqual([MqttOpcode.publish, 15, [1, 1 | 8]]);
  turn([fact({ kind: FactKind.complete, request: 12, data: Uint8Array.of(0x10) })]);
  expect(await staged).toBe(0x10);
  client.close();
  await reading;
});

test("an MQTT client drops messages beyond its queue and counts them", async () => {
  global.__pocketWorker = host();
  bindWorker({ entry: "worker.ts", nodes: [{ name: "mqtt", kind: "mqtt" }] });
  const client = io.mqtt().open({ url: "mqtt://b" });
  for (let t = 0; t < 9; ++t) {
    turn(Array.from({ length: 8 }, (_, i) => fact({ data: record("n", Uint8Array.of(t * 8 + i)) })));
    await jobs();
  }
  const seen: MqttEvent[] = [];
  const iterator = client.events()[Symbol.asyncIterator]();
  for (let i = 0; i < 65; ++i) seen.push((await iterator.next()).value!);
  expect(seen.slice(0, 64).every(event => event.type === "message")).toBe(true);
  expect(seen[63]!.type === "message" && seen[63]!.payload[0]).toBe(63);
  expect(seen[64]).toEqual({ type: "lost", count: 8 });
  const pending = iterator.next();
  client.close();
  expect((await pending).done).toBe(true);
});
