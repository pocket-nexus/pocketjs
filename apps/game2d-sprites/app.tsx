// Load for game2d's drawing paths, in two scenes:
//
//   sprites  moving, mirrored, animated sprites with name tags between them, all redrawn every
//            frame; SELECT switches the layer between draw items and one node per image.
//   world    a scrolling 12×8-chunk map with walkers. SELECT switches between the layered form
//            (a tile layer and a walker layer inside a camera) and the frame-wide form (everything
//            drawn every frame, the camera applied as an offset to every draw call).
//
//   START         next scene
//   UP / DOWN     20 sprites more / fewer
//
// Before boot, `__sprites{Scene,Path,Count,Plain}` choose the starting scene, its path ("nodes" or
// "flat" for the second form of each scene), the sprite count, and a label without the path, so
// both paths of a scene can be compared pixel for pixel. `globalThis.__sprites` reports the frame.
import { createSignal, Match, Switch } from "solid-js";
import { getOps } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  BTN, createCamera, createDirector, createInput, createLayer, createLoop, createTexturePool, createTileLayer, rgb,
  type PackImage, type PackStore,
} from "@pocketjs/framework/game2d";
import { PSM } from "../../contracts/spec/spec.ts";

const W = 480, H = 272, SIZE = 32, MAX = 400, CHUNK = 128, COLS = 12, ROWS = 8;
const g = globalThis as Record<string, unknown>;
const plain = g.__spritesPlain === true;

// Pictures are drawn into textures here, so the bench needs no pack. A PackImage whose handle is
// already live is what the texture pool returns as is.
function image(handle: number, size: number, ax: number, ay: number): PackImage {
  return { pack: "bench", name: "", off: 0, len: 0, tw: size, th: size, w: size, h: size, ox: 0, oy: 0, fw: size, fh: size, ax, ay, handle, used: 0, fails: 0, retryAt: 0, pins: 0 };
}
function upload(px: Uint32Array, size: number) {
  return getOps().uploadTexture(new Uint8Array(px.buffer), size, size, PSM.PSM_8888);
}
function makeBirds(): PackImage[] {
  const colors = [0xffe0a040, 0xff40c0e0, 0xff80e060, 0xffe060c0];
  const out: PackImage[] = [];
  for (let c = 0; c < colors.length; c++) {
    for (let wing = 0; wing < 2; wing++) {
      const px = new Uint32Array(SIZE * SIZE);
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const dx = x - 12, dy = y - 18;
        const body = dx * dx + dy * dy < 64, head = (x - 22) * (x - 22) + (y - 12) * (y - 12) < 16;
        const wingY = wing ? 6 : 14, inWing = x > 4 && x < 16 && y > wingY && y < wingY + 6;
        px[y * SIZE + x] = body || head ? colors[c] : inWing ? 0xfff4efdc : 0;
      }
      out.push(image(upload(px, SIZE), SIZE, SIZE / 2, SIZE));
    }
  }
  return out;
}
function makeChunks(): PackImage[] {
  const tones = [[0xff2a4a3a, 0xff335a46], [0xff3a4a5a, 0xff445a6a], [0xff4a3a2a, 0xff5a4634], [0xff2a3a5a, 0xff34466a]];
  return tones.map(([a, b]) => {
    const px = new Uint32Array(CHUNK * CHUNK);
    for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) px[y * CHUNK + x] = ((x >> 4) + (y >> 4)) & 1 ? a : b;
    return image(upload(px, CHUNK), CHUNK, 0, 0);
  });
}

