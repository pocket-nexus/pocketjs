// Generates the Pocket Link 2 conformance vectors of docs/POCKET-LINK.md §10
// into tests/vectors/pocket-link-2/ from fixed inputs:
//
//   bun tools/pocket-link/v2/vectors.ts          write the files
//   bun tools/pocket-link/v2/vectors.ts --check  fail when a file would change
//
// Bytes are hex; each transcript step names its sender. A bulk DATA frame is
// given as its 12 header bytes and `fill`: the payload is `bytes` copies of
// that one byte. JSON control messages are written without whitespace, keys
// in the order of the object; receivers accept any order.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LINK2_APP_EVENT_WINDOW,
  LINK2_APP_FRAME_STREAM,
  LINK2_APP_STREAM_WINDOW,
  LINK2_ERROR,
  LINK2_FLAG,
  LINK2_FRAME,
  LINK2_HTTP_HEADERS_BYTES,
  LINK2_HTTP_MAX_HEADERS,
  LINK2_HTTP_MIN_PAYLOAD,
  LINK2_HTTP_URL_BYTES,
  LINK2_LABEL,
  LINK2_LOG_OVERHEAD,
  LINK2_MAX_HANDSHAKE,
  LINK2_MIN_PAYLOAD,
  LINK2_PAIR_CODE_DIGITS,
  LINK2_PAIR_DONE_MS,
  LINK2_PAIR_MAX_SEEN,
  LINK2_PAIR_SEEN_MS,
  LINK2_PAIR_TRIES,
  LINK2_PAIR_WINDOW_MS,
  LINK2_TCP_PAYLOAD,
  LINK2_WINDOW,
  type Link2CatalogApp,
  type Link2Hello,
  type Link2InstalledApp,
  type Link2Pair,
  type Link2PairOffer,
  type Link2Ready,
} from "../../../contracts/spec/link2.ts";
import { AppletStreamWindow, EventReceiver, SendCredit, eventUnits } from "./credit.ts";
import { CatalogPager, catalogRows, pageRuntimeApps } from "./paging.ts";
import { formatCompanionFile, formatDeviceFile, formatLastFile, planSetup, type SetupInput } from "./pairing.ts";
import {
  appMessageLimit,
  companionProof,
  consoleProof,
  devicePreamble,
  encodeBeacon,
  encodeCancel,
  encodeClose,
  encodeCredit,
  encodeData,
  encodeHandshake,
  encodeJsonFrame,
  encodePing,
  encodePreamble,
  encodeRawFrame,
  encodeReset,
  encodedBytes,
  jsonBytes,
  pairCompanionProof,
  pairConsoleProof,
  pairMaskKey,
  proofMessage,
  refused,
  selectVersion,
  toHex,
} from "./protocol.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "../../..");
export const VECTOR_DIR = join(ROOT, "tests/vectors/pocket-link-2");

const utf8 = new TextEncoder();
const hex = toHex;

// Fixed inputs.
export const FIXED = {
  device: "0123456789abcdef",
  hub: "fedcba9876543210",
  otherHub: "00112233445566ff",
  key: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  otherKey: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
  deviceNonce: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
  hubNonce: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
  clock: { utc: 1_794_312_000_000, local: 1_794_340_800_000 },
  /** The code the device shows (§3.11), and another one entered in its place. */
  code: "314159",
  otherCode: "271828",
} as const;

const hello = (maxPayload: number): Link2Hello => ({
  t: "hello",
  device: FIXED.device,
  companion: FIXED.hub,
  nonce: FIXED.deviceNonce,
  name: "Pocket",
  model: "New Nintendo 3DS XL",
  target: "3ds-dev",
  hostAbi: 12,
  features: ["runtime", "runtime.native", "runtime.remove", "devtools", "catalog", "install", "net.http", "agent", "channel", "apps"],
  maxPayload,
});
const ready = (maxPayload: number): Link2Ready => ({
  t: "ready",
  name: "Studio Mac",
  features: ["runtime", "runtime.native", "runtime.remove", "devtools", "catalog", "install", "net.http", "channel", "apps"],
  maxPayload,
  clock: { ...FIXED.clock },
});

/** A string of exactly `bytes` encoded bytes made of `ch`. */
const fillText = (bytes: number, ch = "x") => ch.repeat(bytes);

// ---------------------------------------------------------------------------

function beacon() {
  const good = encodeBeacon({ port: 8628, companion: FIXED.hub, name: "Studio Mac" });
  const full = encodeBeacon({ port: 50123, companion: FIXED.hub, name: "N".repeat(40) });
  // 39 ASCII bytes, then a 3-byte character that does not fit: cut before it.
  const cut = encodeBeacon({ port: 8628, companion: FIXED.hub, name: `${"a".repeat(39)}中` });
  const flag = new Uint8Array(good);
  flag[5] = 1;
  const edit = (change: (bytes: Uint8Array) => void) => {
    const bytes = new Uint8Array(good);
    change(bytes);
    return bytes;
  };
  return {
    accepted: [
      { name: "a plain beacon", hex: hex(good), port: 8628, companion: FIXED.hub, text: "Studio Mac" },
      { name: "a 40-byte name", hex: hex(full), port: 50123, companion: FIXED.hub, text: "N".repeat(40) },
      { name: "a name cut before a multi-byte character", hex: hex(cut), port: 8628, companion: FIXED.hub, text: "a".repeat(39) },
      { name: "flag bit 0 set, which a version-2 receiver ignores", hex: hex(flag), port: 8628, companion: FIXED.hub, text: "Studio Mac" },
    ],
    refused: [
      { name: "63 bytes", hex: hex(good.subarray(0, 63)) },
      { name: "65 bytes", hex: hex(new Uint8Array([...good, 0])) },
      { name: "wrong magic", hex: hex(edit((b) => (b[0] = 0x51))) },
      { name: "version 1", hex: hex(edit((b) => (b[4] = 1))) },
      { name: "port 0", hex: hex(edit((b) => ((b[6] = 0), (b[7] = 0)))) },
      { name: "an uppercase id", hex: hex(edit((b) => (b[8] = 0x46))) },
    ],
  };
}

function preamble() {
  const hub = { highest: 2, lowest: 2 };
  const cases = [
    { name: "a version-2 device", device: { highest: 2, lowest: 2, selected: 0 }, hub },
    { name: "a version-1 console (PKLK, 1, 0, 0, 0)", device: { highest: 1, lowest: 0, selected: 0 }, hub },
    { name: "a device with range 2 to 3", device: { highest: 3, lowest: 2, selected: 0 }, hub },
    { name: "a device with range 3 to 4", device: { highest: 4, lowest: 3, selected: 0 }, hub },
    { name: "a Hub with range 2 to 3 and a version-2 device", device: { highest: 2, lowest: 2, selected: 0 }, hub: { highest: 3, lowest: 2 } },
  ].map((c) => {
    const selected = selectVersion(c.hub, c.device);
    return { ...c, deviceHex: hex(encodePreamble(c.device)), selected, hubHex: hex(encodePreamble({ ...c.hub, selected })), hubCloses: selected === 0 };
  });
  return {
    device: hex(devicePreamble()),
    selection: cases,
    deviceAccepts: [
      { name: "selected 2 inside 2..2", device: { highest: 2, lowest: 2 }, hubHex: hex(encodePreamble({ highest: 2, lowest: 2, selected: 2 })), version: 2 },
      { name: "selected 0: no common version", device: { highest: 2, lowest: 2 }, hubHex: hex(encodePreamble({ highest: 4, lowest: 3, selected: 0 })), version: null },
      { name: "selected 3 outside 2..2", device: { highest: 2, lowest: 2 }, hubHex: hex(encodePreamble({ highest: 3, lowest: 2, selected: 3 })), version: null },
    ],
    wrongMagic: hex(new Uint8Array([0x50, 0x4b, 0x4c, 0x42, 2, 2, 0, 0])),
    // A several-version device that did not wait: its version-3 hello is read
    // by version 2's frame checks. Here a version-3 frame whose reserved
    // field is in use fails them.
    notWaiting: { hex: hex(encodeRawFrame(LINK2_FRAME.handshake, 0, 3, 0, utf8.encode("{}"))), close: "protocol" },
  };
}

