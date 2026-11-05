#![no_std]
#![allow(static_mut_refs)]
use core::ffi::c_void;
use pocket_psp_ge::DisplayList;
use psp::sys::{
    self, DisplayPixelFormat, GuContextType, GuState, GuSyncBehavior, GuSyncMode, ShadingModel,
    TexturePixelFormat,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};
pub mod pixels;
// GE display list buffer (1 MB). One per program; the frame loop owns
// sceGuStart/Finish against it (the "dreamcart contract" — ge.rs never opens
// or kicks lists). sceGuStart writes it through the uncached mirror, so it
// has data-cache lines of its own: in a line shared with a static the CPU
// writes through the cache, that line's write-back replaces the first
// commands with what RAM held before them (pocket_psp_ge::list).
static mut LIST: DisplayList<0x40000> = DisplayList::new();

/// The display-list pointer for `sceGuStart`.
pub fn list_ptr() -> *mut c_void {
    DisplayList::as_mut_ptr(core::ptr::addr_of_mut!(LIST))
}

static mut RENDER_MEMORY: (*mut u8, usize) = (core::ptr::null_mut(), 0);

/// Transfer the unused VRAM after graphics initialization to the composition.
/// Call on the graphics thread. Returns a region once; the display/depth
/// buffers never overlap it.
///
/// # Safety
/// Call from the graphics thread after initialization. Synchronize the GE
/// before replacing bytes that submitted commands still reference.
pub unsafe fn take_render_memory() -> Option<&'static mut [u8]> {
    let (ptr, len) = RENDER_MEMORY;
    RENDER_MEMORY = (core::ptr::null_mut(), 0);
    if len == 0 {
        None
    } else {
        Some(core::slice::from_raw_parts_mut(ptr, len))
    }
}

/// Graphics setup selector. `depth: false` is the 2D UI runtime's exact
/// historical init (no zbuffer, depth test off). `depth: true` additionally
/// allocates a 16-bit zbuffer for 3D passes; the frame loop still owns
/// enabling/disabling DepthTest per pass.
#[derive(Clone, Copy, Default)]
pub struct GfxConfig {
    pub depth: bool,
}

/// Double-buffered 480x272 PSM8888 GU init — copied from dreamcart
/// runtime/src/main.rs init_graphics with the 3D-pass state trimmed to what a
/// 2D UI needs (scissor + smooth shading for gradient gouraud; depth test
/// off). With `cfg.depth` a zbuffer is allocated and registered as well.
pub unsafe fn init_graphics(cfg: GfxConfig) -> Result<(), &'static str> {
    init_graphics_with_format(cfg, DisplayPixelFormat::Psm8888)
}

/// Select the display buffer precision before allocating VRAM. The 16-bit
/// formats enable ordered dithering; texture and vertex colors retain their
/// original precision. The default entry point remains PSM8888.
pub unsafe fn init_graphics_with_format(
    cfg: GfxConfig,
    format: DisplayPixelFormat,
) -> Result<(), &'static str> {
    let texture_format = match format {
        DisplayPixelFormat::Psm5650 => TexturePixelFormat::Psm5650,
        DisplayPixelFormat::Psm5551 => TexturePixelFormat::Psm5551,
        DisplayPixelFormat::Psm4444 => TexturePixelFormat::Psm4444,
        DisplayPixelFormat::Psm8888 => TexturePixelFormat::Psm8888,
    };
    let allocator = match get_vram_allocator() {
        Ok(a) => a,
        Err(_) => return Err("get_vram_allocator failed"),
    };
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, texture_format)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, texture_format)
        .as_mut_ptr_from_zero();
    let zbp = cfg.depth.then(|| {
        allocator
            .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
            .as_mut_ptr_from_zero()
    });

    let bytes_per_pixel = if matches!(format, DisplayPixelFormat::Psm8888) {
        4
    } else {
        2
    };
    let used = BUF_WIDTH * SCREEN_HEIGHT * (2 * bytes_per_pixel + if cfg.depth { 2 } else { 0 });
    let remaining = sys::sceGeEdramGetSize().saturating_sub(used);
    if remaining > 0 {
        RENDER_MEMORY = (
            allocator.alloc(remaining).as_mut_ptr_direct_to_vram(),
            remaining as usize,
        );
    }

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, list_ptr());
    sys::sceGuDrawBuffer(format, fbp0 as _, BUF_WIDTH as i32);
    if !matches!(format, DisplayPixelFormat::Psm8888) {
        sys::sceGuEnable(GuState::Dither);
    }
    sys::sceGuDispBuffer(
        SCREEN_WIDTH as i32,
        SCREEN_HEIGHT as i32,
        fbp1 as _,
        BUF_WIDTH as i32,
    );
    if let Some(zbp) = zbp {
        sys::sceGuDepthBuffer(zbp as _, BUF_WIDTH as i32);
    }
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    // Smooth shading: gradient rects gouraud-interpolate per-vertex color.
    sys::sceGuShadeModel(ShadingModel::Smooth);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
    Ok(())
}

/// Copy displayed rows through main RAM into 512-stride RGBA8 capture bytes.
/// Reads the uncached VRAM mirror; supports every display format accepted by
/// `init_graphics_with_format`. The caller must synchronize presentation.
pub unsafe fn read_display_rows_rgba(first: usize, rows: usize, out: &mut [u8]) -> bool {
    if first > 272 || rows > 272 - first || out.len() < rows * 512 * 4 {
        return false;
    }
    let mut top = core::ptr::null_mut();
    let mut stride = 0;
    let mut format = DisplayPixelFormat::Psm8888;
    if sys::sceDisplayGetFrameBuf(
        &mut top,
        &mut stride,
        &mut format,
        sys::DisplaySetBufSync::Immediate,
    ) < 0
        || top.is_null()
        || stride < 480
    {
        return false;
    }
    let mut address = top as usize;
    if address < 0x0400_0000 {
        address += 0x0400_0000;
    }
    address |= 0x4000_0000;
    let bytes = if matches!(format, DisplayPixelFormat::Psm8888) {
        4
    } else {
        2
    };
    for row in 0..rows {
        let source = (address + (first + row) * stride * bytes) as *const u8;
        let dest = &mut out[row * 2048..(row + 1) * 2048];
        dest.fill(0);
        if bytes == 4 {
            core::ptr::copy_nonoverlapping(source, dest.as_mut_ptr(), 480 * 4);
        } else {
            for x in 0..480 {
                let pixel = core::ptr::read_volatile(source.add(x * 2).cast::<u16>());
                dest[x * 4..x * 4 + 4]
                    .copy_from_slice(&crate::pixels::rgba16(pixel, format as u32));
            }
        }
    }
    true
}
