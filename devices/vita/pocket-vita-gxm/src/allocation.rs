//! Checked layout arithmetic, also exercised by host tests.

pub(crate) fn rounded(size: usize, align: usize) -> Option<usize> {
    if !align.is_power_of_two() {
        return None;
    }
    size.checked_add(align - 1).map(|n| n & !(align - 1))
}

pub(crate) fn reserve(
    used: &mut usize,
    capacity: usize,
    len: usize,
    align: usize,
) -> Option<usize> {
    let start = rounded(*used, align.max(1))?;
    let end = start.checked_add(len)?;
    if end > capacity {
        return None;
    }
    *used = end;
    Some(start)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aligned_allocations_do_not_overlap_or_advance_on_failure() {
        let mut used = 0;
        assert_eq!(reserve(&mut used, 4096, 3, 16), Some(0));
        assert_eq!(reserve(&mut used, 4096, 4, 16), Some(16));
        assert_eq!(reserve(&mut used, 4096, 4096, 16), None);
        assert_eq!(used, 20);
        assert_eq!(reserve(&mut used, 4096, usize::MAX, 16), None);
        assert_eq!(used, 20);
    }
    #[test]
    fn invalid_alignment_and_rounding_overflow_fail() {
        assert_eq!(rounded(4097, 4096), Some(8192));
        assert_eq!(rounded(usize::MAX, 4096), None);
        assert_eq!(rounded(16, 3), None);
        assert_eq!(rounded(16, 0), None);
    }
}
