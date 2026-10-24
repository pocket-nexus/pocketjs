//! Move retained pixels through an exclusive CPU surface before repainting.

use crate::damage::{DamageError, DamageMotion};
use pocket_drivers::Surface;

/// Copy a plan's retained pixels inside one acquired surface. Both source
/// and destination must fit that region; padding and other bytes stay intact.
/// Reject unsupported formats, overflow and out-of-region moves before writes.
pub fn move_pixels(
    surface: &mut Surface<'_>,
    scale: u32,
    motion: DamageMotion,
) -> Result<(), DamageError> {
    let bits = surface.format().bits_per_pixel();
    if scale == 0 || bits % 8 != 0 || motion.destination.is_empty() {
        return Err(DamageError::InvalidTarget);
    }
    let region = surface.region();
    let s = i64::from(scale);
    let bounds = motion.destination;
    let destination = [
        i64::from(bounds.x0),
        i64::from(bounds.y0),
        i64::from(bounds.x1),
        i64::from(bounds.y1),
    ];
    let source = [
        destination[0] - i64::from(motion.dx),
        destination[1] - i64::from(motion.dy),
        destination[2] - i64::from(motion.dx),
        destination[3] - i64::from(motion.dy),
    ];
    let mut rectangles = [[0i64; 4]; 2];
    for (out, rect) in rectangles.iter_mut().zip([destination, source]) {
        for (value, coordinate) in out.iter_mut().zip(rect) {
            *value = coordinate
                .checked_mul(s)
                .ok_or(DamageError::InvalidTarget)?;
        }
        if out[0] < i64::from(region.x)
            || out[1] < i64::from(region.y)
            || out[2] > i64::from(region.x) + i64::from(region.width)
            || out[3] > i64::from(region.y) + i64::from(region.height)
        {
            return Err(DamageError::InvalidTarget);
        }
    }
    let [to, from] = rectangles;
    let bpp = bits / 8;
    let stride = surface.stride_bytes();
    let length = (to[2] - to[0]) as usize * bpp;
    let rows = (to[3] - to[1]) as usize;
    let target_start = (to[1] - i64::from(region.y)) as usize * stride
        + (to[0] - i64::from(region.x)) as usize * bpp;
    let source_start = (from[1] - i64::from(region.y)) as usize * stride
        + (from[0] - i64::from(region.x)) as usize * bpp;
    let pixels = surface.pixels_mut();
    for step in 0..rows {
        let row = if motion.dy > 0 { rows - 1 - step } else { step };
        let source = source_start + row * stride;
        pixels.copy_within(source..source + length, target_start + row * stride);
    }
    Ok(())
}