function frames() {
  const json = { t: "x.ping", n: 1 };
  const one = (name: string, bytes: Uint8Array, limit: number = LINK2_TCP_PAYLOAD, linked = true) => ({ name, hex: hex(bytes), limit, linked });
  const valid = [
    one("PING", encodePing(7)),
    one("PONG", encodeRawFrame(LINK2_FRAME.pong, 0, 0, 0, new Uint8Array([7, 0, 0, 0]))),
    one("CLOSE going_away with a reason", encodeClose("going_away", "the device sleeps")),
    one("HANDSHAKE before ready", encodeHandshake({ t: "auth", proof: "0".repeat(64) }), LINK2_TCP_PAYLOAD, false),
    one("REQUEST", encodeJsonFrame(LINK2_FRAME.request, 5, { t: "catalog" })),
    one("REQUEST with APP", encodeJsonFrame(LINK2_FRAME.request, 6, json, { channel: 3 })),
    one("REQUEST with APP and BODY", encodeJsonFrame(LINK2_FRAME.request, 7, json, { channel: 3, body: true })),
    one("REPLY", encodeJsonFrame(LINK2_FRAME.reply, 5, { apps: [], rev: 1, more: false })),
    one("REPLY with ERROR", encodeJsonFrame(LINK2_FRAME.reply, 5, { code: "busy", message: "four requests are open" }, { error: true })),
    one("EVENT with id 0", encodeJsonFrame(LINK2_FRAME.event, 0, { t: "catalog.changed" })),
    one("EVENT with APP and id 0", encodeJsonFrame(LINK2_FRAME.event, 0, json, { channel: 3 })),
    one("EVENT with APP that opens a stream", encodeJsonFrame(LINK2_FRAME.event, 0x8000_0009, json, { channel: 3 })),
    one("CANCEL", encodeCancel(5)),
    one("DATA", encodeData(5, new Uint8Array([1, 2, 3]))),
    one("DATA with END and bytes", encodeData(5, new Uint8Array([4]), true)),
    one("DATA with END and no bytes", encodeData(5, new Uint8Array(0), true)),
    one("CREDIT", encodeCredit(5, 65536)),
    one("RESET refused", encodeReset(0x8000_0009, "refused")),
    one("an unknown type after ready, skipped by length", encodeRawFrame(0x7f, 0, 0, 0, new Uint8Array([9, 9]))),
  ];
  const bad = (name: string, bytes: Uint8Array, close: string, limit: number = LINK2_TCP_PAYLOAD, linked = true) => ({ name, hex: hex(bytes), limit, linked, close });
  const empty = new Uint8Array(0);
  const refusedFrames = [
    bad("non-zero reserved", encodeRawFrame(LINK2_FRAME.ping, 0, 1, 0, new Uint8Array(4)), "protocol"),
    bad("an undefined flag on PING", encodeRawFrame(LINK2_FRAME.ping, 0x01, 0, 0, new Uint8Array(4)), "protocol"),
    bad("the reserved encryption flag", encodeRawFrame(LINK2_FRAME.data, LINK2_FLAG.sealed, 0, 5, new Uint8Array(1)), "protocol"),
    bad("length 16,385 on a 16,384 limit, header alone", encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, empty, 16_385), "too_large"),
    bad("length 1,025 on a 1,024 limit, header alone", encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, empty, 1025), "too_large", LINK2_MIN_PAYLOAD),
    bad("REQUEST with id 0", encodeRawFrame(LINK2_FRAME.request, 0, 0, 0, utf8.encode("{}")), "protocol"),
    bad("REQUEST with id 0x80000000", encodeRawFrame(LINK2_FRAME.request, 0, 0, 0x8000_0000, utf8.encode("{}")), "protocol"),
    bad("DATA of 0 bytes without END", encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, empty), "protocol"),
    bad("CREDIT of 0", encodeRawFrame(LINK2_FRAME.credit, 0, 0, 5, new Uint8Array(4)), "protocol"),
    bad("PING of 3 bytes", encodeRawFrame(LINK2_FRAME.ping, 0, 0, 0, new Uint8Array(3)), "protocol"),
    bad("PING with an id", encodeRawFrame(LINK2_FRAME.ping, 0, 0, 5, new Uint8Array(4)), "protocol"),
    bad("REQUEST with BODY and no APP", encodeRawFrame(LINK2_FRAME.request, LINK2_FLAG.body, 0, 5, utf8.encode("{}")), "protocol"),
    bad("an APP frame of 3 bytes", encodeRawFrame(LINK2_FRAME.event, LINK2_FLAG.app, 0, 0, new Uint8Array(3)), "protocol"),
    bad("CANCEL with a payload", encodeRawFrame(LINK2_FRAME.cancel, 0, 0, 5, new Uint8Array(1)), "protocol"),
    bad("HANDSHAKE after ready", encodeRawFrame(LINK2_FRAME.handshake, 0, 0, 0, utf8.encode("{}")), "protocol"),
    bad("DATA before ready", encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, new Uint8Array(1)), "protocol", LINK2_TCP_PAYLOAD, false),
    bad("HANDSHAKE of 1,025 bytes, header alone", encodeRawFrame(LINK2_FRAME.handshake, 0, 0, 0, empty, LINK2_MAX_HANDSHAKE + 1), "too_large", LINK2_TCP_PAYLOAD, false),
  ];
  return { valid, refused: refusedFrames };
}

function handshake() {
  const h = hello(LINK2_TCP_PAYLOAD);
  const companionMessage = proofMessage(LINK2_LABEL.companion, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub);
  const consoleMessage = proofMessage(LINK2_LABEL.console, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub);
  const challenge = { t: "challenge" as const, nonce: FIXED.hubNonce, proof: companionProof(FIXED.key, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub) };
  const auth = { t: "auth" as const, proof: consoleProof(FIXED.key, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub) };
  const r = ready(LINK2_TCP_PAYLOAD);
  return {
    key: FIXED.key,
    companionMessage,
    consoleMessage,
    companionProof: challenge.proof,
    consoleProof: auth.proof,
    transcript: [
      { from: "device", what: "preamble", hex: hex(devicePreamble()) },
      { from: "device", what: "hello", hex: hex(encodeHandshake(h)), json: h },
      { from: "hub", what: "preamble", hex: hex(encodePreamble({ highest: 2, lowest: 2, selected: 2 })) },
      { from: "hub", what: "challenge", hex: hex(encodeHandshake(challenge)), json: challenge },
      { from: "device", what: "auth", hex: hex(encodeHandshake(auth)), json: auth },
      { from: "hub", what: "ready", hex: hex(encodeHandshake(r)), json: r },
    ],
    limits: [
      { hello: 16_384, ready: 16_384, limit: 16_384 },
      { hello: 1024, ready: 16_384, limit: 1024 },
      { hello: 16_384, ready: 1024, limit: 1024 },
      { hello: 32_768, ready: 16_384, limit: 16_384 },
    ],
  };
}

