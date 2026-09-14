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
