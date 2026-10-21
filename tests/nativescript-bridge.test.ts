import { afterEach, describe, expect, test } from 'bun:test';
import { mountUi } from '../engine/guest-web/src/generated-ui.js';
import { attachGuest } from '../hosts/ios-nativescript/pocketjs/guest.js';
import { foundationCodec } from '../hosts/ios-nativescript/pocketjs/codec.js';

class Dict {
  constructor(readonly values: Record<string, any>) {}
  objectForKey(key: string) { return this.values[key] ?? null; }
}
class List {
  constructor(readonly values: any[]) {}
  get count() { return this.values.length; }
  objectAtIndex(index: number) { return this.values[index]; }
}
const codec = foundationCodec({
  bufferFromData: (value: ArrayBuffer) => value,
  data: (value: ArrayBuffer) => value,
  number: (value: number) => value,
  array: (values: any[]) => new List(values),
  dictionary: (values: Record<string, any>) => new Dict(values),
});
function environment(pak = new Uint8Array([1, 2]).buffer) {
  return new Dict({ host: 'ios-dev', hostAbi: 7, tickHz: 120, rasterDensity: 2,
    viewport: new Dict({ w: 16, h: 12 }), pak, textures: new List([]), sprites: new List([]) });
}
const globals = globalThis as any;
afterEach(() => { delete globals.ui; delete globals.__pak; delete globals.frame; delete globals.observedFrame; });

describe('NativeScript canonical guest bridge', () => {
  test('owns exact byte windows and copies borrowed results', () => {
    const all = new Uint8Array([99, 1, 2, 88]);
    const args = codec.arguments([{ kind: 'bytes', value: all.subarray(1, 3) }]);
    const data = args.objectAtIndex(0).objectForKey('value');
    all.fill(77);
    expect(Array.from(new Uint8Array(data))).toEqual([1, 2]);
    const result = codec.result(new Dict({ kind: 'bytes', value: data }));
    new Uint8Array(data).fill(66);
    expect(Array.from(result.value)).toEqual([1, 2]);
    expect(codec.result(new Dict({ error: 'rejected' }))).toEqual({ error: 'rejected' });
  });
  test('generated operations and canonical frame facts share one transport', () => {
    const calls: any[] = [], errors: unknown[] = [];
    const view: any = {
      supportsOperation: (op: number) => [1, 9, 31, 43].includes(op),
      dispatchOperationArguments(op: number, args: List) {
        calls.push([op, args]);
        return new Dict({ kind: op === 31 ? 'none' : 'integer', value: 17 });
      },
    };
    attachGuest(view, codec, (error: unknown) => errors.push(error), mountUi);
    const pak = new Uint8Array([1, 2]);
    expect(view.onGuestInitialize(environment(pak.buffer))).toBe(true);
    pak.fill(9);
    expect(Array.from(new Uint8Array(globals.__pak))).toEqual([1, 2]);
    expect(globals.ui.__tickHz).toBe(120);
    expect(globals.ui.createNode(1)).toBe(17);
    expect(globals.ui.uploadTexture(new Uint8Array([8, 9, 10]).subarray(1), 1, 1, 4)).toBe(17);
    expect(Array.from(new Uint8Array(calls[1][1].objectAtIndex(0).objectForKey('value')))).toEqual([9, 10]);
    expect(globals.ui.svcPoll()).toBeUndefined();
    expect(globals.ui.appLaunch).toBeUndefined();
    expect(view.onGuestEvaluate('globalThis.frame=(...args)=>{globalThis.observedFrame=args}')).toBe(true);
    expect(view.onGuestFrame(new Dict({ buttons: 4, analog: 0x8080, rightAnalog: 0x807f,
      touches: new List([0xc0000001]), hits: new List([17]), surfaces: new List([0]) }))).toBe(true);
    expect(globals.observedFrame).toEqual([4, 0x8080, [0xc0000001], [17], [0], 0x807f, [], undefined]);
    const retained = globals.ui.createNode;
    view.onGuestShutdown();
    expect(() => retained(1)).toThrow('shut down');
    expect(globals.ui).toBeUndefined();
    expect(globals.frame).toBeUndefined();
    expect(errors).toEqual([]);
  });
  test('failed evaluation removes partially installed callbacks and can retry', () => {
    const errors: unknown[] = [];
    const view: any = { supportsOperation: () => false };
    attachGuest(view, codec, (error: unknown) => errors.push(error), mountUi);
    expect(view.onGuestInitialize(environment())).toBe(true);
    expect(view.onGuestEvaluate('globalThis.frame=()=>{};throw Error("failed boot")')).toBe(false);
    view.onGuestShutdown();
    expect(globals.frame).toBeUndefined();
    expect(view.onGuestInitialize(environment())).toBe(true);
    expect(view.onGuestEvaluate('globalThis.frame=()=>{throw Error("failed frame")}')).toBe(true);
    expect(view.onGuestFrame(new Dict({ buttons:0, analog:0x8080, rightAnalog:0x8080,
      touches:new List([]), hits:new List([]), surfaces:new List([]) }))).toBe(false);
    view.onGuestShutdown();
    expect(errors).toHaveLength(2);
  });
});
