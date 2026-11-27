// platforms/web/ui-layer.js — a guest's interface as a transparent layer over
// a page's own content (a WebGPU or WebGL scene in another canvas).
//
// `createUiLayer(canvas, instance)` draws the AppInstance's primary surface
// into `canvas` with its coverage: `instance.renderPremultiplied(scale)`
// rasterizes premultiplied RGBA whose alpha is 0 where the guest draws
// nothing, and a WebGL2 context created with `premultipliedAlpha: true`
// shows it as it is, so the browser composites the layer over whatever lies
// beneath it. `present()` rasterizes and uploads only when the draw hash or
// the size changed since the last upload; it returns whether it did.
//
// The layer takes the page's pointer events (createBrowserInput listens on
// it). Whether the interface claims a point is the bounds hit query the
// guest's own input uses: `claims(x, y)` is true when a node with paint lies
// under the logical point.

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() {
  uv = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D picture;
in vec2 uv;
out vec4 color;
void main() { color = texture(picture, uv); }`;

export function createUiLayer(canvas, instance) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error("ui-layer: WebGL2 is not available");
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`ui-layer: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`ui-layer: ${gl.getProgramInfoLog(program)}`);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let lastHash = null, lastKey = "";

  return {
    /** Rasterize at `scale` physical px a logical px and show the result when
     *  the guest's draw hash or the layer's size changed. */
    present(scale = 1) {
      const [w, h] = instance.viewport;
      const key = `${w}x${h}@${scale}`;
      const hash = instance.drawHash();
      if (hash === lastHash && key === lastKey) return false;
      const pixels = instance.renderPremultiplied(scale);
      if (!pixels) throw new Error("ui-layer: this pocketjs.wasm has no premultiplied rendering");
      const pw = w * scale, ph = h * scale;
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      gl.viewport(0, 0, pw, ph);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      lastHash = hash;
      lastKey = key;
      return true;
    },
    /** True when a painted node of the committed frame lies under the logical point. */
    claims(x, y) {
      return instance.hitTestBounds(x, y) !== 0;
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(corners);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
