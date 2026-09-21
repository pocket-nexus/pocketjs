use crate::{NodeId, Ui};
use alloc::string::String;
use core::fmt;

/// Canonical Color spelling is lowercase RGBA, independent of source shorthand.
pub fn format_color(bits: u32, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
        formatter,
        "#{:02x}{:02x}{:02x}{:02x}",
        bits & 255,
        (bits >> 8) & 255,
        (bits >> 16) & 255,
        bits >> 24
    )
}

/// Only scalar contract types implement text interpolation.
pub trait MicroTsDisplay {
    fn fmt_microts(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result;
}

pub struct DisplayValue<'a, T: ?Sized>(&'a T);
pub fn display<T: MicroTsDisplay + ?Sized>(value: &T) -> DisplayValue<'_, T> {
    DisplayValue(value)
}

/// JavaScript template literals stringify an absent value as `undefined`.
/// Vue's direct text interpolation keeps using `display`, which emits no text.
pub struct TemplateOptionDisplay<'a, T>(&'a Option<T>);
pub fn template_option_display<T: MicroTsDisplay>(value: &Option<T>) -> TemplateOptionDisplay<'_, T> {
    TemplateOptionDisplay(value)
}
impl<T: MicroTsDisplay> fmt::Display for TemplateOptionDisplay<'_, T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(value) => value.fmt_microts(formatter),
            None => formatter.write_str("undefined"),
        }
    }
}

/// Compare formatting output against a memo without allocating a string.
/// Generated string keys use this on the unchanged-sequence path.
pub fn formatted_eq(expected: &str, arguments: fmt::Arguments<'_>) -> bool {
    struct Comparison<'a> {
        expected: &'a [u8],
        offset: usize,
    }
    impl fmt::Write for Comparison<'_> {
        fn write_str(&mut self, text: &str) -> fmt::Result {
            if !self.expected[self.offset..].starts_with(text.as_bytes()) {
                return Err(fmt::Error);
            }
            self.offset += text.len();
            Ok(())
        }
    }
    let mut comparison = Comparison {
        expected: expected.as_bytes(),
        offset: 0,
    };
    fmt::write(&mut comparison, arguments).is_ok() && comparison.offset == expected.len()
}
impl<T: MicroTsDisplay + ?Sized> fmt::Display for DisplayValue<'_, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt_microts(f)
    }
}
impl<T: MicroTsDisplay + ?Sized> MicroTsDisplay for &T {
    fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        (*self).fmt_microts(f)
    }
}
impl MicroTsDisplay for str {
    fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self)
    }
}
impl MicroTsDisplay for String {
    fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self)
    }
}
impl MicroTsDisplay for bool {
    fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if *self { "true" } else { "false" })
    }
}
impl<T: MicroTsDisplay> MicroTsDisplay for Option<T> {
    fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Some(value) => value.fmt_microts(f),
            None => Ok(()),
        }
    }
}
macro_rules! integer_display {
    ($($type:ty),*) => { $(impl MicroTsDisplay for $type {
        fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(self, f) }
    })* };
}
integer_display!(i8, i16, i32, i64, u8, u16, u32, u64, usize);
macro_rules! float_display {
    ($($type:ty),*) => { $(impl MicroTsDisplay for $type {
        fn fmt_microts(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(ryu_js::Buffer::new().format(*self))
        }
    })* };
}
float_display!(f32, f64);

/// Generated code compares interpolation inputs before calling `write`.
/// The output and scratch buffers retain capacity across changed frames.
#[derive(Default)]
pub struct TextMemo {
    text: String,
    scratch: String,
    initialized: bool,
}

impl TextMemo {
    pub fn write(&mut self, ui: &mut Ui, node: NodeId, format: impl FnOnce(&mut String)) {
        self.scratch.clear();
        format(&mut self.scratch);
        if !self.initialized || self.text != self.scratch {
            ui.set_text(node, &self.scratch);
            core::mem::swap(&mut self.text, &mut self.scratch);
            self.initialized = true;
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
}
