use alloc::{
    string::{String, ToString},
    vec::Vec,
};

pub trait Length {
    fn scalar_len(&self) -> usize;
}
impl Length for str {
    fn scalar_len(&self) -> usize {
        self.chars().count()
    }
}
impl Length for String {
    fn scalar_len(&self) -> usize {
        self.chars().count()
    }
}
impl<T> Length for [T] {
    fn scalar_len(&self) -> usize {
        self.len()
    }
}
impl<T, const N: usize> Length for [T; N] {
    fn scalar_len(&self) -> usize {
        N
    }
}
impl<T> Length for Vec<T> {
    fn scalar_len(&self) -> usize {
        self.len()
    }
}
impl<T: Length + ?Sized> Length for &T {
    fn scalar_len(&self) -> usize {
        (**self).scalar_len()
    }
}
pub fn len<T: Length + ?Sized>(value: &T) -> i32 {
    value.scalar_len() as i32
}

/// JavaScript orders strings by UTF-16 code units, including astral characters.
pub fn string_compare(left: &str, right: &str) -> i32 {
    match left.encode_utf16().cmp(right.encode_utf16()) {
        core::cmp::Ordering::Less => -1,
        core::cmp::Ordering::Equal => 0,
        core::cmp::Ordering::Greater => 1,
    }
}

pub trait Float: Copy {
    fn as_f64(self) -> f64;
}
impl Float for f32 {
    fn as_f64(self) -> f64 {
        self as f64
    }
}
impl Float for f64 {
    fn as_f64(self) -> f64 {
        self
    }
}
pub fn trunc<T: Float>(value: T) -> i32 {
    libm::trunc(value.as_f64()) as i32
}
pub fn floor<T: Float>(value: T) -> i32 {
    libm::floor(value.as_f64()) as i32
}
pub fn ceil<T: Float>(value: T) -> i32 {
    libm::ceil(value.as_f64()) as i32
}
pub fn round<T: Float>(value: T) -> i32 {
    let value = value.as_f64();
    let lower = libm::floor(value);
    // Adding 0.5 first can round a value immediately below a half up to the
    // half. Compare the fraction before addition, as JavaScript Math.round does.
    (if value - lower >= 0.5 {
        lower + 1.0
    } else {
        lower
    }) as i32
}

pub trait Integer: Copy {
    fn divide(self, other: Self) -> Self;
    fn remainder(self, other: Self) -> Self;
}
macro_rules! integer {
    ($($type:ty),*) => { $(impl Integer for $type {
        fn divide(self, other: Self) -> Self { if other == 0 { 0 } else { self.wrapping_div(other) } }
        fn remainder(self, other: Self) -> Self { if other == 0 { 0 } else { self.wrapping_rem(other) } }
    })* };
}
integer!(i8, i16, i32, i64, u8, u16, u32, u64, usize);
pub fn idiv<T: Integer>(value: T, other: T) -> T {
    value.divide(other)
}
pub fn imod<T: Integer>(value: T, other: T) -> T {
    value.remainder(other)
}

pub trait Numeric: Copy {
    fn minimum(self, other: Self) -> Self;
    fn maximum(self, other: Self) -> Self;
    fn absolute(self) -> Self;
}
macro_rules! numeric_integer {
    ($($type:ty => $absolute:expr),*) => { $(impl Numeric for $type {
        fn minimum(self, other: Self) -> Self { core::cmp::min(self, other) }
        fn maximum(self, other: Self) -> Self { core::cmp::max(self, other) }
        fn absolute(self) -> Self { ($absolute)(self) }
    })* };
}
numeric_integer!(i8 => i8::wrapping_abs, i16 => i16::wrapping_abs, i32 => i32::wrapping_abs, i64 => i64::wrapping_abs,
    u8 => |x| x, u16 => |x| x, u32 => |x| x, u64 => |x| x, usize => |x| x);
