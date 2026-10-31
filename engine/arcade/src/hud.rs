//! 2D quads in a 1280x720 virtual screen: rectangles and text from a
//! coverage atlas filled on first sight of each glyph at each pixel size.
use crate::gl::*;
use ab_glyph::{Font, FontRef, GlyphId, PxScale, ScaleFont};
use std::{collections::HashMap, ffi::c_void};

const ATLAS: i32 = 2048;
const VIRTUAL: [f32; 2] = [1280.0, 720.0];

const VERTEX: &str = "#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec4 a_color;
uniform vec2 u_half;
out mediump vec2 v_uv;
out lowp vec4 v_color;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  gl_Position = vec4(a_pos.x / u_half.x - 1.0, 1.0 - a_pos.y / u_half.y, 0.0, 1.0);
}
";
const FRAGMENT: &str = "#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in mediump vec2 v_uv;
in lowp vec4 v_color;
out vec4 out_color;
void main() {
  out_color = vec4(v_color.rgb, v_color.a * texture(u_atlas, v_uv).r);
}
";
const IMAGE_FRAGMENT: &str = "#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in mediump vec2 v_uv;
in lowp vec4 v_color;
out vec4 out_color;
void main() {
  out_color = texture(u_atlas, v_uv) * v_color;
}
";

#[derive(Clone, Copy)]
struct Glyph {
    uv: [f32; 4],
    size: [f32; 2],
    offset: [f32; 2],
    advance: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Left,
    Center,
    Right,
}

pub struct Hud {
    program: u32,
    image_program: u32,
    vao: u32,
    buffer: u32,
    atlas: u32,
    vertices: Vec<f32>,
    glyphs: HashMap<(char, u16), Glyph>,
    cursor: [i32; 2],
    row: i32,
    font: Option<memmap2::Mmap>,
    half: [f32; 2],
    half_at: i32,
    image_half_at: i32,
}

