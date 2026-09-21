import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export const VITA_SYSTEM_ASSET_PATHS = {
  icon: "sce_sys/icon0.png",
  background: "sce_sys/livearea/contents/bg.png",
  startup: "sce_sys/livearea/contents/startup.png",
  template: "sce_sys/livearea/contents/template.xml",
} as const;
export const VITA_REQUIRED_SYSTEM_ASSETS = Object.values(VITA_SYSTEM_ASSET_PATHS);
export const VITA_ICON_VPK_PATH = VITA_SYSTEM_ASSET_PATHS.icon;
export const DEFAULT_VITA_PACKAGE_ASSETS = fileURLToPath(
  new URL("../hosts/vita/assets", import.meta.url),
);
export const DEFAULT_VITA_SYSTEM_ASSETS = join(DEFAULT_VITA_PACKAGE_ASSETS, "sce_sys");
export const DEFAULT_VITA_ICON = join(DEFAULT_VITA_PACKAGE_ASSETS, VITA_ICON_VPK_PATH);

export interface VitaPackageAsset {
  readonly source: string;
  readonly destination: string;
}

export interface ResolveVitaPackageAssetsInput {
  /** Optional application tree whose relative paths mirror the VPK root. */
  readonly applicationAssets?: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_RULES = new Map<string, readonly [width: number, height: number]>([
  [VITA_SYSTEM_ASSET_PATHS.icon, [128, 128]],
  [VITA_SYSTEM_ASSET_PATHS.background, [840, 500]],
  [VITA_SYSTEM_ASSET_PATHS.startup, [280, 158]],
]);
const compareCodePoints = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function files(root: string): VitaPackageAsset[] {
  const output: VitaPackageAsset[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareCodePoints(a.name, b.name))) {
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(source);
      } else if (entry.isFile()) {
        output.push({
          source,
          destination: relative(root, source).split(sep).join("/"),
        });
      } else {
        throw new Error(`unsupported Vita package asset at ${source}`);
      }
    }
  };
  walk(root);
  return output;
}

function validateIndexedPng(asset: VitaPackageAsset, width: number, height: number): void {
  const png = readFileSync(asset.source);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${asset.destination} is not a PNG`);
  }
  if (png.length > 420 * 1024) {
    throw new Error(`${asset.destination} exceeds Vita's 420 KiB artwork limit`);
  }
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`${asset.destination} must be ${width}x${height}`);
  }
  if (png[24] !== 8 || png[25] !== 3 || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) {
    throw new Error(`${asset.destination} must be indexed PNG-8 and non-interlaced`);
  }

  const chunks: string[] = [];
  const imageData: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error(`${asset.destination} has a truncated PNG chunk`);
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > png.length) throw new Error(`${asset.destination} has a truncated PNG payload`);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR" && (chunks.length !== 0 || length !== 13)) {
      throw new Error(`${asset.destination} has an invalid IHDR`);
    }
    if (type === "PLTE" && (length === 0 || length > 768 || length % 3 !== 0)) {
      throw new Error(`${asset.destination} has an invalid palette`);
    }
    if (type === "IDAT" && !chunks.includes("PLTE")) {
      throw new Error(`${asset.destination} has image data before its palette`);
    }
    if (type === "IEND" && length !== 0) {
      throw new Error(`${asset.destination} has an invalid IEND`);
    }
    if (chunks.includes(type) && ["IHDR", "PLTE", "IEND"].includes(type)) {
      throw new Error(`${asset.destination} repeats its ${type} chunk`);
    }
    const expectedCrc = png.readUInt32BE(dataEnd);
    const actualCrc = crc32(png.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`${asset.destination} has an invalid ${type} CRC`);
    chunks.push(type);
    if (type === "IDAT") imageData.push(png.subarray(dataStart, dataEnd));
    offset = end;
    if (type === "IEND") break;
  }
  if (offset !== png.length || chunks[0] !== "IHDR" || chunks.at(-1) !== "IEND" ||
      !chunks.includes("PLTE") || imageData.length === 0) {
    throw new Error(`${asset.destination} is not a complete indexed PNG`);
  }
  try {
    const scanlines = inflateSync(Buffer.concat(imageData));
    if (scanlines.length !== height * (width + 1)) {
      throw new Error(`expected ${height * (width + 1)} decoded bytes, got ${scanlines.length}`);
    }
    for (let row = 0; row < height; row++) {
      if (scanlines[row * (width + 1)]! > 4) throw new Error(`invalid filter on row ${row}`);
    }
  } catch (error) {
    throw new Error(`${asset.destination} has invalid image data: ${(error as Error).message}`);
  }
}