function handshakeRefusals() {
  const base = hello(LINK2_TCP_PAYLOAD);
  const wrong = (name: string, change: Record<string, unknown>, remove?: string) => {
    const object: Record<string, unknown> = { ...base, ...change };
    if (remove) delete object[remove];
    return { name, json: object, refused: "malformed" };
  };
  const refusal = (code: Parameters<typeof refused>[0], message: string) => {
    const r = refused(code, message);
    return { code, hex: hex(encodeHandshake(r)), json: r };
  };
  return {
    refusals: [
      refusal("unknown_device", "this computer holds no key for the device"),
      refusal("bad_proof", "the proof does not verify"),
      refusal("malformed", "maxPayload"),
      refusal("busy", "32 connections are open"),
    ],
    malformedHello: [
      wrong("maxPayload 512", { maxPayload: 512 }),
      wrong("maxPayload 32,769", { maxPayload: 32_769 }),
      wrong("an uppercase device id", { device: "0123456789ABCDEF" }),
      wrong("a 31-digit nonce", { nonce: FIXED.deviceNonce.slice(1) }),
      wrong("17 features", { features: Array.from({ length: 17 }, (_, i) => `f${i}`) }),
      wrong("a feature of 25 bytes", { features: ["f".repeat(25)] }),
      wrong("a name of 65 bytes", { name: "n".repeat(65) }),
      wrong("a target of 16 bytes", { target: "t".repeat(16) }),
      wrong("no model", {}, "model"),
      wrong("hostAbi as a string", { hostAbi: "12" }),
    ],
    unknownDevice: [
      { name: "Hub holds no key for the device", hello: base, hubId: FIXED.hub, key: null, refused: "unknown_device" },
      { name: "companion names another Hub", hello: { ...base, companion: FIXED.otherHub }, hubId: FIXED.hub, key: FIXED.key, refused: "unknown_device" },
    ],
    badProof: {
      auth: { t: "auth", proof: consoleProof(FIXED.otherKey, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub) },
      expected: consoleProof(FIXED.key, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub),
      refused: "bad_proof",
    },
    deviceCloseAuth: {
      challenge: { t: "challenge", nonce: FIXED.hubNonce, proof: companionProof(FIXED.otherKey, FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub) },
      close: hex(encodeClose("auth", "the proof does not verify")),
      holdMs: 30_000,
    },
    readyOutOfRange: { json: { ...ready(512) }, close: "protocol" },
    dataBeforeReady: { hex: hex(encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, new Uint8Array(1))), close: "protocol" },
  };
}

/** §3.11: a device paired by the code it shows. */
function pairByCode() {
  const ids = [FIXED.deviceNonce, FIXED.hubNonce, FIXED.device, FIXED.hub] as const;
  const pair: Link2Pair = { t: "pair", device: FIXED.device, nonce: FIXED.deviceNonce, name: "Pocket", model: "M5Stack Tab5", target: "tab5-home" };
  const offerUnder = (code: string, key: string): Link2PairOffer => ({
    t: "pair.offer",
    companion: FIXED.hub,
    name: "Studio Mac",
    nonce: FIXED.hubNonce,
    proof: pairCompanionProof(code, ...ids),
    key: pairMaskKey(code, key, ...ids),
  });
  const offer = offerUnder(FIXED.code, FIXED.key);
  const accept = { t: "pair.accept" as const, proof: pairConsoleProof(FIXED.key, ...ids) };
  const done = { t: "pair.done" as const };
  const wrongOffer = offerUnder(FIXED.otherCode, FIXED.otherKey);
  const declined = refused("declined", "this computer's owner dismissed the request");
  const wrongPair = (name: string, change: Record<string, unknown>, remove?: string) => {
    const object: Record<string, unknown> = { ...pair, ...change };
    if (remove) delete object[remove];
    return { name, json: object, refused: "malformed" };
  };
  const wrongOfferOf = (name: string, change: Record<string, unknown>, remove?: string) => {
    const object: Record<string, unknown> = { ...offer, ...change };
    if (remove) delete object[remove];
    return { name, json: object };
  };
  // The connection reached Hub at this address and port: they go into the key file.
  const reached = { address: "192.168.1.5", port: 8628 };
  return {
    code: FIXED.code,
    // The key of the first two HMACs: the code's digits as ASCII bytes.
    codeKey: hex(utf8.encode(FIXED.code)),
    key: FIXED.key,
    companionMessage: proofMessage(LINK2_LABEL.pairCompanion, ...ids),
    keyMessage: proofMessage(LINK2_LABEL.pairKey, ...ids),
    consoleMessage: proofMessage(LINK2_LABEL.pairConsole, ...ids),
    companionProof: offer.proof,
    // HMAC(code, keyMessage): the link key XOR this is `pair.offer.key`.
    keyMask: pairMaskKey(FIXED.code, "00".repeat(32), ...ids),
    maskedKey: offer.key,
    consoleProof: accept.proof,
    transcript: [
      { from: "device", what: "preamble", hex: hex(devicePreamble()) },
      { from: "device", what: "pair", hex: hex(encodeHandshake(pair)), json: pair },
      { from: "hub", what: "preamble", hex: hex(encodePreamble({ highest: 2, lowest: 2, selected: 2 })) },
      { from: "hub", what: "pair.offer", hex: hex(encodeHandshake(offer)), json: offer },
      { from: "device", what: "pair.accept", hex: hex(encodeHandshake(accept)), json: accept },
      { from: "hub", what: "pair.done", hex: hex(encodeHandshake(done)), json: done },
    ],
    // What the device writes between the offer and its accept, and the record Hub stores at the accept.
    keyFile: {
      ...reached,
      deleted: `companions/${FIXED.hub}.last`,
      path: `companions/${FIXED.hub}.txt`,
      text: formatCompanionFile({ key: FIXED.key, name: offer.name, ...reached }),
    },
    record: { id: FIXED.device, key: FIXED.key, name: pair.name, model: pair.model, target: pair.target },
    // Hub's owner entered another code: the proof fails at the device, which closes and keeps its code.
    wrongCode: {
      entered: FIXED.otherCode,
      offer: { hex: hex(encodeHandshake(wrongOffer)), json: wrongOffer },
      expectedProof: offer.proof,
      close: hex(encodeClose("auth")),
      triesLeft: LINK2_PAIR_TRIES - 1,
      stored: false,
    },
    // An offer that names another Hub than the one asked fails the same way.
    otherCompanion: { asked: FIXED.otherHub, offer: { json: offer }, close: hex(encodeClose("auth")) },
    // An accept keyed with another key: Hub refuses and stores nothing.
    badAccept: { json: { t: "pair.accept", proof: pairConsoleProof(FIXED.otherKey, ...ids) }, refused: "bad_proof", stored: false },
    declined: { hex: hex(encodeHandshake(declined)), json: declined },
    codes: {
      accepted: ["000000", "999999", FIXED.code],
      refused: ["", "31415", "3141592", "31415a", " 14159", "٣١٤١٥٩"],
    },
    malformedPair: [
      wrongPair("an uppercase device id", { device: "0123456789ABCDEF" }),
      wrongPair("a 31-digit nonce", { nonce: FIXED.deviceNonce.slice(1) }),
      wrongPair("a name of 65 bytes", { name: "n".repeat(65) }),
      wrongPair("a model of 33 bytes", { model: "m".repeat(33) }),
      wrongPair("a target of 16 bytes", { target: "t".repeat(16) }),
      wrongPair("no model", {}, "model"),
    ],
    // Not an offer to the device: it asks that Hub again.
    malformedOffer: [
      wrongOfferOf("an uppercase companion id", { companion: FIXED.hub.toUpperCase() }),
      wrongOfferOf("a 31-digit nonce", { nonce: FIXED.hubNonce.slice(1) }),
      wrongOfferOf("a proof of 63 digits", { proof: offer.proof.slice(1) }),
      wrongOfferOf("a key with an uppercase digit", { key: `${offer.key.slice(0, 63)}F` }),
      wrongOfferOf("no key", {}, "key"),
      wrongOfferOf("another t", { t: "challenge" }),
    ],
    limits: {
      digits: LINK2_PAIR_CODE_DIGITS,
      windowMs: LINK2_PAIR_WINDOW_MS,
      tries: LINK2_PAIR_TRIES,
      seenMs: LINK2_PAIR_SEEN_MS,
      maxSeen: LINK2_PAIR_MAX_SEEN,
      doneMs: LINK2_PAIR_DONE_MS,
    },
  };
}

