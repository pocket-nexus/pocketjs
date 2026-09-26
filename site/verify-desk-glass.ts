// Browser-side regression: white app pixels must not erase the baked reflection.
import { DeskCompositor } from "./desk/compositor.js";
import { hitScreen } from "./desk/geometry.ts";

export function checkGlass(projection: any, plate: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:-3000px;top:0;width:1280px;height:960px";
  document.body.append(canvas);
  const compositor = new DeskCompositor(canvas, plate, projection.screens);
  const app = document.createElement("canvas"); app.width = app.height = 16;
  const ctx = app.getContext("2d")!;
  const outputs = new Map(projection.screens.map((screen: any) => [screen.node,
    { canvas: app, rect: [0, 0, 1, 1], version: 1 }]));
  const render = (color: string, version: number) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 16);
    for (const output of outputs.values() as any) output.version = version;
    compositor.draw(outputs);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    compositor.gl.readPixels(0, 0, canvas.width, canvas.height, compositor.gl.RGBA, compositor.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  try {
    const black = render("#000", 1), white = render("#fff", 2);
    return projection.screens.map((screen: any) => {
      let min = 256, max = -1, low = 0, high = 0;
      // Sample inset screen points; skip silhouette antialiasing and UV edges.
      for (let y = 0; y < canvas.height; y += 3) for (let x = 0; x < canvas.width; x += 3) {
        const uv = hitScreen(screen, (x + .5) / canvas.width, (y + .5) / canvas.height);
        if (!uv || uv.some(v => v < .08 || v > .92)) continue;
        const i = (y * canvas.width + x) * 4;
        const brightness = (black[i] + black[i + 1] + black[i + 2]) / 3;
        if (brightness < min) { min = brightness; low = i; }
        if (brightness > max) { max = brightness; high = i; }
      }
      const brightness = (i: number) => (white[i] + white[i + 1] + white[i + 2]) / 3;
      const whiteSpan = brightness(high) - brightness(low), reflectionSpan = max - min;
      if (reflectionSpan <= 0 || whiteSpan < reflectionSpan * .30)
        throw Error(`${screen.node}: white app erased the reflection (${whiteSpan}/${reflectionSpan})`);
      if (brightness(low) > 235) throw Error(`${screen.node}: panel white has no highlight headroom`);
      return { node: screen.node, reflectionSpan, whiteSpan, retainedContrast: whiteSpan / reflectionSpan };
    });
  } finally { compositor.dispose(); canvas.remove(); }
}
