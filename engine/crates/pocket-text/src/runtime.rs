//! Immutable runtime font instances, shaping and layout; raster residency is independent.
use base64::Engine as _;
use harfrust::{FontRef, ShaperData, UnicodeBuffer};
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::c_void, sync::Arc};
use ttf_parser::Face;
use unicode_bidi::{BidiInfo, Level};
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;
const MAX_GLYPH_KEYS: usize = 65536;
const MAX_INSTANCES: usize = 256;
const MAX_UNITS: usize = 2048;
const MAX_GLYPHS: usize = 8192;
#[cfg_attr(target_arch = "wasm32", link(wasm_import_module = "pocket_freetype"))]
unsafe extern "C" {
    fn pocket_ft_face(bytes: *const u8, len: u32) -> *mut c_void;
    fn pocket_ft_drop(face: *mut c_void);
    fn pocket_ft_render(face: *mut c_void, size64: u32, glyph: u32, info: *mut i32) -> i32;
    fn pocket_ft_copy(face: *mut c_void, bytes: *mut u8, capacity: u32) -> i32;
}
struct Font {
    data: Arc<Vec<u8>>,
    family: String,
    name: String,
    handle: *mut c_void,
    shaper_data: ShaperData,
}
impl Drop for Font {
    fn drop(&mut self) {
        unsafe { pocket_ft_drop(self.handle) }
    }
}
#[derive(Clone)]
struct Instance {
    faces: Vec<usize>,
    size64: u32,
    ascent: f32,
    line_height: f32,
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct GlyphKey {
    face: usize,
    size64: u32,
    glyph: u32,
}
#[derive(Clone)]
struct ShapeGlyph {
    id: u32,
    advance: f32,
    x: f32,
    y: f32,
}
#[derive(Clone)]
struct Cluster {
    from: usize,
    to: usize,
    glyphs: Vec<ShapeGlyph>,
    width: f32,
    stops: Vec<usize>,
    break_after: bool,
    hard: bool,
    level: u8,
}
struct Shape {
    font: u32,
    clusters: Vec<Cluster>,
    units: usize,
    missing: usize,
    glyphs: usize,
}
type LayoutGlyph = (u32, f32, f32, f32, usize, usize, usize);
type LayoutRow = (usize, usize, f32, f32);
type Caret = (usize, f32, f32, usize);
struct Layout {
    shape: u32,
    glyphs: Vec<LayoutGlyph>,
    rows: Vec<LayoutRow>,
    carets: Vec<Caret>,
    width: f32,
    height: f32,
    baseline: f32,
    truncated: bool,
}
struct Bitmap {
    width: i32,
    height: i32,
    left: i32,
    top: i32,
    bytes: Vec<u8>,
}
struct Entry<T> {
    key: String,
    value: Arc<T>,
    bytes: usize,
    tick: u64,
    pins: u32,
}
struct Cache<T> {
    entries: BTreeMap<u32, Entry<T>>,
    budget: usize,
    bytes: usize,
    peak: usize,
    hits: u64,
    misses: u64,
    evictions: u64,
    next: u32,
    clock: u64,
}
impl<T> Cache<T> {
    fn new(budget: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            budget,
            bytes: 0,
            peak: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
            next: 1,
            clock: 0,
        }
    }
    fn get(&mut self, id: u32) -> Option<Arc<T>> {
        self.clock += 1;
        self.entries.get_mut(&id).map(|e| {
            e.tick = self.clock;
            e.value.clone()
        })
    }
    fn find(&mut self, key: &str) -> Option<(u32, Arc<T>)> {
        let id = self
            .entries
            .iter()
            .find(|(_, e)| e.key == key)
            .map(|(id, _)| *id);
        if let Some(id) = id {
            self.hits += 1;
            Some((id, self.get(id).unwrap()))
        } else {
            self.misses += 1;
            None
        }
    }
    fn reserve(&mut self, bytes: usize) -> Result<(), String> {
        if bytes > self.budget {
            return Err("Cache budget exceeded".into());
        }
        let pinned: usize = self
            .entries
            .values()
            .filter(|e| e.pins > 0)
            .map(|e| e.bytes)
            .sum();
        if pinned + bytes > self.budget {
            return Err("Pinned cache budget exceeded".into());
        }
        while self.bytes + bytes > self.budget {
            let id = self
                .entries
                .iter()
                .filter(|(_, e)| e.pins == 0)
                .min_by_key(|(_, e)| e.tick)
                .map(|(id, _)| *id)
                .ok_or("Pinned cache budget exceeded")?;
            self.bytes -= self.entries.remove(&id).unwrap().bytes;
            self.evictions += 1;
        }
        Ok(())
    }
    fn insert(&mut self, key: String, value: T, bytes: usize) -> Result<u32, String> {
        self.reserve(bytes)?;
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or("Cache identity exhausted")?;
        self.clock += 1;
        self.bytes += bytes;
        self.peak = self.peak.max(self.bytes);
        self.entries.insert(
            id,
            Entry {
                key,
                value: Arc::new(value),
                bytes,
                tick: self.clock,
                pins: 0,
            },
        );
        Ok(id)
    }
    fn pin(&mut self, id: u32, add: bool) -> Result<(), String> {
        let e = self.entries.get_mut(&id).ok_or("Cache entry evicted")?;
        e.pins = if add {
            e.pins.checked_add(1).ok_or("Lease budget exceeded")?
        } else {
            e.pins.checked_sub(1).ok_or("Lease is not held")?
        };
        Ok(())
    }
    fn set_budget(&mut self, budget: usize) -> Result<(), String> {
        let pinned: usize = self
            .entries
            .values()
            .filter(|e| e.pins > 0)
            .map(|e| e.bytes)
            .sum();
        if budget < pinned {
            return Err("Pinned cache budget exceeded".into());
        }
        self.budget = budget;
        self.reserve(0)
    }
    fn stats(&self) -> Value {
        json!({"bytes":self.bytes,"budget":self.budget,"peak":self.peak,"hits":self.hits,"misses":self.misses,"evictions":self.evictions,"entries":self.entries.len(),"pinned":self.entries.values().filter(|e|e.pins>0).count()})
    }
}
pub struct RuntimeText {
    fonts: Vec<Font>,
    font_bytes: usize,
    instances: BTreeMap<u32, Instance>,
    leases: BTreeMap<String, u32>,
    glyph_ids: BTreeMap<GlyphKey, u32>,
    glyph_keys: Vec<GlyphKey>,
    shapes: Cache<Shape>,
    layouts: Cache<Layout>,
    bitmaps: Cache<Bitmap>,
    rasterizations: u64,
    layout_count: u64,
    shape_count: u64,
}
impl Default for RuntimeText {
    fn default() -> Self {
        Self {
            fonts: vec![],
            font_bytes: 0,
            instances: BTreeMap::new(),
            leases: BTreeMap::new(),
            glyph_ids: BTreeMap::new(),
            glyph_keys: vec![],
            shapes: Cache::new(1024 * 1024),
            layouts: Cache::new(1024 * 1024),
            bitmaps: Cache::new(2 * 1024 * 1024),
            rasterizations: 0,
            layout_count: 0,
            shape_count: 0,
        }
    }
}
impl RuntimeText {
    #[cfg(test)]
    pub fn load_font(&mut self, bytes: &[u8]) -> bool {
        self.load_shared_font(Arc::new(bytes.to_vec()))
    }
    pub fn is_static_ttf(bytes: &[u8]) -> bool {
        Face::parse(bytes, 0).is_ok_and(|face| {
            !face.is_variable()
                && face
                    .raw_face()
                    .table(ttf_parser::Tag::from_bytes(b"fvar"))
                    .is_none()
                && face.tables().glyf.is_some()
                && !bytes.starts_with(b"ttcf")
        })
    }
    pub fn source_bytes(&self) -> usize {
        self.font_bytes / 2
    }
    pub fn load_shared_font(&mut self, data: Arc<Vec<u8>>) -> bool {
        if self.fonts.iter().any(|f| f.data == data) {
            return true;
        }
        if self.font_bytes + data.len() * 2 > MAX_FONT_BYTES
            || self.fonts.len() >= 64
            || !Self::is_static_ttf(&data)
        {
            return false;
        }
        let face = Face::parse(&data, 0).unwrap();
        let family = face
            .names()
            .into_iter()
            .filter(|n| n.name_id == 16 || n.name_id == 1)
            .filter_map(|n| n.to_string().map(|s| (n.name_id, s)))
            .max_by_key(|(id, _)| *id)
            .map(|(_, s)| s);
        let name = face
            .names()
            .into_iter()
            .filter(|n| n.name_id == 4)
            .find_map(|n| n.to_string());
        let (Some(family), Some(name)) = (family, name) else {
            return false;
        };
        if family.is_empty()
            || name.is_empty()
            || family.len() > 128
            || name.len() > 128
            || self.fonts.iter().any(|f| f.name == name)
        {
            return false;
        }
        let handle = unsafe { pocket_ft_face(data.as_ptr(), data.len() as u32) };
        if handle.is_null() {
            return false;
        }
        self.font_bytes += data.len() * 2;
        let shaper_data = ShaperData::new(&FontRef::new(&data).unwrap());
        self.fonts.push(Font {
            data,
            family,
            name,
            handle,
            shaper_data,
        });
        true
    }
    fn font_page(&self, v: &Value) -> Result<Value, String> {
        let offset = page_offset(v)?;
        if offset > self.fonts.len() {
            return Err("Invalid font page".into());
        }
        let mut end = offset;
        let mut names = vec![];
        let mut faces = vec![];
        while end < self.fonts.len() {
            let f = &self.fonts[end];
            let mut next_names = vec![f.name.clone()];
            if f.family != f.name
                && self
                    .fonts
                    .iter()
                    .filter(|other| other.family == f.family)
                    .count()
                    == 1
                && !self.fonts.iter().any(|other| other.name == f.family)
            {
                next_names.push(f.family.clone());
            }
            let entry = json!({"face":f.name,"family":f.family});
            let cost: usize = names.iter().map(String::len).sum::<usize>()
                + next_names.iter().map(String::len).sum::<usize>()
                + faces
                    .iter()
                    .map(|v: &Value| v.to_string().len())
                    .sum::<usize>()
                + entry.to_string().len();
            if cost > 2000 && end > offset {
                break;
            }
            names.extend(next_names);
            faces.push(entry);
            end += 1;
        }
        Ok(
            json!({"families":names,"faces":faces,"next":if end<self.fonts.len(){Some(end)}else{None},"total":self.fonts.len(),"staticTTF":true,"gray8":true,"density":1,"maxUnits":MAX_UNITS}),
        )
    }
    pub fn dispatch(&mut self, method: &str, v: &Value) -> Result<Value, String> {
        match method {
            "runtime.fonts" => self.font_page(v),
            "runtime.font" => self.font(v),
            "runtime.shape" => {
                let font = id(v, "font")?;
                let text = v["text"].as_str().ok_or("Text required")?;
                let (shape, s) = self.shape(font, text)?;
                Ok(json!({"shape":shape,"glyphs":s.glyphs,"units":s.units,"missing":s.missing}))
            }
            "runtime.layout" => self.layout(v),
            "runtime.prepare" => self.prepare(v),
            "runtime.release" => {
                let key = v["key"].as_str().ok_or("Lease key required")?;
                let released = if let Some(lid) = self.leases.remove(key) {
                    let l = self.layouts.get(lid).ok_or("Leased layout unavailable")?;
                    self.layouts.pin(lid, false)?;
                    self.shapes.pin(l.shape, false)?;
                    true
                } else {
                    false
                };
                Ok(json!({"released":released}))
            }
            "runtime.layout.page" => self.page(v),
            "runtime.glyph" => self.glyph(v),
            "runtime.glyph.batch" => {
                let ids = v["glyphs"]
                    .as_array()
                    .filter(|a| a.len() <= 16)
                    .ok_or("Invalid glyph batch")?;
                let offset = page_offset(v)?;
                if offset > ids.len() {
                    return Err("Invalid batch offset".into());
                }
                let mut items = vec![];
                let mut end = offset;
                let mut bytes = 64;
                while end < ids.len() {
                    let item = self.glyph(&json!({"glyph":ids[end]}))?;
                    let cost = item.to_string().len() + 1;
                    if bytes + cost > 2400 {
                        break;
                    }
                    bytes += cost;
                    items.push(item);
                    end += 1;
                }
                Ok(
                    json!({"items":items,"next":if end<ids.len(){Some(end)}else{None},"total":ids.len()}),
                )
            }
            "runtime.lease" => {
                let lid = id(v, "layout")?;
                let add = match v["action"].as_str() {
                    Some("pin") => true,
                    Some("release") => false,
                    _ => return Err("Invalid lease action".into()),
                };
                let l = self.layouts.get(lid).ok_or("Layout evicted")?;
                if add {
                    self.shapes.pin(l.shape, true)?;
                    if let Err(e) = self.layouts.pin(lid, true) {
                        self.shapes.pin(l.shape, false)?;
                        return Err(e);
                    }
                } else {
                    let keyed = self.leases.values().filter(|id| **id == lid).count() as u32;
                    if self.layouts.entries[&lid].pins <= keyed {
                        return Err("Lease is not held".into());
                    }
                    self.layouts.pin(lid, false)?;
                    self.shapes.pin(l.shape, false)?
                }
                Ok(json!({"leased":add}))
            }
            "runtime.budget" => {
                let mut changes = vec![];
                for (name, pinned) in [
                    (
                        "shaping",
                        self.shapes
                            .entries
                            .values()
                            .filter(|e| e.pins > 0)
                            .map(|e| e.bytes)
                            .sum::<usize>(),
                    ),
                    (
                        "layout",
                        self.layouts
                            .entries
                            .values()
                            .filter(|e| e.pins > 0)
                            .map(|e| e.bytes)
                            .sum(),
                    ),
                    ("bitmap", 0),
                ] {
                    if let Some(n) = v.get(name) {
                        let n = n
                            .as_u64()
                            .filter(|n| *n <= 64 * 1024 * 1024)
                            .ok_or("Invalid cache budget")?
                            as usize;
                        if n < pinned {
                            return Err("Pinned cache budget exceeded".into());
                        }
                        changes.push((name, n));
                    }
                }
                for (name, n) in changes {
                    match name {
                        "shaping" => self.shapes.set_budget(n)?,
                        "layout" => self.layouts.set_budget(n)?,
                        _ => self.bitmaps.set_budget(n)?,
                    }
                }
                Ok(self.stats())
            }
            "runtime.stats" => Ok(self.stats()),
            _ => Err("Capability not granted".into()),
        }
    }
    fn stats(&self) -> Value {
        json!({"shaping":self.shapes.stats(),"layout":self.layouts.stats(),"bitmap":self.bitmaps.stats(),"shapeCount":self.shape_count,"layoutCount":self.layout_count,"rasterizations":self.rasterizations,"fontBytes":self.font_bytes,"fontSourceBytes":self.font_bytes/2,"leases":self.leases.len(),"fontBudget":MAX_FONT_BYTES,"glyphKeys":self.glyph_keys.len(),"glyphKeyBudget":MAX_GLYPH_KEYS,"instances":self.instances.len(),"instanceBudget":MAX_INSTANCES})
    }
    fn font(&mut self, v: &Value) -> Result<Value, String> {
        let family = v["family"].as_str().ok_or("Font family required")?;
        let size = v["size"]
            .as_f64()
            .filter(|s| s.is_finite() && (4.0..=256.0).contains(s))
            .ok_or("Font size outside 4..256")?;
        let fallback = v["fallback"]
            .as_array()
            .ok_or("Explicit fallback array required")?;
        if fallback.len() > 8 {
            return Err("Fallback budget exceeded".into());
        }
        let names = std::iter::once(Ok(family)).chain(
            fallback
                .iter()
                .map(|s| s.as_str().ok_or("Invalid fallback family")),
        );
        let mut faces = vec![];
        for name in names {
            let name = name?;
            let face = if let Some(face) = self.fonts.iter().position(|f| f.name == name) {
                face
            } else {
                let candidates: Vec<usize> = self
                    .fonts
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| f.family == name)
                    .map(|(i, _)| i)
                    .collect();
                if candidates.len() > 1 {
                    return Err(format!("Ambiguous font family; use a face name: {name}"));
                }
                *candidates
                    .first()
                    .ok_or_else(|| format!("Runtime font unavailable: {name}"))?
            };
            if !faces.contains(&face) {
                faces.push(face)
            }
        }
        let size64 = (size * 64.0).round() as u32;
        let size = size64 as f32 / 64.0;
        let mut ascent: f32 = 0.0;
        let mut descent: f32 = 0.0;
        let mut height: f32 = 0.0;
        for i in &faces {
            let f = Face::parse(&self.fonts[*i].data, 0).unwrap();
            let scale = size / f.units_per_em() as f32;
            ascent = ascent.max(f.ascender() as f32 * scale);
            descent = descent.max(-f.descender() as f32 * scale);
            height = height
                .max((f.ascender() as f32 - f.descender() as f32 + f.line_gap() as f32) * scale);
        }
        let line_height = round(height.max(ascent + descent));
        let existing = self
            .instances
            .iter()
            .find(|(_, i)| i.faces == faces && i.size64 == size64)
            .map(|(id, _)| *id);
        let font = if let Some(id) = existing {
            id
        } else {
            if self.instances.len() >= MAX_INSTANCES {
                return Err("Font instance budget exceeded".into());
            }
            let id = self.instances.len() as u32 + 1;
            self.instances.insert(
                id,
                Instance {
                    faces,
                    size64,
                    ascent: round(ascent),
                    line_height,
                },
            );
            id
        };
        Ok(
            json!({"font":font,"ascent":round(ascent),"descent":round(descent),"lineHeight":line_height}),
        )
    }
    fn glyph_id(&mut self, key: GlyphKey) -> Result<u32, String> {
        if let Some(id) = self.glyph_ids.get(&key) {
            return Ok(*id);
        }
        if self.glyph_keys.len() >= MAX_GLYPH_KEYS {
            return Err("Glyph identity budget exceeded".into());
        }
        let id = self.glyph_keys.len() as u32 + 1;
        self.glyph_keys.push(key);
        self.glyph_ids.insert(key, id);
        Ok(id)
    }
    fn shape(&mut self, font: u32, text: &str) -> Result<(u32, Arc<Shape>), String> {
        let instance = self
            .instances
            .get(&font)
            .ok_or("Font instance unavailable")?
            .clone();
        let units = text.encode_utf16().count();
        if units > MAX_UNITS {
            return Err("Shaping text budget exceeded".into());
        }
        let key = format!("{font}:{text}");
        if let Some(hit) = self.shapes.find(&key) {
            return Ok(hit);
        }
        // Reject before shaping if even the immutable source cannot fit.
        if key.len() + text.len() + std::mem::size_of::<Shape>() > self.shapes.budget {
            return Err("Shaping budget exceeded".into());
        }
        let bidi = BidiInfo::new(text, None);
        let mut byte_units = vec![0; text.len() + 1];
        let mut unit = 0;
        for (byte, ch) in text.char_indices() {
            byte_units[byte] = unit;
            unit += ch.len_utf16();
        }
        byte_units[text.len()] = unit;
        let boundaries: Vec<(usize, usize)> = text
            .grapheme_indices(true)
            .map(|(b, _)| (b, byte_units[b]))
            .chain(std::iter::once((text.len(), units)))
            .collect();
        let mut clusters = vec![];
        let mut missing = 0;
        let mut total_glyphs = 0;
        let mut at = 0;
        while at + 1 < boundaries.len() {
            let start = boundaries[at].0;
            let end = boundaries[at + 1].0;
            let g = &text[start..end];
            if g == "\n" || g == "\r\n" {
                clusters.push(Cluster {
                    from: boundaries[at].1,
                    to: boundaries[at + 1].1,
                    glyphs: vec![],
                    width: 0.0,
                    stops: vec![boundaries[at].1, boundaries[at + 1].1],
                    break_after: true,
                    hard: true,
                    level: 0,
                });
                at += 1;
                continue;
            }
            let face_index = choose_face(&self.fonts, &instance, g);
            let level = bidi.levels.get(start).map_or(0, |l| l.number());
            let mut script = strong_script(g);
            let mut last = at + 1;
            while last + 1 < boundaries.len() {
                let next = &text[boundaries[last].0..boundaries[last + 1].0];
                let next_script = strong_script(next);
                if next.contains('\n')
                    || (script.is_some() && next_script.is_some() && script != next_script)
                    || choose_face(&self.fonts, &instance, next) != face_index
                    || bidi
                        .levels
                        .get(boundaries[last].0)
                        .map_or(0, |l| l.number())
                        != level
                {
                    break;
                }
                if script.is_none() {
                    script = next_script;
                }
                last += 1;
            }
            let run_end = boundaries[last].0;
            let source = &text[start..run_end];
            let face = Face::parse(&self.fonts[face_index].data, 0).unwrap();
            let scale = instance.size64 as f32 / 64.0 / face.units_per_em() as f32;
            let mut buffer = UnicodeBuffer::new();
            buffer.push_str(source);
            buffer.set_direction(if level % 2 == 1 {
                harfrust::Direction::RightToLeft
            } else {
                harfrust::Direction::LeftToRight
            });
            buffer.guess_segment_properties();
            let font_ref = FontRef::new(&self.fonts[face_index].data).unwrap();
            let shaper = self.fonts[face_index].shaper_data.shaper(&font_ref).build();
            let shaped = shaper.shape(buffer, &[]);
            let mut starts: Vec<usize> = shaped
                .glyph_infos()
                .iter()
                .map(|g| start + g.cluster as usize)
                .collect();
            starts.push(run_end);
            starts.sort_unstable();
            starts.dedup();
            let mut groups: BTreeMap<usize, Vec<(u32, f32, f32, f32)>> = BTreeMap::new();
            for (info, pos) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
                let b = start + info.cluster as usize;
                if info.glyph_id == 0 {
                    missing += 1
                }
                groups.entry(b).or_default().push((
                    info.glyph_id,
                    round(pos.x_advance as f32 * scale),
                    round(pos.x_offset as f32 * scale),
                    round(-pos.y_offset as f32 * scale),
                ));
            }
            for (b, glyph_data) in groups {
                let next = starts[starts.partition_point(|s| *s <= b)];
                let from = byte_units[b];
                let to = byte_units[next];
                let stop_start = boundaries.partition_point(|(off, _)| *off < b);
                let stop_end = boundaries.partition_point(|(off, _)| *off <= next);
                let stops = boundaries[stop_start..stop_end]
                    .iter()
                    .map(|(_, u)| *u)
                    .collect();
                let mut glyphs = vec![];
                let mut width = 0.0;
                for (glyph, advance, x, y) in glyph_data {
                    let id = self.glyph_id(GlyphKey {
                        face: face_index,
                        size64: instance.size64,
                        glyph,
                    })?;
                    glyphs.push(ShapeGlyph { id, advance, x, y });
                    width += advance;
                    total_glyphs += 1;
                    if total_glyphs > MAX_GLYPHS {
                        return Err("Shaped glyph budget exceeded".into());
                    }
                }
                let tail = text[b..next].chars().last().unwrap_or(' ');
                clusters.push(Cluster {
                    from,
                    to,
                    glyphs,
                    width: round(width),
                    stops,
                    break_after: tail.is_whitespace() || tail == '-' || is_cjk(tail),
                    hard: false,
                    level,
                });
            }
            at = last;
        }
        let bytes = std::mem::size_of::<Shape>()
            + 128
            + key.capacity()
            + clusters.capacity() * std::mem::size_of::<Cluster>()
            + clusters
                .iter()
                .map(|c| {
                    c.glyphs.capacity() * std::mem::size_of::<ShapeGlyph>()
                        + c.stops.capacity() * std::mem::size_of::<usize>()
                })
                .sum::<usize>();
        let shape = Shape {
            font,
            clusters,
            units,
            missing,
            glyphs: total_glyphs,
        };
        let id = self.shapes.insert(key, shape, bytes)?;
        self.shape_count += 1;
        Ok((id, self.shapes.get(id).unwrap()))
    }
    fn prepare(&mut self, v: &Value) -> Result<Value, String> {
        if let Some(releases) = v.get("releases") {
            let releases = releases
                .as_array()
                .filter(|r| r.len() <= 32)
                .ok_or("Invalid released leases")?;
            if releases
                .iter()
                .any(|key| key.as_str().is_none_or(|s| s.is_empty() || s.len() > 64))
            {
                return Err("Invalid released lease key".into());
            }
            for key in releases {
                self.dispatch("runtime.release", &json!({"key":key}))?;
            }
        }
        let lease_key = v["leaseKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 64)
            .ok_or("Invalid lease key")?;
        if !self.leases.contains_key(lease_key) && self.leases.len() >= 128 {
            return Err("Lease budget exceeded".into());
        }
        let text = v["text"].as_str().ok_or("Text required")?;
        let (sid, shape) = self.shape(id(v, "font")?, text)?;
        if shape.missing > 0 {
            return Err("Explicit fonts do not cover text".into());
        }
        let mut options = v.clone();
        options["shape"] = json!(sid);
        let mut reply = self.layout(&options)?;
        let lid = id(&reply, "layout")?;
        if let Some(existing) = self.leases.get(lease_key) {
            if *existing != lid {
                return Err("Lease key already active".into());
            }
        } else {
            self.shapes.pin(sid, true)?;
            if let Err(error) = self.layouts.pin(lid, true) {
                self.shapes.pin(sid, false)?;
                return Err(error);
            }
            self.leases.insert(lease_key.to_owned(), lid);
        }
        reply["shape"] = json!(sid);
        reply["units"] = json!(shape.units);
        reply["missing"] = json!(0);
        let l = self.layouts.get(lid).unwrap();
        if l.glyphs.len() + l.rows.len() + l.carets.len() <= 128 {
            reply["inline"] = json!({"glyphs":l.glyphs,"rows":l.rows,"carets":l.carets});
            if reply.to_string().len() > 2400 {
                reply.as_object_mut().unwrap().remove("inline");
            }
        }
        Ok(reply)
    }
    fn layout(&mut self, v: &Value) -> Result<Value, String> {
        let sid = id(v, "shape")?;
        self.shapes.pin(sid, true)?;
        let result = self.build_layout(v);
        self.shapes.pin(sid, false)?;
        result
    }
    fn build_layout(&mut self, v: &Value) -> Result<Value, String> {
        let sid = id(v, "shape")?;
        let shape = self.shapes.get(sid).ok_or("Shape evicted")?;
        let width = if v["width"].is_null() {
            f32::INFINITY
        } else {
            let w = v["width"]
                .as_f64()
                .filter(|w| w.is_finite() && *w > 0.0 && *w <= 16384.0)
                .ok_or("Invalid layout width")?;
            round(w as f32).max(1.0 / 64.0)
        };
        let max_lines = if v["maxLines"].is_null() {
            4096
        } else {
            v["maxLines"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 4096)
                .ok_or("Invalid maxLines")? as usize
        };
        let ellipsis = match v["overflow"].as_str() {
            None | Some("clip") => false,
            Some("ellipsis") => true,
            _ => return Err("Invalid overflow".into()),
        };
        let key = format!("{sid}:{width}:{max_lines}:{ellipsis}");
        if let Some((id, l)) = self.layouts.find(&key) {
            return Ok(layout_info(id, &l));
        }
        let instance = self.instances[&shape.font].clone();
        let mut lines: Vec<(usize, usize)> = vec![];
        let mut start = 0;
        let n = shape.clusters.len();
        while start < n {
            let mut end = start;
            let mut w = 0.0;
            let mut last_break = None;
            while end < n {
                let c = &shape.clusters[end];
                if c.hard {
                    break;
                }
                if end > start && w + c.width > width {
                    if let Some(b) = last_break {
                        end = b;
                    }
                    break;
                }
                w += c.width;
                end += 1;
                if c.break_after {
                    last_break = Some(end)
                }
                if w > width {
                    break;
                }
            }
            lines.push((start, end));
            start = if end < n && shape.clusters[end].hard {
                end + 1
            } else {
                end
            };
            if start == end && end == n {
                break;
            }
            if lines.len() > 4096 {
                return Err("Layout row budget exceeded".into());
            }
        }
        if lines.is_empty() || shape.clusters.last().is_some_and(|c| c.hard) {
            lines.push((n, n));
        }
        let truncated = lines.len() > max_lines;
        lines.truncate(max_lines);
        let mut glyphs = vec![];
        let mut rows = vec![];
        let mut carets = vec![];
        let mut max_width: f32 = 0.0;
        let ellipsis_cluster = if truncated && ellipsis {
            let (_, s) = self.shape(shape.font, "…")?;
            if s.missing > 0 {
                return Err("Explicit fonts do not cover ellipsis".into());
            }
            Some(s)
        } else {
            None
        };
        for (row, (a, b)) in lines.iter().copied().enumerate() {
            let mut end = b;
            let extra = if row + 1 == lines.len() {
                ellipsis_cluster
                    .as_ref()
                    .map(|s| s.clusters.iter().map(|c| c.width).sum::<f32>())
                    .unwrap_or(0.0)
            } else {
                0.0
            };
            if extra > width {
                end = a;
            }
            let extra = if extra > width { 0.0 } else { extra };
            let mut line_width = shape.clusters[a..end].iter().map(|c| c.width).sum::<f32>();
            while extra > 0.0 && end > a && line_width + extra > width {
                end -= 1;
                line_width -= shape.clusters[end].width;
            }
            let from = shape.clusters.get(a).map_or(shape.units, |c| c.from);
            let to = if end > a {
                shape.clusters[end - 1].to
            } else {
                from
            };
            let top = round(row as f32 * instance.line_height);
            let baseline = round(top + instance.ascent);
            let levels: Vec<Level> = shape.clusters[a..end]
                .iter()
                .map(|c| Level::new(c.level).unwrap())
                .collect();
            let order = BidiInfo::reorder_visual(&levels);
            let mut x = 0.0;
            for i in order {
                let c = &shape.clusters[a + i];
                let mut gx = x;
                for g in &c.glyphs {
                    glyphs.push((
                        g.id,
                        round(gx + g.x),
                        round(baseline + g.y),
                        g.advance,
                        c.from,
                        c.to,
                        row,
                    ));
                    gx += g.advance;
                }
                let stops = if c.stops.len() >= 2 {
                    c.stops.clone()
                } else {
                    vec![c.from, c.to]
                };
                for (i, offset) in stops.iter().enumerate() {
                    let t = i as f32 / (stops.len() - 1) as f32;
                    let cx = if c.level % 2 == 1 {
                        x + c.width * (1.0 - t)
                    } else {
                        x + c.width * t
                    };
                    carets.push((*offset, round(cx), top, row));
                }
                x += c.width;
            }
            if end == a {
                carets.push((from, 0.0, top, row));
            }
            if extra > 0.0 {
                if let Some(s) = &ellipsis_cluster {
                    for c in &s.clusters {
                        for g in &c.glyphs {
                            glyphs.push((
                                g.id,
                                round(x + g.x),
                                round(baseline + g.y),
                                g.advance,
                                to,
                                to,
                                row,
                            ));
                            x += g.advance;
                        }
                    }
                }
            }
            rows.push((from, to, round(x), baseline));
            max_width = max_width.max(x);
        }
        carets.sort_by(|a, b| a.3.cmp(&b.3).then(a.0.cmp(&b.0)).then(a.1.total_cmp(&b.1)));
        carets.dedup();
        let height = round(rows.len() as f32 * instance.line_height);
        let bytes = std::mem::size_of::<Layout>()
            + 128
            + key.capacity()
            + glyphs.capacity() * std::mem::size_of::<LayoutGlyph>()
            + rows.capacity() * std::mem::size_of::<LayoutRow>()
            + carets.capacity() * std::mem::size_of::<Caret>();
        let value = Layout {
            shape: sid,
            glyphs,
            rows,
            carets,
            width: round(max_width),
            height,
            baseline: instance.ascent,
            truncated,
        };
        let id = self.layouts.insert(key, value, bytes)?;
        self.layout_count += 1;
        Ok(layout_info(id, &self.layouts.get(id).unwrap()))
    }
    fn page(&mut self, v: &Value) -> Result<Value, String> {
        let l = self.layouts.get(id(v, "layout")?).ok_or("Layout evicted")?;
        let offset = page_offset(v)?;
        match v["kind"].as_str() {
            Some("glyphs") => page(&l.glyphs, offset, 16),
            Some("rows") => page(&l.rows, offset, 24),
            Some("carets") => page(&l.carets, offset, 24),
            _ => Err("Invalid layout page kind".into()),
        }
    }
    fn glyph(&mut self, v: &Value) -> Result<Value, String> {
        if self.bitmaps.budget < std::mem::size_of::<Bitmap>() + 128 {
            return Err("Cache budget exceeded".into());
        }
        let glyph = id(v, "glyph")?;
        let key = *self
            .glyph_keys
            .get(glyph.checked_sub(1).ok_or("Invalid glyph")? as usize)
            .ok_or("Glyph unavailable")?;
        let cache_key = glyph.to_string();
        let bitmap = if let Some((_, b)) = self.bitmaps.find(&cache_key) {
            b
        } else {
            let handle = self.fonts[key.face].handle;
            let mut info = [0i32; 5];
            let status =
                unsafe { pocket_ft_render(handle, key.size64, key.glyph, info.as_mut_ptr()) };
            if status != 0 {
                return Err(format!("FreeType rasterization failed: {status}"));
            }
            let [width, height, left, top, length] = info;
            if width < 0
                || height < 0
                || length < 0
                || width as i64 * height as i64 != length as i64
                || length > 65536
                || width > 512
                || height > 512
            {
                return Err("Glyph bitmap budget exceeded".into());
            }
            let cost = length as usize + std::mem::size_of::<Bitmap>() + cache_key.capacity() + 128;
            self.bitmaps.reserve(cost)?;
            let mut bytes = vec![0; length as usize];
            if unsafe { pocket_ft_copy(handle, bytes.as_mut_ptr(), bytes.len() as u32) } != length {
                return Err("FreeType bitmap copy failed".into());
            }
            let b = Bitmap {
                width,
                height,
                left,
                top,
                bytes,
            };
            let id = self.bitmaps.insert(cache_key, b, cost)?;
            self.rasterizations += 1;
            self.bitmaps.get(id).unwrap()
        };
        let offset = page_offset(v)?;
        if offset > bitmap.bytes.len() {
            return Err("Invalid bitmap offset".into());
        }
        let end = (offset + 1024).min(bitmap.bytes.len());
        Ok(
            json!({"glyph":glyph,"width":bitmap.width,"height":bitmap.height,"left":bitmap.left,"top":bitmap.top,"offset":offset,"next":if end<bitmap.bytes.len(){Some(end)}else{None},"total":bitmap.bytes.len(),"coverage":base64::engine::general_purpose::STANDARD.encode(&bitmap.bytes[offset..end])}),
        )
    }
}
fn strong_script(text: &str) -> Option<Script> {
    text.chars()
        .map(|c| c.script())
        .find(|s| !matches!(s, Script::Common | Script::Inherited | Script::Unknown))
}
fn choose_face(fonts: &[Font], instance: &Instance, text: &str) -> usize {
    instance
        .faces
        .iter()
        .copied()
        .find(|i| {
            let face = Face::parse(&fonts[*i].data, 0).unwrap();
            text.chars()
                .filter(|c| !matches!(*c, '\u{200d}' | '\u{200c}' | '\u{fe0f}' | '\u{fe0e}'))
                .all(|c| face.glyph_index(c).is_some())
        })
        .unwrap_or(instance.faces[0])
}
fn is_cjk(c: char) -> bool {
    matches!(c as u32,0x2e80..=0x9fff|0xac00..=0xd7af|0xf900..=0xfaff|0x20000..=0x3134f)
}
fn round(n: f32) -> f32 {
    (n * 64.0).round() / 64.0
}
fn page_offset(v: &Value) -> Result<usize, String> {
    if v["offset"].is_null() {
        return Ok(0);
    }
    v["offset"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| "Invalid page offset".into())
}
fn id(v: &Value, key: &str) -> Result<u32, String> {
    v[key]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn layout_info(id: u32, l: &Layout) -> Value {
    json!({"layout":id,"width":l.width,"height":l.height,"baseline":l.baseline,"glyphs":l.glyphs.len(),"rows":l.rows.len(),"carets":l.carets.len(),"truncated":l.truncated})
}
fn page<T: serde::Serialize>(items: &[T], offset: usize, limit: usize) -> Result<Value, String> {
    if offset > items.len() {
        return Err("Invalid page offset".into());
    }
    let end = (offset + limit).min(items.len());
    Ok(
        json!({"items":&items[offset..end],"next":if end<items.len(){Some(end)}else{None},"total":items.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> RuntimeText {
        let mut s = RuntimeText::default();
        assert!(s.load_font(include_bytes!("../../../../assets/fonts/Inter-Regular.ttf")));
        assert!(s.load_font(include_bytes!(
            "../../../../assets/fonts/JetBrainsMono-Regular.ttf"
        )));
        s
    }
    fn font(s: &mut RuntimeText, size: u32) -> u32 {
        s.dispatch(
            "runtime.font",
            &json!({"family":"Inter","size":size,"fallback":[]}),
        )
        .unwrap()["font"]
            .as_u64()
            .unwrap() as u32
    }
    fn layout(s: &mut RuntimeText, font: u32, text: &str, width: f32) -> (u32, Arc<Layout>) {
        let (shape, _) = s.shape(font, text).unwrap();
        let v = s.layout(&json!({"shape":shape,"width":width})).unwrap();
        let id = v["layout"].as_u64().unwrap() as u32;
        (id, s.layouts.get(id).unwrap())
    }
    #[test]
    fn full_face_names_distinguish_styles_and_conflicting_sources_are_rejected() {
        let mut s = service();
        assert!(s.load_font(include_bytes!("../../../../assets/fonts/Inter-Bold.ttf")));
        let faces: Vec<String> = s
            .fonts
            .iter()
            .filter(|f| f.family == "Inter")
            .map(|f| f.name.clone())
            .collect();
        assert_eq!(faces.len(), 2);
        assert_ne!(faces[0], faces[1]);
        let a = s
            .font(&json!({"family":faces[0],"size":24,"fallback":[]}))
            .unwrap();
        let b = s
            .font(&json!({"family":faces[1],"size":24,"fallback":[]}))
            .unwrap();
        assert_ne!(a["font"], b["font"]);
        if !faces.iter().any(|n| n == "Inter") {
            assert!(s
                .font(&json!({"family":"Inter","size":24,"fallback":[]}))
                .unwrap_err()
                .contains("Ambiguous"));
        }
        let page = s.font_page(&json!({})).unwrap();
        for face in faces {
            assert!(page["families"].as_array().unwrap().contains(&json!(face)));
        }
        let mut altered = include_bytes!("../../../../assets/fonts/Inter-Regular.ttf").to_vec();
        let last = altered.len() - 1;
        altered[last] ^= 1;
        let before = s.font_bytes;
        assert!(!s.load_font(&altered));
        assert_eq!(s.font_bytes, before);
    }
    #[test]
    fn runtime_font_is_static_explicit_and_sized() {
        let mut s = service();
        assert!(!s.load_font(include_bytes!("../../../../assets/fonts/W95FA.otf")));
        assert!(s
            .dispatch("runtime.font", &json!({"family":"Inter","size":16}))
            .is_err());
        assert!(s
            .dispatch(
                "runtime.font",
                &json!({"family":"Inter","size":16,"fallback":["not installed"]})
            )
            .is_err());
        let small = font(&mut s, 16);
        let large = font(&mut s, 32);
        assert_ne!(small, large);
        assert_eq!(small, font(&mut s, 16));
        let (_, a) = layout(&mut s, small, "AV", 400.0);
        let (_, b) = layout(&mut s, large, "AV", 400.0);
        assert!((b.width - a.width * 2.0).abs() < 0.1);
    }
    #[test]
    fn nonmono_kerning_ligatures_and_grapheme_carets_share_layout() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (_, i) = layout(&mut s, f, "iii", 800.0);
        let (_, w) = layout(&mut s, f, "WWW", 800.0);
        assert!(w.width > i.width * 2.0);
        let (_, av) = layout(&mut s, f, "AV", 800.0);
        let (_, a) = layout(&mut s, f, "A", 800.0);
        let (_, v) = layout(&mut s, f, "V", 800.0);
        assert!(av.width < a.width + v.width);
        assert!(s.load_font(include_bytes!(
            "../../../../tests/fixtures/runtime-font/NotoSans-Ligature.ttf"
        )));
        let jf = s
            .font(&json!({"family":"Pocket Ligature Test","size":24,"fallback":[]}))
            .unwrap()["font"]
            .as_u64()
            .unwrap() as u32;
        let (_, office) = s.shape(jf, "office").unwrap();
        assert!(
            office.clusters.iter().any(|c| c.to - c.from > 1),
            "font must exercise ligature shaping"
        );
        let (_, combined) = layout(&mut s, f, "e\u{301}x", 800.0);
        assert!(combined.carets.iter().any(|c| c.0 == 0));
        assert!(!combined.carets.iter().any(|c| c.0 == 1));
        assert!(combined.carets.iter().any(|c| c.0 == 2));
        let (_, ligature) = layout(&mut s, jf, "office", 800.0);
        for offset in 0..=6 {
            assert!(ligature.carets.iter().any(|c| c.0 == offset));
        }
        for row in &ligature.rows {
            assert_eq!(row.2, ligature.width)
        }
    }
    #[test]
    fn explicit_fallback_shapes_actual_glyphs() {
        let mut s = service();
        assert!(s.load_font(include_bytes!(
            "../../../../tests/fixtures/runtime-font/NotoSansSC-Test.ttf"
        )));
        let f = font(&mut s, 24);
        let (_, missing) = s.shape(f, "A中文").unwrap();
        assert!(missing.missing > 0);
        let v = s
            .dispatch(
                "runtime.font",
                &json!({"family":"Inter","size":24,"fallback":["Pocket CJK Test"]}),
            )
            .unwrap();
        let f = v["font"].as_u64().unwrap() as u32;
        let (_, shaped) = s.shape(f, "A中文").unwrap();
        assert_eq!(shaped.missing, 0);
        let faces: Vec<_> = shaped
            .clusters
            .iter()
            .flat_map(|c| &c.glyphs)
            .map(|g| s.glyph_keys[g.id as usize - 1].face)
            .collect();
        assert_ne!(faces[0], faces[1]);
        assert_eq!(faces[1], faces[2]);
    }
    #[test]
    fn resizing_reuses_shape_and_bitmap_eviction_preserves_positions_and_ids() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (sid, _) = s.shape(f, "AV office e\u{301} words").unwrap();
        let a = s.layout(&json!({"shape":sid,"width":300})).unwrap();
        let first = s.layouts.get(a["layout"].as_u64().unwrap() as u32).unwrap();
        let positions = first.glyphs.clone();
        let id = positions[0].0;
        s.glyph(&json!({"glyph":id})).unwrap();
        assert!(s.bitmaps.bytes > 0);
        s.dispatch("runtime.budget", &json!({"bitmap":0})).unwrap();
        assert_eq!(first.glyphs, positions);
        assert_eq!(s.shapes.entries.len(), 1);
        s.dispatch("runtime.budget", &json!({"bitmap":2*1024*1024}))
            .unwrap();
        s.glyph(&json!({"glyph":id})).unwrap();
        assert_eq!(first.glyphs, positions);
        s.layout(&json!({"shape":sid,"width":70})).unwrap();
        assert_eq!(s.shape_count, 1);
        assert_eq!(s.layout_count, 2);
        assert_eq!(s.rasterizations, 2);
        assert_eq!(s.shape(f, "AV office e\u{301} words").unwrap().0, sid);
    }
    #[test]
    fn leases_and_independent_budgets_fail_without_invalidating_layout() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (lid, l) = layout(&mut s, f, "hello world", 300.0);
        s.dispatch("runtime.lease", &json!({"layout":lid,"action":"pin"}))
            .unwrap();
        let before = s.layouts.budget;
        assert!(s
            .dispatch("runtime.budget", &json!({"layout":0,"shaping":0}))
            .is_err());
        assert_eq!(s.layouts.budget, before);
        assert_eq!(l.glyphs, s.layouts.get(lid).unwrap().glyphs);
        s.dispatch("runtime.lease", &json!({"layout":lid,"action":"release"}))
            .unwrap();
        s.dispatch(
            "runtime.budget",
            &json!({"layout":0,"shaping":0,"bitmap":0}),
        )
        .unwrap();
        assert!(s.layouts.get(lid).is_none());
        assert!(s.shape(f, "x").is_err());
        assert_eq!(s.bitmaps.bytes, 0);
    }
    #[test]
    fn truncation_pages_and_gray8_large_raster_are_bounded() {
        let mut s = service();
        let f = font(&mut s, 256);
        let (sid, _) = s.shape(f, "WWW WWW WWW").unwrap();
        let info = s
            .layout(&json!({"shape":sid,"width":500,"maxLines":1,"overflow":"ellipsis"}))
            .unwrap();
        assert_eq!(info["truncated"], true);
        let lid = info["layout"].as_u64().unwrap() as u32;
        let l = s.layouts.get(lid).unwrap();
        assert!(l.width <= 500.0);
        assert_eq!(l.rows.len(), 1);
        let glyph = l.glyphs[0].0;
        let mut offset = 0;
        let mut pixels = vec![];
        loop {
            let page = s.glyph(&json!({"glyph":glyph,"offset":offset})).unwrap();
            let data = base64::engine::general_purpose::STANDARD
                .decode(page["coverage"].as_str().unwrap())
                .unwrap();
            assert!(data.len() <= 1024);
            pixels.extend(data);
            if page["next"].is_null() {
                assert_eq!(pixels.len(), page["total"].as_u64().unwrap() as usize);
                break;
            }
            offset = page["next"].as_u64().unwrap();
        }
        assert!(pixels.iter().any(|n| *n > 0 && *n < 255));
        assert_eq!(s.rasterizations, 1);
    }
    #[test]
    fn glyph_batch_is_record_bounded_and_carries_actual_ids() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (_, l) = layout(&mut s, f, "abcdefghijklmnop", 600.0);
        let ids: Vec<u32> = l.glyphs.iter().map(|g| g.0).collect();
        let mut offset = 0;
        let mut seen = vec![];
        loop {
            let page = s
                .dispatch(
                    "runtime.glyph.batch",
                    &json!({"glyphs":ids,"offset":offset}),
                )
                .unwrap();
            assert!(page.to_string().len() <= 2400);
            let items = page["items"].as_array().unwrap();
            assert!(!items.is_empty());
            seen.extend(items.iter().map(|i| i["glyph"].as_u64().unwrap() as u32));
            if page["next"].is_null() {
                break;
            }
            offset = page["next"].as_u64().unwrap();
        }
        assert_eq!(seen, ids);
    }
    #[test]
    fn budget_admission_preserves_pinned_entries_and_independent_metadata() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (lid, l) = layout(&mut s, f, "cached", 600.0);
        s.dispatch("runtime.lease", &json!({"layout":lid,"action":"pin"}))
            .unwrap();
        let used = s.shapes.bytes;
        s.dispatch("runtime.budget", &json!({"shaping":used}))
            .unwrap();
        assert!(s.shape(f, "another entry").is_err());
        assert_eq!(s.shapes.bytes, used);
        assert!(s.shapes.get(l.shape).is_some());
        assert_eq!(s.layouts.get(lid).unwrap().glyphs, l.glyphs);
        let gid = l.glyphs[0].0;
        s.dispatch("runtime.budget", &json!({"bitmap":0})).unwrap();
        assert!(s.glyph(&json!({"glyph":gid})).is_err());
        assert_eq!(s.bitmaps.bytes, 0);
    }
    #[test]
    fn atomic_prepare_is_idempotent_and_cancellable_by_key() {
        let mut s = service();
        let f = font(&mut s, 24);
        let request = json!({"font":f,"text":"AV office","width":300,"leaseKey":"edit-1"});
        let first = s.dispatch("runtime.prepare", &request).unwrap();
        assert!(first["inline"].is_object());
        assert!(first.to_string().len() <= 2400);
        assert_eq!(s.dispatch("runtime.prepare", &request).unwrap(), first);
        let lid = first["layout"].as_u64().unwrap() as u32;
        assert_eq!(s.layouts.entries[&lid].pins, 1);
        assert!(s
            .dispatch("runtime.lease", &json!({"layout":lid,"action":"release"}))
            .is_err());
        assert!(s.dispatch("runtime.budget", &json!({"layout":0})).is_err());
        assert_eq!(
            s.dispatch("runtime.release", &json!({"key":"edit-1"}))
                .unwrap()["released"],
            true
        );
        assert_eq!(
            s.dispatch("runtime.release", &json!({"key":"edit-1"}))
                .unwrap()["released"],
            false
        );
        assert_eq!(s.layouts.entries[&lid].pins, 0);
        let mut request = request;
        request["text"] = json!("汉");
        assert!(s.dispatch("runtime.prepare", &request).is_err());
        assert!(s.leases.is_empty());
    }
    #[test]
    fn prepare_releases_previous_edit_before_budget_admission() {
        let mut s = service();
        let f = font(&mut s, 24);
        s.dispatch(
            "runtime.prepare",
            &json!({"font":f,"text":"a","width":300,"leaseKey":"old"}),
        )
        .unwrap();
        let budget = s.shapes.bytes;
        s.dispatch("runtime.budget", &json!({"shaping":budget}))
            .unwrap();
        assert!(s
            .dispatch(
                "runtime.prepare",
                &json!({"font":f,"text":"b","width":300,"leaseKey":"new"})
            )
            .is_err());
        s.dispatch(
            "runtime.prepare",
            &json!({"font":f,"text":"b","width":300,"leaseKey":"new","releases":["old"]}),
        )
        .unwrap();
        assert!(!s.leases.contains_key("old"));
        assert!(s.leases.contains_key("new"));
    }
    #[test]
    fn oversized_outline_is_rejected_before_coverage_allocation() {
        let mut bytes = include_bytes!("../../../../assets/fonts/Inter-Regular.ttf").to_vec();
        let face = Face::parse(&bytes, 0).unwrap();
        let head = face
            .raw_face()
            .table(ttf_parser::Tag::from_bytes(b"head"))
            .unwrap();
        let offset = head.as_ptr() as usize - bytes.as_ptr() as usize;
        // A tiny em square makes this otherwise resident outline far larger
        // than the allowed bitmap. Raster preflight must reject it.
        bytes[offset + 18..offset + 20].copy_from_slice(&16u16.to_be_bytes());
        let mut s = RuntimeText::default();
        assert!(s.load_font(&bytes));
        let f = font(&mut s, 256);
        let (_, shape) = s.shape(f, "W").unwrap();
        let glyph = shape.clusters[0].glyphs[0].id;
        assert!(s.glyph(&json!({"glyph":glyph})).unwrap_err().contains("-3"));
        assert_eq!(s.bitmaps.bytes, 0);
        assert_eq!(s.rasterizations, 0);
    }
    #[test]
    fn ellipsis_too_wide_has_no_glyph_and_keeps_a_caret() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (sid, _) = s.shape(f, "abc").unwrap();
        let info = s
            .layout(&json!({"shape":sid,"width":1,"maxLines":1,"overflow":"ellipsis"}))
            .unwrap();
        let l = s
            .layouts
            .get(info["layout"].as_u64().unwrap() as u32)
            .unwrap();
        assert!(l.truncated);
        assert_eq!(l.width, 0.0);
        assert!(l.glyphs.is_empty());
        assert_eq!(l.carets, vec![(0, 0.0, 0.0, 0)]);
    }
    #[test]
    fn bidi_clusters_reorder_glyphs_without_losing_logical_carets() {
        let mut s = service();
        let f = font(&mut s, 24);
        // .notdef remains a shaped glyph in the service. Font admission at prepare
        // rejects missing coverage; this checks bidi geometry before that decision.
        let (_, l) = layout(&mut s, f, "AאבB", 500.0);
        assert_eq!(
            l.glyphs.iter().map(|g| g.4).collect::<Vec<_>>(),
            vec![0, 2, 1, 3]
        );
        for offset in 0..=4 {
            assert!(l.carets.iter().any(|c| c.0 == offset));
        }
        let middle = l.carets.iter().find(|c| c.0 == 2).unwrap();
        let rtl_left = l.glyphs.iter().find(|g| g.4 == 2).unwrap();
        assert_eq!(middle.1, round(rtl_left.1 + rtl_left.3));
    }
    #[test]
    fn newlines_empty_lines_and_oversize_clusters_keep_edit_positions() {
        let mut s = service();
        let f = font(&mut s, 24);
        let (_, l) = layout(&mut s, f, "\nA\n\n", 1.0);
        assert_eq!(l.rows.len(), 4);
        assert_eq!(l.glyphs.len(), 1);
        assert!(l.carets.iter().any(|c| c.0 == 4));
        assert!(l.glyphs[0].3 > 1.0);
    }
}
