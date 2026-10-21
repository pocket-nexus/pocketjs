import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generatedGuestWebBindings } from "../tools/guest-web-bindings.ts";
import { mountUi, encodeUiString, decodeUiString, POCKET_BINDING_GENERATION } from "../engine/guest-web/src/generated-ui.js";
import { POCKET_BINDING_GENERATION as SPEC_GENERATION } from "../contracts/spec/binding-generation.ts";

const environment = { host: "fixture", hostAbi: POCKET_BINDING_GENERATION, tickHz: 60, viewport: { w: 4, h: 4 }, rasterDensity: 1 };
test("web guest binding output follows the canonical operation descriptors", () => {
  expect(POCKET_BINDING_GENERATION).toBe(SPEC_GENERATION);
  expect(readFileSync(new URL("../platforms/web/generated-ui.js", import.meta.url), "utf8")).toBe(generatedGuestWebBindings());
  expect(readFileSync(new URL("../engine/guest-web/src/generated-ui.js", import.meta.url), "utf8")).toBe(generatedGuestWebBindings());
});
test("unsupported generations fail before transport queries or realm mutation and permit retry", () => {
  const global: any = {};
  let queries = 0, calls = 0;
  const transport = { supportsOp: () => { queries++; return true; }, dispatch() { calls++; return { kind: "integer" as const, value: 7 }; } };
  const rejected = [...Array.from({ length: 12 }, (_, i) => i), POCKET_BINDING_GENERATION + 1, 0xffffffff, undefined, null, NaN, Infinity, String(POCKET_BINDING_GENERATION)];
  for (const hostAbi of rejected) {
    expect(() => mountUi(transport, { ...environment, hostAbi, pak: new Uint8Array([1]) } as any, global)).toThrow("Unsupported UI binding generation");
    expect(queries).toBe(0);
    expect(calls).toBe(0);
    expect(Reflect.ownKeys(global)).toEqual([]);
  }
  let reads = 0;
  const guest = mountUi(transport, { ...environment, get hostAbi() { reads++; return reads === 1 ? POCKET_BINDING_GENERATION : 0; } }, global);
  expect(reads).toBe(1);
  expect(guest.ui.__hostAbi).toBe(POCKET_BINDING_GENERATION);
  expect(guest.ui.createNode(0)).toBe(7);
  guest.dispose();
});
test("web binding converts before byte borrowing and keeps typed array slice boundaries", () => {
  const calls: any[] = [], global: any = {};
  const guest = mountUi({ supportsOp: () => true, dispatch(op: number, args: any[]) { calls.push([op, args]); return { kind: "integer", value: 7 }; } }, environment, global);
  const backing = new Uint8Array([1, 2, 3, 4]);
  const width = { valueOf() { guest.ui.createNode(1); backing[1] = 9; return 2; } };
  expect(guest.ui.uploadTexture(backing.subarray(1, 3), width, 1, 3)).toBe(7);
  expect(calls.map(call => call[0])).toEqual([1, 9]);
  expect([...calls[1][1][0].value]).toEqual([9, 3]);
  expect(guest.ui.createNode.length).toBe(1);
  expect(() => guest.ui.createNode()).toThrow("missing UI argument");
  expect(() => guest.ui.createNode(1n)).toThrow();
  expect(() => guest.ui.uploadTexture({}, 1, 1, 3)).toThrow("ArrayBuffer");
  expect(guest.ui.createNode(-1)).toBe(7);
  expect(calls.at(-1)[1][0].value).toBe(0xffffffff);
});
test("web string and byte results match canonical guest conversion", () => {
  const global: any = {};
  const source = new Uint8Array([0, 1, 0, 0, 0, 255, 0, 0, 0]);
  const guest = mountUi({ supportsOp: () => true, dispatch(op: number) {
    if (op === 43) return { kind: "bytes", value: source.subarray(1) };
    if (op === 55) return { kind: "bytes", value: source.subarray(1) };
    return { kind: "bytes", value: encodeUiString("中文🙂") };
  } }, environment, global);
  expect(guest.ui.wrapText("abc", 0, 8)).toEqual([1, 255]);
  const copied = new Uint8Array(guest.ui.physicsEvents());
  source.fill(0);
  expect(copied[0]).toBe(1);
  expect(guest.ui.takeAnimationCompletions()).toBe("中文🙂");
  expect(decodeUiString(encodeUiString("\ud800"))).toBe("\ufffd\ufffd\ufffd");
  expect(() => decodeUiString(new Uint8Array([0xc0, 0x80]))).toThrow("UTF-8");
  expect(() => decodeUiString(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow("UTF-8");
  expect(() => guest.ui.setText(1, Symbol())).toThrow();
});
test("mount owns package bytes and invalidates retained functions at shutdown", () => {
  const global: any = {}, pak = new Uint8Array([1, 2]);
  let calls = 0;
  const guest = mountUi({ supportsOp: (op: number) => op === 1, dispatch() { calls++; return { kind: "integer", value: 1 }; } }, { ...environment, pak, textures: [{ name: "__proto__", handle: 9 }], sprites: [] }, global);
  pak.fill(0);
  expect([...new Uint8Array(global.__pak)]).toEqual([1, 2]);
  expect(global.ui.__textures.__proto__).toBe(9);
  expect(global.ui.svcSend).toBeUndefined();
  const create = guest.ui.createNode;
  expect(() => create({ valueOf() { guest.dispose(); return 1; } })).toThrow("shut down");
  expect(calls).toBe(0);
  expect(() => create(1)).toThrow("shut down");
  expect(global.ui).toBeUndefined();
  expect(global.__pak).toBeUndefined();
});
