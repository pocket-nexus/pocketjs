// Binary Android resources as aapt2 writes them: string pools, the compiled
// XML of AndroidManifest.xml and the resource table (resources.arsc). The
// Android repack (tools/repack/android.ts) changes the identity of a template
// APK that aapt2 linked when the runtime was built; this file rewrites the
// two binary files the way aapt2 would have written them for that identity.
//
//   - A string pool is a 28-byte header, one u32 offset per string, the
//     strings (UTF-16 in the manifest, modified UTF-8 in the table: a
//     character past U+FFFF is two 3-byte surrogates; length-prefixed and
//     NUL-terminated) and zero padding to 4 bytes. No styles.
//   - aapt2 sorts every pool: the manifest's attribute names that carry a
//     resource id come first, in the resource map's order, then every other
//     string by its UTF-8 bytes; the table's global pool by UTF-8 bytes. One
//     entry per distinct string, and only strings something refers to.
//   - A changed string goes to its sorted place, and every reference to the
//     pool (element and attribute names, raw values, typed string values,
//     namespaces, a table entry's string value) is renumbered with it.
//
// tests/repack-android.test.ts compares the result with aapt2's own link of
// the same identity, byte for byte, where the Android SDK is installed.

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_XML = 0x0003;
const RES_XML_START_NAMESPACE = 0x0100;
const RES_XML_END_NAMESPACE = 0x0101;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_CDATA = 0x0104;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC = 0x0202;

const UTF8_FLAG = 1 << 8;
const NO_REFERENCE = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;
const ENTRY_FLAG_COMPLEX = 0x0001;
const ENTRY_FLAG_COMPACT = 0x0008;

/** Resource ids of the manifest attributes the repack reads or writes (android.R.attr). */
export const ANDROID_ATTR = {
  label: 0x01010001,
  debuggable: 0x0101000f,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
} as const;

/** The longest package name a resource table holds: 128 UTF-16 units with the NUL. */
export const MAX_PACKAGE_NAME = 127;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fail(message: string): never {
  throw new Error(`android resources: ${message}`);
}

interface Chunk {
  readonly type: number;
  readonly headerSize: number;
  readonly size: number;
  readonly at: number;
}

/** The chunks laid end to end from `start` to `end`. */
function chunks(bytes: Uint8Array, start: number, end: number): Chunk[] {
  const data = view(bytes);
  const out: Chunk[] = [];
  let at = start;
  while (at < end) {
    if (at + 8 > end) fail(`a chunk header at ${at} runs past its parent`);
    const type = data.getUint16(at, true);
    const headerSize = data.getUint16(at + 2, true);
    const size = data.getUint32(at + 4, true);
    if (headerSize < 8 || size < headerSize || at + size > end) fail(`chunk 0x${type.toString(16)} at ${at} has a bad size`);
    out.push({ type, headerSize, size, at });
    at += size;
  }
  return out;
}

// ------------------------------------------------------------ string pools

export interface StringPool {
  readonly strings: string[];
  readonly utf8: boolean;
  /** The pool chunk's size in bytes. */
  readonly size: number;
}

const utf16Decoder = new TextDecoder("utf-16le", { fatal: true });
const utf8Encoder = new TextEncoder();

/** Modified UTF-8, as aapt2 writes a UTF-8 pool: UTF-16 units encoded one by one, so a surrogate pair is two 3-byte sequences. */
function encodeModifiedUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) out.push(unit);
    else if (unit < 0x800) out.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    else out.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
  }
  return Uint8Array.from(out);
}

