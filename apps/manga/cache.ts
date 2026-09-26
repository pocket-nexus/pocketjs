/** An LRU bounded by both retained bytes and entry count. */
export function boundedCache<K, V>(maxEntries: number, maxBytes: number) {
  if (![maxEntries, maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw Error("Invalid cache budget");
  const entries = new Map<K, { value: V; bytes: number }>();
  let bytes = 0, hits = 0, misses = 0, evictions = 0;
  const remove = (key: K) => {
    const item = entries.get(key);
    if (item) { bytes -= item.bytes; entries.delete(key); }
  };
  return {
    get(key: K): V | undefined {
      const item = entries.get(key);
      if (!item) { misses++; return; }
      hits++; entries.delete(key); entries.set(key, item); return item.value;
    },
    set(key: K, value: V, cost: number) {
      if (!Number.isSafeInteger(cost) || cost < 0) throw Error("Invalid cache entry size");
      remove(key);
      if (cost > maxBytes) return;
      while (entries.size >= maxEntries || bytes + cost > maxBytes) { remove(entries.keys().next().value!); evictions++; }
      entries.set(key, { value, bytes: cost }); bytes += cost;
    },
    delete: remove,
    deleteWhere(predicate: (key: K) => boolean) { for (const key of entries.keys()) if (predicate(key)) remove(key); },
    clear() { entries.clear(); bytes = 0; },
    stats: () => ({ entries: entries.size, bytes, hits, misses, evictions, maxEntries, maxBytes }),
  };
}
