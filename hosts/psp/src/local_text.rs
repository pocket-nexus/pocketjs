//! Worker-owned PSP runtime text service. No filesystem or UI callbacks run here.
//! The host invokes the bounded file reader on the text worker for `runtime.load`.
use alloc::{
    string::{String, ToString},
    vec::Vec,
};
use pocket_text::runtime::{RuntimeLimits, RuntimeText};
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: usize = 4096;
const MAX_PATH_BYTES: usize = 255;

pub struct LocalText {
    runtime: RuntimeText,
    loaded_package_fonts: usize,
    rejected_package_fonts: usize,
}
impl LocalText {
    /// Called after the worker selects its private heap. The PAK remains immutable.
    pub fn new(pak: &[u8]) -> Self {
        let mut service = Self {
            runtime: RuntimeText::with_limits(RuntimeLimits::psp()),
            loaded_package_fonts: 0,
            rejected_package_fonts: 0,
        };
        for entry in pocketjs_core::pak::entries(pak) {
            let Some(index) = entry.key.strip_prefix("text:font.") else {
                continue;
            };
            if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            if service.runtime.load_font(entry.blob) {
                service.loaded_package_fonts += 1;
            } else {
                service.rejected_package_fonts += 1;
            }
        }
        service
    }

    pub fn dispatch(
        &mut self,
        method: &str,
        payload: &str,
        mut load_file: impl FnMut(&str, usize) -> Result<Vec<u8>, String>,
    ) -> Result<String, String> {
        if payload.len() > MAX_REQUEST_BYTES {
            return Err("Runtime text request budget exceeded".into());
        }
        let value: Value =
            serde_json::from_str(payload).map_err(|_| "Invalid runtime text JSON")?;
        if !value.is_object() {
            return Err("Runtime text object required".into());
        }
        let mut reply = if method == "runtime.load" {
            let path = value["path"]
                .as_str()
                .filter(|path| {
                    !path.is_empty()
                        && path.len() <= MAX_PATH_BYTES
                        && !path.chars().any(|c| c.is_control())
                })
                .ok_or("Explicit font path required")?;
            let remaining =
                (self.runtime.limits().font_bytes / 2).saturating_sub(self.runtime.source_bytes());
            // Refuse before invoking a reader when no new font can be admitted.
            if !self.runtime.can_load_font_bytes(1) {
                return Err("Runtime font budget exceeded".into());
            }
            let bytes = load_file(path, remaining)?;
            if bytes.len() > remaining || !self.runtime.can_load_font_bytes(bytes.len()) {
                return Err("Runtime font budget exceeded".into());
            }
            if !self.runtime.load_owned_font(bytes) {
                return Err("Runtime font rejected: static TTF required within font budget".into());
            }
            let mut fonts = self.runtime.dispatch("runtime.fonts", &json!({}))?;
            fonts["loaded"] = json!(true);
            fonts
        } else {
            self.runtime.dispatch(method, &value)?
        };
        if method == "runtime.fonts" || method == "runtime.load" {
            let limits = self.runtime.limits();
            reply["local"] = json!(true);
            reply["limits"] = json!({
                "fontSourceBytes": limits.font_bytes / 2,
                "fontBytes": limits.font_bytes,
                "fonts": limits.fonts,
                "instances": limits.instances,
                "glyphKeys": limits.glyph_keys,
                "units": limits.units,
                "glyphs": limits.glyphs,
                "shaping": limits.shaping_bytes,
                "layout": limits.layout_bytes,
                "bitmap": limits.bitmap_bytes,
                "requestBytes": MAX_REQUEST_BYTES,
            });
        }
        if method == "runtime.stats" {
            reply["local"] = json!(true);
            reply["loadedPackageFonts"] = json!(self.loaded_package_fonts);
            reply["rejectedPackageFonts"] = json!(self.rejected_package_fonts);
        }
        Ok(reply.to_string())
    }
}
