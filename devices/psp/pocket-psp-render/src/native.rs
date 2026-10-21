//! Native bindings. The host initializes GU and owns the framebuffer pair.
use crate::{Device, Encoder, Primitive, TextureBinding, Vertices};
use core::ffi::c_void;
use pocket_drivers::{DamageRect, DisplayError, RenderError, RenderResources};
use pocket_spec as spec;
use psp::sys::{
    self, BlendFactor, BlendOp, ClearBuffer, ClutPixelFormat, GeListState, GuContextType,
    GuPrimitive, GuState, GuSyncBehavior, GuSyncMode, MipmapLevel, TextureColorComponent,
    TextureEffect, TextureFilter, TexturePixelFormat, VertexType,
};
const COLOR: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);
const TEXTURE: VertexType =
    VertexType::from_bits_truncate(COLOR.bits() | VertexType::TEXTURE_16BIT.bits());
const MAX_PRIM_VERTICES: usize = 65532;
// Every high-level call below emits less than 256 words. Keep room for the
// terminal list command even if a producer exceeds the native command budget.
const LIST_BYTES: usize = 1024 * 1024;
const CALL_RESERVE: usize = 1024;
pub struct NativeDevice {
    list: *mut c_void,
    open: bool,
    pending: bool,
    failed: bool,
    external: bool,
}
impl NativeDevice {
    /// # Safety
    /// Initialize GU first. `list` must point to a 16-byte-aligned 1 MiB command
    /// allocation that outlives this device. This is the sole list owner on the
    /// graphics thread; the host may use GU only outside pending submissions.
    pub unsafe fn new(list: *mut c_void) -> Self {
        assert!(!list.is_null() && (list as usize).is_multiple_of(16));
        Self {
            list,
            open: false,
            pending: false,
            failed: false,
            external: false,
        }
    }
    unsafe fn reserve(&mut self) -> bool {
        if self.failed {
            return false;
        }
        let used = sys::sceGuCheckList();
        if used < 0 || used as usize > LIST_BYTES - CALL_RESERVE {
            self.failed = true;
            false
        } else {
            true
        }
    }
    unsafe fn terminal(&mut self) {
        if self.open {
            sys::sceGuFinish();
            self.open = false;
            self.pending = true;
        }
        if self.pending {
            // A Wait call must never report a still-executing queue as a
            // terminal error. Firmware failure parks here with memory live.
            while !matches!(
                sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait),
                GeListState::Done
            ) {
                sys::sceDisplayWaitVblankStart();
            }
            self.pending = false;
        }
    }
}
unsafe impl Device for NativeDevice {
    fn begin(&mut self) -> Result<(), RenderError> {
        if self.open || self.pending || self.external {
            return Err(RenderError::Failed);
        }
        self.failed = false;
        unsafe {
            sys::sceGuStart(GuContextType::Direct, self.list);
        }
        self.open = true;
        Ok(())
    }
    fn begin_pass(&mut self, clear: bool) {
        unsafe {
            if !self.reserve() {
                return;
            }
            if clear {
                sys::sceGuClearColor(0xff00_0000);
                sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT);
            }
            sys::sceGuEnable(GuState::Blend);
            sys::sceGuBlendFunc(
                BlendOp::Add,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                0,
                0,
            );
            sys::sceGuDisable(GuState::Texture2D);
            sys::sceGuScissor(0, 0, 480, 272);
        }
    }
    fn clip(&mut self, clip: DamageRect) {
        unsafe {
            if self.reserve() {
                sys::sceGuScissor(clip.x0, clip.y0, clip.x1, clip.y1);
            }
        }
    }
    unsafe fn publish(&mut self, pointer: *const u8, bytes: usize) {
        if bytes > 0 {
            sys::sceKernelDcacheWritebackRange(pointer.cast(), bytes as u32);
        }
    }
    unsafe fn bind(&mut self, texture: Option<TextureBinding>) {
        if !self.reserve() {
            return;
        }
        let Some(t) = texture else {
            sys::sceGuDisable(GuState::Texture2D);
            return;
        };
        sys::sceGuEnable(GuState::Texture2D);
        let format = match t.psm {
            spec::psm::PSM_T8 => {
                sys::sceGuClutMode(ClutPixelFormat::Psm8888, 0, 255, 0);
                sys::sceGuClutLoad(32, t.palette.cast());
                TexturePixelFormat::PsmT8
            }
            spec::psm::PSM_5650 => TexturePixelFormat::Psm5650,
            spec::psm::PSM_4444 => TexturePixelFormat::Psm4444,
            _ => TexturePixelFormat::Psm8888,
        };
        sys::sceGuTexMode(format, 0, 0, 0);
        sys::sceGuTexImage(
            MipmapLevel::None,
            t.width as i32,
            t.height as i32,
            t.width as i32,
            t.pixels.cast(),
        );
        // Real GE caches do not invalidate when only the texture pointer
        // changes. Equal-size icons require this flush on every bind.
        sys::sceGuTexFlush();
        sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
        let filter = || {
            if t.linear {
                TextureFilter::Linear
            } else {
                TextureFilter::Nearest
            }
        };
        sys::sceGuTexFilter(filter(), filter());
    }
    unsafe fn draw(&mut self, primitive: Primitive, vertices: Vertices<'_>) {
        let (pointer, count, stride, kind) = match vertices {
            Vertices::Colored(v) => (
                v.as_ptr().cast::<u8>(),
                v.len(),
                core::mem::size_of::<crate::VertC>(),
                COLOR,
            ),
            Vertices::Textured(v) => (
                v.as_ptr().cast::<u8>(),
                v.len(),
                core::mem::size_of::<crate::VertTC>(),
                TEXTURE,
            ),
        };
        self.publish(pointer, count * stride);
        let primitive = match primitive {
            Primitive::Sprites => GuPrimitive::Sprites,
            Primitive::Triangles => GuPrimitive::Triangles,
            Primitive::TriangleStrip => GuPrimitive::TriangleStrip,
        };
        let mut done = 0;
        while done < count {
            if !self.reserve() {
                break;
            }
            let n = (count - done).min(MAX_PRIM_VERTICES);
            sys::sceGuDrawArray(
                primitive,
                kind,
                n as i32,
                core::ptr::null(),
                pointer.add(done * stride).cast(),
            );
            done += n;
        }
    }
    fn end_pass(&mut self) {
        unsafe {
            if self.reserve() {
                sys::sceGuDisable(GuState::Blend);
                sys::sceGuDisable(GuState::Texture2D);
                sys::sceGuScissor(0, 0, 480, 272);
            }
        }
    }
    fn finish(&mut self) -> Result<(), RenderError> {
        unsafe {
            if self.open {
                sys::sceGuFinish();
                self.open = false;
                self.pending = true;
            }
        }
        if self.failed {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn wait(&mut self) -> Result<(), RenderError> {
        unsafe {
            self.terminal();
        }
        if self.failed {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn present(&mut self) -> Result<(), DisplayError> {
        unsafe {
            self.terminal();
            sys::sceGuSwapBuffers();
        }
        Ok(())
    }
    fn stop(&mut self) {
        unsafe {
            self.terminal();
        }
    }
}
impl Drop for NativeDevice {
    fn drop(&mut self) {
        if !self.external {
            self.stop();
        }
    }
}
/// Legacy composition helper for a list already opened by a native game host.
///
/// # Safety
/// The list has 1 MiB capacity and is exclusively owned by this thread. Keep
/// source textures and encoder alive until GU sync, then call encoder.retire().
pub unsafe fn encode_open(
    encoder: &mut Encoder,
    resources: &dyn RenderResources,
    words: &[u32],
    clear: bool,
) -> Result<(), RenderError> {
    let mut device = NativeDevice {
        list: core::ptr::null_mut(),
        open: false,
        pending: false,
        failed: false,
        external: true,
    };
    encoder.encode_open(&mut device, resources, words, true, clear)?;
    if device.failed {
        Err(RenderError::Failed)
    } else {
        Ok(())
    }
}