interface XmlNode {
  readonly name: string;
  readonly children: XmlNode[];
  text: string;
}

function parseXml(xml: string, destination: string): XmlNode {
  let withoutDeclaration = xml.trim();
  if (withoutDeclaration.startsWith("<?xml")) {
    const declaration = withoutDeclaration.match(
      /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?\s*\?>/,
    );
    if (!declaration) throw new Error(`${destination} has an invalid XML declaration`);
    withoutDeclaration = withoutDeclaration.slice(declaration[0].length).trimStart();
  }
  if (withoutDeclaration.includes("<?")) {
    throw new Error(`${destination} may not contain processing instructions`);
  }
  if (withoutDeclaration.includes("<!") || withoutDeclaration.includes("&")) {
    throw new Error(`${destination} may not contain declarations or entity references`);
  }
  const tokens = withoutDeclaration.match(/<[^>]+>|[^<]+/g) ?? [];
  if (tokens.join("") !== withoutDeclaration) throw new Error(`${destination} is malformed XML`);
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (stack.length === 0 && token.trim()) throw new Error(`${destination} has text outside its root`);
      if (stack.length > 0) stack.at(-1)!.text += token;
      continue;
    }
    const close = token.match(/^<\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>$/);
    if (close) {
      if (stack.at(-1)?.name !== close[1]) throw new Error(`${destination} has mismatched XML tags`);
      stack.pop();
      continue;
    }
    const open = token.match(
      /^<([A-Za-z_:][A-Za-z0-9_.:-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<>&]*"|'[^'<>&]*'))*)\s*>$/,
    );
    if (!open || token.endsWith("/>") || token.startsWith("<?")) {
      throw new Error(`${destination} contains unsupported XML syntax`);
    }
    const attributeNames = new Set<string>();
    const attributes = open[2]!;
    const attribute = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"[^"<>&]*"|'[^'<>&]*')/gy;
    let attributeOffset = 0;
    while (attributeOffset < attributes.length) {
      attribute.lastIndex = attributeOffset;
      const match = attribute.exec(attributes);
      if (!match || match.index !== attributeOffset) {
        throw new Error(`${destination} contains invalid XML attributes`);
      }
      const name = match[1]!;
      if (attributeNames.has(name)) throw new Error(`${destination} repeats XML attribute ${name}`);
      attributeNames.add(name);
      attributeOffset = attribute.lastIndex;
    }
    const node: XmlNode = { name: open[1]!, children: [], text: "" };
    if (stack.length > 0) stack.at(-1)!.children.push(node);
    else if (root) throw new Error(`${destination} has multiple roots`);
    else root = node;
    stack.push(node);
  }
  if (!root || stack.length > 0) throw new Error(`${destination} is incomplete XML`);
  return root;
}

function onlyChild(node: XmlNode, name: string, destination: string): XmlNode {
  const matches = node.children.filter((child) => child.name === name);
  if (matches.length !== 1) throw new Error(`${destination} must contain one ${name}`);
  return matches[0]!;
}

