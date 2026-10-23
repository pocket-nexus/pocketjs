import type { JsonSchema, JsonSchemaObject } from "../../../contracts/spec/pocket-manifest.ts";
import type { ContractDiagnostic } from "../../../contracts/spec/applet.ts";

export type { ContractDiagnostic };

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

function pointer(path: string, key: string | number): string {
  const escaped = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${escaped}`;
}

function jsonKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jsonKey(record[key])}`).join(",")}}`;
}

function matchesType(value: unknown, type: NonNullable<JsonSchemaObject["type"]>): boolean {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string": return typeof value === "string";
  }
}

export function validateSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  diagnostics: ContractDiagnostic[],
): void {
  if (schema === true) return;
  if (schema === false) {
    diagnostics.push({ code: "schema.forbidden", path, message: "value is not allowed" });
    return;
  }

  if (schema.anyOf) {
    const matched = schema.anyOf.some((candidate) => {
      const branchDiagnostics: ContractDiagnostic[] = [];
      validateSchema(value, candidate, path, branchDiagnostics);
      return branchDiagnostics.length === 0;
    });
    if (!matched) {
      diagnostics.push({
        code: "schema.anyOf",
        path,
        message: "value does not match any allowed schema",
      });
    }
    return;
  }

  if (schema.const !== undefined && jsonKey(value) !== jsonKey(schema.const)) {
    diagnostics.push({
      code: "schema.const",
      path,
      message: `expected ${JSON.stringify(schema.const)}`,
    });
  }

  if (schema.enum && !schema.enum.some((candidate) => jsonKey(value) === jsonKey(candidate))) {
    diagnostics.push({
      code: "schema.enum",
      path,
      message: `expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    });
  }

  if (schema.type && !matchesType(value, schema.type)) {
    diagnostics.push({
      code: "schema.type",
      path,
      message: `expected ${schema.type}`,
    });
    return;
  }

  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        diagnostics.push({
          code: "schema.required",
          path: pointer(path, required),
          message: "required property is missing",
        });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema !== undefined) {
        validateSchema(child, propertySchema, pointer(path, key), diagnostics);
      } else if (schema.additionalProperties === false) {
        diagnostics.push({
          code: "schema.additionalProperty",
          path: pointer(path, key),
          message: "unknown property",
        });
      } else if (typeof schema.additionalProperties === "object") {
        validateSchema(child, schema.additionalProperties, pointer(path, key), diagnostics);
      }
    }
  }

  if (schema.type === "array") {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) {
      diagnostics.push({
        code: "schema.minItems",
        path,
        message: `expected at least ${schema.minItems} item(s)`,
      });
    }
    if (schema.maxItems !== undefined && items.length > schema.maxItems) {
      diagnostics.push({
        code: "schema.maxItems",
        path,
        message: `expected at most ${schema.maxItems} item(s)`,
      });
    }
    if (schema.uniqueItems) {
      const keys = items.map(jsonKey);
      if (new Set(keys).size !== keys.length) {
        diagnostics.push({
          code: "schema.uniqueItems",
          path,
          message: "array items must be unique",
        });
      }
    }
    if (schema.items) {
      items.forEach((item, index) => validateSchema(item, schema.items!, pointer(path, index), diagnostics));
    }
  }

  if (schema.type === "string") {
    const text = value as string;
    if (schema.minLength !== undefined && text.length < schema.minLength) {
      diagnostics.push({ code: "schema.minLength", path, message: `minimum length is ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && text.length > schema.maxLength) {
      diagnostics.push({ code: "schema.maxLength", path, message: `maximum length is ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(text)) {
      diagnostics.push({ code: "schema.pattern", path, message: `value does not match ${schema.pattern}` });
    }
  }

  if (schema.type === "integer" || schema.type === "number") {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) {
      diagnostics.push({ code: "schema.minimum", path, message: `minimum value is ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && number > schema.maximum) {
      diagnostics.push({ code: "schema.maximum", path, message: `maximum value is ${schema.maximum}` });
    }
  }
}
