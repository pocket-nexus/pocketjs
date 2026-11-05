//! Offscreen render targets whose colour (and optionally depth) is sampled
//! by later scenes of the same frame.

use core::ptr;

use vita2d_sys as g;

use crate::mem::Arena;
use crate::program::Output;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorFormat {
    /// 8-bit RGBA.
    Rgba8,
    /// Half-float RGBA (64 bits per pixel).
    Rgba16f,
    /// Packed float RGB, 32 bits per pixel.
    R11G11B10f,
    /// Single-channel 32-bit float (4 bytes per pixel), sampled as RRRR.
    /// Storage precision does not change arithmetic already compiled into GXP.
    R32f,
    /// Two unsigned-normalized 16-bit channels (4 bytes per pixel).
    /// Matching GR surface/texture swizzles preserve shader R/G as sampled
    /// `.rg`. Write normalized float4 COLOR through [`Output::Ushort2`].
    Rg16Unorm,
}

impl ColorFormat {
    fn surface(self) -> g::SceGxmColorFormat {
        match self {
            ColorFormat::Rgba8 => g::SceGxmColorFormat_SCE_GXM_COLOR_FORMAT_U8U8U8U8_ABGR,
            ColorFormat::Rgba16f => g::SceGxmColorFormat_SCE_GXM_COLOR_FORMAT_F16F16F16F16_ABGR,
            ColorFormat::R11G11B10f => g::SceGxmColorFormat_SCE_GXM_COLOR_FORMAT_F11F11F10_RGB,
            ColorFormat::R32f => g::SceGxmColorFormat_SCE_GXM_COLOR_FORMAT_F32_R,
            ColorFormat::Rg16Unorm => g::SceGxmColorFormat_SCE_GXM_COLOR_FORMAT_U16U16_GR,
        }
    }

    fn texture(self) -> g::SceGxmTextureFormat {
        match self {
            ColorFormat::Rgba8 => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
            ColorFormat::Rgba16f => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_F16F16F16F16_ABGR,
            ColorFormat::R11G11B10f => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_F11F11F10_RGB,
            ColorFormat::R32f => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_F32_RRRR,
            ColorFormat::Rg16Unorm => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U16U16_GR,
        }
    }

    pub fn bytes(self) -> u32 {
        match self {
            ColorFormat::Rgba16f => 8,
            _ => 4,
        }
    }

    fn register(self) -> g::SceGxmOutputRegisterSize {
        match self {
            ColorFormat::Rgba16f => g::SceGxmOutputRegisterSize_SCE_GXM_OUTPUT_REGISTER_SIZE_64BIT,
            _ => g::SceGxmOutputRegisterSize_SCE_GXM_OUTPUT_REGISTER_SIZE_32BIT,
        }
    }

