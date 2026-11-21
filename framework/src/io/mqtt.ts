// Encoders and decoders of the worker's MQTT layouts (contracts/spec/mqtt.ts).
// `io.mqtt(name).open(...)` in @pocketjs/framework/io uses them; they are
// pure functions, so a host test or another transport can use them as well.
import {
  MQTT_LAYOUT_VERSION, MQTT_LIMITS, MQTT_OPEN_FIXED_BYTES, MQTT_RECORD_FIXED_BYTES, MqttAvailable, MqttConnackFlag,
  MqttDisconnectFlag, MqttMessageFlag, MqttOpenFlag, MqttProperty, MqttProtocol, MqttPublishFlag, MqttSubscribeOption,
} from "../../../contracts/spec/mqtt.ts";
import { WORKER_LIMITS } from "../../../contracts/spec/worker.ts";
import { utf8, utf8Text } from "./utf8.ts";

export {
  MQTT_ERROR, MQTT_LIMITS, MqttOpcode, MqttProperty, MqttProtocol, type MqttErrorCode,
} from "../../../contracts/spec/mqtt.ts";
export { utf8, utf8Text } from "./utf8.ts";

export type MqttQos = 0 | 1 | 2;
export type MqttVersion = "3.1.1" | "5";
/** User properties as a record or as ordered pairs; pairs keep repeated keys. */
export type MqttUserProperties = Readonly<Record<string, string>> | readonly (readonly [string, string])[];
export type MqttBytes = Uint8Array | string;

/** MQTT 5 properties of an outgoing message or will. */
export interface MqttMessageProperties {
  /** Marks the payload as UTF-8 text (payload format indicator 1). */
  readonly payloadUtf8?: boolean;
  readonly messageExpirySeconds?: number;
  readonly contentType?: string;
  readonly responseTopic?: string;
  readonly correlationData?: MqttBytes;
  readonly userProperties?: MqttUserProperties;
}
export interface MqttPublishOptions extends MqttMessageProperties {
  readonly qos?: MqttQos;
  readonly retain?: boolean;
  /** MQTT 5 topic alias, at most the broker's topicAliasMaximum. */
  readonly topicAlias?: number;
}
export interface MqttWill extends MqttMessageProperties {
  readonly topic: string;
  readonly payload?: MqttBytes;
  readonly qos?: MqttQos;
  readonly retain?: boolean;
  /** MQTT 5 will delay interval. */
  readonly delaySeconds?: number;
}
export interface MqttTlsOptions {
  /** PEM or DER; without it the host verifies the broker against its bundle. */
  readonly ca?: MqttBytes;
  /** Client certificate and key for mutual TLS, PEM or DER. */
  readonly certificate?: MqttBytes;
  readonly key?: MqttBytes;
  readonly keyPassword?: string;
  /** The name the broker certificate must carry; default: the URL host. */
  readonly commonName?: string;
  readonly alpn?: readonly string[];
}
export interface MqttOptions {
  /** mqtt://, mqtts://, ws:// or wss://host[:port][/path]. */
  readonly url: string;
  readonly protocol?: MqttVersion;
  /** Omitted: the host's default identifier; null: the broker assigns one. */
  readonly clientId?: string | null;
  readonly username?: string;
  readonly password?: MqttBytes;
  /** 0 turns keepalive off; default 60. */
  readonly keepAliveSeconds?: number;
  /** Clean session (3.1.1) or clean start (5); default true. */
  readonly cleanStart?: boolean;
  readonly will?: MqttWill;
  /** Delay before reconnecting; 0 ends the session at its first
   *  disconnection. Default 5000. */
  readonly reconnectMs?: number;
  /** Connect, TLS handshake and CONNACK wait; default 10000. */
  readonly timeoutMs?: number;
  /** The largest incoming payload; larger messages are dropped. Default 65536. */
  readonly maxMessageBytes?: number;
  readonly tls?: MqttTlsOptions;
  /** MQTT 5 connect properties. */
  readonly sessionExpirySeconds?: number;
  readonly receiveMaximum?: number;
  /** Default: a size that carries a maxMessageBytes payload. A broker
   *  withholds larger messages without the session seeing them. */
  readonly maximumPacketSize?: number;
  readonly topicAliasMaximum?: number;
  readonly requestResponseInformation?: boolean;
  readonly requestProblemInformation?: boolean;
  readonly userProperties?: MqttUserProperties;
}
export interface MqttSubscription {
  readonly filter: string;
  readonly qos?: MqttQos;
}
export interface MqttSubscribeOptions {
  /** MQTT 5 subscription options, applied to every filter of the request. */
  readonly noLocal?: boolean;
  readonly retainAsPublished?: boolean;
  /** 0 send retained messages, 1 only for a new subscription, 2 never. */
  readonly retainHandling?: 0 | 1 | 2;
  readonly subscriptionIdentifier?: number;
  readonly userProperties?: MqttUserProperties;
}
export interface MqttDisconnectOptions {
  /** MQTT 5 reason code: 0 normal disconnection, 4 publish the will. */
  readonly reasonCode?: number;
  readonly sessionExpirySeconds?: number;
  readonly userProperties?: MqttUserProperties;
}

