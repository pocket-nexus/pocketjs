// Skinned/static models: base color texture, hemisphere + sun lighting.

struct Globals {
    view_proj: mat4x4f,
    inverse_view_proj: mat4x4f,
    cam_pos: vec4f,
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sky_sun_dir: vec4f,
    sky_sun_color: vec4f,
    model_sun_dir: vec4f,
    model_sun_color: vec4f,
    model_ambient: vec4f,
    // x: band count, y: wrap, z: enabled
    toon: vec4f,
    // rgb: color, w: strength
    rim_color: vec4f,
    // x: exponent
    rim_params: vec4f,
    // rgb: color, w: enabled
    fog_color: vec4f,
    // x: start, y: end
    fog_params: vec4f,
}

struct Instance {
    model: mat4x4f,
    normal_model: mat4x4f,
    tint: vec4f,
    // x: lit amount, y: alpha-test cutoff (0 = off), z/w unused
    params: vec4f,
}

struct Material {
    base_color_factor: vec4f,
    // x: unlit, y: alpha-test cutoff, z: double-sided, w: alpha blend
    params: vec4f,
    // x: monochrome base color, y/z/w reserved
    style: vec4f,
}

@group(0) @binding(0) var<uniform> globals: Globals;

@group(1) @binding(0) var t_albedo: texture_2d<f32>;
@group(1) @binding(1) var s_albedo: sampler;
@group(1) @binding(2) var<uniform> material: Material;

@group(2) @binding(0) var<uniform> instance: Instance;
@group(2) @binding(1) var<storage, read> joints: array<mat4x4f>;

struct VsIn {
    @location(0) pos: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) joints: vec4u,
    @location(4) weights: vec4f,
}

struct VsOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) normal: vec3f,
    @location(2) world_pos: vec3f,
}

fn safe_normalize(v: vec3f) -> vec3f {
    let length_squared = dot(v, v);
    if length_squared > 1e-10 {
        return v * inverseSqrt(length_squared);
    }
    return vec3f(0.0);
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var skin = mat4x4f(
        vec4f(1.0, 0.0, 0.0, 0.0),
        vec4f(0.0, 1.0, 0.0, 0.0),
        vec4f(0.0, 0.0, 1.0, 0.0),
        vec4f(0.0, 0.0, 0.0, 1.0),
    );
    let wsum = in.weights.x + in.weights.y + in.weights.z + in.weights.w;
    if wsum > 0.001 {
        skin = in.weights.x * joints[in.joints.x]
            + in.weights.y * joints[in.joints.y]
            + in.weights.z * joints[in.joints.z]
            + in.weights.w * joints[in.joints.w];
    }
    let skinned_pos = skin * vec4f(in.pos, 1.0);
    let skinned_normal = (skin * vec4f(in.normal, 0.0)).xyz;
    let wp = instance.model * skinned_pos;

    var out: VsOut;
    out.clip = globals.view_proj * wp;
    out.uv = in.uv;
    out.normal = safe_normalize(
        (instance.normal_model * vec4f(skinned_normal, 0.0)).xyz,
    );
    out.world_pos = wp.xyz;
    return out;
}

fn diffuse_amount(normal: vec3f) -> f32 {
    let light_dir = safe_normalize(globals.model_sun_dir.xyz);
    let lambert = dot(normal, light_dir);
    if globals.toon.z < 0.5 {
        return max(lambert, 0.0);
    }

    let wrap = clamp(globals.toon.y, 0.0, 1.0);
    var diffuse = clamp((lambert + wrap) / (1.0 + wrap), 0.0, 1.0);
    let steps = floor(globals.toon.x + 0.5);
    if steps >= 2.0 {
        let highest_band = steps - 1.0;
        diffuse = min(floor(diffuse * steps), highest_band) / highest_band;
    }
    return diffuse;
}

fn distance_fog(world_pos: vec3f) -> f32 {
    if globals.fog_color.w < 0.5 {
        return 0.0;
    }
    let distance_to_camera = distance(world_pos, globals.cam_pos.xyz);
    return smoothstep(globals.fog_params.x, globals.fog_params.y, distance_to_camera);
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
    let material_albedo = textureSample(t_albedo, s_albedo, in.uv)
        * material.base_color_factor;
    var albedo = material_albedo * instance.tint;
    if material.style.x > 0.5 {
        // Texture samples are already linearized by the sRGB texture view.
        // Rec. 709 luminance removes hue without changing transparency.
        let luminance = dot(albedo.rgb, vec3f(0.2126, 0.7152, 0.0722));
        albedo = vec4f(vec3f(luminance), albedo.a);
    }
    let alpha_cutoff = max(instance.params.y, material.params.y);
    if alpha_cutoff > 0.0 && material_albedo.a < alpha_cutoff {
        discard;
    }
    var n = normalize(in.normal);
    if material.params.z > 0.5 && !front_facing {
        n = -n;
    }
    let sun = diffuse_amount(n);
    // Colored shadow fill below and cool sky fill above. The coefficients
    // retain the previous default exposure while making model ambient active.
    let hemi = mix(
        globals.model_ambient.rgb * 0.72,
        globals.model_ambient.rgb * 0.58 + globals.sky_zenith.rgb * 0.56,
        n.y * 0.5 + 0.5,
    );
    let view_dir = safe_normalize(globals.cam_pos.xyz - in.world_pos);
    let rim = pow(1.0 - max(dot(n, view_dir), 0.0), globals.rim_params.x)
        * globals.rim_color.w;
    let lit_amount = instance.params.x * (1.0 - material.params.x);
    let lighting = mix(
        vec3f(1.0),
        hemi + globals.model_sun_color.rgb * sun * 0.95
            + globals.rim_color.rgb * rim,
        lit_amount,
    );
    let alpha = select(1.0, material_albedo.a, material.params.w > 0.5)
        * clamp(instance.tint.a, 0.0, 1.0);
    let color = mix(
        albedo.rgb * lighting,
        globals.fog_color.rgb,
        distance_fog(in.world_pos),
    );
    return vec4f(color, alpha);
}
