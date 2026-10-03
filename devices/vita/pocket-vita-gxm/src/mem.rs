//! GPU-visible memory: kernel memory blocks mapped into GXM, with a bump
//! allocator on top. Scene data lives for the scene's lifetime and is freed
//! in one go; per-frame data uses [`Ring`].

use crate::allocation::{reserve, rounded};
use core::ffi::c_void;
use core::ptr;

use vita2d_sys as g;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 128 MiB of video RAM: fastest for textures and render targets.
    Cdram,
    /// Main LPDDR, uncached, GPU-mapped: geometry and staging.
    Main,
}

pub struct Block {
    uid: g::SceUID,
    base: *mut u8,
    size: usize,
    used: usize,
    pub kind: Kind,
}

impl Block {
    /// # Safety
    /// Must be released with [`Block::free`] after the GPU stopped using it.
    pub unsafe fn new(kind: Kind, size: usize) -> Result<Self, String> {
        Self::with_access(kind, size, true)
    }

    /// Allocate mapped memory; `gpu_write` selects whether GPU writes are allowed.
    /// # Safety
    /// Release only after all GPU accesses complete.
    pub unsafe fn with_access(kind: Kind, size: usize, gpu_write: bool) -> Result<Self, String> {
        let (ty, align) = match kind {
            Kind::Cdram => (g::SCE_KERNEL_MEMBLOCK_TYPE_USER_CDRAM_RW, 256 * 1024),
            Kind::Main => (g::SCE_KERNEL_MEMBLOCK_TYPE_USER_RW_UNCACHE, 4096),
        };
        let size = rounded(size.max(align), align)
            .filter(|&n| n <= u32::MAX as usize)
            .ok_or("GPU allocation overflow")?;
        let uid = g::sceKernelAllocMemBlock(
            c"pocket-vita-gxm".as_ptr(),
            ty,
            size as u32,
            ptr::null_mut(),
        );
        if uid < 0 {
            return Err(format!(
                "sceKernelAllocMemBlock({kind:?}, {} KiB) 0x{:08x}",
                size / 1024,
                uid as u32
            ));
        }
        let mut base: *mut c_void = ptr::null_mut();
        if g::sceKernelGetMemBlockBase(uid, &mut base) < 0 || base.is_null() {
            g::sceKernelFreeMemBlock(uid);
            return Err("sceKernelGetMemBlockBase failed".into());
        }
        let attrib = g::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_READ
            | if gpu_write {
                g::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_WRITE
            } else {
                0
            };
        let r = g::sceGxmMapMemory(base, size as u32, attrib);
        if r < 0 {
            g::sceKernelFreeMemBlock(uid);
            return Err(format!("sceGxmMapMemory 0x{:08x}", r as u32));
        }
        Ok(Self {
            uid,
            base: base.cast(),
            size,
            used: 0,
            kind,
        })
    }

    /// Bump-allocates `len` bytes aligned to `align` (a power of two).
    pub fn alloc(&mut self, len: usize, align: usize) -> Option<*mut u8> {
        let start = reserve(&mut self.used, self.size, len, align)?;
        Some(unsafe { self.base.add(start) })
    }

    pub fn used(&self) -> usize {
        self.used
    }

    pub fn reset(&mut self) {
        self.used = 0;
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn base(&self) -> *mut u8 {
        self.base
    }

    /// # Safety
    /// No queued or in-flight GPU work may reference the block.
    pub unsafe fn free(self) {
        g::sceGxmUnmapMemory(self.base.cast());
        g::sceKernelFreeMemBlock(self.uid);
    }
}

/// A growable set of blocks of one kind.
pub struct Arena {
    kind: Kind,
    chunk: usize,
    blocks: Vec<Block>,
}

impl Arena {
    pub fn new(kind: Kind, chunk: usize) -> Self {
        Self {
            kind,
            chunk,
            blocks: Vec::new(),
        }
    }

    /// # Safety
    /// See [`Block::new`].
    pub unsafe fn alloc(&mut self, len: usize, align: usize) -> Result<*mut u8, String> {
        if let Some(p) = self.blocks.last_mut().and_then(|b| b.alloc(len, align)) {
            return Ok(p);
        }
        let capacity = len
            .max(self.chunk)
            .checked_add(align)
            .ok_or("GPU arena size overflow")?;
        let mut b = Block::new(self.kind, capacity)?;
        let p = b.alloc(len, align).ok_or("fresh block too small")?;
        self.blocks.push(b);
        Ok(p)
    }

    pub fn used(&self) -> usize {
        self.blocks.iter().map(|b| b.used()).sum()
    }

    pub fn reserved(&self) -> usize {
        self.blocks.iter().map(|b| b.size()).sum()
    }

    /// # Safety
    /// GPU idle with respect to every allocation.
    pub unsafe fn free(self) {
        for b in self.blocks {
            b.free();
        }
    }
}

/// Per-frame GPU scratch memory: `frames` segments used round-robin. A
/// segment is reused `frames` frames later, after the caller has waited for
/// that frame's GPU work.
pub struct Ring {
    block: Block,
    frames: usize,
    segment: usize,
    current: usize,
    offset: usize,
}

impl Ring {
    /// # Safety
    /// See [`Block::new`].
    pub unsafe fn new(segment: usize, frames: usize) -> Result<Self, String> {
        if frames == 0 || segment == 0 {
            return Err("GPU ring needs nonempty segments".into());
        }
        let segment = rounded(segment, 4096).ok_or("GPU ring size overflow")?;
        let size = segment
            .checked_mul(frames)
            .ok_or("GPU ring size overflow")?;
        Ok(Self {
            block: Block::new(Kind::Main, size)?,
            frames,
            segment,
            current: 0,
            offset: 0,
        })
    }

    pub fn next_frame(&mut self) {
        self.current = (self.current + 1) % self.frames;
        self.offset = 0;
    }

    pub fn alloc(&mut self, len: usize, align: usize) -> Option<*mut u8> {
        let start = reserve(&mut self.offset, self.segment, len, align)?;
        Some(unsafe { self.block.base.add(self.current * self.segment + start) })
    }

    pub fn used(&self) -> usize {
        self.offset
    }

    /// # Safety
    /// GPU idle.
    pub unsafe fn free(self) {
        self.block.free();
    }
}
