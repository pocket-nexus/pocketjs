//! Which regions a framebuffer gui-server lends needs.
//!
//! gui-server rotates a small set of buffers and the app cannot tell which
//! one it holds: a mapping address can come back for a different buffer. A
//! lent buffer is therefore up to `depth` frames stale, and each presentation
//! repaints the damage of the last `depth` frames. A buffer gui-server marks
//! as new, and the first `depth` presentations after [`Presenter::reset`],
//! repaint the whole surface.

use std::collections::VecDeque;

use pocketjs_core::damage::DamageRect;

pub struct Presenter {
    depth: usize,
    history: VecDeque<Vec<DamageRect>>,
    whole: usize,
}

impl Presenter {
    pub fn new(depth: usize) -> Presenter {
        let depth = depth.max(1);
        Presenter { depth, history: VecDeque::new(), whole: depth }
    }

    /// Repaint the whole surface for the next `depth` presentations (the app
    /// just became visible).
    pub fn reset(&mut self) {
        self.whole = self.depth;
    }

    /// Note the regions the latest step changed.
    pub fn record(&mut self, regions: &[DamageRect]) {
        if self.history.len() == self.depth {
            self.history.pop_front();
        }
        self.history.push_back(regions.to_vec());
    }

    /// The regions to repaint into the buffer at hand, inside `bounds`: the
    /// whole surface for a fresh buffer, otherwise the recorded damage as
    /// disjoint rectangles.
    pub fn regions(&mut self, bounds: DamageRect, fresh_buffer: bool) -> Vec<DamageRect> {
        if fresh_buffer || self.whole > 0 {
            self.whole = self.whole.saturating_sub(1);
            return vec![bounds];
        }
        let rects: Vec<DamageRect> = self
            .history
            .iter()
            .flatten()
            .map(|r| r.intersect(bounds))
            .filter(|r| !r.is_empty())
            .collect();
        disjoint(&rects)
    }
}

/// Cover the union of `rects` with disjoint rectangles: one per run of rows
/// that the same set of column spans covers.
pub fn disjoint(rects: &[DamageRect]) -> Vec<DamageRect> {
    let mut edges: Vec<i32> = rects.iter().flat_map(|r| [r.y0, r.y1]).collect();
    edges.sort_unstable();
    edges.dedup();
    let mut out: Vec<DamageRect> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    let mut spans: Vec<(i32, i32)> = Vec::new();
    for slab in edges.windows(2) {
        let (y0, y1) = (slab[0], slab[1]);
        spans.clear();
        spans.extend(rects.iter().filter(|r| r.y0 <= y0 && r.y1 >= y1).map(|r| (r.x0, r.x1)));
        spans.sort_unstable();
        let mut merged: Vec<(i32, i32)> = Vec::with_capacity(spans.len());
        for &(x0, x1) in &spans {
            match merged.last_mut() {
                Some(last) if x0 <= last.1 => last.1 = last.1.max(x1),
                _ => merged.push((x0, x1)),
            }
        }
        let mut next_open = Vec::with_capacity(merged.len());
        for (x0, x1) in merged {
            // Extend a rectangle that ended on the previous slab with the same columns.
            let continued = open
                .iter()
                .copied()
                .find(|&i| out[i].y1 == y0 && out[i].x0 == x0 && out[i].x1 == x1);
            match continued {
                Some(i) => {
                    out[i].y1 = y1;
                    next_open.push(i);
                }
                None => {
                    out.push(DamageRect::new(x0, y0, x1, y1));
                    next_open.push(out.len() - 1);
                }
            }
        }
        open = next_open;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(rects: &[DamageRect]) -> u64 {
        rects.iter().map(|r| r.area()).sum()
    }

    #[test]
    fn overlapping_history_is_repainted_once() {
        let mut presenter = Presenter::new(3);
        let bounds = DamageRect::new(0, 0, 100, 100);
        presenter.regions(bounds, false);
        presenter.regions(bounds, false);
        presenter.regions(bounds, false);
        for _ in 0..3 {
            presenter.record(&[bounds]);
        }
        assert_eq!(presenter.regions(bounds, false), vec![bounds]);
    }

    #[test]
    fn a_fresh_buffer_gets_the_whole_surface() {
        let mut presenter = Presenter::new(2);
        let bounds = DamageRect::new(0, 0, 10, 10);
        presenter.whole = 0;
        presenter.record(&[DamageRect::new(1, 1, 2, 2)]);
        assert_eq!(presenter.regions(bounds, true), vec![bounds]);
        assert_eq!(presenter.regions(bounds, false), vec![DamageRect::new(1, 1, 2, 2)]);
    }

    #[test]
    fn disjoint_cover_keeps_the_union_and_drops_overlap() {
        let rects = [
            DamageRect::new(0, 0, 10, 10),
            DamageRect::new(5, 5, 15, 15),
            DamageRect::new(0, 20, 4, 22),
        ];
        let cover = disjoint(&rects);
        assert_eq!(area(&cover), 100 + 100 - 25 + 8);
        for (i, a) in cover.iter().enumerate() {
            for b in &cover[i + 1..] {
                assert!(a.intersect(*b).is_empty(), "{a:?} overlaps {b:?}");
            }
        }
        for y in 0..25 {
            for x in 0..20 {
                let inside = |r: &DamageRect| x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
                assert_eq!(rects.iter().any(inside), cover.iter().any(inside), "({x}, {y})");
            }
        }
    }
}
