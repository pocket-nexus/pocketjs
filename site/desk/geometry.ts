export type Vertex = [number, number, number, number, number];
export interface ScreenBinding {
  node: string;
  device: string;
  surface: string;
  framebuffer_size: [number, number];
  vertices: Vertex[];
}

/** Camera-space barycentrics need reciprocal depth to recover the source UV. */
export function hitScreen(screen: ScreenBinding, x: number, y: number) {
  const vs = screen.vertices;
  for (let i = 0; i < vs.length; i += 3) {
    const [a, b, c] = vs.slice(i, i + 3);
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
    const w = 1 - u - v;
    if (Math.min(u, v, w) < -1e-6) continue;
    const weights = [u / a[2], v / b[2], w / c[2]];
    const sum = weights.reduce((s, n) => s + n, 0);
    return [3, 4].map(k => weights.reduce((s, n, j) => s + n * [a, b, c][j][k], 0) / sum) as [number, number];
  }
  return null;
}

export function contentRect(screenSize: readonly number[], appSize: readonly number[]) {
  const ratio = (appSize[0] / appSize[1]) / (screenSize[0] / screenSize[1]);
  const width = Math.min(1, ratio), height = Math.min(1, 1 / ratio);
  return [(1 - width) / 2, (1 - height) / 2, width, height];
}

export function appPoint(uv: readonly number[], rect: readonly number[], size: readonly number[]) {
  const x = (uv[0] - rect[0]) / rect[2], y = 1 - (uv[1] - rect[1]) / rect[3];
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [Math.min(size[0] - 1, Math.floor(x * size[0])), Math.min(size[1] - 1, Math.floor(y * size[1]))] as [number, number];
}
