// Only the display triangles are drawn. Every other pixel stays in the baked plate.
const VERTEX = `
attribute vec3 position;
attribute vec2 uv;
varying vec2 screenUv;
void main() {
  gl_Position = vec4((position.xy * 2.0 - 1.0) * position.z, 0.0, position.z);
  screenUv = uv;
}`;
const FRAGMENT = `
precision mediump float;
uniform sampler2D appTexture;
uniform sampler2D plateTexture;
uniform vec2 resolution;
uniform vec4 contentRect;
varying vec2 screenUv;
void main() {
  vec2 p = (screenUv - contentRect.xy) / contentRect.zw;
  vec3 app = vec3(0.0);
  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0)
    app = texture2D(appTexture, p).rgb;
  vec3 glass = texture2D(plateTexture, gl_FragCoord.xy / resolution).rgb;
  // A full-white framebuffer used to cancel the glass term in screen blending.
  // Reserve display-referred headroom: panel white is 0.64, reflected light
  // can still rise above it. Black pixels and letterboxing retain the plate.
  // The AgX plate is already tone-mapped; this is an image-space composite.
  vec3 panel = app * 0.64;
  gl_FragColor = vec4(panel + glass * (1.0 - panel), 1.0);
}`;

export class DeskCompositor {
  constructor(canvas, plate, screens) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) throw Error("WebGL is unavailable. Showing the original render.");
    const shader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = this.program = gl.createProgram();
    const vs = shader(gl.VERTEX_SHADER, VERTEX), fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.position = gl.getAttribLocation(program, "position");
    this.uv = gl.getAttribLocation(program, "uv");
    this.resolution = gl.getUniformLocation(program, "resolution");
    this.rect = gl.getUniformLocation(program, "contentRect");
    gl.uniform1i(gl.getUniformLocation(program, "appTexture"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "plateTexture"), 1);
    this.plate = this.texture(plate);
    this.screens = screens.map(screen => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(screen.vertices.flat()), gl.STATIC_DRAW);
      return { screen, buffer, texture: null, version: -1 };
    });
  }

  texture(source) {
    const gl = this.gl, texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return texture;
  }

  draw(outputs) {
    const gl = this.gl, canvas = this.canvas;
    const width = Math.max(1, Math.round(Math.min(2560, canvas.clientWidth * Math.min(2, devicePixelRatio))));
    const height = Math.round(width * 3 / 4);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.resolution, width, height);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.plate);
    for (const entry of this.screens) {
      const output = outputs.get(entry.screen.node);
      if (!output || !output.version) continue;
      gl.activeTexture(gl.TEXTURE0);
      if (!entry.texture) entry.texture = this.texture(output.canvas);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (entry.version !== output.version) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, output.canvas);
        entry.version = output.version;
      }
      gl.uniform4fv(this.rect, output.rect);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.enableVertexAttribArray(this.position); gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(this.uv); gl.vertexAttribPointer(this.uv, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, entry.screen.vertices.length);
    }
  }

  dispose() {
    const gl = this.gl;
    for (const entry of this.screens) { gl.deleteBuffer(entry.buffer); if (entry.texture) gl.deleteTexture(entry.texture); }
    gl.deleteTexture(this.plate); gl.deleteProgram(this.program);
  }
}
