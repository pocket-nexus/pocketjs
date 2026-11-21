// NativeScript's NSData bridge wraps native storage. Copy both directions so
// no JS typed view outlives a runtime result or points outside its own window.
export function foundationCodec(native) {
  const get = (value, key) => value.objectForKey(key);
  const array = (value, convert = (item) => Number(item)) => {
    const result = [];
    for (let i = 0; i < value.count; i++) result.push(convert(value.objectAtIndex(i)));
    return result;
  };
  const bytes = (value) => new Uint8Array(native.bufferFromData(value)).slice();
  const named = (item, sprite) => {
    const value = { name: String(get(item, 'name')), handle: Number(get(item, 'handle')) };
    if (sprite) for (const key of ['frames', 'columns', 'step']) value[key] = Number(get(item, key));
    return value;
  };
  return {
    arguments(args) {
      return native.array(args.map(({ kind, value }) => native.dictionary({ kind,
        value: kind === 'bytes' ? native.data(value.slice().buffer) : native.number(value),
      })));
    },
    result(result) {
      const error = get(result, 'error');
      if (error != null) return { error: String(error) };
      const kind = String(get(result, 'kind'));
      const value = get(result, 'value');
      return kind === 'none' ? { kind } : { kind, value: kind === 'bytes' ? bytes(value) : Number(value) };
    },
    environment(value) {
      const viewport = get(value, 'viewport');
      return {
        host: String(get(value, 'host')), hostAbi: Number(get(value, 'hostAbi')),
        tickHz: Number(get(value, 'tickHz')), rasterDensity: Number(get(value, 'rasterDensity')),
        viewport: { w: Number(get(viewport, 'w')), h: Number(get(viewport, 'h')) },
        pak: bytes(get(value, 'pak')),
        textures: array(get(value, 'textures'), (item) => named(item, false)),
        sprites: array(get(value, 'sprites'), (item) => named(item, true)),
      };
    },
    frame(value) {
      return {
        buttons: Number(get(value, 'buttons')), analog: Number(get(value, 'analog')),
        rightAnalog: Number(get(value, 'rightAnalog')),
        touches: array(get(value, 'touches')), hits: array(get(value, 'hits')), surfaces: array(get(value, 'surfaces')),
      };
    },
  };
}
