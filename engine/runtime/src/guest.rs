use crate::{OpContext, RuntimeError};
use alloc::{string::String, vec::Vec};
use pocket_drivers::{AxisDelta, MotionState, TextEvent};

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
    pub tick_hz: u32,
    pub viewport: [u32; 2],
    pub auxiliary_viewport: Option<[u32; 2]>,
    pub auxiliary_root: i32,
    pub raster_density: u32,
    pub heap_limit: usize,
    pub pak: &'a [u8],
    /// None means that JS must load assets from pak. Some(empty) means that
    /// native asset loading completed and found no texture or sprite entries.
    pub assets: Option<&'a AssetRegistry>,
}

/// The existing eight frame arguments; cancellation records are part of the
/// touches array (bit 30), with corresponding zero hits and surface ids.
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
    /// Run frame once and drain the engine's queued jobs before returning.
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError>;
    fn collect(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn shutdown(&mut self) {}
}
