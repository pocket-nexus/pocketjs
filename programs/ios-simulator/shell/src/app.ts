// The `pocket ios play` shell: hosts one PocketJS surface and answers the
// guest's service channel. tools/ios.ts stages the guest bundle, its resolved
// build plan, and current.json (which app + which guest mode) into
// src/assets/pocket before launching.
import { Application, File, Frame, GridLayout, Page, Screen, knownFolders } from '@nativescript/core';
import { PocketHostView, PocketView } from '@nativescript/pocketjs';

type BridgeCommand = { t?: string; id?: number; kind?: string; payload?: { n?: number } };
type StagedApp = { app: string; externalGuest?: boolean; tickHz?: number };
type StagedPlan = { viewport: { logical: [number, number]; rasterDensity: number } };

function readJson<T>(relativePath: string): T {
  const path = knownFolders.currentApp().path + relativePath;
  return JSON.parse(File.fromPath(path).readTextSync()) as T;
}

function createMainPage(): Page {
  const staged = readJson<StagedApp>('/assets/pocket/current.json');
  const plan = readJson<StagedPlan>(`/assets/pocket/${staged.app}.plan.json`);
  const [logicalWidth, logicalHeight] = plan.viewport.logical;

  const page = new Page();
  page.actionBarHidden = true;
  page.backgroundColor = '#020617';

  const root = new GridLayout();
  const pocket = staged.externalGuest ? new PocketHostView() : new PocketView();
  pocket.viewportWidth = logicalWidth;
  pocket.viewportHeight = logicalHeight;
  // Glyph atlases bake at build density; the surface must raster at the same
  // scale or text renders soft. Never leave this to the screen-scale default.
  pocket.density = plan.viewport.rasterDensity;
  // Virtual time is baked into the bundle the same way glyphs are baked into
  // the atlases: the display link has to run at the rate it was built for.
  pocket.tickRate = staged.tickHz ?? 60;
  const width = Screen.mainScreen.widthDIPs;
  pocket.width = width as never;
  pocket.height = Math.round((width * logicalHeight) / logicalWidth) as never;
  pocket.on('loaded', () => console.log('[pocket-shell] guest loaded'));
  pocket.on('error', (event) =>
    console.error('[pocket-shell] error:', (event as { message?: string }).message),
  );
  pocket.on('effect', (event) => {
    const cmd = (event as { data?: BridgeCommand }).data;
    if (cmd?.t === 'cmd' && cmd.kind === 'ns.ping') {
      pocket.post({ t: 'result', id: cmd.id, result: `pong ${cmd.payload?.n ?? 0}` });
    }
  });
  pocket.src = `~/assets/pocket/${staged.app}`;
  root.addChild(pocket);
  page.content = root;
  return page;
}

Application.run({
  create: () => {
    const frame = new Frame();
    frame.navigate({ create: createMainPage });
    return frame;
  },
});
