//! JS `Number.prototype.toString()` for the values a Micro TS program
//! displays, plus the small numeric helpers generated code calls. `core`
//! only: the PSP target has no std float math, so integral tests and
//! floor/ceil/round/trunc go through `i64` conversion (exact for |v| < 2^53,
//! which covers every value a UI counter reaches).

use alloc::string::String;
use core::fmt::Write;

const INTEGRAL_ABOVE: f64 = 9_007_199_254_740_992.0; // 2^53: every f64 beyond is integral

/// Whether `v` has no fractional part (finite `v`).
pub fn is_integral(v: f64) -> bool {
    v.abs() >= INTEGRAL_ABOVE || (v as i64) as f64 == v
}

/// Append the JS string form of `v`: integers as decimal digits; other finite
/// values as the shortest round-trip decimal, in exponent form below 1e-6
/// and from 1e21 like ECMAScript Number::toString.
pub fn push_num(out: &mut String, v: f64) {
    if v.is_nan() {
        out.push_str("NaN");
        return;
    }
    if v.is_infinite() {
        out.push_str(if v > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    if v == 0.0 {
        out.push('0'); // -0 prints as "0"
        return;
    }
    let abs = v.abs();
    if abs < 1e21 && is_integral(v) {
        let _ = write!(out, "{}", v as i64);
        return;
    }
    if abs >= 1e-6 && abs < 1e21 {
        let _ = write!(out, "{}", v);
        return;
    }
    // Exponent form: Rust prints `1.5e21` / `1e-7`; JS prints `1.5e+21` / `1e-7`.
    let mut buf = String::new();
    let _ = write!(buf, "{:e}", v);
    if let Some(at) = buf.find('e') {
        let (mantissa, exp) = buf.split_at(at);
        out.push_str(mantissa);
        out.push('e');
        let exp = &exp[1..];
        if !exp.starts_with('-') {
            out.push('+');
        }
        out.push_str(exp);
    } else {
        out.push_str(&buf);
    }
}

/// Append a 32-bit integer.
pub fn push_int(out: &mut String, v: i32) {
    let _ = write!(out, "{}", v);
}

/// Append `s` as a JSON string literal.
pub fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// JS truthiness of a number.
pub fn truthy_num(v: f64) -> bool {
    v != 0.0 && !v.is_nan()
}

/// A millisecond count for the core's animation API: negative and NaN clamp to 0.
pub fn ms(v: f64) -> u32 {
    if v.is_nan() || v <= 0.0 {
        0
    } else if v >= u32::MAX as f64 {
        u32::MAX
    } else {
        v as u32
    }
}

/// JS `%` on integers: the sign follows the dividend; a zero divisor yields 0
/// (JS yields NaN; a Micro `int` has no NaN).
pub fn imod(a: i32, b: i32) -> i32 {
    if b == 0 {
        0
    } else {
        a.wrapping_rem(b)
    }
}

/// JS `%` on numbers.
pub fn fmod(a: f64, b: f64) -> f64 {
    if b == 0.0 || a.is_nan() || b.is_nan() || a.is_infinite() {
        return f64::NAN;
    }
    if b.is_infinite() {
        return a;
    }
    a - b * trunc(a / b)
}

pub fn trunc(v: f64) -> f64 {
    if !v.is_finite() || v.abs() >= INTEGRAL_ABOVE {
        return v;
    }
    let t = (v as i64) as f64;
    if t == 0.0 && v < 0.0 {
        -0.0
    } else {
        t
    }
}

pub fn floor(v: f64) -> f64 {
    let t = trunc(v);
    if t > v {
        t - 1.0
    } else {
        t
    }
}

pub fn ceil(v: f64) -> f64 {
    let t = trunc(v);
    if t < v {
        t + 1.0
    } else {
        t
    }
}

/// JS `Math.round`: halves round toward +infinity.
pub fn round(v: f64) -> f64 {
    floor(v + 0.5)
}

pub fn fabs(v: f64) -> f64 {
    if v < 0.0 {
        -v
    } else {
        v
    }
}

/// JS `Math.min`: NaN wins.
pub fn fmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// JS `Math.max`: NaN wins.
pub fn fmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: f64) -> String {
        let mut out = String::new();
        push_num(&mut out, v);
        out
    }

    #[test]
    fn integers_and_fractions() {
        assert_eq!(s(0.0), "0");
        assert_eq!(s(-0.0), "0");
        assert_eq!(s(42.0), "42");
        assert_eq!(s(-7.0), "-7");
        assert_eq!(s(0.5), "0.5");
        assert_eq!(s(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(s(1.5e21), "1.5e+21");
        assert_eq!(s(1e-7), "1e-7");
        assert_eq!(s(f64::NAN), "NaN");
        assert_eq!(s(f64::INFINITY), "Infinity");
    }

    #[test]
    fn math_helpers() {
        assert_eq!(floor(-1.5), -2.0);
        assert_eq!(ceil(-1.5), -1.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(trunc(-1.7), -1.0);
        assert_eq!(imod(-7, 3), -1);
        assert_eq!(imod(7, 0), 0);
        assert_eq!(fmod(5.5, 2.0), 1.5);
        assert_eq!(fmod(-5.5, 2.0), -1.5);
        assert_eq!(ms(-3.0), 0);
        assert_eq!(ms(150.9), 150);
        let mut j = String::new();
        push_json_str(&mut j, "a\"b\n");
        assert_eq!(j, "\"a\\\"b\\n\"");
    }
}
