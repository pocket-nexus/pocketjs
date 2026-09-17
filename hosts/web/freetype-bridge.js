// Both memories belong to the text worker. No font object crosses to the UI.
export function createFreeTypeImports(ft, memory) {
  const temporary = (length, callback) => {
    const pointer = ft._malloc(Math.max(1, length));
    if (!pointer) throw Error("FreeType worker memory budget exceeded");
    try { return callback(pointer); } finally { ft._free(pointer); }
  };
  return {
    pocket_ft_face(pointer, length) {
      if (length <= 0 || length > 32 * 1024 * 1024) return 0;
      return temporary(length, target => {
        ft.HEAPU8.set(new Uint8Array(memory().buffer, pointer, length), target);
        return ft._pocket_ft_face(target, length);
      });
    },
    pocket_ft_drop(handle) { ft._pocket_ft_drop(handle); },
    pocket_ft_render(handle, size64, glyph, info) {
      return temporary(20, target => {
        const result = ft._pocket_ft_render(handle, size64, glyph, target);
        if (result === 0)
          new Uint8Array(memory().buffer, info, 20).set(ft.HEAPU8.subarray(target, target + 20));
        return result;
      });
    },
    pocket_ft_copy(handle, destination, capacity) {
      if (capacity < 0 || capacity > 256 * 256) return -1;
      return temporary(capacity, target => {
        const result = ft._pocket_ft_copy(handle, target, capacity);
        if (result >= 0 && result <= capacity)
          new Uint8Array(memory().buffer, destination, result).set(ft.HEAPU8.subarray(target, target + result));
        return result;
      });
    },
  };
}