function pairingFiles() {
  const companion = { key: FIXED.key, name: "Studio Mac", address: "192.168.1.5", port: 8628 };
  const keyText = formatCompanionFile(companion);
  const lastText = formatLastFile({ name: "Studio Mac", address: "192.168.1.9", port: 50123 });
  const other = (n: number) => ({ name: `${n.toString(16).padStart(16, "0")}.txt`, text: formatCompanionFile({ key: FIXED.otherKey, name: `Mac ${n}`, address: "10.0.0.2", port: 8628 }) });
  const setup = (name: string, change: Partial<SetupInput>, expect: Record<string, unknown>) => {
    let deviceIds = 0;
    let keys = 0;
    const input: SetupInput = {
      hubId: FIXED.hub,
      key: null,
      hub: { name: "Studio Mac", port: 8628 },
      via: { kind: "ftp", localAddress: "192.168.1.5" },
      device: { kind: "file", text: formatDeviceFile(FIXED.device) },
      listing: [],
      companion: { kind: "absent" },
      last: { kind: "absent" },
      mintDeviceId: () => ["1111111111111111", "2222222222222222"][deviceIds++],
      mintKey: () => [FIXED.otherKey, "aa".repeat(32)][keys++],
      ...change,
    };
    const plan = planSetup(input);
    const { mintDeviceId: _a, mintKey: _b, ...rest } = input;
    return { name, input: rest, minted: { deviceIds: ["1111111111111111", "2222222222222222"], keys: [FIXED.otherKey, "aa".repeat(32)] }, plan, expect };
  };
  const ownFile = { name: `${FIXED.hub}.txt`, text: keyText };
  return {
    deviceFile: { text: formatDeviceFile(FIXED.device), hex: hex(utf8.encode(formatDeviceFile(FIXED.device))), id: FIXED.device },
    companionFile: { name: `companions/${FIXED.hub}.txt`, text: keyText, hex: hex(utf8.encode(keyText)), parsed: companion },
    lastFile: { name: `companions/${FIXED.hub}.last`, text: lastText, parsed: { name: "Studio Mac", address: "192.168.1.9", port: 50123 } },
    deviceFileReads: [
      { name: "with its newline", text: `${FIXED.device}\n`, id: FIXED.device },
      { name: "without a newline", text: FIXED.device, id: FIXED.device },
      { name: "two newlines, as the device's reader strips them", text: `${FIXED.device}\n\n`, id: FIXED.device },
      { name: "a CRLF line end and a space", text: `${FIXED.device} \r\n`, id: FIXED.device },
      { name: "a space inside", text: "01234567 89abcdef\n", id: null },
      { name: "an uppercase id", text: "0123456789ABCDEF\n", id: null },
      { name: "15 digits", text: "0123456789abcde\n", id: null },
      { name: "empty", text: "", id: null },
    ],
    companionFileReads: [
      { name: "a missing final newline", text: keyText.slice(0, -1), parsed: companion },
      { name: "fields in another order", text: `port=8628\naddress=192.168.1.5\nname=Studio Mac\nkey=${FIXED.key}\n`, parsed: companion },
      { name: "CRLF line ends", text: keyText.replace(/\n/g, "\r\n"), parsed: companion },
      { name: "no port: the default port", text: `key=${FIXED.key}\nname=Studio Mac\naddress=192.168.1.5\n`, parsed: companion },
      { name: "a bad address reads as none", text: `key=${FIXED.key}\nname=Studio Mac\naddress=mac.local\nport=8628\n`, parsed: { ...companion, address: "" } },
      { name: "a 63-digit key", text: `key=${FIXED.key.slice(1)}\nname=Studio Mac\n`, parsed: null },
      { name: "an uppercase key", text: `key=${FIXED.key.toUpperCase()}\n`, parsed: null },
      { name: "no key line", text: "name=Studio Mac\naddress=192.168.1.5\nport=8628\n", parsed: null },
    ],
    load: [
      {
        name: "a key file with its .last file: the .last values replace the key file's",
        entries: [ownFile, { name: `${FIXED.hub}.last`, text: lastText }],
        companions: [{ id: FIXED.hub, key: FIXED.key, name: "Studio Mac", address: "192.168.1.9", port: 50123 }],
        error: null,
      },
      {
        name: "a damaged .last falls back to the key file",
        entries: [ownFile, { name: `${FIXED.hub}.last`, text: "name=Studio Mac\naddress=\n" }],
        companions: [{ id: FIXED.hub, ...companion }],
        error: null,
      },
      {
        name: "a .new file and an uppercase name are not pairings",
        entries: [{ name: `${FIXED.hub}.new`, text: keyText }, { name: "FEDCBA9876543210.txt", text: keyText }, ownFile],
        companions: [{ id: FIXED.hub, ...companion }],
        error: null,
      },
      {
        name: "nine key files: eight read in directory order, the ninth reported",
        entries: [...Array.from({ length: 8 }, (_, i) => other(i + 1)), ownFile],
        companions: Array.from({ length: 8 }, (_, i) => ({ id: (i + 1).toString(16).padStart(16, "0"), key: FIXED.otherKey, name: `Mac ${i + 1}`, address: "10.0.0.2", port: 8628 })),
        error: "more than 8 computers",
      },
    ],
    setups: [
      setup("a card without device.txt: a new id and a new key", { device: { kind: "absent" } }, { outcome: "key", deviceId: "1111111111111111" }),
      setup("a card with device.txt and no key file", {}, { outcome: "key", deviceId: FIXED.device }),
      setup(
        "the key file's key is the record's and the address is the FTP connection's: nothing written",
        { key: FIXED.key, listing: [ownFile], companion: { kind: "file", text: keyText } },
        { outcome: "kept", ops: 0 },
      ),
      setup(
        "the key matches and the device would use another address: .last rewritten, the key file untouched",
        { key: FIXED.key, listing: [ownFile], companion: { kind: "file", text: keyText }, via: { kind: "ftp", localAddress: "192.168.7.7" } },
        { outcome: "address" },
      ),
      setup(
        "on a mounted card an address that is one of Hub's own is left alone",
        { key: FIXED.key, listing: [ownFile], companion: { kind: "file", text: keyText }, via: { kind: "card", addresses: ["10.0.0.5", "192.168.1.5"] } },
        { outcome: "kept", ops: 0 },
      ),
      setup(
        "the key file's key is not the record's: a new key replaces the record's before the first write",
        { key: "bb".repeat(32), listing: [ownFile], companion: { kind: "file", text: keyText } },
        { outcome: "key", key: FIXED.otherKey },
      ),
      setup(
        "eight files of other Hubs: nothing written",
        { listing: Array.from({ length: 8 }, (_, i) => other(i + 1)) },
        { outcome: "eight-computers", ops: 0 },
      ),
      setup(
        "eight loadable key files and two the device would not load: the two are not counted",
        { listing: [...Array.from({ length: 7 }, (_, i) => other(i + 1)), { name: "0000000000000008.txt", text: "name=no key\n" }, { name: "notes.txt", text: keyText }] },
        { outcome: "key" },
      ),
      setup("a leftover .new of this Hub is removed first", { listing: [{ name: `${FIXED.hub}.new`, text: "key=" }] }, { outcome: "key", firstOp: "delete" }),
      setup("the read of the key file failed: the setup ends and the record stays", { key: FIXED.key, companion: { kind: "failed" } }, { outcome: "failed-read", key: FIXED.key, ops: 0 }),
    ],
    // What the card holds after a cut that let N operations of the second setup above through.
    powerCut: {
      before: { "device.txt": formatDeviceFile(FIXED.device), [`companions/${FIXED.hub}.txt`]: keyText, [`companions/${FIXED.hub}.last`]: lastText },
      key: "bb".repeat(32),
      cuts: [
        { completed: 0, holds: ["device.txt", `companions/${FIXED.hub}.last`, `companions/${FIXED.hub}.txt`], pairing: "unchanged" },
        { completed: 3, holds: ["device.txt", `companions/${FIXED.hub}.new`, `companions/${FIXED.hub}.txt`], pairing: "unchanged, no .last" },
        { completed: 4, holds: ["device.txt", `companions/${FIXED.hub}.new`], pairing: "none until the next setup" },
        { completed: 5, holds: ["device.txt", `companions/${FIXED.hub}.txt`], pairing: "the new key" },
      ],
    },
  };
}