macro_rules! numeric_float {
    ($($type:ty),*) => { $(impl Numeric for $type {
        fn minimum(self, other: Self) -> Self {
            if self.is_nan() || other.is_nan() { Self::NAN }
            else if self == 0.0 && other == 0.0 { if self.is_sign_negative() || other.is_sign_negative() { -0.0 } else { 0.0 } }
            else if self < other { self } else { other }
        }
        fn maximum(self, other: Self) -> Self {
            if self.is_nan() || other.is_nan() { Self::NAN }
            else if self == 0.0 && other == 0.0 { if self.is_sign_positive() || other.is_sign_positive() { 0.0 } else { -0.0 } }
            else if self > other { self } else { other }
        }
        fn absolute(self) -> Self { self.abs() }
    })* };
}
numeric_float!(f32, f64);
pub fn min<T: Numeric>(value: T, other: T) -> T {
    value.minimum(other)
}
pub fn max<T: Numeric>(value: T, other: T) -> T {
    value.maximum(other)
}
pub fn abs<T: Numeric>(value: T) -> T {
    value.absolute()
}
pub fn clamp<T: Numeric>(value: T, lower: T, upper: T) -> T {
    value.maximum(lower).minimum(upper)
}

/// ECMAScript `Number.prototype.toFixed`, including exact binary half ties.
pub fn fixed<T: Float>(value: T, digits: i32) -> String {
    assert!(
        (0..=100).contains(&digits),
        "fixed digits must be between 0 and 100"
    );
    ryu_js::Buffer::new()
        .format_to_fixed(value.as_f64(), digits as u8)
        .to_string()
}

// Float math, in-place array operations and code points.
// Array operations clamp their ranges; an out-of-range element is left alone,
// matching element writes.

pub trait Math: Copy {
    fn sqrt(self) -> Self;
    fn sin(self) -> Self;
    fn cos(self) -> Self;
    fn tan(self) -> Self;
    fn asin(self) -> Self;
    fn acos(self) -> Self;
    fn atan(self) -> Self;
    fn exp(self) -> Self;
    fn log(self) -> Self;
    fn atan2(self, other: Self) -> Self;
    fn pow(self, other: Self) -> Self;
    fn hypot(self, other: Self) -> Self;
}
macro_rules! math {
    ($type:ty, $sqrt:ident, $sin:ident, $cos:ident, $tan:ident, $asin:ident, $acos:ident, $atan:ident, $exp:ident, $log:ident, $atan2:ident, $pow:ident, $hypot:ident) => {
        impl Math for $type {
            fn sqrt(self) -> Self { libm::$sqrt(self) }
            fn sin(self) -> Self { libm::$sin(self) }
            fn cos(self) -> Self { libm::$cos(self) }
            fn tan(self) -> Self { libm::$tan(self) }
            fn asin(self) -> Self { libm::$asin(self) }
            fn acos(self) -> Self { libm::$acos(self) }
            fn atan(self) -> Self { libm::$atan(self) }
            fn exp(self) -> Self { libm::$exp(self) }
            fn log(self) -> Self { libm::$log(self) }
            fn atan2(self, other: Self) -> Self { libm::$atan2(self, other) }
            fn pow(self, other: Self) -> Self { libm::$pow(self, other) }
            fn hypot(self, other: Self) -> Self { libm::$hypot(self, other) }
        }
    };
}
math!(f32, sqrtf, sinf, cosf, tanf, asinf, acosf, atanf, expf, logf, atan2f, powf, hypotf);
math!(f64, sqrt, sin, cos, tan, asin, acos, atan, exp, log, atan2, pow, hypot);
pub fn sqrt<T: Math>(value: T) -> T { value.sqrt() }
pub fn sin<T: Math>(value: T) -> T { value.sin() }
pub fn cos<T: Math>(value: T) -> T { value.cos() }
pub fn tan<T: Math>(value: T) -> T { value.tan() }
pub fn asin<T: Math>(value: T) -> T { value.asin() }
pub fn acos<T: Math>(value: T) -> T { value.acos() }
pub fn atan<T: Math>(value: T) -> T { value.atan() }
pub fn exp<T: Math>(value: T) -> T { value.exp() }
pub fn log<T: Math>(value: T) -> T { value.log() }
pub fn atan2<T: Math>(value: T, other: T) -> T { value.atan2(other) }
pub fn pow<T: Math>(value: T, other: T) -> T { value.pow(other) }
pub fn hypot<T: Math>(value: T, other: T) -> T { value.hypot(other) }