/** UTF-8 or modified UTF-8 bytes as a string. */
function decodeModifiedUtf8(bytes: Uint8Array): string {
  const units: number[] = [];
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at]!;
    const next = (offset: number) => {
      const byte = bytes[at + offset];
      if (byte === undefined || (byte & 0xc0) !== 0x80) fail("a UTF-8 pool string is malformed");
      return byte & 0x3f;
    };
    if (lead < 0x80) {
      units.push(lead);
      at += 1;
    } else if ((lead & 0xe0) === 0xc0) {
      units.push(((lead & 0x1f) << 6) | next(1));
      at += 2;
    } else if ((lead & 0xf0) === 0xe0) {
      units.push(((lead & 0x0f) << 12) | (next(1) << 6) | next(2));
      at += 3;
    } else if ((lead & 0xf8) === 0xf0) {
      const point = (((lead & 0x07) << 18) | (next(1) << 12) | (next(2) << 6) | next(3)) - 0x10000;
      units.push(0xd800 | (point >> 10), 0xdc00 | (point & 0x3ff));
      at += 4;
    } else {
      fail("a UTF-8 pool string is malformed");
    }
  }
  let text = "";
  for (let index = 0; index < units.length; index += 0x8000) text += String.fromCharCode(...units.slice(index, index + 0x8000));
  return text;
}

/** The string pool chunk at `at`. Refuses a pool with styles. */
export function readStringPool(bytes: Uint8Array, at: number): StringPool {
  const data = view(bytes);
  if (data.getUint16(at, true) !== RES_STRING_POOL) fail(`no string pool at ${at}`);
  const headerSize = data.getUint16(at + 2, true);
  const size = data.getUint32(at + 4, true);
  const count = data.getUint32(at + 8, true);
  const styleCount = data.getUint32(at + 12, true);
  const flags = data.getUint32(at + 16, true);
  const stringsStart = data.getUint32(at + 20, true);
  if (styleCount !== 0) fail("a pool with styled strings is not read here");
  if (at + size > bytes.length || headerSize + count * 4 > size) fail(`the string pool at ${at} runs past its chunk`);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = [];
  for (let index = 0; index < count; index++) {
    let cursor = at + stringsStart + data.getUint32(at + headerSize + index * 4, true);
    if (utf8) {
      if (bytes[cursor++]! & 0x80) cursor++; // the UTF-16 length, unused here
      let length = bytes[cursor++]!;
      if (length & 0x80) length = ((length & 0x7f) << 8) | bytes[cursor++]!;
      strings.push(decodeModifiedUtf8(bytes.subarray(cursor, cursor + length)));
    } else {
      let length = data.getUint16(cursor, true);
      cursor += 2;
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | data.getUint16(cursor, true);
        cursor += 2;
      }
      strings.push(utf16Decoder.decode(bytes.subarray(cursor, cursor + length * 2)));
    }
  }
  return { strings, utf8, size };
}

/** A string pool chunk as aapt2 writes one: the strings in order, no styles, padded to 4 bytes. */
export function writeStringPool(strings: readonly string[], utf8: boolean): Uint8Array {
  const parts: number[] = [];
  const offsets: number[] = [];
  for (const text of strings) {
    offsets.push(parts.length);
    if (utf8) {
      const encoded = encodeModifiedUtf8(text);
      if (text.length > 0x7fff || encoded.length > 0x7fff) fail(`a string of ${encoded.length} bytes is past the pool's length field`);
      for (const length of [text.length, encoded.length]) {
        if (length > 0x7f) parts.push(0x80 | (length >> 8), length & 0xff);
        else parts.push(length);
      }
      for (const byte of encoded) parts.push(byte);
      parts.push(0);
    } else {
      if (text.length > 0x7fff) fail(`a string of ${text.length} UTF-16 units is past the pool's length field`);
      parts.push(text.length & 0xff, text.length >> 8);
      for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        parts.push(unit & 0xff, unit >> 8);
      }
      parts.push(0, 0);
    }
  }
  while (parts.length % 4) parts.push(0);
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const out = new Uint8Array(stringsStart + parts.length);
  const data = view(out);
  data.setUint16(0, RES_STRING_POOL, true);
  data.setUint16(2, headerSize, true);
  data.setUint32(4, out.length, true);
  data.setUint32(8, strings.length, true);
  data.setUint32(12, 0, true);
  data.setUint32(16, utf8 ? UTF8_FLAG : 0, true);
  data.setUint32(20, strings.length ? stringsStart : 0, true);
  data.setUint32(24, 0, true);
  offsets.forEach((offset, index) => data.setUint32(headerSize + index * 4, offset, true));
  out.set(parts, stringsStart);
  return out;
}

function compareUtf8(a: string, b: string): number {
  const x = utf8Encoder.encode(a);
  const y = utf8Encoder.encode(b);
  const length = Math.min(x.length, y.length);
  for (let index = 0; index < length; index++) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}