function requests() {
  const step = (from: "device" | "hub", what: string, bytes: Uint8Array) => ({ from, what, hex: hex(bytes) });
  return {
    withProgress: [
      step("hub", "REQUEST runtime.push", encodeJsonFrame(LINK2_FRAME.request, 0x8000_0001, { t: "runtime.push", bytes: 3, hash: "00000000000000aa" })),
      step("device", "CREDIT", encodeCredit(0x8000_0001, LINK2_WINDOW.bulk)),
      step("device", "EVENT runtime.install receiving", encodeJsonFrame(LINK2_FRAME.event, 0x8000_0001, { t: "runtime.install", phase: "receiving", hash: "00000000000000aa", generation: 4, message: "" })),
      step("hub", "DATA with END", encodeData(0x8000_0001, new Uint8Array([1, 2, 3]), true)),
      step("device", "EVENT runtime.install staged", encodeJsonFrame(LINK2_FRAME.event, 0x8000_0001, { t: "runtime.install", phase: "staged", hash: "00000000000000aa", generation: 4, message: "" })),
      step("device", "REPLY", encodeJsonFrame(LINK2_FRAME.reply, 0x8000_0001, { phase: "accepted", hash: "00000000000000aa", generation: 5, message: "", app: { id: "dev.example.app", output: "example", title: "Example" } })),
    ],
    errors: LINK2_ERROR.map((code) => ({ code, hex: hex(encodeJsonFrame(LINK2_FRAME.reply, 9, { code, message: `the ${code} case` }, { error: true })) })),
    unknownMessage: [
      step("device", "REQUEST of an unknown t", encodeJsonFrame(LINK2_FRAME.request, 11, { t: "catalog.search" })),
      step("hub", "REPLY ERROR unknown_message", encodeJsonFrame(LINK2_FRAME.reply, 11, { code: "unknown_message", message: "catalog.search" }, { error: true })),
    ],
    malformed: [
      step("device", "REQUEST whose payload is not an object", encodeRawFrame(LINK2_FRAME.request, 0, 0, 12, utf8.encode("[1,2]"))),
      step("hub", "REPLY ERROR malformed", encodeJsonFrame(LINK2_FRAME.reply, 12, { code: "malformed", message: "not an object with a string t" }, { error: true })),
    ],
    cancel: [
      step("device", "REQUEST install", encodeJsonFrame(LINK2_FRAME.request, 13, { t: "install", app: "dev.example.app" })),
      step("device", "CANCEL", encodeCancel(13)),
      step("hub", "REPLY ERROR cancelled", encodeJsonFrame(LINK2_FRAME.reply, 13, { code: "cancelled", message: "" }, { error: true })),
    ],
    cancelCrossesReply: [
      step("device", "REQUEST catalog", encodeJsonFrame(LINK2_FRAME.request, 14, { t: "catalog" })),
      step("hub", "REPLY, already queued", encodeJsonFrame(LINK2_FRAME.reply, 14, { apps: [], rev: 1, more: false })),
      step("device", "CANCEL, crossing it", encodeCancel(14)),
    ],
    ids: [
      { id: 1, range: "device" },
      { id: 0x7fff_ffff, range: "device" },
      { id: 0x8000_0001, range: "hub" },
      { id: 0xffff_ffff, range: "hub" },
      { id: 0, range: null },
      { id: 0x8000_0000, range: null },
    ],
    runtimeRemove: runtimeRemove(),
  };
}

/** §6.2 runtime.remove: a removal and the report after it, each error with
 *  the state that gives it, and the ids at and past the limit. */
function runtimeRemove() {
  const step = (from: "device" | "hub", what: string, bytes: Uint8Array) => ({ from, what, hex: hex(bytes) });
  const request = (id: number, app: unknown) => encodeJsonFrame(LINK2_FRAME.request, id, { t: "runtime.remove", id: app });
  const refusal = (id: number, code: string, message: string, reason?: string) =>
    encodeJsonFrame(LINK2_FRAME.reply, id, reason === undefined ? { code, message } : { code, message, reason }, { error: true });
  const home: Link2InstalledApp = { id: "dev.pocket-nexus.shell", output: "pocket-shell", version: "1.4.0", hash: "0c264b65890d0377", home: true };
  const map: Link2InstalledApp = { id: "dev.example.map", output: "map", version: "2.0.1", hash: "00000000000000a1" };
  const notes: Link2InstalledApp = { id: "dev.example.notes", output: "notes", version: "1.0.0", hash: "00000000000000a2" };
  const running = map.id;
  const error = (n: number, name: string, app: string, code: string, message: string, reason?: string) => ({
    name,
    id: app,
    code,
    reason: reason ?? null,
    steps: [step("hub", "REQUEST runtime.remove", request(0x8000_0030 + n, app)), step("device", `REPLY ERROR ${code}`, refusal(0x8000_0030 + n, code, message, reason))],
  });
  const id = (name: string, json: Record<string, unknown>, accepted: boolean) => ({ name, json, hex: hex(encodeJsonFrame(LINK2_FRAME.request, 0x8000_0040, json)), accepted });
  return {
    installed: [home, map, notes],
    running,
    removed: [
      step("hub", "REQUEST runtime.remove", request(0x8000_0021, notes.id)),
      step("device", "REPLY, after the slot is deleted", encodeJsonFrame(LINK2_FRAME.reply, 0x8000_0021, { id: notes.id })),
      step("device", "EVENT runtime.apps: the set without the applet, under the one-a-second rule", encodeJsonFrame(LINK2_FRAME.event, 0, { t: "runtime.apps", set: 2, at: 0, apps: [home, map], more: false })),
    ],
    errors: [
      error(1, "the launcher, never removed", home.id, "rejected", "the launcher is never removed", "home"),
      error(2, "the running applet", running, "rejected", "the applet is running; switch to another one first", "running"),
      error(3, "an id no installed applet has", "dev.example.none", "not_found", "no installed applet has this id"),
      error(4, "an install of the applet streams or waits to commit", notes.id, "busy", "an install of this applet is under way"),
      error(5, "another state-changing request is open (a Hub that breaks §8.3)", notes.id, "busy", "a state-changing request is open"),
      error(6, "the slot could not be deleted", notes.id, "storage", "the applet's slot could not be deleted"),
      error(7, "the device does not list runtime.remove (a Hub that sends it anyway)", notes.id, "unsupported", "the group is not in use"),
    ],
    ids: [
      id("128 bytes", { t: "runtime.remove", id: fillText(128) }, true),
      id("129 bytes", { t: "runtime.remove", id: fillText(129) }, false),
      id("126 bytes and a quote: 127 bytes, 128 counted as encoded", { t: "runtime.remove", id: `${fillText(126)}"` }, true),
      id("127 bytes and a quote: 128 bytes, 129 counted as encoded", { t: "runtime.remove", id: `${fillText(127)}"` }, false),
      id("empty", { t: "runtime.remove", id: "" }, false),
      id("a number", { t: "runtime.remove", id: 7 }, false),
      id("no id", { t: "runtime.remove" }, false),
    ],
  };
}

/** A stream of `total` bytes from a sender whose receiver keeps `window`
 *  bytes of credit outstanding and regrants what it consumed. */
