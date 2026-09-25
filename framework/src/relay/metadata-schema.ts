/** Validator for the strict JSON Schemas attached to relay control metadata.
 *
 * `RELAY_METADATA_SCHEMAS` in contracts/spec/relay.ts uses a small fixed
 * subset of JSON Schema; this file implements exactly that subset, so the
 * session layer never pulls in a generic schema dependency. The custom
 * `maxBytes` keyword counts UTF-8 bytes (TextEncoder), not UTF-16 code
 * units — every relay string bound is a wire-byte bound. */

type Schema = Record<string, unknown>;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function failAt(path: string, message: string): string {
  return path ? `${path}: ${message}` : message;
}

/** Returns null when `value` satisfies `schema`, or a fixed reason string
 * naming the first violated rule. */
export function validateRelaySchema(schema: Schema, value: unknown, path = ""): string | null {
  const expected = schema.type;
  if (typeof expected === "string") {
    const actual = typeOf(value);
    if (expected === "integer") {
      if (actual !== "number" || !Number.isSafeInteger(value as number)) {
        return failAt(path, "expected safe integer");
      }
    } else if (actual !== expected) {
      return failAt(path, `expected ${expected}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return failAt(path, `below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) return failAt(path, `above ${schema.maximum}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return failAt(path, `shorter than ${schema.minLength} chars`);
    }
    if (typeof schema.maxBytes === "number" && utf8Length(value) > schema.maxBytes) {
      return failAt(path, `over ${schema.maxBytes} UTF-8 bytes`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      return failAt(path, `does not match ${schema.pattern}`);
    }
  }

  if ("const" in schema && value !== schema.const) return failAt(path, "const mismatch");
  if (schema.not && typeof schema.not === "object") {
    if (validateRelaySchema(schema.not as Schema, value, path) === null) return failAt(path, "matched excluded schema");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
    return failAt(path, "not in enum");
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return failAt(path, `fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return failAt(path, `more than ${schema.maxItems} items`);
    }
    if (Array.isArray(schema.items)) {
      // Tuple: positions must match item schemas; additionalItems:false
      // forbids any extra position.
      for (let i = 0; i < schema.items.length; i++) {
        const err = validateRelaySchema(schema.items[i] as Schema, value[i], `${path}[${i}]`);
        if (err) return err;
      }
      if (schema.additionalItems === false && value.length > schema.items.length) {
        return failAt(path, "tuple has extra items");
      }
    } else if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i++) {
        const err = validateRelaySchema(schema.items as Schema, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) return failAt(path, `missing ${key}`);
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      // Own properties only: `props` is a plain object, so `key in props`
      // would resolve `constructor`/`__proto__` and other
      // Object.prototype names through the chain and treat them as known.
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        if (schema.additionalProperties === false) return failAt(path, `unknown property ${key}`);
        continue;
      }
      const err = validateRelaySchema(props[key], child, path ? `${path}.${key}` : key);
      if (err) return err;
    }
  }
  return null;
}
