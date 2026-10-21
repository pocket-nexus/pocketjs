//! Vita2d's embedded shaders plus pocket-vita-gxm owned vertex storage.
//! No runtime shader compiler or libshacccg.suprx is required.
use super::*;
use core::{mem::size_of, ptr, sync::atomic::AtomicBool};
use pocket_vita_gxm::mem::{Block, Kind};
use vita2d_sys::*;
static ACQUIRED: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Copy)]
struct Texture {
    ptr: *mut vita2d_texture,
    w: u32,
    h: u32,
    format: TextureFormat,
    bytes: usize,
}
#[derive(Clone, Copy)]
struct Draw {
    ptr: *const u8,
    count: usize,
    texture: *const vita2d_texture,
    color: u32,
    clip: Clip,
}
pub struct NativeFrame {
    block: Option<Block>,
}
/// Process-owned vita2d device. The renderer holds the exclusive Rust lease;
/// native games can record commands through the legacy shared-scene API.
pub struct VitaDevice {
    textures: Vec<(u32, Texture)>,
    recycled: Vec<Texture>,
    next_texture: u32,
    scene_open: bool,
    scene_has_ui: bool,
    active_textures: Vec<u32>,
    external: bool,
    gpu_pending: bool,
    display_failed: bool,
    vertex_budget: usize,
    texture_budget: usize,
    allocated_textures: usize,
    _thread: core::marker::PhantomData<Rc<()>>,
}
impl VitaDevice {
    /// # Safety
    /// Call on the Vita render thread before any vita2d scene. No other owner
    /// may initialize/finalize vita2d or close a scene owned by this device.
    /// Native drawing is allowed only between begin_external and wait/present.
    pub unsafe fn new(pool_bytes: u32) -> Result<Self, RenderError> {
        if pool_bytes == 0
            || ACQUIRED
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err(RenderError::Failed);
        }
        if vita2d_init_advanced(pool_bytes) < 0 {
            ACQUIRED.store(false, Ordering::Release);
            return Err(RenderError::Failed);
        }
        vita2d_set_vblank_wait(1);
        vita2d_set_clear_color(0xff00_0000);
        Ok(Self {
            textures: Vec::new(),
            recycled: Vec::new(),
            next_texture: 1,
            scene_open: false,
            scene_has_ui: false,
            active_textures: Vec::new(),
            external: false,
            gpu_pending: false,
            display_failed: false,
            vertex_budget: pool_bytes as usize,
            texture_budget: 64 * 1024 * 1024,
            allocated_textures: 0,
            _thread: core::marker::PhantomData,
        })
    }
    pub fn allocated_texture_bytes(&self) -> usize {
        self.allocated_textures
    }
    unsafe fn begin(&mut self, clear: u32) {
        if self.gpu_pending {
            vita2d_wait_rendering_done();
            self.gpu_pending = false;
            self.active_textures.clear();
        }
        vita2d_set_clear_color(clear);
        vita2d_start_drawing();
        self.scene_open = true;
        self.scene_has_ui = false;
        vita2d_disable_clipping();
        vita2d_clear_screen();
    }
    unsafe fn end(&mut self) {
        if self.scene_open {
            vita2d_disable_clipping();
            vita2d_end_drawing();
            self.scene_open = false;
            self.gpu_pending = true;
        }
    }
    unsafe fn free(&mut self, texture: Texture) {
        vita2d_free_texture(texture.ptr);
        self.allocated_textures = self.allocated_textures.saturating_sub(texture.bytes);
    }
    fn prepare_vertices(
        &self,
        vertices: &[Vertex],
        commands: &[Command],
    ) -> Result<(NativeFrame, Vec<Draw>), RenderError> {
        let mut required = 0usize;
        for command in commands {
            if command
                .first
                .checked_add(command.count)
                .is_none_or(|end| end > vertices.len())
                || command.count % 3 != 0
            {
                return Err(RenderError::InvalidFrame);
            }
            let stride = if command.texture == 0 {
                size_of::<vita2d_color_vertex>()
            } else {
                size_of::<vita2d_texture_vertex>()
            };
            required = required
                .checked_add(
                    command
                        .count
                        .checked_mul(stride)
                        .ok_or(RenderError::InvalidFrame)?,
                )
                .ok_or(RenderError::InvalidFrame)?;
            if command.texture != 0 && !self.textures.iter().any(|(id, _)| *id == command.texture) {
                return Err(RenderError::InvalidFrame);
            }
        }
        let rounded = required
            .checked_add(4095)
            .map(|bytes| bytes / 4096 * 4096)
            .ok_or(RenderError::InvalidFrame)?;
        if rounded > self.vertex_budget {
            return Err(RenderError::Failed);
        }
        if required == 0 {
            return Ok((NativeFrame { block: None }, Vec::new()));
        }
        let mut block = unsafe { Block::with_access(Kind::Main, rounded, false) }
            .map_err(|_| RenderError::Failed)?;
        let mut draws = Vec::new();
        for command in commands {
            let source = &vertices[command.first..command.first + command.count];
            if command.texture == 0 {
                let Some(out) = block.alloc(source.len() * size_of::<vita2d_color_vertex>(), 4)
                else {
                    unsafe {
                        block.free();
                    }
                    return Err(RenderError::Failed);
                };
                for (index, v) in source.iter().enumerate() {
                    unsafe {
                        out.cast::<vita2d_color_vertex>()
                            .add(index)
                            .write(vita2d_color_vertex {
                                x: v.position[0],
                                y: v.position[1],
                                z: 0.5,
                                color: v.color,
                            });
                    }
                }
                draws.push(Draw {
                    ptr: out,
                    count: source.len(),
                    texture: ptr::null(),
                    color: 0,
                    clip: command.clip,
                });
            } else {
                let texture = self
                    .textures
                    .iter()
                    .find(|(id, _)| *id == command.texture)
                    .unwrap()
                    .1;
                let Some(out) = block.alloc(source.len() * size_of::<vita2d_texture_vertex>(), 4)
                else {
                    unsafe {
                        block.free();
                    }
                    return Err(RenderError::Failed);
                };
                for (index, v) in source.iter().enumerate() {
                    unsafe {
                        out.cast::<vita2d_texture_vertex>().add(index).write(
                            vita2d_texture_vertex {
                                x: v.position[0],
                                y: v.position[1],
                                z: 0.5,
                                u: v.uv[0],
                                v: v.uv[1],
                            },
                        );
                    }
                }
                // Vita2d has one tint per textured draw. Preserve adjacent
                // tint boundaries while sharing the submission's vertex block.
                let mut start = 0;
                while start < source.len() {
                    let color = source[start].color;
                    let mut end = start;
                    while end < source.len() && source[end].color == color {
                        if source[end..end + 3].iter().any(|v| v.color != color) {
                            unsafe {
                                block.free();
                            }
                            return Err(RenderError::InvalidFrame);
                        }
                        end += 3;
                    }
                    draws.push(Draw {
                        ptr: unsafe { out.add(start * size_of::<vita2d_texture_vertex>()) },
                        count: end - start,
                        texture: texture.ptr,
                        color,
                        clip: command.clip,
                    });
                    start = end;
                }
            }
        }
        Ok((NativeFrame { block: Some(block) }, draws))
    }
}
unsafe impl Device for VitaDevice {
    type Frame = NativeFrame;
    fn upload(
        &mut self,
        pixels: &[u8],
        w: u32,
        h: u32,
        format: TextureFormat,
        linear: bool,
    ) -> Result<u32, RenderError> {
        let bpp = if format == TextureFormat::Rgba { 4 } else { 1 };
        let row = (w as usize)
            .checked_mul(bpp)
            .ok_or(RenderError::InvalidFrame)?;
        if w == 0
            || h == 0
            || w > 2048
            || h > 2048
            || row
                .checked_mul(h as usize)
                .is_none_or(|len| len > pixels.len())
        {
            return Err(RenderError::InvalidFrame);
        }
        let id = self.next_texture;
        self.next_texture = id.checked_add(1).ok_or(RenderError::Failed)?;
        let recycled = self
            .recycled
            .iter()
            .position(|texture| texture.w == w && texture.h == h && texture.format == format);
        let texture = if let Some(index) = recycled {
            self.recycled.swap_remove(index)
        } else {
            let bytes = texture_bytes(w, h, bpp).ok_or(RenderError::InvalidFrame)?;
            if self
                .allocated_textures
                .checked_add(bytes)
                .is_none_or(|total| total > self.texture_budget)
            {
                return Err(RenderError::Failed);
            }
            let native_format = if format == TextureFormat::Rgba {
                SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR
            } else {
                SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8_R111
            };
            let ptr = unsafe { vita2d_create_empty_texture_format(w, h, native_format) };
            if ptr.is_null() {
                return Err(RenderError::Failed);
            }
            self.allocated_textures += bytes;
            Texture {
                ptr,
                w,
                h,
                format,
                bytes,
            }
        };
        unsafe {
            let stride = vita2d_texture_get_stride(texture.ptr) as usize;
            let out = vita2d_texture_get_datap(texture.ptr).cast::<u8>();
            if out.is_null() || stride < row {
                self.recycled.push(texture);
                return Err(RenderError::Failed);
            }
            for y in 0..h as usize {
                ptr::copy_nonoverlapping(pixels.as_ptr().add(y * row), out.add(y * stride), row);
            }
            let filter = if linear {
                SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR
            } else {
                SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT
            };
            vita2d_texture_set_filters(texture.ptr, filter, filter);
        }
        self.textures.push((id, texture));
        Ok(id)
    }
    fn update(
        &mut self,
        id: u32,
        pixels: &[u8],
        w: u32,
        h: u32,
        format: TextureFormat,
        linear: bool,
    ) -> Result<(), RenderError> {
        // Direct Device callers receive the same protection as cache users.
        // Native 3D cannot reference the private UI texture allocations.
        if self.active_textures.contains(&id) {
            return Err(RenderError::Unsupported);
        }
        let texture = self
            .textures
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, texture)| *texture)
            .ok_or(RenderError::InvalidFrame)?;
        if texture.w != w || texture.h != h || texture.format != format {
            return Err(RenderError::Unsupported);
        }
        let bpp = if format == TextureFormat::Rgba { 4 } else { 1 };
        let row = (w as usize)
            .checked_mul(bpp)
            .ok_or(RenderError::InvalidFrame)?;
        if row
            .checked_mul(h as usize)
            .is_none_or(|len| len > pixels.len())
        {
            return Err(RenderError::InvalidFrame);
        }
        unsafe {
            let stride = vita2d_texture_get_stride(texture.ptr) as usize;
            let out = vita2d_texture_get_datap(texture.ptr).cast::<u8>();
            if out.is_null() || stride < row {
                return Err(RenderError::Failed);
            }
            for y in 0..h as usize {
                ptr::copy_nonoverlapping(pixels.as_ptr().add(y * row), out.add(y * stride), row);
            }
            let filter = if linear {
                SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR
            } else {
                SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT
            };
            vita2d_texture_set_filters(texture.ptr, filter, filter);
        }
        Ok(())
    }
    fn release_texture(&mut self, id: u32) {
        if self.active_textures.contains(&id) {
            let _ = self.wait();
        }
        if let Some(index) = self.textures.iter().position(|(key, _)| *key == id) {
            self.recycled.push(self.textures.swap_remove(index).1);
        }
    }
    fn submit(
        &mut self,
        vertices: &[Vertex],
        commands: &[Command],
        clear: Option<u32>,
    ) -> Result<NativeFrame, RenderError> {
        if clear.is_none() && !self.scene_open {
            return Err(RenderError::Failed);
        }
        if clear.is_some() && self.scene_open {
            return Err(RenderError::Failed);
        }
        // Allocate and validate every command before starting native work.
        let (frame, draws) = self.prepare_vertices(vertices, commands)?;
        unsafe {
            if let Some(color) = clear {
                self.external = false;
                self.begin(color);
            }
            for command in commands {
                if command.texture != 0 && !self.active_textures.contains(&command.texture) {
                    self.active_textures.push(command.texture);
                }
            }
            for draw in draws {
                if draw.clip.w <= 0 || draw.clip.h <= 0 {
                    continue;
                }
                vita2d_set_clip_rectangle(
                    draw.clip.x,
                    draw.clip.y,
                    draw.clip.x + draw.clip.w,
                    draw.clip.y + draw.clip.h,
                );
                vita2d_enable_clipping();
                // vita2d uses a fixed 16-bit ascending index buffer. Split
                // without breaking triangles or changing painter order.
                for range in triangle_ranges(draw.count) {
                    if draw.texture.is_null() {
                        let vertices = draw.ptr.cast::<vita2d_color_vertex>().add(range.start);
                        vita2d_draw_array(
                            SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
                            vertices,
                            range.len(),
                        );
                    } else {
                        let vertices = draw.ptr.cast::<vita2d_texture_vertex>().add(range.start);
                        vita2d_draw_array_textured(
                            draw.texture,
                            SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
                            vertices,
                            range.len(),
                            draw.color,
                        );
                    }
                }
            }
            vita2d_disable_clipping();
            self.scene_has_ui = true;
            if !self.external {
                self.end();
            }
        }
        Ok(frame)
    }
    fn wait(&mut self) -> Result<(), RenderError> {
        unsafe {
            self.end();
            if self.gpu_pending {
                vita2d_wait_rendering_done();
                self.gpu_pending = false;
            }
            self.scene_has_ui = false;
            self.active_textures.clear();
        }
        Ok(())
    }
    fn retire(&mut self, frame: NativeFrame) {
        if self.gpu_pending || self.scene_has_ui {
            let _ = self.wait();
        }
        if let Some(block) = frame.block {
            unsafe {
                block.free();
            }
        }
    }
    fn begin_external(&mut self, clear: u32) -> Result<(), RenderError> {
        if self.scene_open {
            return Err(RenderError::Failed);
        }
        unsafe {
            self.begin(clear);
        }
        self.external = true;
        Ok(())
    }
    fn flush(&mut self) -> Result<(), RenderError> {
        if self.scene_open || self.gpu_pending {
            return Err(RenderError::Failed);
        }
        unsafe {
            vita2d_swap_buffers();
        }
        Ok(())
    }
    fn wait_display(&mut self) -> Result<(), RenderError> {
        let status = unsafe { sceGxmDisplayQueueFinish() };
        if status < 0 {
            self.display_failed = true;
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn reset_guest(&mut self) {
        let _ = self.wait();
        let mut bytes = self
            .recycled
            .iter()
            .map(|texture| texture.bytes)
            .sum::<usize>();
        while bytes > 16 * 1024 * 1024 && !self.recycled.is_empty() {
            let texture = self.recycled.remove(0);
            bytes -= texture.bytes;
            unsafe {
                self.free(texture);
            }
        }
    }
}
impl Drop for VitaDevice {
    fn drop(&mut self) {
        let _ = self.wait();
        let _ = self.wait_display();
        while let Some((_, texture)) = self.textures.pop() {
            unsafe {
                self.free(texture);
            }
        }
        while let Some(texture) = self.recycled.pop() {
            unsafe {
                self.free(texture);
            }
        }
        if !self.display_failed {
            unsafe {
                vita2d_fini();
            }
            ACQUIRED.store(false, Ordering::Release);
        }
    }
}
