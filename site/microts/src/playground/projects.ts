// User projects: stored in localStorage, one entry per project.
import type { PresetFramework } from "./presets";
import type { TemplateId } from "./templates";
import type { Viewport } from "./screens";

export interface Project {
  id: string;
  name: string;
  template: TemplateId;
  framework: PresetFramework;
  entry: string;
  open: string;
  files: Record<string, string>;
  /** Baked assets used by a retro project (/retro/<id>/), kept when copied from an example; null for new projects */
  retroAssets: string | null;
  /** UI preview screen size, 480 × 272 when absent; retro projects take their size from system.init() */
  viewport?: Viewport;
  /** Example this project was copied from */
  from?: string;
  createdAt: number;
  updatedAt: number;
}

const PREFIX = "microts-playground:project:";

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function listProjects(): Project[] {
  const s = storage();
  if (!s) return [];
  const out: Project[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      out.push(JSON.parse(s.getItem(key)!) as Project);
    } catch {
      // Skip corrupt entries
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Project | null {
  try {
    const raw = storage()?.getItem(PREFIX + id);
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

export function saveProject(project: Project): boolean {
  try {
    storage()?.setItem(PREFIX + project.id, JSON.stringify({ ...project, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function deleteProject(id: string): void {
  storage()?.removeItem(PREFIX + id);
}

export function createProject(init: Omit<Project, "id" | "createdAt" | "updatedAt">): Project {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
  const now = Date.now();
  const project: Project = { ...init, id, createdAt: now, updatedAt: now };
  saveProject(project);
  return project;
}

/** Number duplicate project names: "Vue SFC app 2" */
export function uniqueName(base: string): string {
  const names = new Set(listProjects().map((p) => p.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
