//! GBA Mode 0 tile background and hardware sprite presenter.
//!
//! BG0 owns character block 0 and screen block 31. Its 8bpp tiles occupy
//! 0x06000000..0x0600F800; its 32 x 32 map occupies 0x0600F800..0x06010000.
//! OBJ uses 8bpp tiles and one-dimensional mapping in the separate 32 KiB
//! at 0x06010000. Palette entry zero is transparent for both BG and OBJ.
//! The CPU uploads assets and OAM; the LCD controller composites every pixel.
//!
//! Register fields and tile addressing follow GBATEK:
//! https://rust-console.github.io/gbatek-gbaonly/#lcd-obj---oam-attributes

use core::ptr::write_volatile;
use core::sync::atomic::{compiler_fence, Ordering};

pub const BG_TILE_BYTES: usize = 0xf800;
pub const OBJ_TILE_BYTES: usize = 0x8000;
pub const MAP_WORDS: usize = 32 * 32;
pub const OAM_SLOTS: usize = 128;
pub const DISPLAY_CONTROL: u16 = 0x1140; // Mode 0, BG0, OBJ, 1D OBJ mapping.
pub const BG_CONTROL: u16 = 0x1f83; // 8bpp, char block 0, map block 31, priority 3.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoError {
    BackgroundPalette,
    ObjectPalette,
    BackgroundTiles,
    BackgroundMap,
    ObjectTiles,
    ObjectSlot,
    ObjectPriority,
    AffineSlot,
}

/// Generated buffers use halfwords so DMA sources have guaranteed alignment.
/// The map has 32 columns, including the two columns beyond the 240px screen.
pub struct Background<'a> {
    pub palette: &'a [u16],
    pub tiles: &'a [u16],
    pub map: &'a [u16],
}

