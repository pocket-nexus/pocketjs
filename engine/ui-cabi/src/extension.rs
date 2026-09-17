//! Compatibility projection of the versioned native-extension ABI owned by the
//! Symbian Qt host. Application-specific static libraries depend on this
//! module instead of repeating the C table or key assignments.

use core::ffi::c_void;

pub const ABI_V1: u32 = 1;
pub const FLAG_DEPTH_BUFFER: u32 = 1 << 0;

pub const KEY_MOVE_FORWARD: u32 = 1 << 0;
pub const KEY_MOVE_BACK: u32 = 1 << 1;
pub const KEY_MOVE_LEFT: u32 = 1 << 2;
pub const KEY_MOVE_RIGHT: u32 = 1 << 3;
pub const KEY_LOOK_UP: u32 = 1 << 4;
pub const KEY_LOOK_DOWN: u32 = 1 << 5;
pub const KEY_LOOK_LEFT: u32 = 1 << 6;
pub const KEY_LOOK_RIGHT: u32 = 1 << 7;
pub const KEY_FIRE: u32 = 1 << 8;
pub const KEY_JUMP: u32 = 1 << 9;
pub const KEY_RELOAD: u32 = 1 << 10;
pub const KEY_WALK: u32 = 1 << 11;

#[repr(C)]
pub struct ExtensionV1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub flags: u32,
    pub boot: Option<
        unsafe extern "C" fn(
            context: *mut c_void,
            pak: *const u8,
            pak_len: usize,
            viewport_width: i32,
            viewport_height: i32,
        ) -> i32,
    >,
    /// Tears down the extension. `gl_context_current` is non-zero only while
    /// the owning GLES context is live and current; a zero value forbids GL
    /// calls and requires abandoning any stale handles.
    pub shutdown: Option<unsafe extern "C" fn(gl_context_current: i32)>,
    pub before_guest: Option<
        unsafe extern "C" fn(
            context: *mut c_void,
            buttons: u32,
            analog: u32,
            native_keys: u32,
        ) -> i32,
    >,
    pub after_guest: Option<unsafe extern "C" fn(context: *mut c_void) -> i32>,
    pub resize: Option<unsafe extern "C" fn(viewport_width: i32, viewport_height: i32)>,
    pub render: Option<
        unsafe extern "C" fn(
            target_x: i32,
            target_y: i32,
            target_width: i32,
            target_height: i32,
            window_width: i32,
            window_height: i32,
        ) -> i32,
    >,
}

/// Optional tail used by native app navigation to retire GPU resources while
/// retaining the guest and simulation. Set base.struct_size to this table's size.
#[repr(C)]
pub struct GraphicsExtensionV1 {
    pub base: ExtensionV1,
    pub release_graphics: Option<unsafe extern "C" fn(gl_context_current: i32)>,
}
unsafe impl Sync for GraphicsExtensionV1 {}

impl ExtensionV1 {
    pub const fn struct_size() -> u32 {
        core::mem::size_of::<Self>() as u32
    }
}

unsafe impl Sync for ExtensionV1 {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_bits_match_the_public_c_header() {
        assert_eq!(KEY_MOVE_FORWARD, 0x001);
        assert_eq!(KEY_WALK, 0x800);
        assert_eq!(
            KEY_MOVE_FORWARD
                | KEY_MOVE_BACK
                | KEY_MOVE_LEFT
                | KEY_MOVE_RIGHT
                | KEY_LOOK_UP
                | KEY_LOOK_DOWN
                | KEY_LOOK_LEFT
                | KEY_LOOK_RIGHT
                | KEY_FIRE
                | KEY_JUMP
                | KEY_RELOAD
                | KEY_WALK,
            0x0fff
        );
    }

    #[test]
    fn graphics_tail_preserves_the_v1_prefix() {
        assert_eq!(core::mem::offset_of!(GraphicsExtensionV1, base), 0);
        assert_eq!(core::mem::offset_of!(GraphicsExtensionV1, release_graphics), core::mem::size_of::<ExtensionV1>());
        assert_eq!(core::mem::size_of::<GraphicsExtensionV1>(), core::mem::size_of::<ExtensionV1>() + core::mem::size_of::<usize>());
    }

    #[test]
    fn abi_v1_layout_uses_only_pointer_aligned_fields() {
        assert_eq!(
            core::mem::align_of::<ExtensionV1>(),
            core::mem::align_of::<usize>()
        );
        assert!(core::mem::align_of::<ExtensionV1>() <= 8);
        assert_eq!(
            ExtensionV1::struct_size() as usize,
            core::mem::size_of::<ExtensionV1>()
        );
    }
}