// Integer state, seeded: every host sees the same run.
const xs = new Int32Array(MAX), ys = new Int32Array(MAX), vxs = new Int32Array(MAX), vys = new Int32Array(MAX);
let seed = 0x2f6e2b1;
const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
for (let i = 0; i < MAX; i++) {
  xs[i] = rand((W + 160) * 16); ys[i] = (SIZE + rand(H - SIZE)) * 16;
  vxs[i] = (rand(2) ? 1 : -1) * (8 + rand(24)); vys[i] = (rand(2) ? 1 : -1) * (4 + rand(16));
}
function bounce(count: number, w: number, h: number) {
  for (let i = 0; i < count; i++) {
    let x = xs[i] + vxs[i], y = ys[i] + vys[i];
    if (x < 0 || x > w * 16) { vxs[i] = -vxs[i]; x = xs[i]; }
    if (y < SIZE * 16 || y > h * 16) { vys[i] = -vys[i]; y = ys[i]; }
    xs[i] = x; ys[i] = y;
  }
}

const store = { loadImage: () => -1 } as unknown as PackStore;
const tex = createTexturePool(store, 1 << 20);
const report = { frame: 0, scene: "", path: "", count: 0, draws: 0, images: 0, dropped: 0 };
g.__sprites = report;
const FLIP = { flip: true };
const bands = [rgb(0x1c2a3a), rgb(0x22344a), rgb(0x2a405a), rgb(0x324c6a)];
const label = (path: string, count: number) => (plain ? `${count} sprites` : `${path}  ${count} sprites`);

function Sprites(props: { items: boolean; count: () => number }) {
  const layer = createLayer({ width: W, height: H, images: MAX + 8, rects: 16, texts: 8, tex, drawItems: props.items });
  const gfx = layer.gfx, birds = makeBirds();
  let frame = 0;
  onFrame(() => {
    frame++;
    const count = props.count();
    bounce(count, W + 160, H);
    gfx.begin();
    for (let b = 0; b < 4; b++) gfx.rect(0, b * 68, W, 68, bands[b]);
    gfx.origin(-((frame * 2) % 160), 0);
    for (let i = 0; i < count; i++) {
      const img = birds[((i & 3) << 1) | (((frame >> 2) + i) & 1)];
      gfx.sprite(img, xs[i] >> 4, ys[i] >> 4, vxs[i] < 0 ? FLIP : undefined);
      // Name tags between sprites: the sprites drawn after a tag cover it.
      if (i % 40 === 0) gfx.text(`#${i}`, (xs[i] >> 4) - 8, (ys[i] >> 4) - SIZE - 14);
    }
    gfx.origin(0, 0);
    gfx.rect(0, 0, W, 18, rgb(0x0c0605), 0.8);
    gfx.text(label(props.items ? "draw items" : "nodes", count), 6, 2);
    gfx.end();
    const s = layer.stats();
    report.frame++; report.scene = "sprites"; report.path = props.items ? "items" : "nodes"; report.count = count;
    report.draws = s.draws; report.images = s.images; report.dropped = s.dropped;
  });
  return <layer.View />;
}

// A camera path over the map, as a function of the frame: the same on every host.
const MAP_W = COLS * CHUNK, MAP_H = ROWS * CHUNK;
const camAt = (frame: number) => {
  const t = frame % 1200, k = t < 600 ? t / 600 : (1200 - t) / 600;
  return { x: Math.round(k * (MAP_W - W)), y: Math.round(k * (MAP_H - H) * 0.6) };
};
const chunkOf = (chunks: PackImage[], i: number) => chunks[(i * 7 + (i >> 2)) & 3];