impl Hud {
    /// # Safety
    /// A GLES 3 context must be current on this thread.
    pub unsafe fn new(font_path: &str) -> anyhow::Result<Self> {
        let program = program(VERTEX, FRAGMENT, &["a_pos", "a_uv", "a_color"])?;
        let image_program = self::program(VERTEX, IMAGE_FRAGMENT, &["a_pos", "a_uv", "a_color"])?;
        let (mut vao, mut buffer, mut atlas) = (0, 0, 0);
        glGenVertexArrays(1, &mut vao);
        glBindVertexArray(vao);
        glGenBuffers(1, &mut buffer);
        glBindBuffer(ARRAY_BUFFER, buffer);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, FLOAT, 0, 32, std::ptr::null());
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 2, FLOAT, 0, 32, 8 as *const c_void);
        glEnableVertexAttribArray(2);
        glVertexAttribPointer(2, 4, FLOAT, 0, 32, 16 as *const c_void);
        glBindVertexArray(0);
        glGenTextures(1, &mut atlas);
        glBindTexture(TEXTURE_2D, atlas);
        glPixelStorei(UNPACK_ALIGNMENT, 1);
        let mut pixels = vec![0u8; (ATLAS * ATLAS) as usize];
        // A solid corner for rectangles.
        for y in 0..4 {
            for x in 0..4 {
                pixels[y * ATLAS as usize + x] = 255;
            }
        }
        glTexImage2D(
            TEXTURE_2D,
            0,
            R8 as i32,
            ATLAS,
            ATLAS,
            0,
            RED,
            UNSIGNED_BYTE,
            pixels.as_ptr() as *const c_void,
        );
        glTexParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR);
        glTexParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, LINEAR);
        glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_S, CLAMP_TO_EDGE);
        glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_T, CLAMP_TO_EDGE);
        let font = std::fs::File::open(font_path)
            .ok()
            .and_then(|file| memmap2::Mmap::map(&file).ok());
        Ok(Self {
            program,
            image_program,
            vao,
            buffer,
            atlas,
            vertices: Vec::with_capacity(4096),
            glyphs: HashMap::new(),
            cursor: [8, 0],
            row: 0,
            font,
            half: [VIRTUAL[0] / 2.0, VIRTUAL[1] / 2.0],
            half_at: uniform(program, "u_half"),
            image_half_at: uniform(image_program, "u_half"),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn quad(&mut self, x: f32, y: f32, w: f32, h: f32, uv: [f32; 4], color: [f32; 4]) {
        let (x1, y1) = (x + w, y + h);
        for (px, py, u, v) in [
            (x, y, uv[0], uv[1]),
            (x1, y, uv[2], uv[1]),
            (x1, y1, uv[2], uv[3]),
            (x, y, uv[0], uv[1]),
            (x1, y1, uv[2], uv[3]),
            (x, y1, uv[0], uv[3]),
        ] {
            self.vertices
                .extend_from_slice(&[px, py, u, v, color[0], color[1], color[2], color[3]]);
        }
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: [f32; 4]) {
        let texel = 1.0 / ATLAS as f32;
        self.quad(x, y, w, h, [texel, texel, texel * 2.0, texel * 2.0], color);
    }

    unsafe fn glyph(&mut self, character: char, px: u16) -> Option<Glyph> {
        if let Some(glyph) = self.glyphs.get(&(character, px)) {
            return Some(*glyph);
        }
        let map = self.font.as_ref()?;
        let font = FontRef::try_from_slice(map).ok()?;
        let scale = PxScale::from(px as f32);
        let scaled = font.as_scaled(scale);
        let id: GlyphId = font.glyph_id(character);
        let advance = scaled.h_advance(id);
        let mut glyph = Glyph {
            uv: [0.0; 4],
            size: [0.0; 2],
            offset: [0.0; 2],
            advance,
        };
        if let Some(outline) = font.outline_glyph(id.with_scale(scale)) {
            let bounds = outline.px_bounds();
            let (w, h) = (bounds.width().ceil() as i32, bounds.height().ceil() as i32);
            if self.cursor[0] + w + 2 >= ATLAS {
                self.cursor = [0, self.cursor[1] + self.row + 2];
                self.row = 0;
            }
            if self.cursor[1] + h + 2 >= ATLAS {
                // Full: the next frame re-rasterizes what it still needs.
                self.glyphs.clear();
                self.cursor = [8, 0];
                self.row = 0;
            }
            let mut coverage = vec![0u8; (w * h) as usize];
            outline.draw(|x, y, c| {
                let index = y as i32 * w + x as i32;
                if (0..w * h).contains(&index) {
                    coverage[index as usize] = (c * 255.0) as u8;
                }
            });
            glBindTexture(TEXTURE_2D, self.atlas);
            glPixelStorei(UNPACK_ALIGNMENT, 1);
            glTexSubImage2D(
                TEXTURE_2D,
                0,
                self.cursor[0],
                self.cursor[1],
                w,
                h,
                RED,
                UNSIGNED_BYTE,
                coverage.as_ptr() as *const c_void,
            );
            let a = ATLAS as f32;
            glyph.uv = [
                self.cursor[0] as f32 / a,
                self.cursor[1] as f32 / a,
                (self.cursor[0] + w) as f32 / a,
                (self.cursor[1] + h) as f32 / a,
            ];
            glyph.size = [w as f32, h as f32];
            glyph.offset = [bounds.min.x, bounds.min.y];
            self.cursor[0] += w + 2;
            self.row = self.row.max(h);
        }
        self.glyphs.insert((character, px), glyph);
        Some(glyph)
    }

    /// The advance width of `text` at `px`.
    ///
    /// # Safety
    /// The context must be current: an unseen glyph rasterizes into the atlas.
    pub unsafe fn measure(&mut self, text: &str, px: f32) -> f32 {
        let px = px.round().clamp(6.0, 200.0) as u16;
        text.chars()
            .map(|c| self.glyph(c, px).map_or(0.0, |g| g.advance))
            .sum()
    }

    /// `y` is the top of the line box.
    ///
    /// # Safety
    /// The context must be current: an unseen glyph rasterizes into the atlas.
    pub unsafe fn text(
        &mut self,
        text: &str,
        x: f32,
        y: f32,
        px: f32,
        color: [f32; 4],
        align: Align,
    ) {
        let size = px.round().clamp(6.0, 200.0) as u16;
        let width = self.measure(text, px);
        let mut pen = match align {
            Align::Left => x,
            Align::Center => x - width * 0.5,
            Align::Right => x - width,
        };
        let ascent = self
            .font
            .as_ref()
            .and_then(|map| FontRef::try_from_slice(map).ok())
            .map_or(px * 0.8, |font| {
                font.as_scaled(PxScale::from(size as f32)).ascent()
            });
        for character in text.chars() {
            let Some(glyph) = self.glyph(character, size) else {
                continue;
            };
            if glyph.size[0] > 0.0 {
                self.quad(
                    pen + glyph.offset[0],
                    y + ascent + glyph.offset[1],
                    glyph.size[0],
                    glyph.size[1],
                    glyph.uv,
                    color,
                );
            }
            pen += glyph.advance;
        }
    }

    /// Word- and CJK-aware line breaking into `width`.
    ///
    /// # Safety
    /// The context must be current: an unseen glyph rasterizes into the atlas.
    pub unsafe fn wrap(&mut self, text: &str, px: f32, width: f32) -> Vec<String> {
        let mut lines = Vec::new();
        for paragraph in text.split('\n') {
            let mut line = String::new();
            let mut line_width = 0.0;
            for token in tokens(paragraph) {
                let token_width = self.measure(token, px);
                if line_width + token_width > width && !line.is_empty() {
                    lines.push(std::mem::take(&mut line).trim_end().to_owned());
                    line_width = 0.0;
                    if token.trim().is_empty() {
                        continue;
                    }
                }
                line.push_str(token);
                line_width += token_width;
            }
            lines.push(line);
        }
        lines
    }

    /// Draw everything queued, in a framebuffer of any size.
    ///
    /// # Safety
    /// The context must be current on this thread.
    pub unsafe fn flush(&mut self) {
        if self.vertices.is_empty() {
            return;
        }
        glUseProgram(self.program);
        glUniform2f(self.half_at, self.half[0], self.half[1]);
        glActiveTexture(TEXTURE0);
        glBindTexture(TEXTURE_2D, self.atlas);
        self.submit();
    }

    unsafe fn submit(&mut self) {
        glDisable(DEPTH_TEST);
        glDisable(CULL_FACE);
        glEnable(BLEND);
        glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
        glBindVertexArray(self.vao);
        glBindBuffer(ARRAY_BUFFER, self.buffer);
        glBufferData(
            ARRAY_BUFFER,
            (self.vertices.len() * 4) as isize,
            self.vertices.as_ptr() as *const c_void,
            STREAM_DRAW,
        );
        glDrawArrays(TRIANGLES, 0, (self.vertices.len() / 8) as i32);
        glBindVertexArray(0);
        glDisable(BLEND);
        self.vertices.clear();
    }

    /// Draw `texture` into a rectangle of the virtual screen now, after any
    /// queued quads. `flip` is for canvas textures, whose first row is the bottom.
    ///
    /// # Safety
    /// The context must be current on this thread.
    pub unsafe fn image(
        &mut self,
        texture: u32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        flip: bool,
        tint: [f32; 4],
    ) {
        self.flush();
        let (v0, v1) = if flip { (1.0, 0.0) } else { (0.0, 1.0) };
        self.quad(x, y, w, h, [0.0, v0, 1.0, v1], tint);
        glUseProgram(self.image_program);
        glUniform2f(self.image_half_at, self.half[0], self.half[1]);
        glActiveTexture(TEXTURE0);
        glBindTexture(TEXTURE_2D, texture);
        self.submit();
    }

    /// The coordinate space later quads are written in; 1280x720 by default.
    pub fn set_space(&mut self, width: f32, height: f32) {
        self.half = [width / 2.0, height / 2.0];
    }
}

fn tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_word = false;
    for (index, character) in text.char_indices() {
        let ascii_word =
            character.is_ascii_alphanumeric() || "_-.,:;!?'\"()[]{}/".contains(character);
        if in_word && !ascii_word {
            out.push(&text[start..index]);
            in_word = false;
            start = index;
        }
        if ascii_word {
            if !in_word {
                if start < index {
                    out.push(&text[start..index]);
                }
                start = index;
                in_word = true;
            }
        } else {
            let end = index + character.len_utf8();
            out.push(&text[index..end]);
            start = end;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::tokens;

    #[test]
    fn breaks_between_words_and_cjk_characters() {
        assert_eq!(
            tokens("hello 贪吃蛇 go!"),
            ["hello", " ", "贪", "吃", "蛇", " ", "go!"]
        );
    }
}
