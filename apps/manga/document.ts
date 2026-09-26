/** Bounded text records shared by the companion, SD export and the terminal.
 * Large metadata uses JSON string chunks; tile entry addresses do not move. */
export const DOCUMENT_BYTES = 256 * 1024;
export const RECORD_BYTES = 1800;
export interface DocumentHead { document: 1; start: number; count: number }

export function documentHead(raw: string): DocumentHead | undefined {
  const value = JSON.parse(raw);
  if (value?.document !== 1) return undefined;
  if (!Number.isInteger(value.start) || value.start < 1 ||
      !Number.isInteger(value.count) || value.count < 1 || value.count > 512 ||
      value.start + value.count > 65536) throw Error("Invalid metadata chunks");
  return { document: 1, start: value.start, count: value.count };
}

/** UTF-8 length without TextEncoder, which small guest engines may lack. */
export function utf8Length(text: string): number {
  let size = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    size += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return size;
}

export function encodeDocument(value: unknown, start: number): { head: string; chunks: string[] } {
  const raw = JSON.stringify(value);
  if (utf8Length(raw) > DOCUMENT_BYTES) throw Error("Metadata exceeds 256 KiB");
  // Each payload is itself serialized into an offload record. Leave room for
  // escaping in that outer string, including CJK and quote-heavy summaries.
  const fits = (text: string) => {
    // Saving a remote record adds another JSON string layer in the local pack
    // transport. Budget that request too, including the longest pack address.
    const payload = JSON.stringify(["p".repeat(48), 65535, text]);
    return utf8Length(text) <= RECORD_BYTES && payload.length <= 2500 &&
      utf8Length(JSON.stringify({ v: 1, id: 4294967295, method: "pack.cache-text", payload })) <= 3800;
  };
  if (fits(raw)) return { head: raw, chunks: [] };
  const chunks: string[] = [];
  let part = "", recordBytes = 2, payloadBytes = 4, wireBytes = 8;
  for (const char of raw) {
    const encoded = JSON.stringify(char).slice(1, -1);
    const payloadChar = JSON.stringify(encoded).slice(1, -1);
    const recordCost = utf8Length(encoded), payloadCost = utf8Length(payloadChar), wireCost = utf8Length(JSON.stringify(payloadChar)) - 2;
    if (recordBytes + recordCost > RECORD_BYTES || payloadBytes + payloadCost > 2400 || wireBytes + wireCost > 3600) {
      chunks.push(JSON.stringify(part)); part = ""; recordBytes = 2; payloadBytes = 4; wireBytes = 8;
    }
    part += char; recordBytes += recordCost; payloadBytes += payloadCost; wireBytes += wireCost;
  }
  if (part) chunks.push(JSON.stringify(part));
  const head = JSON.stringify({ document: 1, start, count: chunks.length });
  documentHead(head);
  return { head, chunks };
}

export async function readDocument(read: (entry: number) => Promise<string>): Promise<string> {
  const raw = await read(0);
  const head = documentHead(raw);
  if (!head) return raw;
  let result = "";
  let size = 0;
  for (let n = 0; n < head.count; n++) {
    const chunk: unknown = JSON.parse(await read(head.start + n));
    if (typeof chunk !== "string") throw Error("Invalid metadata chunk");
    size += utf8Length(chunk);
    if (size > DOCUMENT_BYTES) throw Error("Metadata exceeds 256 KiB");
    result += chunk;
  }
  return result;
}
