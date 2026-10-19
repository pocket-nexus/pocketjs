// The socket-free half of the 3DS Pocket Link client (hosts/3ds/src/
// link_proto.c, sha256.c, jscan.c) and the vendored QR decoder, compiled for
// the build machine and checked against the contract (contracts/spec/link.ts)
// and the companion's own codec (tools/companion/protocol.ts, qr.ts): the
// console and the companion must compute the same proofs, read the same
// pairing URI and beacon, and the console must decode the code the companion
// shows.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as LINK from "../contracts/spec/link.ts";
import {
  buildPairUri,
  companionProof,
  consoleProof,
  encodeBeacon,
  maskKey,
} from "../tools/companion/protocol.ts";
import { encodeQr, rasterizeQr } from "../tools/companion/qr.ts";

const root = resolve(import.meta.dir, "..");
const src = join(root, "hosts/3ds/src");

// argv-driven probe: one command per run, one result line on stdout.
const HARNESS = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sha256.h"
#include "link_proto.h"
#include "jscan.h"
#include "quirc/quirc.h"

static void print_hex(const uint8_t *bytes, size_t length) {
  char out[256];
  hex_encode(bytes, length, out);
  puts(out);
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  const char *command = argv[1];
  if (strcmp(command, "sha256") == 0) {
    uint8_t digest[32];
    sha256(argv[2], strlen(argv[2]), digest);
    print_hex(digest, 32);
  } else if (strcmp(command, "hmac") == 0) {
    uint8_t key[128], digest[32];
    size_t key_length = strlen(argv[2]) / 2;
    if (!hex_decode(argv[2], strlen(argv[2]), key, key_length)) return 3;
    HmacSha256 hmac;
    hmac_sha256_init(&hmac, key, key_length);
    hmac_sha256_update(&hmac, argv[3], strlen(argv[3]));
    hmac_sha256_final(&hmac, digest);
    print_hex(digest, 32);
  } else if (strcmp(command, "slot") == 0) {
    char slot[17];
    sha256_slot(argv[2], strlen(argv[2]), slot);
    puts(slot);
  } else if (strcmp(command, "proof") == 0) {
    /* proof <secretHex> companion|console nD nC device companion */
    uint8_t secret[64], digest[32];
    size_t secret_length = strlen(argv[2]) / 2;
    if (!hex_decode(argv[2], strlen(argv[2]), secret, secret_length)) return 3;
    const char *label = strcmp(argv[3], "companion") == 0 ? LINK_LABEL_COMPANION : LINK_LABEL_CONSOLE;
    link_proof(secret, secret_length, label, argv[4], argv[5], argv[6], argv[7], digest);
    print_hex(digest, 32);
  } else if (strcmp(command, "unmask") == 0) {
    /* unmask <secretHex> nD nC <maskedKeyHex> */
    uint8_t secret[64], mask[32], key[32];
    size_t secret_length = strlen(argv[2]) / 2;
    if (!hex_decode(argv[2], strlen(argv[2]), secret, secret_length)) return 3;
    if (!hex_decode(argv[5], strlen(argv[5]), key, 32)) return 3;
    link_key_mask(secret, secret_length, argv[3], argv[4], mask);
    for (int i = 0; i < 32; i += 1) key[i] ^= mask[i];
    print_hex(key, 32);
  } else if (strcmp(command, "uri") == 0) {
    LinkPairUri uri;
    if (!link_parse_pair_uri(argv[2], strlen(argv[2]), &uri)) {
      puts("invalid");
      return 0;
    }
    char secret[64];
    hex_encode(uri.secret, sizeof uri.secret, secret);
    printf("%s|%s|%u|%s|%zu", uri.companion, uri.name, (unsigned)uri.port, secret, uri.host_count);
    for (size_t i = 0; i < uri.host_count; i += 1) printf("|%s", uri.hosts[i]);
    puts("");
  } else if (strcmp(command, "beacon") == 0) {
    uint8_t datagram[128];
    size_t length = strlen(argv[2]) / 2;
    if (!hex_decode(argv[2], strlen(argv[2]), datagram, length)) return 3;
    LinkBeacon beacon;
    if (!link_parse_beacon(datagram, length, &beacon)) {
      puts("invalid");
      return 0;
    }
    printf("%u|%u|%s|%s\n", (unsigned)beacon.flags, (unsigned)beacon.port, beacon.companion, beacon.name);
  } else if (strcmp(command, "json") == 0) {
    /* json <document> <key>[.<key>…] -> string or u64 value */
    JsonSpan span = json_span(argv[2], strlen(argv[2]));
    char path[256];
    snprintf(path, sizeof path, "%s", argv[3]);
    char *saveptr = NULL;
    for (char *key = strtok_r(path, ".", &saveptr); key != NULL; key = strtok_r(NULL, ".", &saveptr)) {
      if (!json_find(span, key, &span)) {
        puts("missing");
        return 0;
      }
    }
    char text[512];
    uint64_t number = 0;
    if (json_string(span, text, sizeof text)) puts(text);
    else if (json_u64(span, &number)) printf("%llu\n", (unsigned long long)number);
    else printf("raw:%.*s\n", (int)span.length, span.start);
  } else if (strcmp(command, "write") == 0) {
    JsonBuffer out = { 0 };
    jbuf_text(&out, "{\"s\":");
    jbuf_cstring(&out, argv[2]);
    jbuf_text(&out, "}");
    puts(jbuf_cstr(&out));
    jbuf_free(&out);
  } else if (strcmp(command, "qr") == 0) {
    /* qr <gray8 file> <width> <height> */
    int width = atoi(argv[3]), height = atoi(argv[4]);
    FILE *file = fopen(argv[2], "rb");
    if (file == NULL) return 3;
    struct quirc *decoder = quirc_new();
    if (decoder == NULL || quirc_resize(decoder, width, height) < 0) return 4;
    uint8_t *image = quirc_begin(decoder, NULL, NULL);
    if (fread(image, 1, (size_t)width * height, file) != (size_t)width * height) return 5;
    fclose(file);
    quirc_end(decoder);
    for (int i = 0; i < quirc_count(decoder); i += 1) {
      struct quirc_code code;
      struct quirc_data data;
      quirc_extract(decoder, i, &code);
      if (quirc_decode(&code, &data) == QUIRC_SUCCESS) {
        printf("%.*s\n", data.payload_len, (const char *)data.payload);
        quirc_destroy(decoder);
        return 0;
      }
    }
    puts("none");
    quirc_destroy(decoder);
  } else {
    return 2;
  }
  return 0;
}
`;

let scratch = "";
let binary = "";

function run(...args: string[]): string {
  const result = Bun.spawnSync([binary, ...args]);
  if (result.exitCode !== 0) throw new Error(`harness ${args[0]} exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString().replace(/\n$/, "");
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pocket-3ds-link-"));
  binary = join(scratch, "harness");
  writeFileSync(join(scratch, "harness.c"), HARNESS);
  const compile = Bun.spawnSync([
    "cc", "-std=gnu11", "-O1", "-Wall", "-Wextra", "-fsanitize=address,undefined",
    `-I${src}`, join(scratch, "harness.c"),
    join(src, "sha256.c"), join(src, "link_proto.c"), join(src, "jscan.c"),
    join(src, "quirc/quirc.c"), join(src, "quirc/decode.c"), join(src, "quirc/identify.c"),
    join(src, "quirc/version_db.c"), "-lm", "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("3DS Pocket Link wire facts", () => {
  test("link_proto.h constants match contracts/spec/link.ts", () => {
    const header = readFileSync(join(src, "link_proto.h"), "utf8");
    // Each value is a literal or a product of literals, e.g. (32u * 1024u).
    const define = (name: string) => {
      const match = header.match(new RegExp(`#define ${name} ([^\\n/]+)`));
      if (!match) throw new Error(`no #define ${name}`);
      const factors = match[1].replace(/[()\s]/g, "").split("*");
      return factors.reduce((product, factor) => product * Number(factor.replace(/u$/, "")), 1);
    };
    expect(define("LINK_BEACON_PORT")).toBe(LINK.LINK_BEACON_PORT);
    expect(define("LINK_PORT")).toBe(LINK.LINK_PORT);
    expect(define("LINK_BEACON_MAGIC")).toBe(LINK.LINK_BEACON_MAGIC);
    expect(define("LINK_BEACON_BYTES")).toBe(LINK.LINK_BEACON_BYTES);
    expect(define("LINK_BEACON_NAME_BYTES")).toBe(LINK.LINK_BEACON_NAME_BYTES);
    expect(define("LINK_MAGIC")).toBe(LINK.LINK_MAGIC);
    expect(define("LINK_VERSION")).toBe(LINK.LINK_VERSION);
    expect(define("LINK_PREAMBLE_BYTES")).toBe(LINK.LINK_PREAMBLE_BYTES);
    expect(define("LINK_HEADER_BYTES")).toBe(LINK.LINK_HEADER_BYTES);
    expect(define("LINK_FRAME_PING")).toBe(LINK.LINK_FRAME.ping);
    expect(define("LINK_FRAME_PONG")).toBe(LINK.LINK_FRAME.pong);
    expect(define("LINK_FRAME_CTRL")).toBe(LINK.LINK_FRAME.ctrl);
    expect(define("LINK_FRAME_DATA")).toBe(LINK.LINK_FRAME.data);
    expect(define("LINK_MAX_CTRL")).toBe(LINK.LINK_MAX_CTRL);
    expect(define("LINK_MAX_DATA")).toBe(LINK.LINK_MAX_DATA);
    expect(define("LINK_PING_MS")).toBe(LINK.LINK_PING_MS);
    expect(define("LINK_SILENCE_MS")).toBe(LINK.LINK_SILENCE_MS);
    expect(define("LINK_CONNECT_TIMEOUT_MS")).toBe(LINK.LINK_CONNECT_TIMEOUT_MS);
    expect(define("LINK_HANDSHAKE_TIMEOUT_MS")).toBe(LINK.LINK_HANDSHAKE_TIMEOUT_MS);
    expect(define("LINK_KEY_BYTES")).toBe(LINK.LINK_KEY_BYTES);
    expect(define("LINK_NONCE_BYTES")).toBe(LINK.LINK_NONCE_BYTES);
    expect(define("LINK_ID_HEX")).toBe(LINK.LINK_ID_HEX);
    expect(define("LINK_PAIR_SECRET_BYTES")).toBe(LINK.LINK_PAIR_SECRET_BYTES);
    expect(define("LINK_PAIR_MAX_HOSTS")).toBe(LINK.LINK_PAIR_MAX_HOSTS);
    expect(define("LINK_INSTALL_MAX_BYTES")).toBe(LINK.LINK_INSTALL_MAX_BYTES);
    expect(define("LINK_MAX_REQUESTS")).toBe(LINK.LINK_MAX_REQUESTS);
    expect(header).toContain(`#define LINK_LABEL_COMPANION "${LINK.LINK_LABEL.companion}"`);
    expect(header).toContain(`#define LINK_LABEL_CONSOLE "${LINK.LINK_LABEL.console}"`);
    expect(header).toContain(`#define LINK_LABEL_KEY "${LINK.LINK_LABEL.key}"`);
  });

  test("SHA-256, HMAC-SHA256 and the runtime slot match node:crypto", () => {
    for (const text of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)]) {
      expect(run("sha256", text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
    for (const keyBytes of [16, 32, 64, 100]) {
      const key = randomBytes(keyBytes);
      const message = `pocket-link/1/console\n${randomBytes(16).toString("hex")}`;
      expect(run("hmac", key.toString("hex"), message)).toBe(
        createHmac("sha256", key).update(message).digest("hex"),
      );
    }
    // The Rust core derives the same slot in pocket_package_open.
    expect(run("slot", "dev.pocket-nexus.nexus")).toBe("ee37e3d6eb757504");
    expect(run("slot", "dev.pocket-nexus.home")).toBe(
      createHash("sha256").update("dev.pocket-nexus.home").digest("hex").slice(0, 16),
    );
  });

  test("handshake proofs and the masked key agree with the companion", () => {
    for (const secretBytes of [LINK.LINK_PAIR_SECRET_BYTES, LINK.LINK_KEY_BYTES]) {
      const secret = randomBytes(secretBytes).toString("hex");
      const h = {
        nD: randomBytes(16).toString("hex"),
        nC: randomBytes(16).toString("hex"),
        device: randomBytes(8).toString("hex"),
        companion: randomBytes(8).toString("hex"),
      };
      expect(run("proof", secret, "companion", h.nD, h.nC, h.device, h.companion)).toBe(companionProof(secret, h));
      expect(run("proof", secret, "console", h.nD, h.nC, h.device, h.companion)).toBe(consoleProof(secret, h));
      const key = randomBytes(32).toString("hex");
      expect(run("unmask", secret, h.nD, h.nC, maskKey(key, secret, h.nD, h.nC))).toBe(key);
    }
  });

  test("reads the companion's pairing URI and refuses malformed ones", () => {
    const secret = randomBytes(16).toString("hex");
    const uri = buildPairUri({
      companion: "197eb66ee556b70b",
      hosts: ["192.168.8.159", "10.0.0.2"],
      port: 8628,
      secret,
      name: "Evan's MacBook Pro",
    });
    expect(uri.length).toBeLessThanOrEqual(LINK.LINK_PAIR_URI_MAX);
    expect(run("uri", uri)).toBe(
      `197eb66ee556b70b|Evan's MacBook Pro|8628|${secret}|2|192.168.8.159|10.0.0.2`,
    );
    expect(run("uri", `${uri}\n`)).not.toBe("invalid");
    expect(run("uri", uri.replace("v=1", "v=2"))).toBe("invalid");
    expect(run("uri", uri.replace(secret, secret.slice(2)))).toBe("invalid");
    expect(run("uri", uri.replace("192.168.8.159", "192.168.8.999"))).toBe("invalid");
    expect(run("uri", uri.replace("pocketlink://pair?", "https://pair?"))).toBe("invalid");
    expect(run("uri", uri.replace("&p=8628", ""))).toBe("invalid");
  });

  test("reads the companion's beacon", () => {
    const beacon = encodeBeacon({ pairing: true, port: 8638, companion: "197eb66ee556b70b", name: "Studio Mac" });
    expect(run("beacon", Buffer.from(beacon).toString("hex"))).toBe("1|8638|197eb66ee556b70b|Studio Mac");
    const short = Buffer.from(beacon.subarray(0, 40)).toString("hex");
    expect(run("beacon", short)).toBe("invalid");
    const wrong = Buffer.from(beacon);
    wrong[0] ^= 1;
    expect(run("beacon", wrong.toString("hex"))).toBe("invalid");
  });

  test("the bounded JSON reader finds members, unescapes and survives malformed input", () => {
    const doc = JSON.stringify({
      t: "net.head",
      id: 7,
      headers: { "content-type": "text/html", x: "a}b{c\"d" },
      app: { id: "dev.pocket-nexus.hn", title: "Hacker News ☃ 😀", output: "hn-main" },
      bytes: 4096,
    });
    expect(run("json", doc, "t")).toBe("net.head");
    expect(run("json", doc, "id")).toBe("7");
    expect(run("json", doc, "bytes")).toBe("4096");
    expect(run("json", doc, "headers.x")).toBe('a}b{c"d');
    expect(run("json", doc, "app.title")).toBe("Hacker News ☃ 😀");
    expect(run("json", doc, "app.output")).toBe("hn-main");
    expect(run("json", doc, "app.missing")).toBe("missing");
    expect(run("json", '{"a":"\\u00e9\\ud83d\\ude00"}', "a")).toBe("é😀");
    expect(run("json", '{"a":[1,{"b":2}],"c":3}', "c")).toBe("3");
    // The reader validates the document up to the member it returns.
    for (const bad of ['{"a":', '{"a" 1}', '{"a":"x', "[1,2]", '{"b":1,}', "{{{{", '{"b":[}],"a":1}']) {
      expect(run("json", bad, "a")).toBe("missing");
    }
    const tricky = 'quote " slash \\ newline \n tab \t bell \u0007 é';
    expect(JSON.parse(run("write", tricky))).toEqual({ s: tricky });
  });

  test("the vendored quirc decodes the companion's pairing code at camera size", () => {
    const uri = buildPairUri({
      companion: "197eb66ee556b70b",
      hosts: ["192.168.8.159", "192.168.8.158", "10.0.0.2"],
      port: 8628,
      secret: randomBytes(16).toString("hex"),
      name: "Evan's MacBook Pro",
    });
    const raster = rasterizeQr(encodeQr(uri), 4, 4);
    // Centre it in a mid-grey 320x240 frame, as the outer camera delivers.
    const width = 320, height = 240;
    const frame = new Uint8Array(width * height).fill(128);
    const left = (width - raster.width) >> 1, top = (height - raster.width) >> 1;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    for (let y = 0; y < raster.width; y++) {
      frame.set(raster.pixels.subarray(y * raster.width, (y + 1) * raster.width), (top + y) * width + left);
    }
    const path = join(scratch, "frame.gray");
    writeFileSync(path, frame);
    expect(run("qr", path, String(width), String(height))).toBe(uri);
  });
});
