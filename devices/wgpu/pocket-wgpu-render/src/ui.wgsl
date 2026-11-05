// pocket-ui: one pipeline for the whole DrawList.
// mode 0 = solid vertex color, 1 = image texture x modulate color,
// 2 = glyph coverage (R8) x text color.
//
// DrawList colors are sRGB-encoded bytes; linearize here so the sRGB target
// re-encodes correctly on store.

override LINEAR_OUTPUT: bool = true;

struct VsIn {
    @location(0) pos: vec2f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f,
    @location(3) mode: u32,
    @location(4) bounds: vec4f,
};

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
    @location(2) @interpolate(flat) mode: u32,
    @location(3) @interpolate(flat) bounds: vec4f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    out.pos = vec4f(in.pos, 0.0, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    out.mode = in.mode;
    out.bounds = in.bounds;
    return out;
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

fn srgb_to_linear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    // Atlas pages have transparent guards, but glyph scaling clamps to the
    // glyph's own edge texel centers, matching the original atlas sampler.
    let uv = select(in.uv, clamp(in.uv, in.bounds.xy, in.bounds.zw), in.mode == 2u);
    let t = textureSample(tex, samp, uv);
    var rgb = in.color.rgb;
    if LINEAR_OUTPUT { rgb = srgb_to_linear(rgb); }
    var a = in.color.a;
    if in.mode == 1u {
        // Image: sRGB texture already sampled linear; modulate.
        rgb = rgb * t.rgb;
        a = a * t.a;
    } else if in.mode == 2u {
        // Glyph: R8 coverage scales alpha.
        a = a * t.r;
    }
    return vec4f(rgb, a);
}
