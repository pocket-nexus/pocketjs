//! The switch veil (docs/PLATFORM.md): the system transition a guest swap plays
//! before the incoming bundle's blocking eval.
//!
//! Host-direct GE drawing, no guest anywhere: the outgoing frame's shot
//! dims down, the baked Pocket mark fades in centered and settles, and its
//! brightness swells once — every animated quantity is UNIFORM across the
//! frame (vertex color ramps over time only), because GE sprites do not
//! interpolate color across a quad: any spatial gradient built from flat
//! strips reads as a marching band of seams on hardware (the first cut's
//! left-to-right sweep did exactly that). The last frame settles and HOLDS
//! through the eval; the incoming guest's first present replaces it.
//!
//! Deliberately invisible to every contract: no op, no capability, and the
//! frames present OUTSIDE the input-indexed main loop, so the capture
//! identity (input at frame N <-> file fN) and the e2e switch signature
//! never move.

use core::ffi::c_void;

use psp::sys::{
    self, BlendFactor, BlendOp, GuContextType, GuPrimitive, GuState, GuSyncBehavior, GuSyncMode,
    MipmapLevel, TextureColorComponent, TextureEffect, TextureFilter, TexturePixelFormat,
    VertexType,
};

use crate::{host, switch};

/// 128×128 RGBA, baked from assets/brand by tools/psp.ts. Empty when a
/// custom host builds without the backend env — the veil then dims without
/// the mark.
static LOGO: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/veil.raw"));
const LOGO_TEX: i16 = 128;
/// On-screen mark size (logical px) and center.
const MARK: i16 = 96;
const CX: i16 = 240;
const CY: i16 = 128;

const FRAMES: u32 = 24;
/// The one-shot brightness swell: base silver rises to full white and back
/// over these frames (uniform per frame — no spatial gradient, no seams).
const SWELL_START: u32 = 8;
const SWELL_END: u32 = 22;

/// TEXTURE_16BIT | COLOR_8888 | VERTEX_16BIT | TRANSFORM_2D (ge.rs layout;
/// UVs are TEXELS in 2D transform mode).
#[repr(C)]
#[derive(Copy, Clone)]
struct VertTC {
    u: i16,
    v: i16,
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

const VTYPE_TC: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_16BIT.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);

static mut VERTS: psp::Align16<[VertTC; 64]> = psp::Align16(
    [VertTC { u: 0, v: 0, color: 0, x: 0, y: 0, z: 0, _pad: 0 }; 64],
);
static mut NVERTS: usize = 0;

unsafe fn sprite(u0: i16, v0: i16, u1: i16, v1: i16, x0: i16, y0: i16, x1: i16, y1: i16, color: u32) {
    let n = NVERTS;
    VERTS.0[n] = VertTC { u: u0, v: v0, color, x: x0, y: y0, z: 0, _pad: 0 };
    VERTS.0[n + 1] = VertTC { u: u1, v: v1, color, x: x1, y: y1, z: 0, _pad: 0 };
    NVERTS = n + 2;
}

unsafe fn flush_sprites() {
    if NVERTS == 0 {
        return;
    }
    sys::sceKernelDcacheWritebackRange(
        VERTS.0.as_ptr() as *const c_void,
        (NVERTS * core::mem::size_of::<VertTC>()) as u32,
    );
    sys::sceGuDrawArray(
        GuPrimitive::Sprites,
        VTYPE_TC,
        NVERTS as i32,
        core::ptr::null(),
        VERTS.0.as_ptr() as *const c_void,
    );
    NVERTS = 0;
}

unsafe fn bind(pixels: *const u8, w: i32, h: i32) {
    sys::sceGuEnable(GuState::Texture2D);
    sys::sceGuTexMode(TexturePixelFormat::Psm8888, 0, 0, 0);
    sys::sceGuTexImage(MipmapLevel::None, w, h, w, pixels as *const c_void);
    sys::sceGuTexFlush(); // real-GE cache quirk, same as ge.rs apply_texture
    sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
    sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
}

#[inline]
fn abgr(a: u8, b: u8, g: u8, r: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32
}

