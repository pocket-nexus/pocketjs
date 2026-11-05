//! Texture upload. Block-compressed data arrives in linear block-row order
//! and is swizzled into GPU layout by the transfer engine, one mip level per
//! copy, straight into video memory.

use core::ptr;

use vita2d_sys as g;

use crate::mem::{Arena, Block, Kind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Rgba8,
    Bc1,
    Bc3,
    Bc5,
    /// Half-float RGBA, uploaded as a linear texture.
    Rgba16f,
}

impl Format {
    /// Bytes per 4×4 block (compressed) or per texel.
    fn unit(self) -> usize {
        match self {
            Format::Bc1 => 8,
            Format::Bc3 | Format::Bc5 => 16,
            Format::Rgba8 => 4,
            Format::Rgba16f => 8,
        }
    }

    fn compressed(self) -> bool {
        matches!(self, Format::Bc1 | Format::Bc3 | Format::Bc5)
    }

    fn gxm(self) -> g::SceGxmTextureFormat {
        match self {
            Format::Rgba8 => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
            Format::Bc1 => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_UBC1_ABGR,
            Format::Bc3 => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_UBC3_ABGR,
            // X in R, Y in G; the remaining channels read 0.
            Format::Bc5 => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_UBC5_00GR,
            Format::Rgba16f => g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_F16F16F16F16_ABGR,
        }
    }

