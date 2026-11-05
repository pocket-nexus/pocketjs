//! Host substitutes for the three PSP partition calls used by arena.rs.
//! Allocation and free-list logic come from the production source unchanged.
use core::ffi::c_void;
use core::sync::atomic::{AtomicUsize, Ordering};

pub const CAPACITY: usize = 24 * 1024 * 1024;
#[repr(align(4096))]
struct Backing([u8; CAPACITY]);
static mut BACKING: Backing = Backing([0; CAPACITY]);
pub static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

pub enum SceSysMemBlockTypes {
    Low,
}
pub enum SceSysMemPartitionId {
    SceKernelPrimaryUserPartition,
}
pub struct SceUid(pub i32);
pub unsafe fn sceKernelMaxFreeMemSize() -> u32 {
    (CAPACITY + 2 * 1024 * 1024) as u32
}
pub unsafe fn sceKernelAllocPartitionMemory(
    _: SceSysMemPartitionId,
    _: *const u8,
    _: SceSysMemBlockTypes,
    size: u32,
    _: *mut c_void,
) -> SceUid {
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    assert!(size > 0 && size as usize <= CAPACITY);
    if std::env::var_os("POCKET_TEST_ARENA_INIT_FAIL").is_some() {
        SceUid(-1)
    } else {
        SceUid(1)
    }
}
pub unsafe fn sceKernelGetBlockHeadAddr(_: SceUid) -> *mut c_void {
    core::ptr::addr_of_mut!(BACKING).cast()
}
