//! The instanced GLES 3 forward renderer. Vertex lighting: a sun, a hemisphere
//! and distance fog are computed per vertex; entities that share a mesh draw in
//! one instanced call.
use crate::{
    gl::*,
    math::{self, Mat4, Vec3},
    shapes::{self, Shape},
    world::{Particle, Scene, FLAG_SHADOW, FLAG_VISIBLE, STRIDE},
};
use std::ffi::c_void;

const INSTANCE_FLOATS: usize = 18;
const MAX_INSTANCES: usize = 8192;

const VERTEX: &str = "#version 300 es
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_r0;
in vec4 i_r1;
in vec4 i_r2;
in vec4 i_color;
in vec2 i_extra;
uniform mat4 u_vp;
uniform vec3 u_sun;
uniform vec3 u_sun_color;
uniform vec3 u_top;
uniform vec3 u_bottom;
uniform vec3 u_eye;
uniform vec2 u_fog;
out lowp vec4 v_color;
out mediump float v_fog;
void main() {
  vec4 p = vec4(a_pos, 1.0);
  vec3 world = vec3(dot(i_r0, p), dot(i_r1, p), dot(i_r2, p));
  vec3 c0 = vec3(i_r0.x, i_r1.x, i_r2.x);
  vec3 c1 = vec3(i_r0.y, i_r1.y, i_r2.y);
  vec3 c2 = vec3(i_r0.z, i_r1.z, i_r2.z);
  vec3 n = normalize(c0 * a_normal.x / dot(c0, c0) + c1 * a_normal.y / dot(c1, c1) + c2 * a_normal.z / dot(c2, c2));
  vec3 lit = mix(u_bottom, u_top, n.y * 0.5 + 0.5) + u_sun_color * max(dot(n, -u_sun), 0.0);
  v_color = vec4(i_color.rgb * mix(lit, vec3(1.0), i_color.a), i_extra.x);
  v_fog = clamp((distance(world, u_eye) - u_fog.x) / max(u_fog.y - u_fog.x, 0.001), 0.0, 1.0);
  gl_Position = u_vp * vec4(world, 1.0);
}
";
const FRAGMENT: &str = "#version 300 es
precision mediump float;
in lowp vec4 v_color;
in mediump float v_fog;
uniform vec3 u_fog_color;
out vec4 out_color;
void main() {
  out_color = vec4(mix(v_color.rgb, u_fog_color, v_fog), v_color.a);
}
";
const SHADOW_VERTEX: &str = "#version 300 es
in vec3 a_pos;
in vec3 i_center;
in vec2 i_size;
uniform mat4 u_vp;
out mediump vec2 v_uv;
out lowp float v_alpha;
void main() {
  v_uv = a_pos.xz * 2.0;
  v_alpha = i_size.y;
  gl_Position = u_vp * vec4(i_center + vec3(a_pos.x * i_size.x, 0.0, a_pos.z * i_size.x), 1.0);
}
";
const SHADOW_FRAGMENT: &str = "#version 300 es
precision mediump float;
in mediump vec2 v_uv;
in lowp float v_alpha;
out vec4 out_color;
void main() {
  float d = 1.0 - clamp(dot(v_uv, v_uv), 0.0, 1.0);
  out_color = vec4(0.0, 0.0, 0.0, d * d * v_alpha);
}
";

struct Mesh {
    vao: u32,
    vertex_buffer: u32,
    index_buffer: u32,
    index_count: i32,
}

struct Locations {
    vp: i32,
    sun: i32,
    sun_color: i32,
    top: i32,
    bottom: i32,
    eye: i32,
    fog: i32,
    fog_color: i32,
}

pub struct Renderer {
    program: u32,
    at: Locations,
    shadow_program: u32,
    shadow_vp: i32,
    meshes: Vec<Mesh>,
    builtin_meshes: usize,
    instances: u32,
    opaque: Vec<Vec<f32>>,
    blended: Vec<Vec<f32>>,
    shadows: Vec<f32>,
    /// The last frame's view-projection, for projecting anchors.
    pub view_projection: Mat4,
}

