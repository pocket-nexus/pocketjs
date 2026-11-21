import type { PackOps } from "../../contracts/spec/pack.ts";

interface PackUploader {
  uploadImgEntry(blob: Uint8Array): number;
}

export function createPackHost(options: {
  baseUrl: string;
  ops?: PackUploader | { ops: PackUploader } | null;
  fetch?: typeof fetch;
}): {
  ns: PackOps & { stats(): string };
  reset(): void;
};
