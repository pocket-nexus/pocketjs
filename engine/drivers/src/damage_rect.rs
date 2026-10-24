//! Logical-pixel clipping geometry shared by rasterization and presentation.

/// Integer logical-pixel rectangle with half-open bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamageRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl DamageRect {
    pub const fn new(x0: i32, y0: i32, x1: i32, y1: i32) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub const fn empty() -> Self {
        Self {
            x0: i32::MAX,
            y0: i32::MAX,
            x1: i32::MIN,
            y1: i32::MIN,
        }
    }

    pub fn intersect(self, other: Self) -> Self {
        Self {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        }
    }

    pub fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    /// `self` minus `hole`, as up to four disjoint rectangles.
    pub fn subtract(self, hole: Self) -> [Self; 4] {
        let hole = hole.intersect(self);
        if hole.is_empty() {
            return [self, Self::empty(), Self::empty(), Self::empty()];
        }
        [
            Self::new(self.x0, self.y0, self.x1, hole.y0),
            Self::new(self.x0, hole.y1, self.x1, self.y1),
            Self::new(self.x0, hole.y0, hole.x0, hole.y1),
            Self::new(hole.x1, hole.y0, self.x1, hole.y1),
        ]
    }

    pub const fn offset(self, dx: i32, dy: i32) -> Self {
        Self::new(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)
    }

    pub fn is_empty(self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    pub fn area(self) -> u64 {
        if self.is_empty() {
            0
        } else {
            (self.x1 - self.x0) as u64 * (self.y1 - self.y0) as u64
        }
    }

    pub fn touches(self, other: Self) -> bool {
        !self.is_empty()
            && !other.is_empty()
            && self.x0 <= other.x1
            && other.x0 <= self.x1
            && self.y0 <= other.y1
            && other.y0 <= self.y1
    }
}

impl Default for DamageRect {
    fn default() -> Self {
        Self::empty()
    }
}