impl Renderer {
    /// # Safety
    /// A GLES 3 context must be current on this thread.
    pub unsafe fn new() -> anyhow::Result<Self> {
        let program = program(
            VERTEX,
            FRAGMENT,
            &[
                "a_pos", "a_normal", "i_r0", "i_r1", "i_r2", "i_color", "i_extra",
            ],
        )?;
        let at = Locations {
            vp: uniform(program, "u_vp"),
            sun: uniform(program, "u_sun"),
            sun_color: uniform(program, "u_sun_color"),
            top: uniform(program, "u_top"),
            bottom: uniform(program, "u_bottom"),
            eye: uniform(program, "u_eye"),
            fog: uniform(program, "u_fog"),
            fog_color: uniform(program, "u_fog_color"),
        };
        let shadow_program = self::program(
            SHADOW_VERTEX,
            SHADOW_FRAGMENT,
            &["a_pos", "unused", "i_center", "i_size"],
        )?;
        let shadow_vp = uniform(shadow_program, "u_vp");
        let mut instances = 0;
        glGenBuffers(1, &mut instances);
        let mut renderer = Self {
            program,
            at,
            shadow_program,
            shadow_vp,
            meshes: Vec::new(),
            builtin_meshes: 0,
            instances,
            opaque: Vec::new(),
            blended: Vec::new(),
            shadows: Vec::new(),
            view_projection: [0.0; 16],
        };
        for (_, shape) in shapes::builtin() {
            renderer.add_mesh(&shape);
        }
        renderer.builtin_meshes = renderer.meshes.len();
        Ok(renderer)
    }