function creditedStream(from: "device" | "hub", id: number, total: number, window: number, limit: number) {
  const to = from === "hub" ? "device" : "hub";
  const steps: unknown[] = [];
  const credit = new SendCredit();
  let sent = 0;
  let granted = 0;
  const grant = (bytes: number) => {
    credit.grant(bytes);
    granted += bytes;
    steps.push({ from: to, what: "CREDIT", hex: hex(encodeCredit(id, bytes)) });
  };
  grant(Math.min(window, total));
  while (sent < total) {
    const n = credit.take(Math.min(limit, total - sent));
    sent += n;
    const end = sent === total;
    const frame = encodeData(id, new Uint8Array(n).fill(0x5a), end, limit);
    steps.push({ from, what: end ? "DATA with END" : "DATA", header: hex(frame.subarray(0, 12)), fill: "5a", bytes: n });
    // The receiver regrants what it consumed while more is to come.
    const due = Math.min(n, total - granted);
    if (due > 0) grant(due);
  }
  return steps;
}

function streams() {
  return {
    push: {
      bytes: 100_000,
      window: LINK2_WINDOW.bulk,
      limit: LINK2_TCP_PAYLOAD,
      steps: [
        { from: "hub", what: "REQUEST runtime.push", hex: hex(encodeJsonFrame(LINK2_FRAME.request, 0x8000_0003, { t: "runtime.push", bytes: 100_000, hash: "00000000000000bb" })) },
        ...creditedStream("hub", 0x8000_0003, 100_000, LINK2_WINDOW.bulk, LINK2_TCP_PAYLOAD),
      ],
    },
    pastCredit: { granted: 1000, data: 1001, close: "flow" },
    grantOver16MiB: { grants: [16 * 1024 * 1024, 1], close: "flow" },
    grantAt16MiB: { grants: [16 * 1024 * 1024], close: null },
    resetRefused: [
      { from: "hub", what: "EVENT agent.glyphs opening a stream", hex: hex(encodeJsonFrame(LINK2_FRAME.event, 0x8000_0005, { t: "agent.glyphs", stream: 0x8000_0005, bytes: 333_616 })) },
      { from: "device", what: "RESET refused", hex: hex(encodeReset(0x8000_0005, "refused")) },
    ],
    unknownEventWithFreshId: [
      { from: "hub", what: "EVENT of an unknown t on a fresh id", hex: hex(encodeJsonFrame(LINK2_FRAME.event, 0x8000_0007, { t: "agent.hologram", bytes: 10 })) },
      { from: "device", what: "RESET refused", hex: hex(encodeReset(0x8000_0007, "refused")) },
    ],
    shortOfDeclared: { declared: 100, sentBeforeEnd: 99, request: "transfer", eventStream: "length" },
    senderWithoutCredit: { waitsMs: 30_000, eventStream: hex(encodeReset(0x21, "cancelled")), devtools: "drop-line" },
  };
}

/** The response of 18,244 bytes of §7.8 as frames. The guest reads 16 KiB a
 *  frame (the per-frame hand-over); while its read is pending the device
 *  grants the stream's whole window, so the first CREDIT covers the response
 *  and the next ones return what each read took. */
function appletResponse(total: number, request: number) {
  const window = new AppletStreamWindow();
  const credit = new SendCredit();
  const steps: unknown[] = [];
  let sent = 0;
  let taken = 0;
  let guard = 0;
  while (taken < total && guard++ < 1000) {
    window.read(LINK2_APP_FRAME_STREAM);
    const grant = window.grant();
    if (grant > 0) {
      credit.grant(grant);
      steps.push({ from: "device", what: "CREDIT after the guest's read", hex: hex(encodeCredit(request, grant)) });
    }
    const n = credit.take(Math.min(LINK2_TCP_PAYLOAD, total - sent));
    if (n > 0) {
      sent += n;
      window.received(n);
      const frame = encodeData(request, new Uint8Array(n).fill(0x5a), sent === total);
      steps.push({ from: "hub", what: sent === total ? "DATA with END" : "DATA", header: hex(frame.subarray(0, 12)), fill: "5a", bytes: n });
    }
    taken += window.take(LINK2_APP_FRAME_STREAM);
  }
  return { steps, taken };
}

function channel() {
  const CHANNEL = 3;
  const limit = LINK2_TCP_PAYLOAD;
  const step = (from: "device" | "hub", what: string, bytes: Uint8Array) => ({ from, what, hex: hex(bytes) });
  const response = appletResponse(18_244, 9);
  const receiver = new EventReceiver(LINK2_APP_EVENT_WINDOW);
  const firstGrant = receiver.open();
  const cost600 = receiver.arrived(600);
  return {
    open: [
      step("device", "REQUEST channel.open, header id = the channel id", encodeJsonFrame(LINK2_FRAME.request, CHANNEL, { t: "channel.open", app: "dev.example.map", hash: "00000000000000cc" })),
      step("hub", "REPLY with generation 7", encodeJsonFrame(LINK2_FRAME.reply, CHANNEL, { generation: 7 })),
      step("hub", "CREDIT on the channel id: 256 units, queued after the REPLY", encodeCredit(CHANNEL, 256)),
      step("device", "CREDIT on the channel id: 48 units", encodeCredit(CHANNEL, firstGrant)),
    ],
    appletRequest: [
      step("device", "REQUEST APP", encodeJsonFrame(LINK2_FRAME.request, 4, { t: "tile.get", z: 12, x: 3301, y: 1612, have: "r41" }, { channel: CHANNEL })),
      step("hub", "REPLY", encodeJsonFrame(LINK2_FRAME.reply, 4, { same: true })),
    ],
    daemonRequest: [
      step("hub", "REQUEST APP", encodeJsonFrame(LINK2_FRAME.request, 0x8000_0002, { t: "view.get" }, { channel: CHANNEL })),
      step("device", "REPLY", encodeJsonFrame(LINK2_FRAME.reply, 0x8000_0002, { z: 12 })),
    ],
    events: [
      step("device", "EVENT APP, id 0", encodeJsonFrame(LINK2_FRAME.event, 0, { t: "view.moved", z: 12 }, { channel: CHANNEL })),
      step("hub", "EVENT APP, id 0", encodeJsonFrame(LINK2_FRAME.event, 0, { t: "tile.stale", z: 12 }, { channel: CHANNEL })),
    ],
    body: [
      step("device", "REQUEST APP with BODY", encodeJsonFrame(LINK2_FRAME.request, 6, { t: "note.put", bytes: 3 }, { channel: CHANNEL, body: true })),
      step("hub", "CREDIT for the body", encodeCredit(6, 3)),
      step("device", "DATA with END", encodeData(6, new Uint8Array([1, 2, 3]), true)),
      step("hub", "REPLY", encodeJsonFrame(LINK2_FRAME.reply, 6, { ok: true })),
    ],
    response: {
      bytes: 18_244,
      window: LINK2_APP_STREAM_WINDOW,
      steps: [
        step("device", "REQUEST APP tile.get", encodeJsonFrame(LINK2_FRAME.request, 9, { t: "tile.get", z: 12, x: 3301, y: 1612, have: "r41" }, { channel: CHANNEL })),
        step("hub", "EVENT tile.head on the request's id: the head step", encodeJsonFrame(LINK2_FRAME.event, 9, { t: "tile.head", rev: "r42", bytes: 18_244 })),
        ...response.steps,
        step("hub", "REPLY, the trailer", encodeJsonFrame(LINK2_FRAME.reply, 9, { rev: "r42" })),
      ],
    },
    progressNames: [
      step("hub", "progress named log: read as progress of request 9, never as the system event", encodeJsonFrame(LINK2_FRAME.event, 9, { t: "log", text: "decoding" })),
      step("hub", "progress named features", encodeJsonFrame(LINK2_FRAME.event, 9, { t: "features", features: [] })),
    ],
    lateProgress: {
      // The device closed the channel; the daemon's progress for device request 9 was already queued.
      frame: step("hub", "EVENT log on an id of the device's range that names nothing held", encodeJsonFrame(LINK2_FRAME.event, 9, { t: "log", text: "late" })),
      receiver: "device",
      reading: "ignore",
    },
    streamEvent: [
      step("hub", "EVENT APP that opens a stream", encodeJsonFrame(LINK2_FRAME.event, 0x8000_0011, { t: "log.tail" }, { channel: CHANNEL })),
      step("device", "RESET refused: no handler for log.tail", encodeReset(0x8000_0011, "refused")),
    ],
    sizes: [
      { payloadLimit: 16_384, appMessage: appMessageLimit(16_384) },
      { payloadLimit: 8192, appMessage: appMessageLimit(8192) },
      { payloadLimit: 1024, appMessage: appMessageLimit(1024) },
    ],
    tooLarge: [
      { name: "an object of 8,193 bytes on a 16,384 limit", payloadLimit: 16_384, objectBytes: 8193, refusedBy: "sender", answer: "too_large" },
      { name: "an object of 8,189 bytes on an 8,192 limit (LINK_APP_MSG 8,188)", payloadLimit: 8192, objectBytes: 8189, refusedBy: "sender", answer: "too_large" },
      { name: "an object of 8,188 bytes on an 8,192 limit", payloadLimit: 8192, objectBytes: 8188, refusedBy: null, answer: null },
    ],
    eventWindow: {
      deviceGrants: firstGrant,
      hubGrants: 256,
      costs: [
        { jsonBytes: 1, units: eventUnits(1) },
        { jsonBytes: 512, units: eventUnits(512) },
        { jsonBytes: 513, units: eventUnits(513) },
        { jsonBytes: 600, units: cost600 },
        { jsonBytes: 8192, units: eventUnits(8192) },
      ],
      afterOneOf600: receiver.granted,
      overflow: { granted: 1, eventJsonBytes: 600, answer: hex(encodeJsonFrame(LINK2_FRAME.event, CHANNEL, { t: "channel.close", reason: "overflow" })) },
    },
    noChannel: [
      step("device", "REQUEST APP for a channel that is not open", encodeJsonFrame(LINK2_FRAME.request, 30, { t: "tile.get" }, { channel: 29 })),
      step("hub", "REPLY ERROR no_channel", encodeJsonFrame(LINK2_FRAME.reply, 30, { code: "no_channel", message: "" }, { error: true })),
    ],
    close: [
      step("device", "EVENT channel.close reset, header id = the channel id", encodeJsonFrame(LINK2_FRAME.event, CHANNEL, { t: "channel.close", reason: "reset" })),
      step("device", "REQUEST channel.open for the new realm", encodeJsonFrame(LINK2_FRAME.request, 31, { t: "channel.open", app: "dev.example.map", hash: "00000000000000cc" })),
      step("hub", "REPLY with generation 8", encodeJsonFrame(LINK2_FRAME.reply, 31, { generation: 8 })),
    ],
    openRefusals: [
      { code: "no_daemon", retry: "not during this applet run", hex: hex(encodeJsonFrame(LINK2_FRAME.reply, CHANNEL, { code: "no_daemon", message: "" }, { error: true })) },
      { code: "busy", retryMs: [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000], hex: hex(encodeJsonFrame(LINK2_FRAME.reply, CHANNEL, { code: "busy", message: "" }, { error: true })) },
    ],
    limitNote: limit,
  };
}