/// Play the veil: ~24 vblanks of host-drawn transition. Call between a
/// guest teardown and the next boot — the GE is idle, no list is open, and
/// the display holds the outgoing frame until our first present.
pub unsafe fn play() {
    if !switch::multi() {
        return;
    }
    let shot = switch::shot_pixels();
    if let Some(pixels) = shot {
        sys::sceKernelDcacheWritebackRange(pixels.as_ptr() as *const c_void, pixels.len() as u32);
    }
    let logo = if LOGO.len() == (LOGO_TEX as usize * LOGO_TEX as usize * 4) {
        Some(LOGO.as_ptr())
    } else {
        None
    };

    for k in 0..FRAMES {
        sys::sceGuStart(GuContextType::Direct, host::list_ptr());
        // The veil owns all GE state it needs: the ui path leaves blending
        // disabled between frames, and texture alpha is the whole trick here.
        sys::sceGuEnable(GuState::Blend);
        sys::sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::OneMinusSrcAlpha, 0, 0);

        // Background: the outgoing frame dimming down over the first 8
        // vblanks (modulated by a falling gray), or a flat near-black.
        let t = (k.min(8) as f32) / 8.0;
        let dim = (255.0 + (72.0 - 255.0) * t) as u8;
        match shot {
            Some(pixels) => {
                bind(pixels.as_ptr(), switch::SHOT_W as i32, switch::SHOT_H as i32);
                sprite(
                    0,
                    0,
                    switch::SHOT_W as i16,
                    switch::SHOT_H as i16,
                    0,
                    0,
                    480,
                    272,
                    abgr(0xff, dim, dim, dim),
                );
                flush_sprites();
            }
            None => {
                sys::sceGuDisable(GuState::Texture2D);
                // Untextured path still uses the TC vertex (UVs ignored).
                sprite(0, 0, 0, 0, 0, 0, 480, 272, abgr(0xff, 0x10, 0x0a, 0x0a));
                flush_sprites();
            }
        }

        if let Some(logo_ptr) = logo {
            // The mark: fade + settle in over frames 2..12, slight scale-in,
            // then one gentle whole-mark brightness swell. All ramps are
            // per-frame uniform — reliable on the real GE by construction.
            let f = (((k as f32) - 2.0) / 10.0).clamp(0.0, 1.0);
            if f > 0.0 {
                let alpha = (f * 255.0) as u8;
                let half = (MARK as f32 * (1.10 - 0.10 * f) * 0.5) as i16;
                let swell = if (SWELL_START..SWELL_END).contains(&k) {
                    let t = ((k - SWELL_START) as f32) / ((SWELL_END - SWELL_START) as f32);
                    let d = 2.0 * t - 1.0;
                    (1.0 - d * d).max(0.0)
                } else {
                    0.0
                };
                let bright = |base: f32| ((base + (255.0 - base) * swell) as u8);
                bind(logo_ptr, LOGO_TEX as i32, LOGO_TEX as i32);
                sprite(
                    0,
                    0,
                    LOGO_TEX,
                    LOGO_TEX,
                    CX - half,
                    CY - half,
                    CX + half,
                    CY + half,
                    abgr(alpha, bright(216.0), bright(210.0), bright(204.0)),
                );
                flush_sprites();
            }
        }

        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();
        #[cfg(feature = "capture")]
        dump_veil_frame(k);
    }
}

/// Capture builds: dump each veil frame to ms0:/dc_cap/vNNNN.raw so the
/// transition is inspectable in PPSSPPHeadless. Separate namespace from the
/// main loop's fNNNN files — the e2e capture signature must not move.
#[cfg(feature = "capture")]
unsafe fn dump_veil_frame(k: u32) {
    use psp::sys::{DisplayPixelFormat, DisplaySetBufSync, IoOpenFlags};
    static mut SEQ: u32 = 0;
    let idx = SEQ;
    SEQ = SEQ.wrapping_add(1);
    let _ = k;
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/dc_cap\0".as_ptr(), 0o777);
    }
    let mut name: [u8; 22] = *b"ms0:/dc_cap/v0000.raw\0";
    let mut v = idx;
    let mut i = 16usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 13 {
            break;
        }
        i -= 1;
    }
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let fd = sys::sceIoOpen(name.as_ptr(), IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC, 0o777);
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
}