/**
 * The pool aapt2 writes for the referenced strings: the first `fixed`
 * entries stay where they are (the manifest's attribute names with resource
 * ids), every other referenced string once, sorted by its UTF-8 bytes.
 * `remap[old index]` is the new index of a referenced entry.
 */
function sortPool(strings: readonly string[], referenced: ReadonlySet<number>, fixed: number): { strings: string[]; remap: Map<number, number> } {
  const head = strings.slice(0, fixed);
  const rest = [...new Set([...referenced].filter((index) => index >= fixed).map((index) => strings[index]!))].sort(compareUtf8);
  const place = new Map(rest.map((text, index) => [text, fixed + index]));
  const remap = new Map<number, number>();
  for (const index of referenced) remap.set(index, index < fixed ? index : place.get(strings[index]!)!);
  return { strings: [...head, ...rest], remap };
}

function splice(bytes: Uint8Array, at: number, removed: number, inserted: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - removed + inserted.length);
  out.set(bytes.subarray(0, at));
  out.set(inserted, at);
  out.set(bytes.subarray(at + removed), at + inserted.length);
  return out;
}

// ------------------------------------------------------------ compiled XML

/** A place in the file that holds a string pool index. */
type Reference = number;

interface XmlAttribute {
  readonly at: number;
  readonly namespace: number;
  readonly name: number;
  readonly rawValue: number;
  readonly dataType: number;
  readonly data: number;
}

interface XmlElement {
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
}

interface XmlDocument {
  readonly pool: StringPool;
  readonly resourceIds: readonly number[];
  readonly elements: readonly XmlElement[];
  /** Every place that holds a pool index. */
  readonly references: readonly Reference[];
}

function readXml(bytes: Uint8Array): XmlDocument {
  const data = view(bytes);
  if (bytes.length < 8 || data.getUint16(0, true) !== RES_XML || data.getUint32(4, true) !== bytes.length) {
    fail("AndroidManifest.xml is not compiled XML");
  }
  const parts = chunks(bytes, data.getUint16(2, true), bytes.length);
  if (parts[0]?.type !== RES_STRING_POOL) fail("the compiled XML does not start with its string pool");
  const pool = readStringPool(bytes, parts[0].at);
  const resourceIds: number[] = [];
  const elements: XmlElement[] = [];
  const references: Reference[] = [];
  const reference = (at: number) => {
    const index = data.getUint32(at, true);
    if (index === NO_REFERENCE) return;
    if (index >= pool.strings.length) fail(`a reference at ${at} is past the string pool`);
    references.push(at);
  };
  for (const chunk of parts.slice(1)) {
    const { at, headerSize, size } = chunk;
    if (chunk.type === RES_XML_RESOURCE_MAP) {
      for (let cursor = at + headerSize; cursor < at + size; cursor += 4) resourceIds.push(data.getUint32(cursor, true));
      continue;
    }
    if (chunk.type < RES_XML_START_NAMESPACE || chunk.type > RES_XML_CDATA) fail(`compiled XML chunk 0x${chunk.type.toString(16)} is not read here`);
    reference(at + 12); // the node's comment
    const body = at + headerSize;
    switch (chunk.type) {
      case RES_XML_START_NAMESPACE:
      case RES_XML_END_NAMESPACE:
      case RES_XML_END_ELEMENT:
        reference(body);
        reference(body + 4);
        break;
      case RES_XML_CDATA:
        reference(body);
        if (bytes[body + 7] === TYPE_STRING) reference(body + 8);
        break;
      case RES_XML_START_ELEMENT: {
        reference(body);
        reference(body + 4);
        const attributeStart = data.getUint16(body + 8, true);
        const attributeSize = data.getUint16(body + 10, true);
        const count = data.getUint16(body + 12, true);
        if (attributeSize < 20) fail("an attribute record is shorter than 20 bytes");
        const attributes: XmlAttribute[] = [];
        for (let index = 0; index < count; index++) {
          const record = body + attributeStart + index * attributeSize;
          if (record + 20 > at + size) fail("an attribute runs past its element");
          reference(record);
          reference(record + 4);
          reference(record + 8);
          const dataType = bytes[record + 15]!;
          if (dataType === TYPE_STRING) reference(record + 16);
          attributes.push({
            at: record,
            namespace: data.getUint32(record, true),
            name: data.getUint32(record + 4, true),
            rawValue: data.getUint32(record + 8, true),
            dataType,
            data: data.getUint32(record + 16, true),
          });
        }
        const name = data.getUint32(body + 4, true);
        elements.push({ name: pool.strings[name] ?? "", attributes });
        break;
      }
    }
  }
  return { pool, resourceIds, elements, references };
}

