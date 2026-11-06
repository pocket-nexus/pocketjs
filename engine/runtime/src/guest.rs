use crate::{OpContext, RuntimeError};
use alloc::{string::String, vec::Vec};
use pocket_drivers::{AxisDelta, MotionState, Pointer, TextEvent};

#[derive(Clone, Debug)]
pub struct NamedTexture {
    pub name: String,
    pub handle: i32,
}
#[derive(Clone, Debug)]
pub struct NamedSprite {
    pub name: String,
    pub handle: i32,
    pub frames: u32,
    pub columns: u32,
    pub step: u32,
}
#[derive(Clone, Debug, Default)]
pub struct AssetRegistry {
    pub textures: Vec<NamedTexture>,
    pub sprites: Vec<NamedSprite>,
}

/// Metadata is copied by the guest. The runtime keeps the package allocation
/// unchanged until shutdown; a C guest may expose pak as an immutable buffer.
pub struct GuestEnvironment<'a> {
    pub host: &'a str,
    pub host_abi: u32,
    /// Core ticks per virtual second: the admitted package's rate.
    pub tick_hz: u32,
    /// Guest frames per second: the host cadence. Guests publish it as
    /// `globalThis.__simHz`; each frame advances `tick_hz / sim_hz` ticks.
    pub sim_hz: u32,
    pub viewport: [u32; 2],
    pub auxiliary_viewport: Option<[u32; 2]>,
    pub auxiliary_root: i32,
    pub raster_density: u32,
    pub heap_limit: usize,
    pub pak: &'a [u8],
    /// The package's NUL-terminated worker bundle (section 8); empty when
    /// its plan declares no worker domain. A guest that hosts the worker
    /// starts it before the UI bundle evaluates.
    pub worker_javascript: &'a [u8],
    /// None means that JS must load assets from pak. Some(empty) means that
    /// native asset loading completed and found no texture or sprite entries.
    pub assets: Option<&'a AssetRegistry>,
}

/// The existing eight frame arguments; cancellation records are part of the
/// touches array (bit 30), with corresponding zero hits and surface ids.
/// The frame's text events, its pointer, the pointer's scroll and the exact
/// position of each touches word follow.
pub struct GuestFrame<'a> {
    pub buttons: u32,
    pub analog: u32,
    pub touches: &'a [u32],
    pub hits: &'a [i32],
    pub touch_surfaces: &'a [u8],
    pub right_analog: u32,
    pub axis_deltas: &'a [AxisDelta],
    pub motion: Option<&'a MotionState>,
    pub text: &'a [TextEvent],
    /// The frame's pointer, with or without a button down, in unclamped
    /// logical px of its surface; `None` when no input source reported one.
    pub pointer: Option<Pointer>,
    /// The frame's summed wheel and trackpad scrolling in logical px of the
    /// pointer's surface, x then y; zero when `pointer` is `None`.
    pub scroll: [f32; 2],
    /// Two entries per `touches` word, x then y, in logical px of its
    /// surface: the position the word clamps to whole px in 0..=1023. A
    /// cancellation's pair is zero.
    pub touch_positions: &'a [f32],
}

pub trait Guest {
    fn initialize(
        &mut self,
        _ops: OpContext,
        _environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError>;
    /// Evaluate the package's bytecode section (`pocket_package::bytecode`):
    /// the envelope and the serialized object. `UnsupportedOperation` before
    /// anything ran when the guest has no engine ABI or the digest is another
    /// build's; the runtime then evaluates the source.
    fn evaluate_bytecode(&mut self, _envelope: &[u8]) -> Result<(), RuntimeError> {
        Err(RuntimeError::UnsupportedOperation)
    }
    /// Run frame once and drain the engine's queued jobs before returning.
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError>;
    fn collect(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn shutdown(&mut self) {}
}
