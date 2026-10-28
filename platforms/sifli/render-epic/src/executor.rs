//! The executor contract: bind a device target, run commands in order.
//!
//! Commands may stay in flight after [`Executor::submit`] returns, until the
//! next [`Executor::fence`], [`Executor::begin`] or [`Executor::end`]. The
//! renderer fences before it rewrites a plane or tile a submitted command
//! reads. `fence`, `end` and every error return only after the hardware
//! completed or stopped all submitted work.

use crate::caps::Capabilities;
use crate::cmd::{Cmd, MaskId, TileId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecError {
    /// The request cannot run on this executor; nothing was written.
    Unsupported,
    /// The executor failed and stopped every submitted command.
    Failed,
}

/// Texel layouts of the `.epic` table, in EPIC channel order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum NativeFormat {
    /// RGB565 with red in the high bits.
    Rgb565 = 0,
    /// B, G, R, A bytes.
    Bgra8888 = 1,
    /// 8-bit indices behind a 1024-byte BGRA palette.
    L8 = 2,
}

/// Layout of a texture handed to [`Executor::register_texture`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureFormat {
    Native(NativeFormat),
    /// A PocketJS PSM code; PSM_T8 carries a 1024-byte RGBA palette.
    Portable(u32),
}

#[derive(Clone, Copy, Debug)]
pub struct TextureSource<'a> {
    pub format: TextureFormat,
    pub width: u32,
    pub height: u32,
    pub pixels: &'a [u8],
    pub palette: Option<&'a [u8]>,
}

/// A hardware executor bound to one target at a time.
pub trait Executor {
    /// What the planner may issue. Constant for the executor's lifetime.
    fn caps(&self) -> Capabilities;

    /// Read-only preflight of a BlitRotate command. No writes or queued
    /// operations; false sends the original triangles through the CPU.
    fn can_blit_rotate(&self, _cmd: &Cmd) -> bool {
        false
    }

    /// Wait for earlier work and bind the device target `target`, which
    /// must be `width` x `height` RGB565 pixels.
    fn begin(&mut self, target: u64, width: u32, height: u32) -> Result<(), ExecError>;

    /// Run `cmds` in order after every earlier command.
    fn submit(&mut self, cmds: &[Cmd]) -> Result<(), ExecError>;

    /// Complete every submitted command.
    fn fence(&mut self) -> Result<(), ExecError>;

    /// Complete everything and release the target.
    fn end(&mut self) -> Result<(), ExecError>;

    /// The A8 plane `mask`, at least `Capabilities::mask_bytes` bytes.
    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8];

    /// The RGB565 tile `tile`, at least `Capabilities::tile_pixels` pixels.
    fn tile_mut(&mut self, tile: TileId) -> &mut [u16];

    /// Register a texture commands may then reference by the returned id.
    /// `Unsupported` leaves that texture to the CPU.
    ///
    /// # Safety
    /// A command that references the returned id reads `source`'s storage
    /// when it executes; the caller keeps that storage valid and unchanged
    /// until every such command completed. The registration reads nothing
    /// after this call returns.
    unsafe fn register_texture(&mut self, source: &TextureSource<'_>) -> Result<u32, ExecError>;

    /// Forget a registered texture. No submitted command still reads it.
    fn release_texture(&mut self, id: u32);
}