    /// Fragment program output register format for this surface.
    pub fn output(self) -> Output {
        match self {
            ColorFormat::Rgba8 => Output::Uchar4,
            ColorFormat::Rgba16f => Output::Half4,
            ColorFormat::R11G11B10f => Output::Half4,
            ColorFormat::R32f => Output::Float,
            ColorFormat::Rg16Unorm => Output::Ushort2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Msaa {
    None,
    X2,
    X4,
}

impl Msaa {
    pub fn gxm(self) -> u32 {
        (match self {
            Msaa::None => g::SceGxmMultisampleMode_SCE_GXM_MULTISAMPLE_NONE,
            Msaa::X2 => g::SceGxmMultisampleMode_SCE_GXM_MULTISAMPLE_2X,
            Msaa::X4 => g::SceGxmMultisampleMode_SCE_GXM_MULTISAMPLE_4X,
        }) as u32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Depth {
    None,
    /// Float depth used only while the scene renders.
    Transient,
    /// Float depth stored at scene end and sampleable as `depth_texture`.
    Stored,
}

pub struct Target {
    pub width: u32,
    pub height: u32,
    pub format: ColorFormat,
    pub msaa: Msaa,
    pub rt: *mut g::SceGxmRenderTarget,
    pub color: g::SceGxmColorSurface,
    pub depth: Option<g::SceGxmDepthStencilSurface>,
    /// Resolved colour as a bilinear, clamped texture.
    pub texture: g::SceGxmTexture,
    pub depth_texture: Option<g::SceGxmTexture>,
    pub bytes: usize,
}

const TILE: u32 = 32;

impl Target {
    /// # Safety
    /// `vram` and `main` must outlive the target; call from the GXM thread.
    pub unsafe fn new(
        vram: &mut Arena,
        main: &mut Arena,
        width: u32,
        height: u32,
        format: ColorFormat,
        msaa: Msaa,
        depth: Depth,
    ) -> Result<Self, String> {
        let mut params: g::SceGxmRenderTargetParams = core::mem::zeroed();
        params.width = width as u16;
        params.height = height as u16;
        params.scenesPerFrame = 1;
        params.multisampleMode = msaa.gxm() as u16;
        params.driverMemBlock = -1;
        let mut rt = ptr::null_mut();
        let r = g::sceGxmCreateRenderTarget(&params, &mut rt);
        if r < 0 {
            return Err(format!(
                "sceGxmCreateRenderTarget {width}x{height} 0x{:08x}",
                r as u32
            ));
        }

        let stride = width.next_multiple_of(8);
        let size = (stride * height * format.bytes()) as usize;
        let data = vram.alloc(size, 4096)?;
        ptr::write_bytes(data, 0, size);
        let mut color: g::SceGxmColorSurface = core::mem::zeroed();
        let scale = if msaa == Msaa::None {
            g::SceGxmColorSurfaceScaleMode_SCE_GXM_COLOR_SURFACE_SCALE_NONE
        } else {
            g::SceGxmColorSurfaceScaleMode_SCE_GXM_COLOR_SURFACE_SCALE_MSAA_DOWNSCALE
        };
        let r = g::sceGxmColorSurfaceInit(
            &mut color,
            format.surface(),
            g::SceGxmColorSurfaceType_SCE_GXM_COLOR_SURFACE_LINEAR,
            scale,
            format.register(),
            width,
            height,
            stride,
            data.cast(),
        );
        if r < 0 {
            return Err(format!(
                "sceGxmColorSurfaceInit {format:?} 0x{:08x}",
                r as u32
            ));
        }
        let mut texture: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitLinear(
            &mut texture,
            data.cast(),
            format.texture(),
            width,
            height,
            0,
        );
        if r < 0 {
            return Err(format!(
                "sceGxmTextureInitLinear {format:?} 0x{:08x}",
                r as u32
            ));
        }
        g::sceGxmTextureSetMinFilter(
            &mut texture,
            g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        g::sceGxmTextureSetMagFilter(
            &mut texture,
            g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        g::sceGxmTextureSetUAddrMode(
            &mut texture,
            g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );
        g::sceGxmTextureSetVAddrMode(
            &mut texture,
            g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );
        let mut bytes = size;

        let mut depth_surface = None;
        let mut depth_texture = None;
        if depth != Depth::None {
            let aw = width.next_multiple_of(TILE);
            let ah = height.next_multiple_of(TILE);
            let (samples, stride) = match msaa {
                Msaa::None => (aw * ah, aw),
                Msaa::X2 => (aw * ah * 2, aw),
                Msaa::X4 => (aw * ah * 4, aw * 2),
            };
            let dsize = (samples * 4) as usize;
            // Sampled depth must be in memory the texture unit reads fast.
            let ddata = if depth == Depth::Stored {
                vram.alloc(dsize, 4096)?
            } else {
                main.alloc(dsize, 4096)?
            };
            let mut ds: g::SceGxmDepthStencilSurface = core::mem::zeroed();
            let r = g::sceGxmDepthStencilSurfaceInit(
                &mut ds,
                g::SceGxmDepthStencilFormat_SCE_GXM_DEPTH_STENCIL_FORMAT_DF32M,
                if depth == Depth::Stored {
                    g::SceGxmDepthStencilSurfaceType_SCE_GXM_DEPTH_STENCIL_SURFACE_LINEAR
                } else {
                    g::SceGxmDepthStencilSurfaceType_SCE_GXM_DEPTH_STENCIL_SURFACE_TILED
                },
                stride,
                ddata.cast(),
                ptr::null_mut(),
            );
            if r < 0 {
                return Err(format!("sceGxmDepthStencilSurfaceInit 0x{:08x}", r as u32));
            }
            if depth == Depth::Stored {
                g::sceGxmDepthStencilSurfaceSetForceStoreMode(
                    &mut ds,
                    g::SceGxmDepthStencilForceStoreMode_SCE_GXM_DEPTH_STENCIL_FORCE_STORE_ENABLED,
                );
                let mut dt: g::SceGxmTexture = core::mem::zeroed();
                let (tw, th) = if msaa == Msaa::X4 {
                    (stride, ah * 2)
                } else {
                    (stride, ah)
                };
                let r = g::sceGxmTextureInitLinear(
                    &mut dt,
                    ddata.cast(),
                    g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_DF32M,
                    tw,
                    th,
                    0,
                );
                if r < 0 {
                    return Err(format!("sceGxmTextureInitLinear DF32M 0x{:08x}", r as u32));
                }
                g::sceGxmTextureSetMinFilter(
                    &mut dt,
                    g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT,
                );
                g::sceGxmTextureSetMagFilter(
                    &mut dt,
                    g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT,
                );
                depth_texture = Some(dt);
            }
            depth_surface = Some(ds);
            bytes += dsize;
        }
        Ok(Self {
            width,
            height,
            format,
            msaa,
            rt,
            color,
            depth: depth_surface,
            texture,
            depth_texture,
            bytes,
        })
    }

    /// Begins a scene on this target. `clear_depth` is the value every
    /// sample starts from (the depth buffer is never loaded).
    ///
    /// # Safety
    /// No other scene open on `ctx`.
    pub unsafe fn begin(
        &mut self,
        ctx: *mut g::SceGxmContext,
        clear_depth: f32,
    ) -> Result<(), String> {
        if let Some(ds) = self.depth.as_mut() {
            g::sceGxmDepthStencilSurfaceSetBackgroundDepth(ds, clear_depth);
        }
        let r = g::sceGxmBeginScene(
            ctx,
            0,
            self.rt,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            &self.color,
            self.depth.as_ref().map_or(ptr::null(), |d| d as *const _),
        );
        if r < 0 {
            return Err(format!("sceGxmBeginScene 0x{:08x}", r as u32));
        }
        Ok(())
    }

    /// # Safety
    /// Scene opened with [`Target::begin`].
    pub unsafe fn end(&self, ctx: *mut g::SceGxmContext, notify: Option<&g::SceGxmNotification>) {
        g::sceGxmEndScene(
            ctx,
            ptr::null(),
            notify.map_or(ptr::null(), |n| n as *const _),
        );
    }

    /// # Safety
    /// GPU idle with respect to this target.
    pub unsafe fn destroy(self) {
        g::sceGxmDestroyRenderTarget(self.rt);
    }
}

/// Fence on the fragment stage of a scene: `signal` is attached to a
/// scene's end, `wait` blocks the CPU until that scene finished.
pub struct Fence {
    slots: Vec<g::SceGxmNotification>,
    next: u32,
}

impl Fence {
    /// # Safety
    /// Uses `count` words of the process-wide notification region from `first`.
    pub unsafe fn new(first: usize, count: usize) -> Self {
        let region = g::sceGxmGetNotificationRegion();
        let slots = (0..count)
            .map(|i| {
                let address = region.add(first + i);
                *address = 0;
                g::SceGxmNotification { address, value: 0 }
            })
            .collect();
        Self { slots, next: 0 }
    }

    /// Notification for frame slot `i`; its value increments every use.
    pub fn signal(&mut self, i: usize) -> &g::SceGxmNotification {
        self.next = self.next.wrapping_add(1);
        let n = self.slots.len();
        let s = &mut self.slots[i % n];
        s.value = self.next;
        s
    }

    /// Whether the GPU has written slot `i`'s last value (non-blocking).
    pub fn done(&self, i: usize) -> bool {
        let s = &self.slots[i % self.slots.len()];
        s.value == 0 || unsafe { core::ptr::read_volatile(s.address) } == s.value
    }

    pub fn wait(&self, i: usize) {
        let s = &self.slots[i % self.slots.len()];
        if s.value != 0 {
            unsafe {
                g::sceGxmNotificationWait(s);
            }
        }
    }
}