impl Background<'_> {
    pub fn validate(&self) -> Result<(), VideoError> {
        if self.palette.len() != 256 {
            return Err(VideoError::BackgroundPalette);
        }
        if self.tiles.is_empty()
            || self.tiles.len() % 32 != 0
            || self.tiles.len() > BG_TILE_BYTES / 2
        {
            return Err(VideoError::BackgroundTiles);
        }
        let tile_count = self.tiles.len() / 32;
        if self.map.len() != MAP_WORDS
            || self
                .map
                .iter()
                .any(|entry| usize::from(entry & 0x3ff) >= tile_count)
        {
            return Err(VideoError::BackgroundMap);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpriteShape {
    Square8,
    Square16,
    Square32,
    Square64,
    Wide16x8,
    Wide32x8,
    Wide32x16,
    Wide64x32,
    Tall8x16,
    Tall8x32,
    Tall16x32,
    Tall32x64,
}

impl SpriteShape {
    pub const fn dimensions(self) -> (u16, u16) {
        match self {
            Self::Square8 => (8, 8),
            Self::Square16 => (16, 16),
            Self::Square32 => (32, 32),
            Self::Square64 => (64, 64),
            Self::Wide16x8 => (16, 8),
            Self::Wide32x8 => (32, 8),
            Self::Wide32x16 => (32, 16),
            Self::Wide64x32 => (64, 32),
            Self::Tall8x16 => (8, 16),
            Self::Tall8x32 => (8, 32),
            Self::Tall16x32 => (16, 32),
            Self::Tall32x64 => (32, 64),
        }
    }

    const fn attributes(self) -> (u16, u16) {
        match self {
            Self::Square8 => (0, 0),
            Self::Square16 => (0, 1 << 14),
            Self::Square32 => (0, 2 << 14),
            Self::Square64 => (0, 3 << 14),
            Self::Wide16x8 => (1 << 14, 0),
            Self::Wide32x8 => (1 << 14, 1 << 14),
            Self::Wide32x16 => (1 << 14, 2 << 14),
            Self::Wide64x32 => (1 << 14, 3 << 14),
            Self::Tall8x16 => (2 << 14, 0),
            Self::Tall8x32 => (2 << 14, 1 << 14),
            Self::Tall16x32 => (2 << 14, 2 << 14),
            Self::Tall32x64 => (2 << 14, 3 << 14),
        }
    }
}

/// The tile index is in hardware units of 32 bytes, even with 8bpp tiles.
/// Negative coordinates wrap into the GBA's nine-bit X / eight-bit Y fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sprite {
    pub x: i16,
    pub y: i16,
    pub shape: SpriteShape,
    pub tile_index: u16,
    pub priority: u8,
}

impl Sprite {
    fn attributes(self) -> Result<[u16; 3], VideoError> {
        let (width, height) = self.shape.dimensions();
        if self.tile_index & 1 != 0
            || usize::from(self.tile_index) * 32 + usize::from(width) * usize::from(height)
                > OBJ_TILE_BYTES
        {
            return Err(VideoError::ObjectTiles);
        }
        if self.priority > 3 {
            return Err(VideoError::ObjectPriority);
        }
        let (shape, size) = self.shape.attributes();
        Ok([
            self.y as u16 & 0xff | 0x2000 | shape,
            self.x as u16 & 0x1ff | size,
            self.tile_index | u16::from(self.priority) << 10,
        ])
    }
}

/// A RAM shadow of OAM. Only the changed contiguous halfword range is uploaded.
/// Updating a sprite preserves the fourth halfword used by affine matrices.
pub struct OamBuffer {
    words: [u16; OAM_SLOTS * 4],
    dirty_start: usize,
    dirty_end: usize,
}

impl Default for OamBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl OamBuffer {
    pub const fn new() -> Self {
        let mut words = [0; OAM_SLOTS * 4];
        let mut slot = 0;
        while slot < OAM_SLOTS {
            words[slot * 4] = 0x0200; // Regular OBJ disabled.
            slot += 1;
        }
        Self {
            words,
            dirty_start: 0,
            dirty_end: OAM_SLOTS * 4,
        }
    }

    fn write(&mut self, offset: usize, value: u16) {
        if self.words[offset] != value {
            self.words[offset] = value;
            self.dirty_start = self.dirty_start.min(offset);
            self.dirty_end = self.dirty_end.max(offset + 1);
        }
    }

    pub fn set(&mut self, slot: usize, sprite: Sprite) -> Result<(), VideoError> {
        if slot >= OAM_SLOTS {
            return Err(VideoError::ObjectSlot);
        }
        let attributes = sprite.attributes()?;
        for (index, value) in attributes.into_iter().enumerate() {
            self.write(slot * 4 + index, value);
        }
        Ok(())
    }

    pub fn hide(&mut self, slot: usize) -> Result<(), VideoError> {
        if slot >= OAM_SLOTS {
            return Err(VideoError::ObjectSlot);
        }
        // Clear rotation/scaling and use the smallest shape. This also avoids
        // invisible large sprites consuming the per-scanline OBJ budget.
        self.write(slot * 4, 0x0200);
        self.write(slot * 4 + 1, 0);
        self.write(slot * 4 + 2, 0);
        Ok(())
    }

    /// Cover a rectangular patch with a grid of equal hardware sprites.
    /// Art must be padded to the chosen shape and packed object by object,
    /// with each object's 8 x 8 tiles in row order. Transparent padding uses
    /// palette index zero. Returns the number of occupied OAM slots; callers
    /// hide old surplus slots when a patch shrinks.
    pub fn set_patch(
        &mut self,
        first_slot: usize,
        sprite: Sprite,
        width: u16,
        height: u16,
    ) -> Result<usize, VideoError> {
        if width == 0 || height == 0 {
            return Ok(0);
        }
        let (object_width, object_height) = sprite.shape.dimensions();
        let columns = usize::from(width.div_ceil(object_width));
        let rows = usize::from(height.div_ceil(object_height));
        let count = columns * rows;
        if first_slot >= OAM_SLOTS || count > OAM_SLOTS - first_slot {
            return Err(VideoError::ObjectSlot);
        }
        let tile_step = usize::from(object_width) * usize::from(object_height) / 32;
        if usize::from(sprite.tile_index) + tile_step * count > OBJ_TILE_BYTES / 32 {
            return Err(VideoError::ObjectTiles);
        }
        // Validate before writing, so failed grid updates leave OAM intact.
        sprite.attributes()?;
        for row in 0..rows {
            for column in 0..columns {
                let index = row * columns + column;
                self.set(
                    first_slot + index,
                    Sprite {
                        x: sprite
                            .x
                            .wrapping_add((column * usize::from(object_width)) as i16),
                        y: sprite
                            .y
                            .wrapping_add((row * usize::from(object_height)) as i16),
                        tile_index: sprite.tile_index + (index * tile_step) as u16,
                        ..sprite
                    },
                )?;
            }
        }
        Ok(count)
    }

    pub fn set_affine(
        &mut self,
        slot: usize,
        sprite: Sprite,
        matrix: usize,
        double_size: bool,
    ) -> Result<(), VideoError> {
        if matrix >= 32 {
            return Err(VideoError::AffineSlot);
        }
        self.set(slot, sprite)?;
        let offset = slot * 4;
        self.write(
            offset,
            self.words[offset] | 0x100 | if double_size { 0x200 } else { 0 },
        );
        self.write(offset + 1, self.words[offset + 1] | (matrix as u16) << 9);
        Ok(())
    }

    /// The matrix uses signed 8.8 fixed-point inverse sampling coefficients.
    pub fn set_matrix(&mut self, slot: usize, values: [i16; 4]) -> Result<(), VideoError> {
        if slot >= 32 {
            return Err(VideoError::AffineSlot);
        }
        for (index, value) in values.into_iter().enumerate() {
            self.write(slot * 16 + index * 4 + 3, value as u16);
        }
        Ok(())
    }

    pub fn pending_bytes(&self) -> usize {
        self.dirty_end.saturating_sub(self.dirty_start) * 2
    }

    pub fn words(&self) -> &[u16; OAM_SLOTS * 4] {
        &self.words
    }

    fn clear_dirty(&mut self) {
        self.dirty_start = OAM_SLOTS * 4;
        self.dirty_end = 0;
    }
}

pub struct Presenter;

impl Presenter {
    /// Upload static assets under forced blank. The caller uploads object tiles,
    /// presents its first OAM buffer, and calls `enable` at a VBlank edge.
    ///
    /// # Safety
    /// Call on GBA hardware with exclusive access to video registers and DMA3.
    pub unsafe fn initialize(
        background: &Background<'_>,
        object_palette: &[u16],
    ) -> Result<Self, VideoError> {
        background.validate()?;
        if object_palette.len() != 256 {
            return Err(VideoError::ObjectPalette);
        }
        write_volatile(0x04000000 as *mut u16, DISPLAY_CONTROL | 0x80);
        dma_copy(background.palette, 0x05000000);
        dma_copy(object_palette, 0x05000200);
        dma_copy(background.tiles, 0x06000000);
        dma_copy(background.map, 0x0600f800);
        write_volatile(0x04000008 as *mut u16, BG_CONTROL);
        write_volatile(0x04000010 as *mut u16, 0); // BG0 horizontal offset.
        write_volatile(0x04000012 as *mut u16, 0); // BG0 vertical offset.
        write_volatile(0x04000050 as *mut u16, 0); // No hardware alpha effects.
        Ok(Self)
    }

    /// # Safety
    /// Call at a VBlank edge after the first complete tile and OAM upload.
    pub unsafe fn enable(&mut self) {
        write_volatile(0x04000000 as *mut u16, DISPLAY_CONTROL);
    }

    /// Upload changed object art. Each 8bpp tile occupies 32 halfwords.
    ///
    /// # Safety
    /// DMA3 must be idle and exclusively owned by the caller. Perform uploads
    /// during VBlank or forced blank, with enough scanline time for the copy.
    pub unsafe fn upload_obj_tiles(
        &mut self,
        offset_words: usize,
        tiles: &[u16],
    ) -> Result<usize, VideoError> {
        validate_object_upload(offset_words, tiles.len())?;
        dma_copy(tiles, 0x06010000 + offset_words * 2);
        Ok(tiles.len() * 2)
    }

    /// # Safety
    /// Call during VBlank or forced blank with exclusive access to DMA3/OAM.
    pub unsafe fn present(&mut self, objects: &mut OamBuffer) -> usize {
        let bytes = objects.pending_bytes();
        if bytes != 0 {
            dma_copy(
                &objects.words[objects.dirty_start..objects.dirty_end],
                0x07000000 + objects.dirty_start * 2,
            );
            objects.clear_dirty();
        }
        bytes
    }
}

fn validate_object_upload(offset_words: usize, count: usize) -> Result<(), VideoError> {
    if offset_words % 32 != 0
        || count % 32 != 0
        || offset_words > OBJ_TILE_BYTES / 2
        || count > OBJ_TILE_BYTES / 2 - offset_words
    {
        return Err(VideoError::ObjectTiles);
    }
    Ok(())
}

unsafe fn dma_copy(source: &[u16], destination: usize) {
    if source.is_empty() {
        return;
    }
    // All callers bound copies below 65536 halfwords. DMA3 starts immediately
    // and stalls the CPU until completion. Fences keep RAM shadow writes on
    // the source side of the transfer and later reuse on its destination side.
    compiler_fence(Ordering::SeqCst);
    write_volatile(0x040000d4 as *mut usize, source.as_ptr() as usize);
    write_volatile(0x040000d8 as *mut usize, destination);
    write_volatile(0x040000dc as *mut u32, 0x80000000 | source.len() as u32);
    compiler_fence(Ordering::SeqCst);
}
