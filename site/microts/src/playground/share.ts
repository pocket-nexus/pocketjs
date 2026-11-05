// Share links and local drafts.
// Share: deflate-raw, then base64url, carried in the URL hash (#s=...); never sent to a server.
// Drafts: one per preset, stored in localStorage.

import type { Project } from "./projects";
import { validViewport, type Viewport } from "./screens";

/** Example: carries only the changed files; project: carries all files and is imported as a new project on open */
export type SharedPayload =
  | { preset: string; files: Record<string, string>; viewport?: Viewport }
  | { project: Pick<Project, "name" | "template" | "framework" | "entry" | "open" | "files" | "retroAssets" | "viewport"> };

const toBase64Url = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (text: string) => {
  const b = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeShare(payload: SharedPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decodeShare(token: string): Promise<SharedPayload | null> {
  try {
    const json = await pipe(fromBase64Url(token), new DecompressionStream("deflate-raw"));
    const data = JSON.parse(new TextDecoder().decode(json));
    if (typeof data?.preset === "string" && typeof data.files === "object") {
      if (data.viewport !== undefined && !validViewport(data.viewport)) delete data.viewport;
      return data as SharedPayload;
    }
    const p = data?.project;
    if (p && typeof p.name === "string" && typeof p.entry === "string" && typeof p.files === "object" && p.entry in p.files) {
      if (p.viewport !== undefined && !validViewport(p.viewport)) delete p.viewport;
      return data as SharedPayload;
    }
    return null;
  } catch {
    return null;
  }
}

const DRAFT_KEY = (preset: string) => `microts-playground:draft:${preset}`;

export function loadDraft(preset: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(preset));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function saveDraft(preset: string, changed: Record<string, string>): void {
  try {
    if (Object.keys(changed).length) localStorage.setItem(DRAFT_KEY(preset), JSON.stringify(changed));
    else localStorage.removeItem(DRAFT_KEY(preset));
  } catch {
    // Storage unavailable (private mode, quota): skip saving the draft
  }
}