    /// # Safety
    /// The renderer's context must be current on this thread.
    pub unsafe fn add_mesh(&mut self, shape: &Shape) -> usize {
        let mut mesh = Mesh {
            vao: 0,
            vertex_buffer: 0,
            index_buffer: 0,
            index_count: shape.indices.len() as i32,
        };
        glGenVertexArrays(1, &mut mesh.vao);
        glBindVertexArray(mesh.vao);
        glGenBuffers(1, &mut mesh.vertex_buffer);
        glBindBuffer(ARRAY_BUFFER, mesh.vertex_buffer);
        glBufferData(
            ARRAY_BUFFER,
            (shape.vertices.len() * 4) as isize,
            shape.vertices.as_ptr() as *const c_void,
            STATIC_DRAW,
        );
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, FLOAT, 0, 24, std::ptr::null());
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, FLOAT, 0, 24, 12 as *const c_void);
        glGenBuffers(1, &mut mesh.index_buffer);
        glBindBuffer(ELEMENT_ARRAY_BUFFER, mesh.index_buffer);
        glBufferData(
            ELEMENT_ARRAY_BUFFER,
            (shape.indices.len() * 2) as isize,
            shape.indices.as_ptr() as *const c_void,
            STATIC_DRAW,
        );
        for attribute in 2..=6 {
            glEnableVertexAttribArray(attribute);
            glVertexAttribDivisor(attribute, 1);
        }
        glBindVertexArray(0);
        self.meshes.push(mesh);
        self.meshes.len() - 1
    }

    /// Drop the meshes a game defined, keeping the built-in shapes.
    ///
    /// # Safety
    /// The renderer's context must be current on this thread.
    pub unsafe fn reset_game_meshes(&mut self) {
        for mesh in self.meshes.drain(self.builtin_meshes..) {
            glDeleteVertexArrays(1, &mesh.vao);
            glDeleteBuffers(1, &mesh.vertex_buffer);
            glDeleteBuffers(1, &mesh.index_buffer);
        }
    }

    /// Draw a scene into the bound framebuffer of size `size`.
    ///
    /// # Safety
    /// The renderer's context must be current on this thread.
    pub unsafe fn draw(
        &mut self,
        scene: &Scene,
        entities: &[f32],
        particles: &[Particle],
        size: [i32; 2],
    ) {
        let aspect = size[0] as f32 / size[1].max(1) as f32;
        self.view_projection = scene.view_projection.unwrap_or_else(|| {
            let view = math::look_at(scene.eye, scene.target, [0.0, 1.0, 0.0]);
            let projection = math::perspective(scene.fov, aspect, scene.near, scene.far);
            math::multiply(&projection, &view)
        });

        for bucket in self.opaque.iter_mut().chain(self.blended.iter_mut()) {
            bucket.clear();
        }
        self.opaque.resize(self.meshes.len(), Vec::new());
        self.blended.resize(self.meshes.len(), Vec::new());
        self.shadows.clear();

        let mut count = 0;
        for entity in entities.chunks_exact(STRIDE) {
            let flags = entity[14] as u32;
            if flags & FLAG_VISIBLE == 0 || count >= MAX_INSTANCES {
                continue;
            }
            let mesh = entity[13] as usize;
            if mesh >= self.meshes.len() {
                continue;
            }
            count += 1;
            let position = [entity[0], entity[1], entity[2]];
            let scale = [entity[6], entity[7], entity[8]];
            let rows = math::affine_rows(position, [entity[3], entity[4], entity[5]], scale);
            let alpha = entity[15];
            let bucket = if alpha < 0.999 {
                &mut self.blended[mesh]
            } else {
                &mut self.opaque[mesh]
            };
            bucket.extend_from_slice(&rows);
            bucket.extend_from_slice(&[entity[9], entity[10], entity[11], entity[12], alpha, 0.0]);
            if flags & FLAG_SHADOW != 0 {
                let height = (position[1] - scene.ground).max(0.0);
                let radius = scale[0].abs().max(scale[2].abs()) * 1.25 + height * 0.2;
                let strength = (0.42 - height * 0.05).max(0.05) * alpha;
                self.shadows.extend_from_slice(&[
                    position[0],
                    scene.ground + 0.012,
                    position[2],
                    radius,
                    strength,
                ]);
            }
        }
        for particle in particles {
            let bucket = &mut self.opaque[0];
            let s = particle.size * (particle.life / particle.span).max(0.0);
            bucket.extend_from_slice(&[
                s,
                0.0,
                0.0,
                particle.position[0],
                0.0,
                s,
                0.0,
                particle.position[1],
                0.0,
                0.0,
                s,
                particle.position[2],
            ]);
            bucket.extend_from_slice(&[
                particle.color[0],
                particle.color[1],
                particle.color[2],
                1.0,
                1.0,
                0.0,
            ]);
        }

        glEnable(DEPTH_TEST);
        glDepthFunc(LEQUAL);
        glDepthMask(1);
        glEnable(CULL_FACE);
        glDisable(BLEND);
        if scene.clear {
            glClearColor(scene.sky[0], scene.sky[1], scene.sky[2], 1.0);
            glClear(COLOR_BUFFER_BIT | DEPTH_BUFFER_BIT);
        }

        glUseProgram(self.program);
        glUniformMatrix4fv(self.at.vp, 1, 0, self.view_projection.as_ptr());
        let sun = math::normalize(scene.sun);
        glUniform3f(self.at.sun, sun[0], sun[1], sun[2]);
        set3(self.at.sun_color, scene.sun_color);
        set3(self.at.top, scene.ambient_top);
        set3(self.at.bottom, scene.ambient_bottom);
        set3(self.at.eye, scene.eye);
        glUniform2f(self.at.fog, scene.fog_near, scene.fog_far);
        set3(self.at.fog_color, scene.fog_color);

        glBindBuffer(ARRAY_BUFFER, self.instances);
        // Orphan the stream: last frame's instances may still be in flight.
        let total: usize = self
            .opaque
            .iter()
            .chain(self.blended.iter())
            .map(Vec::len)
            .sum();
        if total > 0 {
            glBufferData(
                ARRAY_BUFFER,
                (total * 4) as isize,
                std::ptr::null(),
                STREAM_DRAW,
            );
        }
        let mut offset = 0usize;
        let upload = |bucket: &Vec<f32>, offset: usize| {
            glBufferSubData(
                ARRAY_BUFFER,
                offset as isize,
                (bucket.len() * 4) as isize,
                bucket.as_ptr() as *const c_void,
            );
        };
        for (index, mesh) in self.meshes.iter().enumerate() {
            let bucket = &self.opaque[index];
            if bucket.is_empty() {
                continue;
            }
            upload(bucket, offset);
            draw_instanced(mesh, offset, bucket.len() / INSTANCE_FLOATS);
            offset += bucket.len() * 4;
        }

        if !self.shadows.is_empty() {
            self.draw_shadows();
            glUseProgram(self.program);
            glBindBuffer(ARRAY_BUFFER, self.instances);
        }

        glEnable(BLEND);
        glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
        glDepthMask(0);
        for (index, mesh) in self.meshes.iter().enumerate() {
            let bucket = &self.blended[index];
            if bucket.is_empty() {
                continue;
            }
            upload(bucket, offset);
            draw_instanced(mesh, offset, bucket.len() / INSTANCE_FLOATS);
            offset += bucket.len() * 4;
        }
        glDepthMask(1);
        glDisable(BLEND);
        glBindVertexArray(0);
    }

    unsafe fn draw_shadows(&mut self) {
        // The plane mesh, with a five-float instance: center and size, strength.
        let mesh = &self.meshes[1];
        glUseProgram(self.shadow_program);
        glUniformMatrix4fv(self.shadow_vp, 1, 0, self.view_projection.as_ptr());
        glBindVertexArray(mesh.vao);
        let mut buffer = 0;
        glGenBuffers(1, &mut buffer);
        glBindBuffer(ARRAY_BUFFER, buffer);
        glBufferData(
            ARRAY_BUFFER,
            (self.shadows.len() * 4) as isize,
            self.shadows.as_ptr() as *const c_void,
            STREAM_DRAW,
        );
        glVertexAttribPointer(2, 3, FLOAT, 0, 20, std::ptr::null());
        glVertexAttribPointer(3, 2, FLOAT, 0, 20, 12 as *const c_void);
        for attribute in [4, 5, 6] {
            glDisableVertexAttribArray(attribute);
        }
        glEnable(BLEND);
        glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
        glDepthMask(0);
        glDrawElementsInstanced(
            TRIANGLES,
            mesh.index_count,
            UNSIGNED_SHORT,
            std::ptr::null(),
            (self.shadows.len() / 5) as i32,
        );
        glDepthMask(1);
        glDisable(BLEND);
        for attribute in [4, 5, 6] {
            glEnableVertexAttribArray(attribute);
        }
        glDeleteBuffers(1, &buffer);
    }
}

unsafe fn set3(location: i32, value: Vec3) {
    glUniform3f(location, value[0], value[1], value[2]);
}

unsafe fn draw_instanced(mesh: &Mesh, offset: usize, count: usize) {
    glBindVertexArray(mesh.vao);
    let stride = (INSTANCE_FLOATS * 4) as i32;
    let at = |floats: usize| (offset + floats * 4) as *const c_void;
    glVertexAttribPointer(2, 4, FLOAT, 0, stride, at(0));
    glVertexAttribPointer(3, 4, FLOAT, 0, stride, at(4));
    glVertexAttribPointer(4, 4, FLOAT, 0, stride, at(8));
    glVertexAttribPointer(5, 4, FLOAT, 0, stride, at(12));
    glVertexAttribPointer(6, 2, FLOAT, 0, stride, at(16));
    glDrawElementsInstanced(
        TRIANGLES,
        mesh.index_count,
        UNSIGNED_SHORT,
        std::ptr::null(),
        count as i32,
    );
}