function features() {
  const event = (list: string[]) => hex(encodeJsonFrame(LINK2_FRAME.event, 0, { t: "features", features: list }));
  return {
    valid: [
      { name: "Hub drops agent", list: ["runtime", "runtime.native", "runtime.remove", "devtools", "catalog", "install", "net.http", "channel", "apps"], hex: event(["runtime", "runtime.native", "runtime.remove", "devtools", "catalog", "install", "net.http", "channel", "apps"]) },
      { name: "16 entries of 24 bytes", list: Array.from({ length: 16 }, (_, i) => `${"f".repeat(22)}${i.toString().padStart(2, "0")}`), hex: event(Array.from({ length: 16 }, (_, i) => `${"f".repeat(22)}${i.toString().padStart(2, "0")}`)) },
      { name: "an empty list", list: [], hex: event([]) },
    ],
    protocol: [
      { name: "17 entries", json: { t: "features", features: Array.from({ length: 17 }, (_, i) => `f${i}`) } },
      { name: "an entry of 25 bytes", json: { t: "features", features: ["f".repeat(25)] } },
      { name: "no features array", json: { t: "features" } },
      { name: "an entry that is not a string", json: { t: "features", features: [1] } },
    ],
    inUse: [
      { device: ["runtime", "agent"], hub: ["runtime", "catalog"], inUse: ["runtime"] },
      { device: ["channel"], hub: [], inUse: [] },
    ],
    dropOrder: ["REPLY ERROR unsupported for the peer's open requests", "CANCEL for its own open requests", "RESET cancelled for streams of no request", "channel.close feature", "EVENT features"],
  };
}

function keepalive() {
  const ping = encodePing(41);
  return {
    ping: hex(ping),
    pong: hex(encodeRawFrame(LINK2_FRAME.pong, 0, 0, 0, ping.subarray(12))),
    pingMs: 3000,
    silenceMs: 10_000,
    timelines: [
      { name: "nothing arrives: silence at 10 s", received: [], until: 12_000, silenceAt: 10_000 },
      { name: "a 100 ms gap between frames changes nothing", received: [3000, 3100, 6000, 9000, 12_000], until: 12_000, silenceAt: null },
      { name: "DATA alone keeps the link up", received: [2000, 5000, 8000, 11_000, 14_000, 17_000, 20_000], until: 20_000, silenceAt: null },
      { name: "frames stop at 4 s: silence at 14 s", received: [1000, 4000], until: 20_000, silenceAt: 14_000 },
    ],
  };
}