/** Properties of a received message (MQTT 5); empty under MQTT 3.1.1. */
export interface MqttReceivedProperties {
  readonly payloadUtf8?: boolean;
  readonly contentType?: string;
  readonly responseTopic?: string;
  readonly correlationData?: Uint8Array;
  readonly subscriptionIdentifier?: number;
  readonly userProperties: readonly (readonly [string, string])[];
}
export interface MqttMessage {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: MqttQos;
  readonly retain: boolean;
  readonly dup: boolean;
  readonly properties: MqttReceivedProperties;
}
/** The broker's CONNACK, each time the session connects. */
export interface MqttConnack {
  readonly sessionPresent: boolean;
  readonly protocol: MqttVersion;
  readonly maximumQos: MqttQos;
  /** 0: the broker announced no limit. */
  readonly maximumPacketSize: number;
  readonly receiveMaximum: number;
  readonly topicAliasMaximum: number;
  readonly retainAvailable: boolean;
  readonly wildcardAvailable: boolean;
  readonly subscriptionIdentifiersAvailable: boolean;
  readonly sharedAvailable: boolean;
  readonly responseInformation?: string;
  readonly userProperties: readonly (readonly [string, string])[];
}
export type MqttEvent =
  | ({ readonly type: "connected" } & MqttConnack)
  /** The connection dropped or a connect attempt failed; `code` is one of
   *  MQTT_ERROR. The session reconnects unless an `ended` event follows. */
  | { readonly type: "disconnected"; readonly code: string; readonly message: string }
  | ({ readonly type: "message" } & MqttMessage)
  /** Messages the host dropped: too large, or not taken in time. */
  | { readonly type: "lost"; readonly count: number }
  /** The session stopped and will not reconnect; close the resource. */
  | { readonly type: "ended"; readonly status: number };

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`MQTT ${name} must be an integer in ${min}..${max}`);
}
function qosOf(value: number | undefined, name: string): MqttQos {
  const qos = value ?? 0;
  integer(qos, 0, 2, name);
  return qos as MqttQos;
}
function bytesOf(value: MqttBytes | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return utf8(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError("MQTT bytes must be a Uint8Array or a string");
}
function pairs(properties: MqttUserProperties | undefined): (readonly [string, string])[] {
  if (!properties) return [];
  const list = Array.isArray(properties) ? properties as readonly (readonly [string, string])[] : Object.entries(properties);
  for (const [key, value] of list) if (typeof key !== "string" || typeof value !== "string") throw new TypeError("MQTT user properties are string pairs");
  return [...list];
}
/** UTF-8 strings of MQTT may not hold U+0000. */
function mqttString(text: string, name: string): Uint8Array {
  if (typeof text !== "string") throw new TypeError(`MQTT ${name} must be a string`);
  if (text.includes("\0")) throw new RangeError(`MQTT ${name} may not contain U+0000`);
  const bytes = utf8(text);
  if (bytes.length > 0xffff) throw new RangeError(`MQTT ${name} exceeds 65535 bytes`);
  return bytes;
}
export function checkTopicName(topic: string): void {
  if (typeof topic !== "string" || !topic.length) throw new RangeError("MQTT topic must be a non-empty string");
  if (/[+#]/.test(topic)) throw new RangeError(`MQTT topic ${topic} may not contain + or #`);
  mqttString(topic, "topic");
}
export function checkTopicFilter(filter: string): void {
  if (typeof filter !== "string" || !filter.length) throw new RangeError("MQTT filter must be a non-empty string");
  const levels = filter.split("/");
  levels.forEach((level, index) => {
    if (level.includes("#") && (level !== "#" || index !== levels.length - 1)) throw new RangeError(`MQTT filter ${filter}: # must be the whole last level`);
    if (level.includes("+") && level !== "+") throw new RangeError(`MQTT filter ${filter}: + must be a whole level`);
  });
  mqttString(filter, "filter");
}

/** A growable little-endian byte writer. */
class Writer {
  private bytes = new Uint8Array(64);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length;
    while (size < this.length + count) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next; this.view = new DataView(next.buffer);
  }
  u8(value: number): this { this.reserve(1); this.bytes[this.length++] = value; return this; }
  u16(value: number): this { this.reserve(2); this.view.setUint16(this.length, value, true); this.length += 2; return this; }
  u32(value: number): this { this.reserve(4); this.view.setUint32(this.length, value, true); this.length += 4; return this; }
  raw(data: Uint8Array): this { this.reserve(data.length); this.bytes.set(data, this.length); this.length += data.length; return this; }
  /** A u16 length and the bytes. */
  field(data: Uint8Array, name: string): this {
    if (data.length > 0xffff) throw new RangeError(`MQTT ${name} exceeds 65535 bytes`);
    return this.u16(data.length).raw(data);
  }
  setU16(at: number, value: number): void { this.view.setUint16(at, value, true); }
  finish(): Uint8Array { return this.bytes.slice(0, this.length); }
}

interface PropertyInput extends MqttMessageProperties {
  readonly topicAlias?: number;
  readonly delaySeconds?: number;
}
/** True when any MQTT 5 property is set. */
function hasProperties(input: PropertyInput): boolean {
  return input.payloadUtf8 !== undefined || input.messageExpirySeconds !== undefined || input.contentType !== undefined ||
    input.responseTopic !== undefined || input.correlationData !== undefined || input.topicAlias !== undefined ||
    input.delaySeconds !== undefined || pairs(input.userProperties).length > 0;
}
/** Property entries (without the block length). */
function writeProperties(w: Writer, input: PropertyInput): void {
  if (input.payloadUtf8 !== undefined) w.u8(MqttProperty.payloadFormat).u8(input.payloadUtf8 ? 1 : 0);
  if (input.messageExpirySeconds !== undefined) {
    integer(input.messageExpirySeconds, 0, 0xffff_ffff, "messageExpirySeconds");
    w.u8(MqttProperty.messageExpiry).u32(input.messageExpirySeconds);
  }
  if (input.contentType !== undefined) w.u8(MqttProperty.contentType).field(mqttString(input.contentType, "contentType"), "contentType");
  if (input.responseTopic !== undefined) {
    checkTopicName(input.responseTopic);
    w.u8(MqttProperty.responseTopic).field(mqttString(input.responseTopic, "responseTopic"), "responseTopic");
  }
  if (input.correlationData !== undefined) w.u8(MqttProperty.correlationData).field(bytesOf(input.correlationData), "correlationData");
  if (input.delaySeconds !== undefined) {
    integer(input.delaySeconds, 0, 0xffff_ffff, "will delaySeconds");
    w.u8(MqttProperty.willDelay).u32(input.delaySeconds);
  }
  if (input.topicAlias !== undefined) {
    integer(input.topicAlias, 1, 0xffff, "topicAlias");
    w.u8(MqttProperty.topicAlias).u16(input.topicAlias);
  }
  for (const [key, value] of pairs(input.userProperties))
    w.u8(MqttProperty.userProperty).field(mqttString(key, "user property key"), "user property").field(mqttString(value, "user property value"), "user property");
}
/** A property block: its u16 byte length and the entries. */
function propertyBlock(w: Writer, input: PropertyInput, v5: boolean, what: string): void {
  if (!v5 && hasProperties(input)) throw new RangeError(`MQTT 3.1.1 carries no ${what} properties; open with protocol "5"`);
  const at = w.length;
  w.u16(0);
  writeProperties(w, input);
  const size = w.length - at - 2;
  if (size > 0xffff) throw new RangeError(`MQTT ${what} properties exceed 65535 bytes`);
  w.setU16(at, size);
}
function versionOf(options: { readonly protocol?: MqttVersion }): typeof MqttProtocol[keyof typeof MqttProtocol] {
  const protocol = options.protocol ?? "3.1.1";
  if (protocol !== "3.1.1" && protocol !== "5") throw new RangeError('MQTT protocol must be "3.1.1" or "5"');
  return protocol === "5" ? MqttProtocol.v5 : MqttProtocol.v311;
}
function checkUrl(url: string): void {
  if (typeof url !== "string" || !/^(mqtts?|wss?):\/\/[^/?#\s]+(\/[^\s]*)?$/i.test(url)) throw new TypeError("MQTT url must be mqtt://, mqtts://, ws:// or wss://host[:port][/path]");
}

export interface EncodedMqttOpen {
  readonly descriptor: Uint8Array;
  /** CA, certificate and key bytes the session waits for, written in order after open. */
  readonly credentials: Uint8Array;
}
/** The open descriptor and the TLS material written after it. */
export function encodeMqttOpen(options: MqttOptions): EncodedMqttOpen {
  checkUrl(options.url);
  const protocol = versionOf(options), v5 = protocol === MqttProtocol.v5;
  const will = options.will;
  const keepAlive = options.keepAliveSeconds ?? MQTT_LIMITS.defaultKeepAliveSeconds;
  const reconnect = options.reconnectMs ?? MQTT_LIMITS.defaultReconnectMs;
  const timeout = options.timeoutMs ?? MQTT_LIMITS.defaultTimeoutMs;
  const maxMessage = options.maxMessageBytes ?? MQTT_LIMITS.defaultMessageBytes;
  integer(keepAlive, 0, 0xffff, "keepAliveSeconds");
  integer(reconnect, 0, 0x7fff_ffff, "reconnectMs");
  integer(timeout, 1, MQTT_LIMITS.maxTimeoutMs, "timeoutMs");
  integer(maxMessage, 1, MQTT_LIMITS.maxMessageBytes, "maxMessageBytes");
  const v5Only = {
    sessionExpirySeconds: options.sessionExpirySeconds, receiveMaximum: options.receiveMaximum,
    maximumPacketSize: options.maximumPacketSize, topicAliasMaximum: options.topicAliasMaximum,
    requestResponseInformation: options.requestResponseInformation, requestProblemInformation: options.requestProblemInformation,
  };
  if (!v5) for (const [name, value] of Object.entries(v5Only)) if (value !== undefined) throw new RangeError(`MQTT ${name} needs protocol "5"`);
  const sessionExpiry = options.sessionExpirySeconds ?? 0, receiveMaximum = options.receiveMaximum ?? 0;
  const maximumPacket = options.maximumPacketSize ?? 0, aliasMaximum = options.topicAliasMaximum ?? 0;
  integer(sessionExpiry, 0, 0xffff_ffff, "sessionExpirySeconds");
  integer(receiveMaximum, 0, 0xffff, "receiveMaximum");
  integer(maximumPacket, 0, 0xffff_ffff, "maximumPacketSize");
  integer(aliasMaximum, 0, 0xffff, "topicAliasMaximum");
  const willQos = will ? qosOf(will.qos, "will qos") : 0;
  if (will) checkTopicName(will.topic);
  const clean = options.cleanStart ?? true;
  if (options.clientId === null && !clean && !v5) throw new RangeError("MQTT 3.1.1 needs cleanStart with a broker-assigned client id");
  let flags = (clean ? MqttOpenFlag.cleanStart : 0) | (options.clientId === null ? MqttOpenFlag.nullClientId : 0);
  if (will) flags |= MqttOpenFlag.will | (will.retain ? MqttOpenFlag.willRetain : 0) | willQos << MqttOpenFlag.willQosShift;
  if (options.requestResponseInformation) flags |= MqttOpenFlag.requestResponseInformation;
  if (options.requestProblemInformation ?? true) flags |= MqttOpenFlag.requestProblemInformation;
  const tls = options.tls ?? {};
  const ca = bytesOf(tls.ca), certificate = bytesOf(tls.certificate), key = bytesOf(tls.key);
  for (const [name, value] of [["ca", ca], ["certificate", certificate], ["key", key]] as const)
    if (value.length > MQTT_LIMITS.maxCredentialBytes) throw new RangeError(`MQTT tls.${name} exceeds ${MQTT_LIMITS.maxCredentialBytes} bytes`);
  if (!certificate.length !== !key.length) throw new RangeError("MQTT tls.certificate and tls.key go together");
  const secure = /^(mqtts|wss):/i.test(options.url);
  if (!secure && (ca.length || certificate.length || tls.commonName !== undefined || tls.alpn?.length)) throw new RangeError("MQTT tls options need an mqtts:// or wss:// url");
  const alpn = (tls.alpn ?? []).map(name => {
    if (typeof name !== "string" || !name.length || name.includes(",")) throw new RangeError("MQTT tls.alpn names are non-empty and hold no comma");
    return name;
  }).join(",");
  const w = new Writer();
  w.u8(MQTT_LAYOUT_VERSION).u8(protocol).u8(flags).u8(0).u16(keepAlive).u16(receiveMaximum)
    .u32(reconnect).u32(timeout).u32(maxMessage).u32(sessionExpiry).u32(maximumPacket).u16(aliasMaximum)
    .u16(ca.length).u16(certificate.length).u16(key.length);
  if (w.length !== MQTT_OPEN_FIXED_BYTES) throw new Error("MQTT open layout drifted from MQTT_OPEN_FIXED_BYTES");
  w.field(mqttString(options.url, "url"), "url");
  w.field(mqttString(options.clientId ?? "", "clientId"), "clientId");
  w.field(mqttString(options.username ?? "", "username"), "username");
  w.field(bytesOf(options.password), "password");
  w.field(mqttString(tls.keyPassword ?? "", "tls.keyPassword"), "tls.keyPassword");
  w.field(mqttString(tls.commonName ?? "", "tls.commonName"), "tls.commonName");
  w.field(mqttString(alpn, "tls.alpn"), "tls.alpn");
  w.field(will ? mqttString(will.topic, "will topic") : new Uint8Array(0), "will topic");
  propertyBlock(w, will ?? {}, v5, "will");
  w.field(bytesOf(will?.payload), "will payload");
  propertyBlock(w, { userProperties: options.userProperties }, v5, "connect");
  const descriptor = w.finish();
  if (descriptor.length > WORKER_LIMITS.payloadBytes) throw new RangeError(`MQTT open descriptor is ${descriptor.length} bytes; the limit is ${WORKER_LIMITS.payloadBytes}`);
  const credentials = new Uint8Array(ca.length + certificate.length + key.length);
  credentials.set(ca, 0); credentials.set(certificate, ca.length); credentials.set(key, ca.length + certificate.length);
  return { descriptor, credentials };
}

export interface EncodedMqttPublish {
  readonly request: Uint8Array;
  /** The payload to write before submitting a staged publish. */
  readonly staged?: Uint8Array;
}
/** A publish request; a payload that does not fit the request is staged. */
export function encodeMqttPublish(topic: string, payload: MqttBytes | undefined, options: MqttPublishOptions, v5: boolean): EncodedMqttPublish {
  checkTopicName(topic);
  const qos = qosOf(options.qos, "qos");
  const body = bytesOf(payload);
  const topicBytes = mqttString(topic, "topic");
  const head = (staged: boolean) => {
    const w = new Writer();
    w.u8(MQTT_LAYOUT_VERSION).u8(qos | (options.retain ? MqttPublishFlag.retain : 0) | (staged ? MqttPublishFlag.staged : 0))
      .u16(topicBytes.length).u32(body.length).raw(topicBytes);
    propertyBlock(w, options, v5, "publish");
    return w;
  };
  const inline = head(false);
  if (inline.length + body.length <= WORKER_LIMITS.payloadBytes) return { request: inline.raw(body).finish() };
  if (body.length > MQTT_LIMITS.maxStagedBytes) throw new RangeError(`MQTT payload is ${body.length} bytes; the limit is ${MQTT_LIMITS.maxStagedBytes}`);
  const request = head(true).finish();
  if (request.length > WORKER_LIMITS.payloadBytes) throw new RangeError("MQTT topic and properties exceed the 1024-byte request");
  return { request, staged: body };
}
function subscriptions(filters: string | MqttSubscription | readonly (string | MqttSubscription)[]): MqttSubscription[] {
  const list = (Array.isArray(filters) ? filters : [filters]) as readonly (string | MqttSubscription)[];
  integer(list.length, 1, MQTT_LIMITS.filters, "filter count");
  return list.map(item => typeof item === "string" ? { filter: item } : item);
}
export function encodeMqttSubscribe(filters: string | MqttSubscription | readonly (string | MqttSubscription)[], options: MqttSubscribeOptions, v5: boolean): { request: Uint8Array; count: number } {
  const list = subscriptions(filters);
  const handling = options.retainHandling ?? 0, identifier = options.subscriptionIdentifier ?? 0;
  integer(handling, 0, 2, "retainHandling");
  integer(identifier, 0, MQTT_LIMITS.maxSubscriptionIdentifier, "subscriptionIdentifier");
  if (!v5 && (options.noLocal || options.retainAsPublished || handling || identifier)) throw new RangeError('MQTT subscription options need protocol "5"');
  const w = new Writer();
  w.u8(MQTT_LAYOUT_VERSION).u8(list.length)
    .u8((options.noLocal ? MqttSubscribeOption.noLocal : 0) | (options.retainAsPublished ? MqttSubscribeOption.retainAsPublished : 0) | handling << MqttSubscribeOption.retainHandlingShift)
    .u8(0).u32(identifier);
  propertyBlock(w, { userProperties: options.userProperties }, v5, "subscribe");
  for (const { filter, qos } of list) {
    checkTopicFilter(filter);
    w.u8(qosOf(qos, "subscription qos")).field(mqttString(filter, "filter"), "filter");
  }
  const request = w.finish();
  if (request.length > WORKER_LIMITS.payloadBytes) throw new RangeError("MQTT subscribe request exceeds 1024 bytes");
  return { request, count: list.length };
}
export function encodeMqttUnsubscribe(filters: string | readonly string[], options: { readonly userProperties?: MqttUserProperties }, v5: boolean): { request: Uint8Array; count: number } {
  const list = (Array.isArray(filters) ? filters : [filters]) as readonly string[];
  integer(list.length, 1, MQTT_LIMITS.filters, "filter count");
  const w = new Writer();
  w.u8(MQTT_LAYOUT_VERSION).u8(list.length);
  propertyBlock(w, { userProperties: options.userProperties }, v5, "unsubscribe");
  for (const filter of list) { checkTopicFilter(filter); w.field(mqttString(filter, "filter"), "filter"); }
  const request = w.finish();
  if (request.length > WORKER_LIMITS.payloadBytes) throw new RangeError("MQTT unsubscribe request exceeds 1024 bytes");
  return { request, count: list.length };
}
export function encodeMqttDisconnect(options: MqttDisconnectOptions, v5: boolean): Uint8Array {
  const reason = options.reasonCode ?? 0;
  integer(reason, 0, 255, "reasonCode");
  if (options.sessionExpirySeconds !== undefined) integer(options.sessionExpirySeconds, 0, 0xffff_ffff, "sessionExpirySeconds");
  if (!v5 && (reason || options.sessionExpirySeconds !== undefined)) throw new RangeError('MQTT disconnect options need protocol "5"');
  const w = new Writer();
  w.u8(MQTT_LAYOUT_VERSION).u8(reason).u8(options.sessionExpirySeconds !== undefined ? MqttDisconnectFlag.sessionExpiry : 0).u8(0)
    .u32(options.sessionExpirySeconds ?? 0);
  propertyBlock(w, { userProperties: options.userProperties }, v5, "disconnect");
  const request = w.finish();
  if (request.length > WORKER_LIMITS.payloadBytes) throw new RangeError("MQTT disconnect request exceeds 1024 bytes");
  return request;
}

/** A little-endian reader that throws on a truncated layout. */
class Reader {
  private readonly view: DataView;
  at = 0;
  constructor(private readonly bytes: Uint8Array, private readonly end = bytes.length) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(count: number): void { if (this.at + count > this.end) throw new RangeError("Truncated MQTT record"); }
  u8(): number { this.need(1); return this.bytes[this.at++]!; }
  u16(): number { this.need(2); const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  u32(): number { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  take(count: number): Uint8Array { this.need(count); const value = this.bytes.slice(this.at, this.at + count); this.at += count; return value; }
  field(): Uint8Array { return this.take(this.u16()); }
  get done(): boolean { return this.at >= this.end; }
}
interface DecodedProperties {
  payloadUtf8?: boolean;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Uint8Array;
  subscriptionIdentifier?: number;
  responseInformation?: string;
  userProperties: [string, string][];
}
function readProperties(r: Reader): DecodedProperties {
  const out: DecodedProperties = { userProperties: [] };
  while (!r.done) {
    const id = r.u8();
    if (id === MqttProperty.payloadFormat) out.payloadUtf8 = r.u8() === 1;
    else if (id === MqttProperty.contentType) out.contentType = utf8Text(r.field());
    else if (id === MqttProperty.responseTopic) out.responseTopic = utf8Text(r.field());
    else if (id === MqttProperty.correlationData) out.correlationData = r.field();
    else if (id === MqttProperty.subscriptionIdentifier) out.subscriptionIdentifier = r.u32();
    else if (id === MqttProperty.responseInformation) out.responseInformation = utf8Text(r.field());
    else if (id === MqttProperty.userProperty) out.userProperties.push([utf8Text(r.field()), utf8Text(r.field())]);
    else if (id === MqttProperty.messageExpiry || id === MqttProperty.willDelay) r.u32();
    else if (id === MqttProperty.topicAlias) r.u16();
    else throw new RangeError(`Unknown MQTT property 0x${id.toString(16)}`);
  }
  return out;
}
export function decodeMqttConnack(bytes: Uint8Array): MqttConnack {
  const r = new Reader(bytes);
  if (r.u8() !== MQTT_LAYOUT_VERSION) throw new RangeError("Unknown MQTT CONNACK record version");
  const flags = r.u8(), protocol = r.u8(), maximumQos = r.u8() as MqttQos;
  const maximumPacketSize = r.u32(), receiveMaximum = r.u16(), topicAliasMaximum = r.u16(), available = r.u8();
  r.u8();
  const size = r.u16();
  const properties = readProperties(new Reader(r.take(size)));
  return {
    sessionPresent: (flags & MqttConnackFlag.sessionPresent) !== 0,
    protocol: protocol === MqttProtocol.v5 ? "5" : "3.1.1",
    maximumQos, maximumPacketSize, receiveMaximum, topicAliasMaximum,
    retainAvailable: (available & MqttAvailable.retain) !== 0,
    wildcardAvailable: (available & MqttAvailable.wildcard) !== 0,
    subscriptionIdentifiersAvailable: (available & MqttAvailable.subscriptionIdentifiers) !== 0,
    sharedAvailable: (available & MqttAvailable.shared) !== 0,
    ...(properties.responseInformation !== undefined ? { responseInformation: properties.responseInformation } : {}),
    userProperties: properties.userProperties,
  };
}
export function decodeMqttRecord(record: Uint8Array): MqttMessage {
  const r = new Reader(record);
  const flags = r.u8(), payloadBytes = r.u32(), topicBytes = r.u16(), propertyBytes = r.u16();
  const topic = utf8Text(r.take(topicBytes));
  const decoded = readProperties(new Reader(r.take(propertyBytes)));
  const payload = r.take(payloadBytes);
  const properties: MqttReceivedProperties = {
    ...(decoded.payloadUtf8 !== undefined ? { payloadUtf8: decoded.payloadUtf8 } : {}),
    ...(decoded.contentType !== undefined ? { contentType: decoded.contentType } : {}),
    ...(decoded.responseTopic !== undefined ? { responseTopic: decoded.responseTopic } : {}),
    ...(decoded.correlationData !== undefined ? { correlationData: decoded.correlationData } : {}),
    ...(decoded.subscriptionIdentifier !== undefined ? { subscriptionIdentifier: decoded.subscriptionIdentifier } : {}),
    userProperties: decoded.userProperties,
  };
  return {
    topic, payload,
    qos: (flags & MqttMessageFlag.qosMask) as MqttQos,
    retain: (flags & MqttMessageFlag.retain) !== 0,
    dup: (flags & MqttMessageFlag.dup) !== 0,
    properties,
  };
}
/** Splits `code: message`; a text without a code becomes `other`. */
export function decodeMqttError(bytes: Uint8Array): { code: string; message: string } {
  const text = utf8Text(bytes), colon = text.indexOf(": ");
  return colon > 0 && /^[a-z_]+$/.test(text.slice(0, colon)) ? { code: text.slice(0, colon), message: text.slice(colon + 2) } : { code: "other", message: text };
}

/** Joins the data facts of message records. A fact at offset 0 starts a
 *  record; a fact that does not continue the record in progress, or a
 *  `reset()` after a gap, discards it. */
export class MqttRecordAssembler {
  private parts: Uint8Array[] = [];
  private received = 0;
  private total = -1;
  constructor(private readonly maxRecordBytes: number) {}
  reset(): void { this.parts = []; this.received = 0; this.total = -1; }
  /** The message a fact completes, if it completes one. */
  push(offset: number, data: Uint8Array): MqttMessage | undefined {
    if (offset === 0) this.reset();
    else if (offset !== this.received || !this.parts.length) { this.reset(); return undefined; }
    this.parts.push(data);
    this.received += data.length;
    if (this.total < 0 && this.received >= MQTT_RECORD_FIXED_BYTES) {
      const head = this.parts.length === 1 ? this.parts[0]! : this.join();
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      this.total = MQTT_RECORD_FIXED_BYTES + view.getUint32(1, true) + view.getUint16(5, true) + view.getUint16(7, true);
      if (this.total > this.maxRecordBytes) { this.reset(); return undefined; }
    }
    if (this.total < 0 || this.received < this.total) return undefined;
    const total = this.total, record = this.join();
    this.reset();
    return record.length === total ? decodeMqttRecord(record) : undefined;
  }
  private join(): Uint8Array {
    if (this.parts.length === 1) return this.parts[0]!;
    const out = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.length; }
    this.parts = [out];
    return out;
  }
}
