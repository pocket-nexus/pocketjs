//! GE's 16-byte by 8-row tiled texture layout, shared by cooks and loaders.
use alloc::vec::Vec;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Empty,
    Overflow,
    Length,
}
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub row_bytes: usize,
    pub rows: usize,
    pub stride: usize,
    pub padded_rows: usize,
    pub bytes: usize,
}
impl Layout {
    pub fn new(row_bytes: usize, rows: usize) -> Result<Self, Error> {
        if row_bytes == 0 || rows == 0 {
            return Err(Error::Empty);
        }
        let stride = row_bytes.checked_add(15).ok_or(Error::Overflow)? & !15;
        let padded_rows = rows.checked_add(7).ok_or(Error::Overflow)? & !7;
        let bytes = stride
            .checked_mul(padded_rows)
            .filter(|&v| v <= isize::MAX as usize)
            .ok_or(Error::Overflow)?;
        Ok(Self {
            row_bytes,
            rows,
            stride,
            padded_rows,
            bytes,
        })
    }
    pub fn offset(&self, x: usize, y: usize) -> Option<usize> {
        if x >= self.row_bytes || y >= self.rows {
            return None;
        }
        Some(((y / 8) * (self.stride / 16) + x / 16) * 128 + (y % 8) * 16 + x % 16)
    }
}
pub fn swizzle_rows(source: &[u8], row_bytes: usize, rows: usize) -> Result<Vec<u8>, Error> {
    let layout = Layout::new(row_bytes, rows)?;
    if row_bytes.checked_mul(rows) != Some(source.len()) {
        return Err(Error::Length);
    }
    let mut output = alloc::vec![0;layout.bytes];
    for y in 0..rows {
        for x in (0..row_bytes).step_by(16) {
            let count = (row_bytes - x).min(16);
            let dst = layout.offset(x, y).unwrap();
            let src = y * row_bytes + x;
            output[dst..dst + count].copy_from_slice(&source[src..src + count]);
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn narrow_mips_and_rectangles_keep_pixels_and_zero_padding() {
        for (w, h) in [(8, 4), (16, 8), (32, 16), (7, 19), (1024, 256)] {
            let source: Vec<u8> = (0..w * h).map(|i| (i % 251) as u8).collect();
            let out = swizzle_rows(&source, w, h).unwrap();
            let layout = Layout::new(w, h).unwrap();
            let mut visited = alloc::vec![false;out.len()];
            for y in 0..h {
                for x in 0..w {
                    let at = layout.offset(x, y).unwrap();
                    assert!(!visited[at]);
                    visited[at] = true;
                    assert_eq!(out[at], source[y * w + x]);
                }
            }
            assert!(out.iter().zip(visited).all(|(&b, used)| used || b == 0));
        }
    }
    #[test]
    fn malformed_layouts_fail() {
        assert_eq!(swizzle_rows(&[1], 1, 2), Err(Error::Length));
        assert!(Layout::new(usize::MAX, 8).is_err());
        assert!(Layout::new(8, 0).is_err());
    }
}