function attributeById(document: XmlDocument, element: XmlElement, id: number): XmlAttribute | undefined {
  return element.attributes.find((attribute) => document.resourceIds[attribute.name] === id);
}

function attributeByName(document: XmlDocument, element: XmlElement, name: string): XmlAttribute | undefined {
  return element.attributes.find((attribute) =>
    attribute.namespace === NO_REFERENCE && document.resourceIds[attribute.name] === undefined && document.pool.strings[attribute.name] === name
  );
}

function element(document: XmlDocument, name: string): XmlElement {
  const found = document.elements.filter((candidate) => candidate.name === name);
  if (found.length !== 1) fail(`the manifest has ${found.length} <${name}> elements`);
  return found[0]!;
}

function stringValue(document: XmlDocument, attribute: XmlAttribute | undefined, what: string): string {
  if (!attribute || attribute.dataType !== TYPE_STRING || attribute.rawValue !== attribute.data) fail(`the manifest's ${what} is not a string`);
  return document.pool.strings[attribute.data]!;
}

function intValue(attribute: XmlAttribute | undefined, what: string): number {
  if (!attribute || attribute.dataType !== TYPE_INT_DEC) fail(`the manifest's ${what} is not a decimal integer`);
  return attribute.data;
}

/** What the repack reads back from a compiled AndroidManifest.xml. */
export interface ManifestSummary {
  readonly packageName: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly minSdkVersion: number;
  readonly targetSdkVersion: number;
  /** `android:debuggable` on <application>; false when absent. */
  readonly debuggable: boolean;
  /** The resource id `android:label` on <application> refers to. */
  readonly labelResource: number;
}

export function readManifest(axml: Uint8Array): ManifestSummary {
  const document = readXml(axml);
  const manifest = element(document, "manifest");
  const usesSdk = element(document, "uses-sdk");
  const application = element(document, "application");
  const debuggable = attributeById(document, application, ANDROID_ATTR.debuggable);
  if (debuggable && debuggable.dataType !== TYPE_INT_BOOLEAN) fail("android:debuggable is not a boolean");
  const label = attributeById(document, application, ANDROID_ATTR.label);
  if (!label || label.dataType !== 0x01) fail("<application> has no android:label reference");
  return {
    packageName: stringValue(document, attributeByName(document, manifest, "package"), "package"),
    versionCode: intValue(attributeById(document, manifest, ANDROID_ATTR.versionCode), "android:versionCode"),
    versionName: stringValue(document, attributeById(document, manifest, ANDROID_ATTR.versionName), "android:versionName"),
    minSdkVersion: intValue(attributeById(document, usesSdk, ANDROID_ATTR.minSdkVersion), "android:minSdkVersion"),
    targetSdkVersion: intValue(attributeById(document, usesSdk, ANDROID_ATTR.targetSdkVersion), "android:targetSdkVersion"),
    debuggable: debuggable ? debuggable.data !== 0 : false,
    labelResource: label.data,
  };
}

/**
 * The compiled manifest with `package`, `android:versionCode` and
 * `android:versionName` on <manifest> replaced, its pool sorted as aapt2 sorts
 * it and every reference renumbered.
 */