function validateTemplate(asset: VitaPackageAsset): void {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(asset.source));
  } catch {
    throw new Error(`${asset.destination} must be valid UTF-8`);
  }
  const root = parseXml(xml, asset.destination);
  if (root.name !== "livearea") throw new Error(`${asset.destination} root must be livearea`);
  const background = onlyChild(root, "livearea-background", asset.destination);
  const gate = onlyChild(root, "gate", asset.destination);
  const image = onlyChild(background, "image", asset.destination);
  const startup = onlyChild(gate, "startup-image", asset.destination);
  if (image.children.length || image.text.trim() !== "bg.png" ||
      startup.children.length || startup.text.trim() !== "startup.png") {
    throw new Error(`${asset.destination} must structurally reference bg.png and startup.png`);
  }
}

function validateLiveArea(assets: ReadonlyMap<string, VitaPackageAsset>): void {
  for (const path of VITA_REQUIRED_SYSTEM_ASSETS) {
    if (!assets.has(path)) throw new Error(`Vita package is missing ${path}`);
  }
  for (const [path, [width, height]] of PNG_RULES) {
    validateIndexedPng(assets.get(path)!, width, height);
  }
  validateTemplate(assets.get(VITA_SYSTEM_ASSET_PATHS.template)!);
}

/**
 * Resolve one deterministic VPK asset list. Framework defaults are registered
 * first and the application's VPK-relative tree overlays matching paths.
 */
export function resolveVitaPackageAssets(
  input: ResolveVitaPackageAssetsInput = {},
): readonly VitaPackageAsset[] {
  if (!existsSync(DEFAULT_VITA_PACKAGE_ASSETS)) {
    throw new Error(`PocketJS Vita assets not found at ${DEFAULT_VITA_PACKAGE_ASSETS}`);
  }
  if (input.applicationAssets && !existsSync(input.applicationAssets)) {
    throw new Error(`Vita application assets not found at ${input.applicationAssets}`);
  }
  const resolved = new Map<string, VitaPackageAsset>();
  for (const asset of files(DEFAULT_VITA_PACKAGE_ASSETS)) resolved.set(asset.destination, asset);
  if (input.applicationAssets) {
    for (const asset of files(input.applicationAssets)) resolved.set(asset.destination, asset);
  }
  validateLiveArea(resolved);
  return [...resolved.values()].sort((a, b) => compareCodePoints(a.destination, b.destination));
}

export interface VitaPackVpkInput extends ResolveVitaPackageAssetsInput {
  readonly sfo: string;
  readonly eboot: string;
  readonly output: string;
  /** Matching USB driver built by prepareVitaUsb; stock runtime enables it by default. */
  readonly usbDriver?: string;
}

export function vitaPackVpkArguments(input: VitaPackVpkInput): string[] {
  const assets = resolveVitaPackageAssets(input);
  for (const asset of assets) {
    if (asset.source.includes("=") || asset.destination.includes("=")) {
      throw new Error(`Vita package asset paths may not contain '=': ${asset.source}`);
    }
  }
  return [
    "-s",
    input.sfo,
    "-b",
    input.eboot,
    ...(input.usbDriver ? ["--add", `${input.usbDriver}=pocket-usbhostfs.skprx`] : []),
    ...assets.flatMap((asset) => [
      "--add",
      `${asset.source}=${asset.destination}`,
    ]),
    input.output,
  ];
}

export interface PackageVitaVpkInput extends VitaPackVpkInput {
  readonly tool: string;
}

/** Atomically create the final VPK through the framework's single asset resolver. */
export async function packageVitaVpk(input: PackageVitaVpkInput): Promise<void> {
  const next = `${input.output}.pocketjs-new`;
  mkdirSync(dirname(input.output), { recursive: true });
  rmSync(next, { force: true });
  const child = Bun.spawn([
    input.tool,
    ...vitaPackVpkArguments({ ...input, output: next }),
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    rmSync(next, { force: true });
    throw new Error(`vita-pack-vpk failed with exit code ${code}`);
  }
  renameSync(next, input.output);
}