    /// Size of one level as stored in the source (linear, tightly packed).
    pub fn level_bytes(self, w: u32, h: u32) -> usize {
        if self.compressed() {
            (w as usize).div_ceil(4) * (h as usize).div_ceil(4) * self.unit()
        } else {
            (w * h) as usize * self.unit()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wrap {
    Repeat,
    Clamp,
    Mirror,
}

fn addr(w: Wrap) -> g::SceGxmTextureAddrMode {
    match w {
        Wrap::Repeat => g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_REPEAT,
        Wrap::Clamp => g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        Wrap::Mirror => g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_MIRROR,
    }
}

pub struct Texture {
    pub gxm: g::SceGxmTexture,
    pub width: u32,
    pub height: u32,
    pub mips: u32,
    pub format: Format,
    pub bytes: usize,
}

impl Texture {
    pub fn set_wrap(&mut self, s: Wrap, t: Wrap) {
        unsafe {
            g::sceGxmTextureSetUAddrMode(&mut self.gxm, addr(s));
            g::sceGxmTextureSetVAddrMode(&mut self.gxm, addr(t));
        }
    }

    /// Bilinear or point sampling; `mipmapped` blends between levels (trilinear).
    pub fn set_filter(&mut self, linear: bool, mipmapped: bool) {
        let f = if linear {
            g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR
        } else {
            g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT
        };
        let m = if mipmapped && self.mips > 1 {
            g::SceGxmTextureMipFilter_SCE_GXM_TEXTURE_MIP_FILTER_ENABLED
        } else {
            g::SceGxmTextureMipFilter_SCE_GXM_TEXTURE_MIP_FILTER_DISABLED
        };
        unsafe {
            g::sceGxmTextureSetMinFilter(&mut self.gxm, f);
            g::sceGxmTextureSetMagFilter(&mut self.gxm, f);
            g::sceGxmTextureSetMipFilter(&mut self.gxm, m);
        }
    }

    /// GXM has no anisotropic filtering; a small negative bias keeps oblique
    /// surfaces (wet asphalt at grazing angles) from blurring out.
    pub fn set_lod_bias(&mut self, bias: f32) {
        // Unsigned 6-bit field in 1/8 steps, 31 = no bias.
        let v = (31.0 + bias * 8.0).round().clamp(0.0, 63.0) as u32;
        unsafe {
            g::sceGxmTextureSetLodBias(&mut self.gxm, v);
        }
    }
}

/// Staging memory for transfer-engine sources: GPU-mapped main memory that
/// is reset after every [`Uploader::flush`].
pub struct Uploader {
    staging: Block,
    pending: usize,
}

impl Uploader {
    /// # Safety
    /// See [`Block::new`].
    pub unsafe fn new(staging: usize) -> Result<Self, String> {
        Ok(Self {
            staging: Block::new(Kind::Main, staging)?,
            pending: 0,
        })
    }

    /// Waits for queued copies and recycles the staging block.
    pub fn flush(&mut self) {
        if self.pending > 0 {
            unsafe {
                g::sceGxmTransferFinish();
            }
            self.pending = 0;
        }
        self.staging.reset();
    }

    fn stage(&mut self, data: &[u8]) -> Option<*mut u8> {
        let p = self.staging.alloc(data.len(), 16)?;
        unsafe { ptr::copy_nonoverlapping(data.as_ptr(), p, data.len()) };
        Some(p)
    }

    /// Creates a texture in `vram` from linear source levels `0..mips`.
    ///
    /// # Safety
    /// `vram` must stay alive while the texture is in use.
    pub unsafe fn texture(
        &mut self,
        vram: &mut Arena,
        format: Format,
        w: u32,
        h: u32,
        mips: u32,
        data: &[u8],
    ) -> Result<Texture, String> {
        if format == Format::Rgba16f || format == Format::Rgba8 {
            return self.linear(vram, format, w, h, mips, data);
        }
        if !w.is_power_of_two() || !h.is_power_of_two() || w > 4096 || h > 4096 {
            return Err(format!(
                "{w}x{h}: swizzled textures need power-of-two sizes"
            ));
        }
        let total: usize = (0..mips)
            .map(|l| format.level_bytes((w >> l).max(1), (h >> l).max(1)))
            .sum();
        if data.len() < total {
            return Err(format!(
                "{w}x{h} {format:?}: {} bytes for {} expected",
                data.len(),
                total
            ));
        }
        let dst = vram.alloc(total, 512)?;
        let mut at = 0;
        for l in 0..mips {
            let (lw, lh) = ((w >> l).max(1), (h >> l).max(1));
            let n = format.level_bytes(lw, lh);
            let (bw, bh) = (lw.div_ceil(4), lh.div_ceil(4));
            let src = match self.stage(&data[at..at + n]) {
                Some(p) => p,
                None => {
                    self.flush();
                    self.stage(&data[at..at + n])
                        .ok_or("staging block smaller than one mip level")?
                }
            };
            // Blocks are copied as opaque pixels of their own size.
            let raw = if format.unit() == 8 {
                g::SceGxmTransferFormat_SCE_GXM_TRANSFER_FORMAT_RAW64
            } else {
                g::SceGxmTransferFormat_SCE_GXM_TRANSFER_FORMAT_RAW128
            };
            let stride = (bw as usize * format.unit()) as i32;
            let r = g::sceGxmTransferCopy(
                bw,
                bh,
                0,
                0,
                g::SceGxmTransferColorKeyMode_SCE_GXM_TRANSFER_COLORKEY_NONE,
                raw,
                g::SceGxmTransferType_SCE_GXM_TRANSFER_LINEAR,
                src.cast(),
                0,
                0,
                stride,
                raw,
                g::SceGxmTransferType_SCE_GXM_TRANSFER_SWIZZLED,
                dst.add(at).cast(),
                0,
                0,
                stride,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
            );
            if r < 0 {
                return Err(format!("sceGxmTransferCopy {lw}x{lh} 0x{:08x}", r as u32));
            }
            self.pending += 1;
            at += n;
        }
        let mut gxm: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitSwizzled(&mut gxm, dst.cast(), format.gxm(), w, h, mips);
        if r < 0 {
            return Err(format!("sceGxmTextureInitSwizzled 0x{:08x}", r as u32));
        }
        let mut t = Texture {
            gxm,
            width: w,
            height: h,
            mips,
            format,
            bytes: total,
        };
        t.set_filter(true, true);
        Ok(t)
    }

    /// Linear textures: every level's rows are padded to 8 texels.
    unsafe fn linear(
        &mut self,
        vram: &mut Arena,
        format: Format,
        w: u32,
        h: u32,
        mips: u32,
        data: &[u8],
    ) -> Result<Texture, String> {
        let unit = format.unit();
        let padded =
            |l: u32| ((w >> l).max(1).next_multiple_of(8) * (h >> l).max(1)) as usize * unit;
        let total: usize = (0..mips).map(padded).sum();
        let dst = vram.alloc(total, 512)?;
        let mut src_at = 0;
        let mut dst_at = 0;
        for l in 0..mips {
            let (lw, lh) = ((w >> l).max(1) as usize, (h >> l).max(1) as usize);
            let row = lw * unit;
            let stride = lw.next_multiple_of(8) * unit;
            for y in 0..lh {
                let s = data
                    .get(src_at + y * row..src_at + (y + 1) * row)
                    .ok_or("truncated linear texture")?;
                ptr::copy_nonoverlapping(s.as_ptr(), dst.add(dst_at + y * stride), row);
            }
            src_at += row * lh;
            dst_at += padded(l);
        }
        let mut gxm: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitLinear(&mut gxm, dst.cast(), format.gxm(), w, h, mips);
        if r < 0 {
            return Err(format!("sceGxmTextureInitLinear 0x{:08x}", r as u32));
        }
        let mut t = Texture {
            gxm,
            width: w,
            height: h,
            mips,
            format,
            bytes: total,
        };
        t.set_filter(true, true);
        Ok(t)
    }

    /// # Safety
    /// GPU idle with respect to staging.
    pub unsafe fn free(mut self) {
        self.flush();
        self.staging.free();
    }
}
