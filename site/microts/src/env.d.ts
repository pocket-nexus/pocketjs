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

declare module "microts:retro-code" {
  /** The home page code panel for one game: game.ts, then the tabs of content/home/retro.md. */
  const code: Record<string, () => Promise<{ default: { title: string; html: string }[] }>>;
  export default code;
}

declare module "microts:build" {
  /** The pocketjs commit the site, docs and playground kit are built from. */
  export const COMMIT: string;
  export const RETRO_WORKER_URL: string;
  export const RETRO_MIXER_URL: string;
}

declare module "microts:shells" {
  /** [x, y, width, height] from the top left of a shell's picture, in its pixels. */
  export type Rect = [number, number, number, number];
  /** A device seen from the front (tools/handheld-shells.ts): the case with its keys taken out, a sheet of the keys, and where things are. */
  export interface Shell {
    name: string;
    /** URL of the case's picture */
    art: string;
    /** URL of the sheet of moving parts */
    partsArt?: string;
    width: number;
    height: number;
    pixelsPerMm: number;
    partsWidth?: number;
    partsHeight?: number;
    screens: { upper: Rect; lower?: Rect };
    /** A part's rectangle in the picture, then its place on the sheet: [x, y, width, height, sheetX, sheetY] */
    parts: [number, number, number, number, number, number][];
    /** A control, the place a finger takes it, and the part that moves with it (null: a place with no part of its own) */
    controls: { button: string; rect: Rect; part: number | null }[];
    sticks: { id: string; centre: [number, number]; radius: number; travel: number; part: number }[];
    /** Keys the device keeps for itself: drawn, and read by no app */
    system?: Record<string, Rect>;
  }
  export const SHELLS: Record<string, Shell>;
}
