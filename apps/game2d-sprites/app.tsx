// A game2d stage under load: moving, mirrored, animated sprites under a panning camera, with
// background bands, a HUD bar and a line of text. It compares the stage's two paths on one host:
// draw items (one native call per run of images) and one node per image.
//
//   SELECT        switch path (the stage remounts)
//   UP / DOWN     20 sprites more / fewer
//
// `globalThis.__sprites` reports the frame, path, sprite count and the stage's draw counts.
// Before boot, `__spritesPath = "nodes"` starts on the node path and `__spritesCount` sets the count.
import { createSignal, Show } from "solid-js";
import { getOps } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN, createStage, createTexturePool, rgb, type PackImage, type PackStore } from "@pocketjs/framework/game2d";
import { PSM } from "../../contracts/spec/spec.ts";

const W = 480, H = 272, SIZE = 32, MAX = 400;

// Sprite frames are drawn into textures here, so the bench needs no pack. A PackImage whose handle
// is already live is what the texture pool returns as is.
function spriteImage(handle: number): PackImage {
  return { pack: "bench", name: "", off: 0, len: 0, tw: SIZE, th: SIZE, w: SIZE, h: SIZE, ox: 0, oy: 0, fw: SIZE, fh: SIZE, ax: SIZE / 2, ay: SIZE, handle, used: 0, fails: 0, retryAt: 0 };
}
function makeFrames(): PackImage[] {
  const ops = getOps();
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
      out.push(spriteImage(ops.uploadTexture(new Uint8Array(px.buffer), SIZE, SIZE, PSM.PSM_8888)));
    }
  }
  return out;
}

// Integer state, seeded: every host sees the same run.
const xs = new Int32Array(MAX), ys = new Int32Array(MAX), vxs = new Int32Array(MAX), vys = new Int32Array(MAX);
let seed = 0x2f6e2b1;
const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
for (let i = 0; i < MAX; i++) {
  xs[i] = rand((W + 160) * 16); ys[i] = (SIZE + rand(H - SIZE)) * 16;
  vxs[i] = (rand(2) ? 1 : -1) * (8 + rand(24)); vys[i] = (rand(2) ? 1 : -1) * (4 + rand(16));
}
function step(count: number) {
  for (let i = 0; i < count; i++) {
    let x = xs[i] + vxs[i], y = ys[i] + vys[i];
    if (x < 0 || x > (W + 160) * 16) { vxs[i] = -vxs[i]; x = xs[i]; }
    if (y < SIZE * 16 || y > H * 16) { vys[i] = -vys[i]; y = ys[i]; }
    xs[i] = x; ys[i] = y;
  }
}

const store = { loadImage: () => -1 } as unknown as PackStore;
const tex = createTexturePool(store, 1 << 20);
const report = { frame: 0, path: "", count: 0, images: 0, rects: 0, texts: 0, dropped: 0 };
(globalThis as Record<string, unknown>).__sprites = report;

function Bench(props: { items: boolean; count: () => number }) {
  const stage = createStage({ width: W, height: H, images: MAX + 8, rects: 16, texts: 8, tex, drawItems: props.items });
  const gfx = stage.gfx, frames = makeFrames(), bands = [rgb(0x1c2a3a), rgb(0x22344a), rgb(0x2a405a), rgb(0x324c6a)];
  let frame = 0;
  onFrame(() => {
    frame++;
    const count = props.count();
    step(count);
    gfx.begin();
    for (let b = 0; b < 4; b++) gfx.rect(0, b * 68, W, 68, bands[b]);
    gfx.origin(-((frame * 2) % 160), 0);
    for (let i = 0; i < count; i++) {
      const left = vxs[i] < 0, img = frames[((i & 3) << 1) | (((frame >> 2) + i) & 1)];
      gfx.sprite(img, xs[i] >> 4, ys[i] >> 4, left ? FLIP : undefined);
      // Name tags between sprites: the sprites drawn after a tag cover it.
      if (i % 40 === 0) gfx.text(`#${i}`, (xs[i] >> 4) - 8, (ys[i] >> 4) - SIZE - 14);
    }
    gfx.origin(0, 0);
    gfx.rect(0, 0, W, 18, rgb(0x0c0605), 0.8);
    gfx.text(plain ? `${count} sprites` : `${props.items ? "draw items" : "nodes"}  ${count} sprites`, 6, 2);
    gfx.end();
    const s = gfx.stats();
    report.frame++; report.path = props.items ? "items" : "nodes"; report.count = count;
    report.images = s.images; report.rects = s.rects; report.texts = s.texts; report.dropped = s.dropped;
  });
  return <stage.View />;
}
const FLIP = { flip: true };
// `__spritesPlain` leaves the path out of the label, so both paths can be compared pixel for pixel.
const plain = (globalThis as Record<string, unknown>).__spritesPlain === true;

export default function App() {
  const [items, setItems] = createSignal((globalThis as Record<string, unknown>).__spritesPath !== "nodes");
  const [count, setCount] = createSignal(Number((globalThis as Record<string, unknown>).__spritesCount ?? 80));
  let prev = 0;
  onFrame((buttons: number) => {
    const edge = buttons & ~prev;
    prev = buttons;
    if (edge & BTN.SELECT) setItems(!items());
    if (edge & BTN.UP) setCount(Math.min(MAX, count() + 20));
    if (edge & BTN.DOWN) setCount(Math.max(0, count() - 20));
  });
  return (
    <View class="w-full h-full bg-black">
      <Show when={items()} fallback={<Bench items={false} count={count} />}>
        <Bench items={true} count={count} />
      </Show>
    </View>
  );
}
