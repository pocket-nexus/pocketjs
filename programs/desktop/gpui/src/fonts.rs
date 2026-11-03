//! The font slot table and the native text measurer.
//!
//! Measurement and painting MUST agree glyph-for-glyph, so both sides build
//! their [`gpui::Font`] through one [`TextConfig`]. Ligatures, contextual
//! alternates and kerning are disabled: app editor math measures prefixes
//! through the `measureText` op (apps/note/layout.ts, apps/im/wrap.ts), and
//! prefix sums only equal shaped positions when advances are additive.
//! Complex scripts still shape correctly — only the discretionary
//! substitutions are off.

use std::sync::Arc;

use gpui::{
    Font, FontFeatures, FontStyle, FontWeight, LineFragment, SharedString, TextRun,
    WindowTextSystem, px,
};
use pocketjs_core::text::{MeasureFn, WrapFn};

/// Slot -> px mirror of the compiler's slot registry
/// (framework/compiler/tailwind.ts FONT_PX: slots 0..6 regular, 7..13 bold,
/// 14/15 the 54 px display pair, 16..18 monospace 12/14/16) — the same
/// hand-mirror note-widget's cjk.rs keeps.
const FONT_PX: [f32; 7] = [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0];
const LARGE_PX: f32 = 54.0;
const MONO_PX: [f32; 3] = [12.0, 14.0, 16.0];

/// (font px, bold, mono) for a font slot; unknown slots read as slot 1.
pub fn slot_px(slot: u8) -> (f32, bool, bool) {
    match slot {
        0..=6 => (FONT_PX[slot as usize], false, false),
        7..=13 => (FONT_PX[(slot - 7) as usize], true, false),
        14 => (LARGE_PX, false, false),
        15 => (LARGE_PX, true, false),
        16..=18 => (MONO_PX[(slot - 16) as usize], false, true),
        _ => (FONT_PX[1], false, false),
    }
}

/// The one shaping configuration measurement and painting share.
#[derive(Clone)]
pub struct TextConfig {
    /// Font family (the host registers Inter from assets/fonts by default;
    /// ".SystemUIFont" is the gpui spelling of the system face).
    pub family: SharedString,
    /// Monospace family for the mono slots (16..18) — JetBrains Mono from
    /// assets/fonts, with the OS fallback chain behind it.
    pub mono_family: SharedString,
}

impl TextConfig {
    pub fn new(family: impl Into<SharedString>) -> TextConfig {
        TextConfig {
            family: family.into(),
            mono_family: "JetBrains Mono".into(),
        }
    }

    pub fn font(&self, bold: bool, mono: bool) -> Font {
        Font {
            family: if mono {
                self.mono_family.clone()
            } else {
                self.family.clone()
            },
            // Additive advances (see module doc): no ligatures, no kerning.
            features: FontFeatures(Arc::new(vec![
                ("liga".into(), 0),
                ("calt".into(), 0),
                ("kern".into(), 0),
            ])),
            fallbacks: None,
            weight: if bold {
                FontWeight::BOLD
            } else {
                FontWeight::NORMAL
            },
            style: FontStyle::Normal,
        }
    }

