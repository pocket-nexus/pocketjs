//! Worker-owned text service. No system fonts, platform text APIs, filesystem,
//! socket, or UI callback. Hosts supply immutable fonts before granting access.
//! The very same Engine dispatches local-thread, WASM-worker and paired RPC.
use base64::Engine as _;
use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache, Wrap};
use pocketjs_core::Ui;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MAX_DOCUMENT: usize = 65536;
pub const MAX_JOBS: usize = 8;
pub const PAGE_ROWS: usize = 32;
pub const MAX_ROWS: usize = 4096;
pub const INLINE_UNITS: usize = 2048;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    key: String,
    revision: u32,
    slot: u8,
    width: Option<f32>,
    length: usize,
}
struct Document {
    revision: u32,
    slot: u8,
    width: f32,
    length: usize,
    source: String,
    rows: Option<Vec<Row>>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Row {
    pub row: usize,
    pub from: usize,
    pub to: usize,
}

pub struct Engine {
    ui: Ui,
    documents: BTreeMap<String, Document>,
    fonts: FontSystem,
    swash: SwashCache,
}
impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
impl Engine {
    pub fn new() -> Self {
        Self {
            ui: Ui::new(),
            documents: BTreeMap::new(),
            fonts: FontSystem::new_with_locale_and_db(
                "en-US".into(),
                cosmic_text::fontdb::Database::new(),
            ),
            swash: SwashCache::new(),
        }
    }
    pub fn load_atlas(&mut self, bytes: &[u8]) -> bool {
        self.ui.load_font_atlas(bytes)
    }
    pub fn load_font(&mut self, bytes: &[u8]) -> bool {
        if bytes.len() > 32 * 1024 * 1024 {
            return false;
        }
        let before = self.fonts.db().faces().count();
        self.fonts.db_mut().load_font_data(bytes.to_vec());
        self.fonts.db().faces().count() > before
    }
    pub fn load_pak(&mut self, pak: &[u8]) {
        for entry in pocketjs_core::pak::entries(pak) {
            if entry.key.starts_with("ui:font.") {
                self.load_atlas(entry.blob);
            } else if entry.key.starts_with("text:font.") {
                self.load_font(entry.blob);
            }
        }
    }
    pub fn reply(&mut self, record: &str) -> String {
        let request: Value = match serde_json::from_str(record) {
            Ok(v) => v,
            Err(_) => return json!({"id":0,"error":"Invalid request"}).to_string(),
        };
        let id = request["id"].as_u64().unwrap_or(0);
        let result = if record.len() > 4096 || id == 0 || id > 9007199254740991 || request["v"] != 1
        {
            Err("Invalid request".into())
        } else if let (Some(method), Some(payload)) =
            (request["method"].as_str(), request["payload"].as_str())
        {
            self.dispatch(method, payload)
        } else {
            Err("Invalid request".into())
        };
        match result {
            Ok(payload) => json!({"id":id,"payload":payload}).to_string(),
            Err(error) => json!({"id":id,"error":error}).to_string(),
        }
    }
    /// One bounded wire request. Call only from a provider worker.
    pub fn dispatch(&mut self, method: &str, payload: &str) -> Result<String, String> {
        if payload.encode_utf16().count() > 2500 {
            return Err("Payload budget exceeded".into());
        }
        let v: Value = serde_json::from_str(payload).map_err(|_| "Invalid JSON")?;
        let result = match method {
            "text.capabilities" => {
                json!({"version":1,"layout":true,"shape":self.fonts.db().faces().count()>0,"maxDocument":MAX_DOCUMENT,"pageRows":PAGE_ROWS})
            }
            "text.replace" => {
                let text = v["text"].as_str().ok_or("Invalid text")?;
                let length = text.encode_utf16().count();
                if length > INLINE_UNITS {
                    return Err("Inline edit budget exceeded".into());
                }
                // Initialization, input and first layout page share one worker job.
                self.dispatch(
                    "text.open",
                    &json!({"key":v["key"],"revision":v["revision"],
                    "slot":v["slot"],"width":v["width"],"length":length})
                    .to_string(),
                )?;
                let doc = document(&mut self.documents, &v)?;
                doc.source = text.to_owned();
                layout_page(&self.ui, doc, 0)?
            }
            "text.edit" => {
                let key = v["key"].as_str().ok_or("Document key required")?;
                let base = number(&v, "baseRevision")?;
                let revision = number(&v, "revision")?;
                let from = number(&v, "from")?;
                let to = number(&v, "to")?;
                let text = v["text"].as_str().ok_or("Invalid text")?;
                let slot = u8::try_from(number(&v, "slot")?).map_err(|_| "Invalid font slot")?;
                let width = if v["width"].is_null() {
                    f32::INFINITY
                } else {
                    let w = v["width"].as_f64().ok_or("Invalid width")? as f32;
                    if !(1.0..=16384.0).contains(&w) {
                        return Err("Invalid width".into());
                    }
                    w
                };
                if self.ui.font_atlas(slot).is_none() {
                    return Err("Font capability unavailable".into());
                }
                let doc = self.documents.get_mut(key).ok_or("Document unavailable")?;
                if base != doc.revision as usize || revision <= base || revision > u32::MAX as usize
                {
                    return Err("Stale document revision".into());
                }
                let units = text.encode_utf16().count();
                if units > INLINE_UNITS
                    || from > to
                    || to > doc.length
                    || doc.source.encode_utf16().count() != doc.length
                    || doc.length - (to - from) + units > MAX_DOCUMENT
                {
                    return Err("Invalid edit range or budget".into());
                }
                let start = utf16_byte(&doc.source, from).ok_or("Edit splits a surrogate pair")?;
                let end = utf16_byte(&doc.source, to).ok_or("Edit splits a surrogate pair")?;
                doc.source.replace_range(start..end, text);
                doc.length = doc.length - (to - from) + units;
                doc.revision = revision as u32;
                doc.slot = slot;
                doc.width = width;
                doc.rows = None;
                layout_page(&self.ui, doc, 0)?
            }
            "text.open" => {
                let open: Open =
                    serde_json::from_value(v).map_err(|_| "Invalid document options")?;
                if open.key.is_empty()
                    || open.key.len() > 64
                    || open.length > MAX_DOCUMENT
                    || open
                        .width
                        .is_some_and(|w| !w.is_finite() || !(1.0..=16384.0).contains(&w))
                {
                    return Err("Invalid document limits".into());
                }
                if self.ui.font_atlas(open.slot).is_none() {
                    return Err("Font capability unavailable".into());
                }
                if !self.documents.contains_key(&open.key) && self.documents.len() >= MAX_JOBS {
                    return Err("Document budget exceeded".into());
                }
                if self
                    .documents
                    .get(&open.key)
                    .is_some_and(|doc| open.revision < doc.revision)
                {
                    return Err("Stale document revision".into());
                }
                self.documents.insert(
                    open.key,
                    Document {
                        revision: open.revision,
                        slot: open.slot,
                        width: open.width.unwrap_or(f32::INFINITY),
                        length: open.length,
                        source: String::new(),
                        rows: None,
                    },
                );
                json!({"offset":0})
            }
            "text.append" => {
                let doc = document(&mut self.documents, &v)?;
                let text = v["text"].as_str().ok_or("Invalid text")?;
                let offset = number(&v, "offset")?;
                let count = doc.source.encode_utf16().count();
                let units = text.encode_utf16().count();
                if units > 512
                    || offset != count
                    || count + units > doc.length
                    || doc.rows.is_some()
                {
                    return Err("Invalid append offset or budget".into());
                }
                doc.source.push_str(text);
                if v["layout"] == true && count + units == doc.length {
                    layout_page(&self.ui, doc, 0)?
                } else {
                    json!({"offset":count+units})
                }
            }
            "text.layout" => {
                let doc = document(&mut self.documents, &v)?;
                let offset = number(&v, "offset")?;
                layout_page(&self.ui, doc, offset)?
            }
            "text.close" => {
                document(&mut self.documents, &v)?;
                self.documents.remove(v["key"].as_str().unwrap());
                json!({"closed":true})
            }
            "text.shape" | "text.raster" => self.shape(method, &v)?,
            _ => return Err("Capability not granted".into()),
        };
        let out = serde_json::to_string(&result).map_err(|_| "Encoding failed")?;
        if out.len() > 2500 {
            return Err("Result budget exceeded".into());
        }
        Ok(out)
    }
    fn shape(&mut self, method: &str, v: &Value) -> Result<Value, String> {
        let text = v["text"].as_str().ok_or("Invalid text")?;
        let family = v["family"].as_str().ok_or("Font family required")?;
        let size = v["size"].as_f64().ok_or("Font size required")? as f32;
        let width = v["width"].as_f64().ok_or("Width required")? as f32;
        if text.encode_utf16().count() > 512
            || family.len() > 128
            || !(4.0..=96.0).contains(&size)
            || !(1.0..=512.0).contains(&width)
        {
            return Err("Shape budget exceeded".into());
        }
        if !self
            .fonts
            .db()
            .faces()
            .any(|face| face.families.iter().any(|(name, _)| name == family))
        {
            return Err("Font capability unavailable".into());
        }
        let mut buffer = Buffer::new(&mut self.fonts, Metrics::new(size, size * 1.25));
        buffer.set_size(Some(width), None);
        buffer.set_wrap(Wrap::WordOrGlyph);
        buffer.set_text(
            text,
            &Attrs::new().family(Family::Name(family)),
            Shaping::Advanced,
            None,
        );
        buffer.shape_until_scroll(&mut self.fonts, false);
        if method == "text.shape" {
            let offset = number(v, "offset")?;
            let glyphs: Vec<_> = buffer
                .layout_runs()
                .flat_map(|run| {
                    run.glyphs.iter().map(move |g| {
                        // UTF-16 source coordinates, even for ligatures and bidi runs.
                        let from = run.text[..g.start].encode_utf16().count();
                        let to = run.text[..g.end].encode_utf16().count();
                        (
                            run.line_i,
                            from,
                            to,
                            round(g.x),
                            round(run.line_y + g.y),
                            round(g.w),
                            g.level.number(),
                        )
                    })
                })
                .collect();
            if offset > glyphs.len() {
                return Err("Invalid glyph page".into());
            }
            let end = (offset + 24).min(glyphs.len());
            return Ok(
                json!({"glyphs":glyphs[offset..end],"next":if end<glyphs.len(){Some(end)}else{None},"total":glyphs.len()}),
            );
        }
        if width > 448.0 {
            return Err("Raster tile exceeds offload record budget (448 pixels)".into());
        }
        self.swash = SwashCache::new(); // Bound retained glyph images to one 512-unit request.
        let y = number(v, "y")?;
        if y > 65536 {
            return Err("Invalid raster offset".into());
        }
        let w = width.ceil() as usize;
        let mut coverage = vec![0u8; w * 16];
        buffer.draw(
            &mut self.fonts,
            &mut self.swash,
            cosmic_text::Color::rgb(255, 255, 255),
            |x, py, rw, rh, color| {
                for yy in py..py + rh as i32 {
                    for xx in x..x + rw as i32 {
                        if xx >= 0 && xx < w as i32 && yy >= y as i32 && yy < y as i32 + 16 {
                            let at = (yy - y as i32) as usize * w + xx as usize;
                            coverage[at] = coverage[at].max(color.a());
                        }
                    }
                }
            },
        );
        let mut packed = vec![0u8; coverage.len().div_ceil(4)];
        for (i, alpha) in coverage.into_iter().enumerate() {
            packed[i / 4] |= (((alpha as u16 * 3 + 127) / 255) as u8) << ((i % 4) * 2);
        }
        Ok(
            json!({"width":w,"height":16,"coverage":base64::engine::general_purpose::STANDARD.encode(packed)}),
        )
    }
}
fn utf16_byte(source: &str, at: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in source.char_indices() {
        if units == at {
            return Some(byte);
        }
        units += ch.len_utf16();
        if units > at {
            return None;
        }
    }
    (units == at).then_some(source.len())
}
fn layout_page(ui: &Ui, doc: &mut Document, offset: usize) -> Result<Value, String> {
    if doc.source.encode_utf16().count() != doc.length {
        return Err("Document incomplete".into());
    }
    if doc.rows.is_none() {
        let mut rows = Vec::new();
        for (row, line) in doc.source.split('\n').enumerate() {
            let mut from = 0;
            for to in ui
                .wrap_text(line, doc.slot, doc.width)
                .into_iter()
                .map(|n| n as usize)
                .chain(std::iter::once(line.encode_utf16().count()))
            {
                if rows.len() >= MAX_ROWS {
                    return Err("Visual row budget exceeded".into());
                }
                rows.push(Row { row, from, to });
                from = to;
            }
        }
        doc.rows = Some(rows);
    }
    let rows = doc.rows.as_ref().unwrap();
    if offset > rows.len() {
        return Err("Invalid page offset".into());
    }
    let end = (offset + PAGE_ROWS).min(rows.len());
    Ok(
        json!({"revision":doc.revision,"rows":rows[offset..end],"next":if end<rows.len(){Some(end)}else{None},"total":rows.len()}),
    )
}
fn round(n: f32) -> f32 {
    (n * 64.0).round() / 64.0
}
fn number(v: &Value, name: &str) -> Result<usize, String> {
    v[name]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("Invalid {name}"))
}
fn document<'a>(
    docs: &'a mut BTreeMap<String, Document>,
    v: &Value,
) -> Result<&'a mut Document, String> {
    let key = v["key"].as_str().ok_or("Invalid document key")?;
    let revision = number(v, "revision")?;
    let doc = docs.get_mut(key).ok_or("Document unavailable")?;
    if revision != doc.revision as usize {
        return Err("Stale document revision".into());
    }
    Ok(doc)
}

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> Engine {
        use pocketjs_core::spec::font_atlas as f;
        let mut atlas = vec![0u8; f::HEADER_SIZE + 96 * f::CMAP_ENTRY_SIZE + 96];
        atlas[..4].copy_from_slice(&f::MAGIC.to_le_bytes());
        atlas[4..6].copy_from_slice(&2u16.to_le_bytes());
        atlas[6..8].copy_from_slice(&96u16.to_le_bytes());
        atlas[8] = 1;
        atlas[9] = 1;
        atlas[10] = 1;
        atlas[11] = 16;
        for i in 0..96 {
            let at = f::HEADER_SIZE + i * f::CMAP_ENTRY_SIZE;
            atlas[at..at + 4].copy_from_slice(&(i as u32 + 32).to_le_bytes());
            atlas[at + 4..at + 6].copy_from_slice(&(i as u16).to_le_bytes());
            atlas[at + 6] = 6;
        }
        let mut engine = Engine::new();
        assert!(engine.load_atlas(&atlas));
        engine
    }
    #[test]
    fn native_layout_is_revisioned_and_bounded() {
        let mut e = engine();
        e.dispatch(
            "text.open",
            r#"{"key":"a","revision":2,"slot":0,"width":24,"length":7}"#,
        )
        .unwrap();
        assert!(e
            .dispatch(
                "text.append",
                r#"{"key":"a","revision":1,"offset":0,"text":"old"}"#
            )
            .is_err());
        e.dispatch(
            "text.append",
            r#"{"key":"a","revision":2,"offset":0,"text":"one two"}"#,
        )
        .unwrap();
        let page: Value = serde_json::from_str(
            &e.dispatch("text.layout", r#"{"key":"a","revision":2,"offset":0}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            page["rows"],
            json!([{"row":0,"from":0,"to":4},{"row":0,"from":4,"to":7}])
        );
        assert!(e
            .dispatch(
                "text.open",
                r#"{"key":"x","revision":1,"slot":0,"width":1,"length":65537}"#
            )
            .is_err());
        for i in 1..8 {
            e.dispatch(
                "text.open",
                &json!({"key":i.to_string(),"revision":1,"slot":0,"width":24,"length":0})
                    .to_string(),
            )
            .unwrap();
        }
        assert!(e
            .dispatch(
                "text.open",
                r#"{"key":"full","revision":1,"slot":0,"width":24,"length":0}"#
            )
            .is_err());
    }
    #[test]
    fn incremental_edits_are_atomic_and_keep_utf16_coordinates() {
        let mut e = engine();
        let replace = json!({"key":"edit","revision":1,"slot":0,"width":24,"text":"a😀z"});
        e.dispatch("text.replace", &replace.to_string()).unwrap();
        let mut edit = json!({"key":"edit","baseRevision":1,"revision":2,"slot":0,"width":48,"from":2,"to":3,"text":"x"});
        assert!(e.dispatch("text.edit", &edit.to_string()).is_err());
        assert_eq!(e.documents["edit"].source, "a😀z");
        assert_eq!(e.documents["edit"].revision, 1);
        edit["from"] = json!(1);
        edit["to"] = json!(3);
        edit["text"] = json!("ok\n");
        let changed: Value =
            serde_json::from_str(&e.dispatch("text.edit", &edit.to_string()).unwrap()).unwrap();
        assert_eq!(e.documents["edit"].source, "aok\nz");
        assert_eq!(changed["revision"], 2);
        assert_eq!(
            changed["rows"],
            json!([{"row":0,"from":0,"to":3},{"row":1,"from":0,"to":1}])
        );
        assert!(e.dispatch("text.edit", &edit.to_string()).is_err());
        assert_eq!(e.documents["edit"].source, "aok\nz");
        // Resize alone reuses resident source; text still executes in the worker.
        edit["baseRevision"] = json!(2);
        edit["revision"] = json!(3);
        edit["from"] = json!(0);
        edit["to"] = json!(0);
        edit["text"] = json!("");
        edit["width"] = json!(6);
        let resized: Value =
            serde_json::from_str(&e.dispatch("text.edit", &edit.to_string()).unwrap()).unwrap();
        assert_eq!(resized["total"], 4);
    }
    #[test]
    fn pure_rust_shaping_requires_explicit_fonts() {
        let mut e = engine();
        let q=json!({"text":"office e\u{301}","family":"Inter","size":14,"width":180,"offset":0,"y":0}).to_string();
        assert!(e.dispatch("text.shape", &q).is_err());
        assert!(e.load_font(include_bytes!("../../../../assets/fonts/Inter-Regular.ttf")));
        let result: Value = serde_json::from_str(&e.dispatch("text.shape", &q).unwrap()).unwrap();
        assert!(result["total"].as_u64().unwrap() > 0);
        assert!(e.dispatch("text.raster", &q).unwrap().len() < 2500);
    }
}