function messages() {
  // hello and ready with every field at its limit.
  const helloAtLimits: Link2Hello = {
    t: "hello",
    device: FIXED.device,
    companion: FIXED.hub,
    nonce: FIXED.deviceNonce,
    name: fillText(64),
    model: fillText(32),
    target: fillText(15),
    hostAbi: 0xffff_ffff,
    features: Array.from({ length: 16 }, () => fillText(24)),
    maxPayload: 32_768,
  };
  const readyAtLimits: Link2Ready = {
    t: "ready",
    name: fillText(64),
    features: Array.from({ length: 16 }, () => fillText(24)),
    maxPayload: 32_768,
    clock: { utc: 9_999_999_999_999, local: 9_999_999_999_999 },
  };

  // net.http and net.head at their encoded limits: a 2 KiB URL, 32 headers
  // whose encoded object is 8 KiB.
  const headersAt = (bytes: number) => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < LINK2_HTTP_MAX_HEADERS; i++) headers[`x-header-${i.toString().padStart(2, "0")}`] = "";
    const free = bytes - jsonBytes(headers);
    const each = Math.floor(free / LINK2_HTTP_MAX_HEADERS);
    let i = 0;
    for (const name of Object.keys(headers)) {
      headers[name] = "v".repeat(each + (i === 0 ? free - each * LINK2_HTTP_MAX_HEADERS : 0));
      i++;
    }
    return headers;
  };
  const url = `https://example.com/${"p".repeat(LINK2_HTTP_URL_BYTES - 20)}`;
  const httpRequest = {
    t: "net.http",
    app: fillText(128),
    url,
    method: "OPTIONS",
    headers: headersAt(LINK2_HTTP_HEADERS_BYTES),
    timeoutMs: 120_000,
    maxBytes: 262_144,
    bytes: 65_536,
  };
  const httpHead = { t: "net.head", status: 200, url, headers: headersAt(LINK2_HTTP_HEADERS_BYTES), truncated: true };

  // log at the 1 KiB floor.
  const logAtFloor = { t: "log", level: "error", source: "guest", text: fillText(LINK2_MIN_PAYLOAD - LINK2_LOG_OVERHEAD), frame: 0xffff_ffff, dropped: 0xffff_ffff };

  // runtime.apps
  const ordinary: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `dev.pocket-nexus.applet-${i.toString().padStart(2, "0")}`, output: `applet-${i.toString().padStart(2, "0")}`, version: "1.0.0", hash: i.toString(16).padStart(16, "0") }));
  const atLimits: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `${i.toString().padStart(2, "0")}${fillText(126)}`, output: fillText(64), version: fillText(32), hash: i.toString(16).padStart(16, "0"), home: true }));
  const pagesOf = (rows: Link2InstalledApp[], set: number, limit: number) => pageRuntimeApps(rows, set, limit).map((page) => ({ at: page.at, rows: page.apps.length, more: page.more, bytes: jsonBytes(page) }));

  // catalog
  const offer: Link2CatalogApp[] = Array.from({ length: 70 }, (_, i) => ({ id: `dev.example.app-${(69 - i).toString().padStart(2, "0")}`, title: `App ${69 - i}`, version: "1.2.3", summary: "A summary of the applet.", output: `app-${69 - i}`, hash: i.toString(16).padStart(16, "0"), bytes: 400_000 + i }));
  const rowAtLimits: Link2CatalogApp = { id: fillText(128), title: fillText(64), version: fillText(32), summary: fillText(120), output: fillText(64), hash: "f".repeat(16), bytes: 24 * 1024 * 1024 };
  let now = 0;
  const pager = new CatalogPager(() => offer, () => now);
  const fetch: unknown[] = [];
  let answer = pager.request({}, LINK2_MIN_PAYLOAD);
  let pagesFetched = 0;
  let rowsFetched = 0;
  let firstId = "";
  let lastId = "";
  while ("reply" in answer) {
    pagesFetched++;
    rowsFetched += answer.reply.apps.length;
    if (firstId === "") firstId = answer.reply.apps[0].id;
    lastId = answer.reply.apps[answer.reply.apps.length - 1].id;
    if (!answer.reply.more) break;
    if (pagesFetched === 2) pager.changed(); // the offer changes mid-fetch: still served from the snapshot
    now += 1000;
    answer = pager.request({ after: lastId, rev: answer.reply.rev }, LINK2_MIN_PAYLOAD);
  }
  fetch.push({ payloadLimit: LINK2_MIN_PAYLOAD, pages: pagesFetched, rows: rowsFetched, firstId, lastId, offerChangedAfterPage: 2 });
  const late = new CatalogPager(() => offer, () => now);
  const first = late.request({}, LINK2_MIN_PAYLOAD) as { reply: { apps: Link2CatalogApp[]; rev: number } };
  now += 31_000;
  const lateAnswer = late.request({ after: first.reply.apps[first.reply.apps.length - 1].id, rev: first.reply.rev }, LINK2_MIN_PAYLOAD);

  return {
    handshake: {
      hello: { json: helloAtLimits, bytes: jsonBytes(helloAtLimits), limit: LINK2_MAX_HANDSHAKE },
      ready: { json: readyAtLimits, bytes: jsonBytes(readyAtLimits), limit: LINK2_MAX_HANDSHAKE },
    },
    http: {
      request: { json: httpRequest, bytes: jsonBytes(httpRequest), urlBytes: encodedBytes(url), headersBytes: jsonBytes(httpRequest.headers), fits: [LINK2_TCP_PAYLOAD, LINK2_HTTP_MIN_PAYLOAD] },
      head: { json: httpHead, bytes: jsonBytes(httpHead), fits: [LINK2_TCP_PAYLOAD, LINK2_HTTP_MIN_PAYLOAD] },
      minPayload: LINK2_HTTP_MIN_PAYLOAD,
      escaped: { text: `${"c".repeat(1799)}\n${"c".repeat(1799)}`, encodedBytes: encodedBytes(`${"c".repeat(1799)}\n${"c".repeat(1799)}`) },
    },
    log: { json: logAtFloor, bytes: jsonBytes(logAtFloor), limit: LINK2_MIN_PAYLOAD },
    runtimeApps: {
      ordinary: { rows: 64, tcp: pagesOf(ordinary, 1, LINK2_TCP_PAYLOAD) },
      atLimits: { rows: 64, rowBytes: jsonBytes(atLimits[0]), tcp: pagesOf(atLimits, 2, LINK2_TCP_PAYLOAD), floor: pagesOf(atLimits, 3, LINK2_MIN_PAYLOAD) },
      first: pageRuntimeApps(ordinary.slice(0, 2), 1, LINK2_TCP_PAYLOAD)[0],
      assembler: [
        { name: "a report in two pages", pages: [{ set: 1, at: 0, rows: 40, more: true }, { set: 1, at: 40, rows: 24, more: false }], complete: [null, 64] },
        { name: "cut short by a change and restarted under the next set", pages: [{ set: 1, at: 0, rows: 40, more: true }, { set: 2, at: 0, rows: 41, more: true }, { set: 1, at: 40, rows: 24, more: false }, { set: 2, at: 41, rows: 23, more: false }], complete: [null, null, null, 64] },
        { name: "a wrong at: the rest of that set is ignored", pages: [{ set: 1, at: 0, rows: 10, more: true }, { set: 1, at: 11, rows: 10, more: true }, { set: 1, at: 10, rows: 10, more: false }], complete: [null, null, null] },
        { name: "a page of an older set is ignored", pages: [{ set: 5, at: 0, rows: 3, more: false }, { set: 4, at: 0, rows: 9, more: false }], complete: [3, null] },
        { name: "a first page with at above 0 drops the set", pages: [{ set: 1, at: 5, rows: 5, more: false }, { set: 2, at: 0, rows: 2, more: false }], complete: [null, 2] },
      ],
    },
    catalog: {
      offered: 70,
      served: catalogRows(offer).length,
      firstServed: catalogRows(offer)[0].id,
      lastServed: catalogRows(offer)[63].id,
      rowAtLimits: { json: rowAtLimits, bytes: jsonBytes(rowAtLimits), pageBytes: jsonBytes({ apps: [rowAtLimits], rev: 0xffff_ffff, more: false }), fitsFloor: true },
      fetch,
      after31s: lateAnswer,
      unknownAfter: (() => {
        const p = new CatalogPager(() => offer, () => 0);
        const f = p.request({}, LINK2_TCP_PAYLOAD) as { reply: { rev: number } };
        return p.request({ after: "dev.example.none", rev: f.reply.rev }, LINK2_TCP_PAYLOAD);
      })(),
    },
  };
}

export function buildVectors(): Record<string, unknown> {
  return {
    "beacon.json": beacon(),
    "pairing-files.json": pairingFiles(),
    "preamble.json": preamble(),
    "frames.json": frames(),
    "handshake.json": handshake(),
    "handshake-refusals.json": handshakeRefusals(),
    "pair-by-code.json": pairByCode(),
    "requests.json": requests(),
    "streams.json": streams(),
    "channel.json": channel(),
    "features.json": features(),
    "keepalive.json": keepalive(),
    "messages.json": messages(),
  };
}

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (import.meta.main) {
  const check = process.argv.includes("--check");
  mkdirSync(VECTOR_DIR, { recursive: true });
  let drift = 0;
  for (const [name, value] of Object.entries(buildVectors())) {
    const path = join(VECTOR_DIR, name);
    const text = serialize(value);
    if (check) {
      let onDisk = "";
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {}
      if (onDisk !== text) {
        console.error(`drift: ${name}`);
        drift++;
      }
    } else {
      writeFileSync(path, text);
      console.log(`${name}  ${text.length} bytes`);
    }
  }
  if (drift > 0) process.exit(1);
}