pub fn fill<T: Clone>(count: i32, value: T) -> Vec<T> {
    alloc::vec![value; count.max(0) as usize]
}
pub fn insert<T>(target: &mut Vec<T>, index: i32, value: T) {
    let index = (index.max(0) as usize).min(target.len());
    target.insert(index, value);
}
pub fn remove_at<T>(target: &mut Vec<T>, index: i32, missing: impl FnOnce() -> T) -> T {
    if index >= 0 && (index as usize) < target.len() {
        target.remove(index as usize)
    } else {
        missing()
    }
}
pub fn truncate<T>(target: &mut Vec<T>, length: i32) {
    target.truncate(length.max(0) as usize);
}
pub fn fill_range<T: Clone>(target: &mut [T], start: i32, end: i32, value: T) {
    let start = (start.max(0) as usize).min(target.len());
    let end = (end.max(0) as usize).min(target.len());
    if start < end {
        target[start..end].fill(value);
    }
}
/// Clips a copy of `count` elements to both slices; returns (to, from, count).
fn copy_window(target: usize, target_start: i32, source: usize, source_start: i32, count: i32) -> Option<(usize, usize, usize)> {
    let (mut to, mut from, mut count) = (target_start as i64, source_start as i64, count as i64);
    if from < 0 {
        count += from;
        to -= from;
        from = 0;
    }
    if to < 0 {
        count += to;
        from -= to;
        to = 0;
    }
    let count = count.min(source as i64 - from).min(target as i64 - to);
    (count > 0).then(|| (to as usize, from as usize, count as usize))
}
/// A row offset of copy_rect or fill_rect; one outside i32 clips to an empty window either way.
fn row_start(start: i32, row: i32, stride: i32) -> i32 {
    (start as i64 + row as i64 * stride as i64).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}
/// copyRect: row r is copyRange from source_start + r * source_stride to
/// target_start + r * target_stride, leaving target elements where the source holds `skip`.
pub fn copy_rect<T: Copy + PartialEq>(target: &mut [T], target_start: i32, target_stride: i32, source: &[T], source_start: i32, source_stride: i32, width: i32, height: i32, skip: Option<T>) {
    for row in 0..height.max(0) {
        let (to, from) = (row_start(target_start, row, target_stride), row_start(source_start, row, source_stride));
        if let Some((to, from, count)) = copy_window(target.len(), to, source.len(), from, width) {
            let (window, values) = (&mut target[to..to + count], &source[from..from + count]);
            match skip {
                None => window.copy_from_slice(values),
                Some(skip) => window.iter_mut().zip(values).filter(|(_, value)| **value != skip).for_each(|(slot, value)| *slot = *value),
            }
        }
    }
}
/// fillRect: row r is fill_range from start + r * stride over `width` elements.
pub fn fill_rect<T: Clone>(target: &mut [T], start: i32, stride: i32, width: i32, height: i32, value: T) {
    for row in 0..height.max(0) {
        let first = row_start(start, row, stride);
        let end = if width <= 0 { first } else { (first as i64 + width as i64).min(i32::MAX as i64) as i32 };
        fill_range(target, first, end, value.clone());
    }
}
pub fn copy_within<T: Copy>(target: &mut [T], source_start: i32, target_start: i32, count: i32) {
    if let Some((to, from, count)) = copy_window(target.len(), target_start, target.len(), source_start, count) {
        target.copy_within(from..from + count, to);
    }
}
pub fn code_points(value: &str) -> Vec<i32> {
    value.chars().map(|character| character as i32).collect()
}
pub fn from_code_point(code: i32) -> String {
    char::from_u32(code as u32).unwrap_or('\u{fffd}').to_string()
}
