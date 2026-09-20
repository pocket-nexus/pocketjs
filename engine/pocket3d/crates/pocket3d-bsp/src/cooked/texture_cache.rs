//! Bounded relocation of cooked texture bytes into caller-owned storage.
use super::CookedMap;
use alloc::vec::Vec;

/// Prioritize used textures by indexed geometry. Each palette and mip starts
/// at a 16-byte boundary. Only complete mip chains move; others keep borrowing
/// the original map. The returned byte count includes alignment padding.
pub fn relocate<'a>(map: &mut CookedMap<'a>, mut memory: &'a mut [u8]) -> (usize, &'a mut [u8]) {
    let capacity = memory.len();
    let align = |n: usize| (n + 15) & !15;
    let padding = memory.as_ptr().align_offset(16);
    if padding > memory.len() {
        return (0, memory);
    }
    memory = &mut memory[padding..];
    let mut order: Vec<_> = (0..map.textures.len())
        .map(|i| {
            let uses: u64 = map
                .batches
                .iter()
                .filter(|b| b.texture as usize == i)
                .map(|b| b.index_count as u64)
                .sum();
            (core::cmp::Reverse(uses), i)
        })
        .collect();
    order.sort_unstable();
    for (core::cmp::Reverse(uses), i) in order {
        if uses == 0 {
            continue;
        }
        let texture = &mut map.textures[i];
        let needed = align(texture.palette.len())
            + texture.mips.iter().map(|m| align(m.len())).sum::<usize>();
        if needed > memory.len() {
            continue;
        }
        let len = texture.palette.len();
        let (dest, rest) = memory.split_at_mut(align(len));
        dest[..len].copy_from_slice(texture.palette);
        texture.palette = &dest[..len];
        memory = rest;
        for mip in &mut texture.mips {
            let len = mip.len();
            let (dest, rest) = memory.split_at_mut(align(len));
            dest[..len].copy_from_slice(mip);
            *mip = &dest[..len];
            memory = rest;
        }
    }
    (capacity - memory.len(), memory)
}