function World(props: { layered: boolean; count: () => number }) {
  const chunks = makeChunks(), birds = makeBirds();
  const walkers = (count: number, frame: number, draw: (img: PackImage, x: number, y: number, flip: boolean) => void) => {
    for (let i = 0; i < count; i++) draw(birds[((i & 3) << 1) | (((frame >> 2) + i) & 1)], xs[i] >> 4, ys[i] >> 4, vxs[i] < 0);
  };
  const hud = createLayer({ width: W, height: H, images: 4, rects: 4, texts: 4, tex });
  let frame = 0;
  const finish = (count: number, draws: number, images: number) => {
    hud.gfx.begin();
    hud.gfx.rect(0, 0, W, 18, rgb(0x0c0605), 0.8);
    hud.gfx.text(label(props.layered ? "layers" : "frame-wide", count), 6, 2);
    hud.gfx.end();
    report.frame++; report.scene = "world"; report.path = props.layered ? "layers" : "flat"; report.count = count;
    report.draws = draws; report.images = images; report.dropped = 0;
  };
  if (props.layered) {
    const camera = createCamera({ width: W, height: H });
    const map = createTileLayer({ width: W, height: H, tile: CHUNK, images: 32, rects: 1, texts: 1, tex });
    map.setMap({ cols: COLS, rows: ROWS, image: (i) => chunkOf(chunks, i) });
    const actors = createLayer({ width: W, height: H, images: MAX + 8, rects: 1, texts: 1, tex, clip: false });
    let mapDraws = 0;
    onFrame(() => {
      frame++;
      const count = props.count(), c = camAt(frame);
      bounce(count, MAP_W, MAP_H);
      camera.move(c.x, c.y);
      if (map.frame(c.x, c.y)) mapDraws++;
      const gfx = actors.gfx;
      gfx.begin();
      walkers(count, frame, (img, x, y, flip) => gfx.sprite(img, x, y, flip ? FLIP : undefined));
      gfx.end();
      finish(count, mapDraws, actors.stats().images);
    });
    return (
      <>
        <camera.View><map.View /><actors.View /></camera.View>
        <hud.View />
      </>
    );
  }
  const layer = createLayer({ width: W, height: H, images: MAX + 64, rects: 1, texts: 1, tex });
  onFrame(() => {
    frame++;
    const count = props.count(), c = camAt(frame), gfx = layer.gfx;
    bounce(count, MAP_W, MAP_H);
    gfx.begin();
    gfx.origin(-c.x, -c.y);
    for (let ty = Math.floor(c.y / CHUNK); ty * CHUNK < c.y + H; ty++) for (let tx = Math.floor(c.x / CHUNK); tx * CHUNK < c.x + W; tx++) {
      if (tx < COLS && ty < ROWS) gfx.cell(chunkOf(chunks, ty * COLS + tx), tx * CHUNK, ty * CHUNK);
    }
    walkers(count, frame, (img, x, y, flip) => gfx.sprite(img, x, y, flip ? FLIP : undefined));
    gfx.end();
    finish(count, layer.stats().draws, layer.stats().images);
  });
  return (
    <>
      <layer.View />
      <hud.View />
    </>
  );
}

type SceneName = "sprites" | "world";

export default function App() {
  const [scene, setScene] = createSignal<SceneName>(g.__spritesScene === "world" ? "world" : "sprites");
  const [second, setSecond] = createSignal(g.__spritesPath === "nodes" || g.__spritesPath === "flat");
  const [count, setCount] = createSignal(Number(g.__spritesCount ?? 80));
  const input = createInput({ bindings: { path: BTN.SELECT, scene: BTN.START, confirm: BTN.CIRCLE, back: BTN.CROSS }, confirm: "confirm", back: "back" });
  const loop = createLoop();
  // The director keeps the scene name; the scene's frame work lives in its component.
  const director = createDirector<SceneName>({ scenes: { sprites: {}, world: {} }, initial: scene(), follow: scene });
  onFrame((buttons: number) => {
    input.update(buttons);
    director.sync();
    loop.frame(() => {
      if (input.pressed("path")) setSecond(!second());
      if (input.pressed("scene")) { setScene(scene() === "sprites" ? "world" : "sprites"); setSecond(false); }
      if (input.pressed("up")) setCount(Math.min(MAX, count() + 20));
      if (input.pressed("down")) setCount(Math.max(0, count() - 20));
      input.endStep();
    });
  });
  return (
    <View class="w-full h-full bg-black">
      <Switch>
        <Match when={scene() === "sprites" && !second()}><Sprites items={true} count={count} /></Match>
        <Match when={scene() === "sprites" && second()}><Sprites items={false} count={count} /></Match>
        <Match when={scene() === "world" && !second()}><World layered={true} count={count} /></Match>
        <Match when={scene() === "world" && second()}><World layered={false} count={count} /></Match>
      </Switch>
    </View>
  );
}