export function patchManifest(
  axml: Uint8Array,
  identity: { readonly packageName: string; readonly versionCode: number; readonly versionName: string },
): Uint8Array {
  if (!Number.isInteger(identity.versionCode) || identity.versionCode < 1 || identity.versionCode > 0x7fffffff) {
    fail(`versionCode ${identity.versionCode} is not a positive 31-bit integer`);
  }
  const document = readXml(axml);
  const manifest = element(document, "manifest");
  const packageAttribute = attributeByName(document, manifest, "package");
  const versionName = attributeById(document, manifest, ANDROID_ATTR.versionName);
  const versionCode = attributeById(document, manifest, ANDROID_ATTR.versionCode);
  stringValue(document, packageAttribute, "package");
  stringValue(document, versionName, "android:versionName");
  intValue(versionCode, "android:versionCode");

  const out = new Uint8Array(axml);
  const data = view(out);
  // The new strings go past the end of the pool, the two attributes point at them, and the sort places them.
  const strings = [...document.pool.strings, identity.packageName, identity.versionName];
  const packageIndex = strings.length - 2;
  const versionNameIndex = strings.length - 1;
  for (const [attribute, index] of [[packageAttribute!, packageIndex], [versionName!, versionNameIndex]] as const) {
    data.setUint32(attribute.at + 8, index, true);
    data.setUint32(attribute.at + 16, index, true);
  }
  data.setUint32(versionCode!.at + 16, identity.versionCode, true);

  const referenced = new Set<number>();
  for (const at of document.references) referenced.add(data.getUint32(at, true));
  const fixed = document.resourceIds.length;
  for (let index = 0; index < fixed; index++) referenced.add(index);
  const sorted = sortPool(strings, referenced, fixed);
  for (const at of document.references) data.setUint32(at, sorted.remap.get(data.getUint32(at, true))!, true);

  const poolAt = data.getUint16(2, true);
  const result = splice(out, poolAt, document.pool.size, writeStringPool(sorted.strings, document.pool.utf8));
  view(result).setUint32(4, result.length, true);
  return result;
}

// ---------------------------------------------------------- resource table

interface TableValue {
  /** Where the Res_value's data field is. */
  readonly at: number;
  readonly type: string;
  readonly key: string;
  readonly defaultConfig: boolean;
  readonly dataType: number;
  readonly data: number;
}

interface Table {
  readonly pool: StringPool;
  readonly poolAt: number;
  readonly packageAt: number;
  readonly packageId: number;
  readonly packageName: string;
  readonly values: readonly TableValue[];
}

function readTable(arsc: Uint8Array): Table {
  const data = view(arsc);
  if (arsc.length < 12 || data.getUint16(0, true) !== RES_TABLE || data.getUint32(4, true) !== arsc.length) {
    fail("resources.arsc is not a resource table");
  }
  if (data.getUint32(8, true) !== 1) fail("the resource table holds more than one package");
  const parts = chunks(arsc, data.getUint16(2, true), arsc.length);
  if (parts.length !== 2 || parts[0]!.type !== RES_STRING_POOL || parts[1]!.type !== RES_TABLE_PACKAGE) {
    fail("the resource table is not one string pool and one package");
  }
  const pool = readStringPool(arsc, parts[0]!.at);
  const packageChunk = parts[1]!;
  const packageAt = packageChunk.at;
  const packageId = data.getUint32(packageAt + 8, true);
  const nameUnits: number[] = [];
  for (let index = 0; index < 128; index++) {
    const unit = data.getUint16(packageAt + 12 + index * 2, true);
    if (unit === 0) break;
    nameUnits.push(unit);
  }
  const typeStrings = readStringPool(arsc, packageAt + data.getUint32(packageAt + 268, true)).strings;
  const keyStrings = readStringPool(arsc, packageAt + data.getUint32(packageAt + 276, true)).strings;
  const values: TableValue[] = [];
  for (const chunk of chunks(arsc, packageAt + packageChunk.headerSize, packageAt + packageChunk.size)) {
    if (chunk.type === RES_STRING_POOL || chunk.type === RES_TABLE_TYPE_SPEC) continue;
    if (chunk.type !== RES_TABLE_TYPE) fail(`resource table chunk 0x${chunk.type.toString(16)} is not read here`);
    const { at } = chunk;
    const typeName = typeStrings[arsc[at + 8]! - 1];
    if (typeName === undefined) fail(`a type chunk names type ${arsc[at + 8]}, which the package lacks`);
    if (arsc[at + 9] !== 0) fail(`the ${typeName} type chunk is sparse or uses 16-bit offsets, which is not read here`);
    const entryCount = data.getUint32(at + 12, true);
    const entriesStart = data.getUint32(at + 16, true);
    const configSize = data.getUint32(at + 20, true);
    let defaultConfig = true;
    for (let cursor = at + 24; cursor < at + 20 + configSize; cursor++) if (arsc[cursor] !== 0) defaultConfig = false;
    for (let index = 0; index < entryCount; index++) {
      const offset = data.getUint32(at + chunk.headerSize + index * 4, true);
      if (offset === NO_REFERENCE) continue;
      const entry = at + entriesStart + offset;
      const size = data.getUint16(entry, true);
      const flags = data.getUint16(entry + 2, true);
      if (flags & ENTRY_FLAG_COMPACT) fail("compact table entries are not read here");
      const key = keyStrings[data.getUint32(entry + 4, true)] ?? fail("a table entry's key is past the key pool");
      const value = (valueAt: number) => {
        values.push({ at: valueAt + 4, type: typeName, key, defaultConfig, dataType: arsc[valueAt + 3]!, data: data.getUint32(valueAt + 4, true) });
      };
      if (flags & ENTRY_FLAG_COMPLEX) {
        const count = data.getUint32(entry + 12, true);
        for (let item = 0; item < count; item++) value(entry + size + item * 12 + 4);
      } else {
        value(entry + size);
      }
    }
  }
  for (const value of values) {
    if (value.dataType === TYPE_STRING && value.data >= pool.strings.length) fail(`the ${value.type}/${value.key} value is past the string pool`);
  }
  return { pool, poolAt: parts[0]!.at, packageAt, packageId, packageName: String.fromCharCode(...nameUnits), values };
}

