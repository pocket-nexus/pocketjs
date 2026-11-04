//! pocket-widget — desktop widgets as a runtime-family capability.
//!
//! The mechanism layer named in docs/WIDGET.md: what pocket-character proved
//! (a transparent, undecorated, always-on-top window that costs almost
//! nothing at rest), generalized so any Pocket runtime can take the desktop
//! widget form. Four pieces:
//!
//!   - [`shell`] — the widget window contract and its event loop. The guest
//!     ticks at a fixed rate, always (Law 3: one guest turn per host tick);
//!     GPU frames are demand-driven — no dirt, no render pass, no present.
//!     An idle widget burns ticks (microseconds), not frames. One governor,
//!     two widget shapes: 3D ([`WidgetGame`]) and flat 2D ([`FlatWidget`],
//!     where the window *is* the `ui` surface).
//!   - [`embed`] — a full PocketJS `ui` surface rendered off-window into an
//!     offscreen target whose texture view binds onto any pocket3d mesh
//!     (`ModelAsset::from_geometry_textured`). The screen inside a widget is
//!     a real app, not a video. The per-tick DrawList hash is the dirty
//!     signal the shell's demand rendering keys off.
//!   - [`pick`] — cursor-ray picking against oriented boxes, event-shaped
//!     (runs on mouse events, never per frame).
//!   - [`parts`] — the interaction vocabulary: named part shapes mapped to
//!     spec BTN bits, analog packing (raw extremes 255/1, never 0), and the
//!     shared uihost keyboard map.
//!
//! What stays out: any specific model, part layout, or behavior — those are
//! the product (see `examples/handheld` for the first one).

pub mod embed;
pub mod parts;
pub mod pick;
pub mod shell;

pub use embed::EmbeddedUi;
pub use parts::{PartMap, PartShape, analog_pack, key_button};
pub use shell::{FlatWidget, WidgetConfig, WidgetGame, run, run_flat};
