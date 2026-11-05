// PocketJS MQTT contract: the byte layouts of the worker's `io.mqtt`
// resource (kind 4, capability `net.mqtt`, contracts/spec/worker.ts). One
// resource is one MQTT 3.1.1 or 5.0 client session with one broker; the host
// keeps it connected and streams what the broker sends as resource facts.
// framework/src/io/mqtt.ts encodes and decodes these layouts; a host parses
// them with the same rules (pocket-m5 `pocket_mqtt_esp` on ESP-IDF).
//
// Integers are little endian. A string is a u16 byte length followed by
// UTF-8 bytes; binary data (a password, a payload, correlation data) has the
// same u16 length prefix. Every layout starts with its version byte, 1.

/** Layout version of every descriptor and record below. */
export const MQTT_LAYOUT_VERSION = 1;

/** Protocol levels of the CONNECT packet. */
export const MqttProtocol = { v311: 4, v5: 5 } as const;

/** Submit opcodes of an open session. */
export const MqttOpcode = {
  /** PUBLISH; settles when the broker acknowledges it (QoS 1 and 2) or the
   *  packet was written to the connection (QoS 0). */
  publish: 1,
  /** SUBSCRIBE; settles with the SUBACK codes, one byte per filter. */
  subscribe: 2,
  /** UNSUBSCRIBE; settles with one code per filter (0 under MQTT 3.1.1). */
  unsubscribe: 3,
  /** The DISCONNECT the host sends when the resource closes: reason code,
   *  session expiry and user properties (MQTT 5). Settles at once. */
  disconnect: 4,
} as const;

/** Bounds a host enforces. A descriptor or request outside them is refused
 *  with `invalid`. */
export const MQTT_LIMITS = {
  /** Topic filters in one SUBSCRIBE or UNSUBSCRIBE request. */
  filters: 8,
  /** The largest incoming payload a session accepts (`maxMessageBytes`). */
  maxMessageBytes: 256 * 1024,
  defaultMessageBytes: 64 * 1024,
  /** The largest payload a staged PUBLISH carries (bytes written with
   *  `write()` before the publish request). */
  maxStagedBytes: 256 * 1024,
  /** TLS material written after open: CA, client certificate, client key. */
  maxCredentialBytes: 16 * 1024,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 120_000,
  defaultKeepAliveSeconds: 60,
  defaultReconnectMs: 5_000,
  /** esp-mqtt carries the subscription identifier as 16 bits. */
  maxSubscriptionIdentifier: 0xffff,
  /** Result bytes a request reserves for its completion: the codes on
   *  success, `code: message` text on failure. */
  resultBytes: 128,
} as const;

/** MQTT 5 property identifiers (MQTT 5.0 section 2.2.2.2) the layouts carry.
 *  A property block is a u16 byte length followed by entries
 *  `u8 identifier, value`; byte and integer values have the fixed widths
 *  below (not the variable byte integer of the wire protocol), strings and
 *  binary data a u16 length. A block under MQTT 3.1.1 must be empty. */
export const MqttProperty = {
  /** u8: 1 when the payload is UTF-8 text. */
  payloadFormat: 0x01,
  /** u32 seconds. */
  messageExpiry: 0x02,
  /** string. */
  contentType: 0x03,
  /** string. */
  responseTopic: 0x08,
  /** binary. */
  correlationData: 0x09,
  /** u32 (1..65535 on ESP-IDF). */
  subscriptionIdentifier: 0x0b,
  /** string (CONNACK). */
  responseInformation: 0x1a,
  /** u32 seconds (will properties). */
  willDelay: 0x18,
  /** u16 (PUBLISH). */
  topicAlias: 0x23,
  /** string key, string value; repeatable. */
  userProperty: 0x26,
} as const;

/** Open descriptor flags. */
export const MqttOpenFlag = {
  cleanStart: 1 << 0,
  will: 1 << 1,
  willRetain: 1 << 2,
  /** Bits 3 and 4 hold the will QoS. */
  willQosShift: 3,
  requestResponseInformation: 1 << 5,
  requestProblemInformation: 1 << 6,
  /** Connect with a zero-length client identifier: the broker assigns one. */
  nullClientId: 1 << 7,
} as const;

/**
 * Open descriptor, at most 1024 bytes:
 *
 *   u8  version (1)
 *   u8  protocol (4 or 5)
 *   u8  flags (MqttOpenFlag)
 *   u8  reserved (0)
 *   u16 keepAliveSeconds (0 turns keepalive off)
 *   u16 receiveMaximum (MQTT 5; 0 for the default)
 *   u32 reconnectMs (0: the session ends at its first disconnection)
 *   u32 timeoutMs (1..120000; connect, TLS handshake and CONNACK wait)
 *   u32 maxMessageBytes (1..262144)
 *   u32 sessionExpirySeconds (MQTT 5)
 *   u32 maximumPacketSize (MQTT 5; 0: the host announces a size that
 *       carries a maxMessageBytes payload)
 *   u16 topicAliasMaximum (MQTT 5)
 *   u16 caBytes, u16 certificateBytes, u16 keyBytes
 *   string url         mqtt://, mqtts://, ws:// or wss://host[:port][/path]
 *   string clientId    empty: the host's default unless nullClientId is set
 *   string username
 *   binary password
 *   string keyPassword
 *   string commonName  the name the broker certificate must carry; empty: the URL host
 *   string alpn        comma-separated ALPN protocol names; empty: none
 *   string willTopic
 *   properties will    payloadFormat, messageExpiry, contentType,
 *                      responseTopic, correlationData, willDelay, userProperty
 *   binary willPayload
 *   properties connect userProperty
 *
 * When caBytes, certificateBytes or keyBytes is nonzero, the session waits
 * for that many bytes written with `write()` after open, in that order (PEM
 * or DER each), and connects once they arrived. Without a CA the host
 * verifies the broker against its certificate bundle. A secure scheme waits
 * for the wall clock before the TLS handshake.
 */