function labelValue(table: Table): TableValue {
  const found = table.values.filter((value) => value.type === "string" && value.key === "app_name");
  if (found.length !== 1 || !found[0]!.defaultConfig || found[0]!.dataType !== TYPE_STRING) {
    fail("the resource table does not hold one string/app_name in the default configuration");
  }
  return found[0]!;
}

/** What the repack reads back from a resource table. */
export interface TableSummary {
  readonly packageId: number;
  readonly packageName: string;
  /** string/app_name, the launcher label. */
  readonly label: string;
  /** Every string value by `type/key`, in table order (a key with several configurations repeats). */
  readonly strings: ReadonlyArray<readonly [string, string]>;
}

export function readResourceTable(arsc: Uint8Array): TableSummary {
  const table = readTable(arsc);
  return {
    packageId: table.packageId,
    packageName: table.packageName,
    label: table.pool.strings[labelValue(table).data]!,
    strings: table.values.filter((value) => value.dataType === TYPE_STRING).map((value) => [`${value.type}/${value.key}`, table.pool.strings[value.data]!]),
  };
}

/**
 * The resource table with its package's name and string/app_name replaced,
 * the global pool sorted as aapt2 sorts it and every string value renumbered.
 */
export function patchResourceTable(arsc: Uint8Array, identity: { readonly packageName: string; readonly label: string }): Uint8Array {
  if (identity.packageName.length > MAX_PACKAGE_NAME) fail(`a package name holds at most ${MAX_PACKAGE_NAME} characters`);
  const table = readTable(arsc);
  const label = labelValue(table);
  const out = new Uint8Array(arsc);
  const data = view(out);
  const strings = [...table.pool.strings, identity.label];
  data.setUint32(label.at, strings.length - 1, true);
  const references = table.values.filter((value) => value.dataType === TYPE_STRING).map((value) => value.at);
  const referenced = new Set(references.map((at) => data.getUint32(at, true)));
  const sorted = sortPool(strings, referenced, 0);
  for (const at of references) data.setUint32(at, sorted.remap.get(data.getUint32(at, true))!, true);
  for (let index = 0; index < 128; index++) {
    data.setUint16(table.packageAt + 12 + index * 2, index < identity.packageName.length ? identity.packageName.charCodeAt(index) : 0, true);
  }
  const result = splice(out, table.poolAt, table.pool.size, writeStringPool(sorted.strings, table.pool.utf8));
  view(result).setUint32(4, result.length, true);
  return result;
}
