// Modules provided by the Bun.build plugins in lib/plugins.ts.

declare module "*.md?tabs" {
  const tabs: { title: string; lang: string; code: string; html: string }[];
  export default tabs;
}

declare module "microts:docs" {
  export interface DocPage {
    html: string;
    title: string;
    toc: { depth: number; id: string; text: string }[];
  }
  export const DOCS: Record<string, () => Promise<{ default: DocPage }>>;
}

declare module "microts:files/*" {
  const files: Record<string, string>;
  export default files;
}

declare module "microts:retro-catalog" {
  const catalog: {
    repo: string;
    commit: string;
    games: {
      id: string;
      title: string;
      blurb: string;
      author: string;
      original: string | null;
      controls: string;
      lines: number;
      width: number;
      height: number;
      fps: number;
    }[];
  };
  export default catalog;
}

declare module "microts:retro-sources" {
  const sources: Record<string, () => Promise<{ default: Record<string, string> }>>;
  export default sources;
}

declare module "microts:build" {
  /** The pocketjs commit the site, docs and playground kit are built from. */
  export const COMMIT: string;
  export const RETRO_WORKER_URL: string;
  export const RETRO_MIXER_URL: string;
}