export const MQTT_OPEN_FIXED_BYTES = 36;

/**
 * CONNACK record, the data of a `headers` fact each time the session
 * connects:
 *
 *   u8  version (1)
 *   u8  flags: bit 0 session present
 *   u8  protocol (4 or 5)
 *   u8  maximumQos (MQTT 5; 2 under MQTT 3.1.1)
 *   u32 maximumPacketSize (0: none announced)
 *   u16 receiveMaximum
 *   u16 topicAliasMaximum
 *   u8  available: bit 0 retain, bit 1 wildcard subscriptions,
 *       bit 2 subscription identifiers, bit 3 shared subscriptions
 *   u8  reserved
 *   properties responseInformation, userProperty
 */
export const MqttConnackFlag = { sessionPresent: 1 << 0 } as const;
export const MqttAvailable = { retain: 1 << 0, wildcard: 1 << 1, subscriptionIdentifiers: 1 << 2, shared: 1 << 3 } as const;

/**
 * Message record. An incoming PUBLISH is one record, carried in order by one
 * or more `data` facts of at most 1024 bytes; a fact's offset is the
 * position of its first byte in the record, so a fact with offset 0 starts a
 * record.
 *
 *   u8  flags: bits 0-1 QoS, bit 2 retain, bit 3 dup
 *   u32 payloadBytes
 *   u16 topicBytes
 *   u16 propertyBytes
 *   topic, then properties (entries without the block's length prefix:
 *   payloadFormat, contentType, responseTopic, correlationData,
 *   subscriptionIdentifier, userProperty), then the payload
 *
 * A record ends after 9 + topicBytes + propertyBytes + payloadBytes bytes.
 * The host drops a message larger than maxMessageBytes, and one the worker
 * does not take within MQTT_DELIVERY_WAIT_MS, as a `gap` fact whose request
 * field counts the dropped messages; a record cut short by a gap or a
 * disconnection is never completed. Under MQTT 5 the broker withholds a
 * message above the maximum packet size the session announced; the session
 * never sees it, so no gap counts it.
 */
export const MQTT_RECORD_FIXED_BYTES = 9;
export const MqttMessageFlag = { qosMask: 0x03, retain: 1 << 2, dup: 1 << 3 } as const;
/** How long a host holds an incoming message for a worker whose event slots
 *  are full before it drops the message. */
export const MQTT_DELIVERY_WAIT_MS = 2_000;

/**
 * Publish request (opcode 1):
 *
 *   u8  version (1)
 *   u8  flags: bits 0-1 QoS, bit 2 retain, bit 3 staged
 *   u16 topicBytes
 *   u32 payloadBytes
 *   topic, properties (payloadFormat, messageExpiry, contentType,
 *   responseTopic, correlationData, topicAlias, userProperty), then the
 *   payload unless staged
 *
 * A staged publish carries no payload: the payload is the payloadBytes
 * bytes written with `write()` since the previous staged publish started.
 * A session holds one staged payload at a time. The completion of an
 * accepted publish carries one byte, the PUBACK or PUBCOMP reason code
 * (0 under MQTT 3.1.1 and for QoS 0).
 */
export const MqttPublishFlag = { qosMask: 0x03, retain: 1 << 2, staged: 1 << 3 } as const;

/**
 * Subscribe request (opcode 2):
 *
 *   u8  version (1)
 *   u8  count (1..8)
 *   u8  options (MQTT 5): bit 0 noLocal, bit 1 retainAsPublished,
 *       bits 2-3 retainHandling
 *   u8  reserved
 *   u32 subscriptionIdentifier (MQTT 5; 0 for none)
 *   properties userProperty
 *   count x (u8 maximum QoS, string filter)
 *
 * The completion carries the SUBACK codes: the granted QoS, or a code of
 * 0x80 and above for a refused filter.
 */
export const MqttSubscribeOption = { noLocal: 1 << 0, retainAsPublished: 1 << 1, retainHandlingShift: 2 } as const;

/**
 * Unsubscribe request (opcode 3):
 *
 *   u8  version (1)
 *   u8  count (1..8)
 *   properties userProperty
 *   count x string filter
 */

/**
 * Disconnect request (opcode 4):
 *
 *   u8  version (1)
 *   u8  reasonCode (MQTT 5; 0 normal, 4 with the will message)
 *   u8  flags: bit 0 sessionExpirySeconds present
 *   u8  reserved
 *   u32 sessionExpirySeconds
 *   properties userProperty
 */
export const MqttDisconnectFlag = { sessionExpiry: 1 << 0 } as const;

/** Codes of an `error` fact or a failed completion, `code: message`. A
 *  session that ends emits an `end` fact with status failed after its last
 *  error. */
export const MQTT_ERROR = {
  /** The network has no address, or the session is not connected. */
  unavailable: "unavailable",
  invalidRequest: "invalid_request",
  /** The client's outbox is full. */
  busy: "busy",
  dns: "dns",
  connect: "connect",
  tls: "tls",
  timeout: "timeout",
  /** The broker refused the CONNECT; the message names the return or reason
   *  code. A refusal other than server unavailable or busy, quota or
   *  connection rate exceeded ends the session. */
  refused: "refused",
  /** The broker closed the connection or sent DISCONNECT. */
  closed: "closed",
  protocol: "protocol",
  other: "other",
} as const;
export type MqttErrorCode = (typeof MQTT_ERROR)[keyof typeof MQTT_ERROR];
