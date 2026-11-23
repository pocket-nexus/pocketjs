// Static image baking shared by the guest build (tools/build.ts) and the AOT
// compile (tools/aot-compile.ts).
//
// Application source always names the logical 1x asset (`logo.png`). A build
// may substitute a same-directory density sibling (`logo@2x.png`) while
// keeping the image name unchanged. The 1x file remains the source of truth
// for intrinsic size, so a malformed sibling fails at build time instead of
// changing layout. An optional `images.json` maps an image name to its pixel
// format and sampling; both builds encode the result as one IMG entry.

import { existsSync, readFileSync } from "node:fs";
import { IMG_FLAG_LINEAR, PSM } from "../../contracts/spec/spec.ts";
import { bakeSvg } from "./bake-svg.ts";
import { decodePng, encodeImageEntry, type DecodedImage } from "./pak.ts";

export interface RasterDimensions {
  readonly width: number;
  readonly height: number;
}

function checkedRasterDensity(rasterDensity: number): number {
  if (!Number.isInteger(rasterDensity) || rasterDensity < 1 || rasterDensity > 255) {
    throw new RangeError(
      `raster density must be an integer from 1 through 255, got ${rasterDensity}`,
    );
  }
  return rasterDensity;
}

/** Insert `@Nx` immediately before the final extension, or append it. */
export function densityVariantPath(path: string, rasterDensity: number): string {
  rasterDensity = checkedRasterDensity(rasterDensity);
  if (rasterDensity === 1) return path;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return `${path}@${rasterDensity}x`;
  return `${path.slice(0, dot)}@${rasterDensity}x${path.slice(dot)}`;
}

/** Require a density sibling to represent exactly the same logical image. */
export function assertDensityVariantDimensions(
  base: RasterDimensions,
  variant: RasterDimensions,
  rasterDensity: number,
  basePath: string,
  variantPath: string,
): void {
  rasterDensity = checkedRasterDensity(rasterDensity);
  const expectedWidth = base.width * rasterDensity;
  const expectedHeight = base.height * rasterDensity;
  if (variant.width === expectedWidth && variant.height === expectedHeight) return;
  throw new Error(
    `density asset ${variantPath} is ${variant.width}x${variant.height}; ` +
      `expected ${expectedWidth}x${expectedHeight} for ${basePath} ` +
      `(${base.width}x${base.height} @${rasterDensity}x)`,
  );
}

/** Reports each file a baker consults, present or not (BuildInputs). */
export interface RasterInputs {
  optional(path: string): void;
}

/** One `images.json` entry: `psm` is a spec PSM code (default PSM_8888),
 *  `linear` requests bilinear sampling (IMG_FLAG_LINEAR). */
export interface ImageMeta {
  linear?: boolean;
  psm?: number;
}

/** Read `images.json` at `path`; an absent file maps no image. */
export function readImageManifest(path: string, inputs: RasterInputs): Record<string, ImageMeta> {
  inputs.optional(path);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, ImageMeta>) : {};
}

export interface RasterImage {
  image: DecodedImage;
  /** The file the pixels came from: `path` or its `@Nx` sibling. */
  source: string;
  /** The 1x size when `source` is the `@Nx` sibling. */
  base?: RasterDimensions;
}

/** Decode the image file `path` at `rasterDensity`: an SVG rasterizes at the
 *  density; a PNG takes its `@Nx` sibling when that exists, after checking it
 *  against the 1x size, and the 1x file otherwise. */
export function loadRasterImage(path: string, rasterDensity: number, inputs: RasterInputs): RasterImage {
  if (/\.svg$/i.test(path)) return { image: bakeSvg(readFileSync(path, "utf8"), rasterDensity), source: path };
  const base = decodePng(new Uint8Array(readFileSync(path)));
  const variant = densityVariantPath(path, rasterDensity);
  inputs.optional(variant);
  if (variant === path || !existsSync(variant)) return { image: base, source: path };
  const image = decodePng(new Uint8Array(readFileSync(variant)));
  assertDensityVariantDimensions(base, image, rasterDensity, path, variant);
  return { image, source: variant, base: { width: base.width, height: base.height } };
}

/** The IMG entry of a static image with its `images.json` format and
 *  sampling. Throws for a size the core rejects (not power-of-two, or above
 *  TEX_MAX_DIM). */
export function encodeStaticImage(image: DecodedImage, meta: ImageMeta | undefined): Uint8Array {
  return encodeImageEntry(image, meta?.psm ?? PSM.PSM_8888, meta?.linear ? IMG_FLAG_LINEAR : 0);
}