    pub fn run(&self, len: usize, bold: bool, mono: bool, color: gpui::Hsla) -> TextRun {
        TextRun {
            len,
            font: self.font(bold, mono),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }
}

/// Default line height for a slot: ceil(ascent + descent), the native
/// counterpart of the baked atlas header's `lineHeight`
/// (framework/compiler/bake-font.ts rounds ascent + descent + lineGap).
pub fn slot_line_height(ts: &WindowTextSystem, cfg: &TextConfig, slot: u8) -> f32 {
    let (size, bold, mono) = slot_px(slot);
    let font_id = ts.resolve_font(&cfg.font(bold, mono));
    let ascent = f32::from(ts.ascent(font_id, px(size)));
    let descent = f32::from(ts.descent(font_id, px(size)));
    (ascent + descent).ceil()
}

/// Build the core text measurer (installed via `UiSurface::set_text_measure`
/// BEFORE the guest mounts). Same `'\n'`-only break contract as the baked
/// `Fonts::measure_run`; tracking never reaches this path (the core routes
/// tracked runs to the baked pair — see engine/core/src/text.rs).
///
/// Measured widths are cached per (line, slot): a keystroke makes the core
/// rebuild its whole layout tree (text change = structure dirt), which
/// re-measures every text leaf — but only the edited line's width actually
/// changed. The cache makes the other N-1 lookups free instead of N-1
/// CoreText shapes per tick.
/// Build the core line wrapper (installed via `UiSurface::set_text_wrap`
/// next to the measurer): gpui's own `LineWrapper` — the exact machinery
/// Zed's editor WrapMap consumes — decides the soft-break positions with
/// the same font the measurer sizes and the painter shapes, so break
/// columns, measured advances and painted glyphs always agree (the additive
/// shaping configuration above is what makes them provably consistent).
/// Returns ascending UTF-16 columns per the wrapText op contract.
pub fn native_wrap(ts: Arc<WindowTextSystem>, cfg: TextConfig) -> WrapFn {
    Box::new(move |text: &str, slot: u8, max_w: f32| {
        if text.is_empty() || max_w.is_nan() || max_w <= 0.0 {
            return Vec::new();
        }
        let (size, bold, mono) = slot_px(slot);
        let mut wrapper = ts.line_wrapper(cfg.font(bold, mono), px(size));
        let fragments = [LineFragment::text(text)];
        // Boundary.ix is the UTF-8 byte index where the next visual row
        // starts (Zed slices `line[prev.ix..boundary.ix]`); convert to the
        // UTF-16 columns the guest slices JS strings with.
        let byte_breaks: Vec<usize> = wrapper
            .wrap_line(&fragments, px(max_w))
            .map(|b| b.ix)
            .collect();
        drop(wrapper);
        if byte_breaks.is_empty() {
            return Vec::new();
        }
        let mut breaks = Vec::with_capacity(byte_breaks.len());
        let mut next = byte_breaks.iter().copied().peekable();
        let mut col = 0u32;
        for (byte_ix, ch) in text.char_indices() {
            while next.peek() == Some(&byte_ix) {
                breaks.push(col);
                next.next();
            }
            if next.peek().is_none() {
                break;
            }
            col += ch.len_utf16() as u32;
        }
        breaks
    })
}

pub fn native_measure(ts: Arc<WindowTextSystem>, cfg: TextConfig) -> MeasureFn {
    let widths: std::cell::RefCell<std::collections::HashMap<(String, u8), f32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    // Sized to spec::MAX_FONT_SLOTS (24) — mono slots live at 16..18.
    let line_heights: std::cell::RefCell<[Option<f32>; 24]> = std::cell::RefCell::new([None; 24]);
    Box::new(move |text: &str, slot: u8, _tracking: f32, line_h: f32| {
        let (size, bold, mono) = slot_px(slot);
        let lh = if line_h.is_nan() {
            let mut heights = line_heights.borrow_mut();
            let entry = &mut heights[(slot as usize).min(23)];
            match *entry {
                Some(h) => h,
                None => {
                    let h = slot_line_height(&ts, &cfg, slot);
                    *entry = Some(h);
                    h
                }
            }
        } else {
            line_h
        };
        let mut max_w = 0.0f32;
        let mut lines = 0u32;
        let mut cache = widths.borrow_mut();
        if cache.len() > 16384 {
            cache.clear(); // crude cap; refills from the live document
        }
        for line in text.split('\n') {
            lines += 1;
            if line.is_empty() {
                continue;
            }
            let key = (line.to_string(), slot);
            let w = match cache.get(&key) {
                Some(w) => *w,
                None => {
                    let run = cfg.run(line.len(), bold, mono, gpui::black());
                    let w = f32::from(ts.layout_line(line, px(size), &[run], None).width);
                    cache.insert(key, w);
                    w
                }
            };
            max_w = max_w.max(w);
        }
        (max_w, lines as f32 * lh)
    })
}
