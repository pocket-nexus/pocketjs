//! A shader patcher with its own memory. vita2d's patcher has 64 KiB each of
//! buffer, vertex USSE and fragment USSE memory, which a scene with a hundred
//! patched material programs exhausts (`sceGxmShaderPatcherCreate*Program`
//! then fails with 0x805b0024). Programs registered here are patched into
//! pools sized for a full material library plus hot-reload churn.

use core::ffi::c_void;
use core::ptr;

use vita2d_sys as g;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

unsafe extern "C" fn host_alloc(_user: *mut c_void, size: u32) -> *mut c_void {
    malloc(size as usize)
}

unsafe extern "C" fn host_free(_user: *mut c_void, mem: *mut c_void) {
    free(mem)
}

#[derive(Clone, Copy)]
enum Map {
    Gpu,
    VertexUsse,
    FragmentUsse,
}

struct Pool {
    uid: g::SceUID,
    base: *mut c_void,
    map: Map,
}

impl Pool {
    unsafe fn new(size: u32, map: Map) -> Result<(Self, u32), String> {
        let size = size.next_multiple_of(4096);
        let uid = g::sceKernelAllocMemBlock(
            c"pocket3d-patcher".as_ptr(),
            g::SCE_KERNEL_MEMBLOCK_TYPE_USER_RW_UNCACHE,
            size,
            ptr::null_mut(),
        );
        if uid < 0 {
            return Err(format!(
                "sceKernelAllocMemBlock(patcher, {} KiB) 0x{:08x}",
                size / 1024,
                uid as u32
            ));
        }
        let mut base = ptr::null_mut();
        if g::sceKernelGetMemBlockBase(uid, &mut base) < 0 {
            g::sceKernelFreeMemBlock(uid);
            return Err("sceKernelGetMemBlockBase(patcher) failed".into());
        }
        let mut offset = 0u32;
        let r = match map {
            Map::Gpu => g::sceGxmMapMemory(
                base,
                size,
                g::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_READ
                    | g::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_WRITE,
            ),
            Map::VertexUsse => g::sceGxmMapVertexUsseMemory(base, size, &mut offset),
            Map::FragmentUsse => g::sceGxmMapFragmentUsseMemory(base, size, &mut offset),
        };
        if r < 0 {
            g::sceKernelFreeMemBlock(uid);
            return Err(format!("mapping patcher memory 0x{:08x}", r as u32));
        }
        Ok((Self { uid, base, map }, offset))
    }

    unsafe fn free(self) {
        match self.map {
            Map::Gpu => g::sceGxmUnmapMemory(self.base),
            Map::VertexUsse => g::sceGxmUnmapVertexUsseMemory(self.base),
            Map::FragmentUsse => g::sceGxmUnmapFragmentUsseMemory(self.base),
        };
        g::sceKernelFreeMemBlock(self.uid);
    }
}

pub struct Patcher {
    pub raw: *mut g::SceGxmShaderPatcher,
    pools: Vec<Pool>,
}

impl Patcher {
    /// # Safety
    /// GXM initialised. Destroy only after every program patched here was
    /// released and the GPU no longer runs them.
    pub unsafe fn new(buffer: u32, vertex_usse: u32, fragment_usse: u32) -> Result<Self, String> {
        let (buf, _) = Pool::new(buffer, Map::Gpu)?;
        let (vusse, voff) = Pool::new(vertex_usse, Map::VertexUsse)?;
        let (fusse, foff) = Pool::new(fragment_usse, Map::FragmentUsse)?;
        let mut params: g::SceGxmShaderPatcherParams = core::mem::zeroed();
        params.hostAllocCallback = Some(host_alloc);
        params.hostFreeCallback = Some(host_free);
        params.bufferMem = buf.base;
        params.bufferMemSize = buffer.next_multiple_of(4096);
        params.vertexUsseMem = vusse.base;
        params.vertexUsseMemSize = vertex_usse.next_multiple_of(4096);
        params.vertexUsseOffset = voff;
        params.fragmentUsseMem = fusse.base;
        params.fragmentUsseMemSize = fragment_usse.next_multiple_of(4096);
        params.fragmentUsseOffset = foff;
        let mut raw = ptr::null_mut();
        let r = g::sceGxmShaderPatcherCreate(&params, &mut raw);
        let pools = vec![buf, vusse, fusse];
        if r < 0 {
            for p in pools {
                p.free();
            }
            return Err(format!("sceGxmShaderPatcherCreate 0x{:08x}", r as u32));
        }
        Ok(Self { raw, pools })
    }

    /// Bytes in use: (buffer, vertex USSE, fragment USSE).
    pub fn usage(&self) -> (u32, u32, u32) {
        unsafe {
            (
                g::sceGxmShaderPatcherGetBufferMemAllocated(self.raw),
                g::sceGxmShaderPatcherGetVertexUsseMemAllocated(self.raw),
                g::sceGxmShaderPatcherGetFragmentUsseMemAllocated(self.raw),
            )
        }
    }

    /// # Safety
    /// See [`Patcher::new`].
    pub unsafe fn destroy(self) {
        g::sceGxmShaderPatcherDestroy(self.raw);
        for p in self.pools {
            p.free();
        }
    }
}
