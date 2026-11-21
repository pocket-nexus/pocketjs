/** Match babel-preset-solid universal's trimWhitespace, including whitespace runs. */
export function normalizeJsxText(value: string): string {
  value = value.replace(/\r/g, "");
  if (value.includes("\n")) value = value.split("\n")
    .map((line, index) => index ? line.replace(/^\s*/, "") : line)
    .filter(line => !/^\s*$/.test(line)).join(" ");
  return value.replace(/\s+/g, " ");
}
export const JSX_ENTITY_DIAGNOSTIC = 'PocketJS: HTML entities in JSX text are not decoded by the JSX renderer - write the literal character (é, ♥) or a string expression {"\\u00e9"} instead.';
export function hasJsxEntity(value: string): boolean { return /&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/.test(value); }
