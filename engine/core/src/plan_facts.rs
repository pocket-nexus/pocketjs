//! The facts a generic native runtime reads from a variant's ResolvedBuildPlan
//! (`.pocket` section 2) when it boots: the primary viewport and its raster
//! density, the auxiliary surface, and named feature flags.
//!
//! A runtime built for one game has these compiled in from the plan the build
//! tool resolved. A runtime built once for every game of a target reads them
//! here instead, from the plan inside the package it loads. The plan is
//! canonical JSON (`framework/src/manifest/plan.ts` `canonicalJson`); this
//! reader accepts any well-formed JSON and looks up only the paths it needs:
//!
//!   viewport.logical              [width, height]
//!   viewport.rasterDensity        integer 1..255
//!   surfaces.auxiliary.logical    [width, height]   (absent: no auxiliary)
//!   surfaces.auxiliary.rasterDensity
//!   features.<name>               boolean (absent: false)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanFactsError {
    /// The plan is not one well-formed JSON object.
    Malformed,
    /// `viewport.logical` / `viewport.rasterDensity` is missing or out of range.
    Viewport,
    /// `surfaces.auxiliary` is present but its viewport or density is not.
    Auxiliary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanSurface {
    pub width: u32,
    pub height: u32,
    pub raster_density: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct PlanFacts<'a> {
    pub viewport: PlanSurface,
    pub auxiliary: Option<PlanSurface>,
    plan: &'a [u8],
    features: Option<usize>,
}

impl<'a> PlanFacts<'a> {
    /// `features.<name>`: true only when the plan says `true`.
    pub fn feature(&self, name: &str) -> bool {
        let Some(start) = self.features else {
            return false;
        };
        let mut reader = Reader { bytes: self.plan, at: start };
        matches!(reader.member(name.as_bytes()), Ok(Some((value, _))) if self.plan[value..].starts_with(b"true"))
    }
}

/// Read the plan's viewport, auxiliary surface and feature table.
pub fn plan_facts(plan: &[u8]) -> Result<PlanFacts<'_>, PlanFactsError> {
    let mut reader = Reader { bytes: plan, at: 0 };
    reader.whitespace();
    let root = reader.at;
    let end = reader.value().map_err(|_| PlanFactsError::Malformed)?;
    reader.at = end;
    reader.whitespace();
    if reader.at != plan.len() || plan.get(root) != Some(&b'{') {
        return Err(PlanFactsError::Malformed);
    }

    let viewport = find(plan, root, &[b"viewport"])
        .and_then(|start| surface(plan, start))
        .ok_or(PlanFactsError::Viewport)?;
    let auxiliary = match find(plan, root, &[b"surfaces", b"auxiliary"]) {
        None => None,
        Some(start) => Some(surface(plan, start).ok_or(PlanFactsError::Auxiliary)?),
    };
    let features = find(plan, root, &[b"features"]).filter(|&start| plan[start] == b'{');
    Ok(PlanFacts { viewport, auxiliary, plan, features })
}

fn find(plan: &[u8], mut object: usize, path: &[&[u8]]) -> Option<usize> {
    for key in path {
        if plan.get(object) != Some(&b'{') {
            return None;
        }
        let mut reader = Reader { bytes: plan, at: object };
        object = reader.member(key).ok()??.0;
    }
    Some(object)
}

fn surface(plan: &[u8], object: usize) -> Option<PlanSurface> {
    let logical = find(plan, object, &[b"logical"])?;
    let density = find(plan, object, &[b"rasterDensity"])?;
    let mut reader = Reader { bytes: plan, at: logical };
    let (width, height) = reader.pair()?;
    let mut reader = Reader { bytes: plan, at: density };
    let raster_density = reader.unsigned()?;
    let valid = (1..=4096).contains(&width) && (1..=4096).contains(&height) && (1..=255).contains(&raster_density);
    valid.then_some(PlanSurface { width, height, raster_density })
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

/// Nesting deeper than this is refused rather than recursed into.
const MAX_DEPTH: usize = 64;

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), ()> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(())
        }
    }

    /// Skip one value starting at `self.at`; returns the offset after it.
    fn value(&mut self) -> Result<usize, ()> {
        self.value_at_depth(0)?;
        Ok(self.at)
    }

    fn value_at_depth(&mut self, depth: usize) -> Result<(), ()> {
        if depth > MAX_DEPTH {
            return Err(());
        }
        match self.peek().ok_or(())? {
            b'{' => {
                self.at += 1;
                self.whitespace();
                if self.peek() == Some(b'}') {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.whitespace();
                    self.string()?;
                    self.whitespace();
                    self.expect(b':')?;
                    self.whitespace();
                    self.value_at_depth(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(());
                        }
                        _ => return Err(()),
                    }
                }
            }
            b'[' => {
                self.at += 1;
                self.whitespace();
                if self.peek() == Some(b']') {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.whitespace();
                    self.value_at_depth(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(());
                        }
                        _ => return Err(()),
                    }
                }
            }
            b'"' => self.string().map(|_| ()),
            b't' => self.literal(b"true"),
            b'f' => self.literal(b"false"),
            b'n' => self.literal(b"null"),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(()),
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), ()> {
        if self.bytes[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(())
        } else {
            Err(())
        }
    }

    fn number(&mut self) -> Result<(), ()> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let digits = |reader: &mut Self| {
            let from = reader.at;
            while matches!(reader.peek(), Some(b'0'..=b'9')) {
                reader.at += 1;
            }
            reader.at > from
        };
        if !digits(self) {
            return Err(());
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if !digits(self) {
                return Err(());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !digits(self) {
                return Err(());
            }
        }
        if self.at == start {
            Err(())
        } else {
            Ok(())
        }
    }

    /// Skip a string; returns the raw bytes between its quotes.
    fn string(&mut self) -> Result<(usize, usize), ()> {
        self.expect(b'"')?;
        let start = self.at;
        loop {
            match self.peek().ok_or(())? {
                b'"' => {
                    let end = self.at;
                    self.at += 1;
                    return Ok((start, end));
                }
                b'\\' => {
                    self.at += 1;
                    match self.peek().ok_or(())? {
                        b'u' => {
                            let hex = self.bytes.get(self.at + 1..self.at + 5).ok_or(())?;
                            if !hex.iter().all(u8::is_ascii_hexdigit) {
                                return Err(());
                            }
                            self.at += 5;
                        }
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => self.at += 1,
                        _ => return Err(()),
                    }
                }
                0..=0x1f => return Err(()),
                _ => self.at += 1,
            }
        }
    }

    /// In the object at `self.at`, the value of member `key` (compared on its
    /// raw, unescaped bytes) as `(value start, value end)`.
    fn member(&mut self, key: &[u8]) -> Result<Option<(usize, usize)>, ()> {
        self.expect(b'{')?;
        self.whitespace();
        if self.peek() == Some(b'}') {
            return Ok(None);
        }
        loop {
            self.whitespace();
            let (start, end) = self.string()?;
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();
            let value = self.at;
            self.value_at_depth(1)?;
            if &self.bytes[start..end] == key {
                return Ok(Some((value, self.at)));
            }
            self.whitespace();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => return Ok(None),
                _ => return Err(()),
            }
        }
    }

    fn unsigned(&mut self) -> Option<u32> {
        let start = self.at;
        let mut value: u32 = 0;
        while let Some(digit @ b'0'..=b'9') = self.peek() {
            value = value.checked_mul(10)?.checked_add((digit - b'0') as u32)?;
            self.at += 1;
        }
        // A fraction or exponent is not an integer viewport.
        if self.at == start || matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return None;
        }
        Some(value)
    }

    fn pair(&mut self) -> Option<(u32, u32)> {
        self.expect(b'[').ok()?;
        self.whitespace();
        let first = self.unsigned()?;
        self.whitespace();
        self.expect(b',').ok()?;
        self.whitespace();
        let second = self.unsigned()?;
        self.whitespace();
        self.expect(b']').ok()?;
        Some((first, second))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUAL: &str = r#"{"app":{"entry":"main.tsx","framework":"solid","id":"dev.pocket-nexus.studio.twenty48","output":"twenty48","title":"Twenty48","version":"0.1.0"},"companions":[],"features":{"display.auxiliary":true,"input.buttons":true,"input.touch":false,"input.touch.auxiliary":true,"text.glyphs.baked":true},"modality":{"analog":2,"buttons":true,"form":"takeover","glyphs":"letters","pointer":"cursor","screens":[{"logical":[400,240],"orientation":"landscape","resizable":false,"role":"primary","touch":false},{"logical":[320,240],"orientation":"landscape","resizable":false,"role":"auxiliary","touch":true}],"text":"osk","touch":"auxiliary"},"planHash":"sha256:dbf475cf30590c7cd7f6294c80b6a739be68969efa096cfe51a9c806f02dd128","presentation":{"entry":"main.tsx","id":"dual-screen"},"surfaces":{"auxiliary":{"logical":[320,240],"physical":[320,240],"presentation":"native","rasterDensity":1}},"target":{"hostAbi":11,"id":"3ds-dev"},"viewport":{"logical":[400,240],"physical":[400,240],"policy":"fixed","presentation":"native","rasterDensity":1}}"#;

    #[test]
    fn reads_the_dual_screen_plan() {
        let facts = plan_facts(DUAL.as_bytes()).unwrap();
        assert_eq!(facts.viewport, PlanSurface { width: 400, height: 240, raster_density: 1 });
        assert_eq!(
            facts.auxiliary,
            Some(PlanSurface { width: 320, height: 240, raster_density: 1 })
        );
        assert!(facts.feature("input.buttons"));
        assert!(facts.feature("text.glyphs.baked"));
        assert!(!facts.feature("input.touch"));
        assert!(!facts.feature("io.offload"));
        assert!(!facts.feature("media.playback"));
    }

    #[test]
    fn reads_a_single_surface_plan_with_whitespace() {
        let plan = br#" { "features" : { "ui.physics" : true } ,
            "viewport" : { "rasterDensity" : 2 , "logical" : [ 320 , 480 ] } } "#;
        let facts = plan_facts(plan).unwrap();
        assert_eq!(facts.viewport, PlanSurface { width: 320, height: 480, raster_density: 2 });
        assert_eq!(facts.auxiliary, None);
        assert!(facts.feature("ui.physics"));
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert_eq!(plan_facts(b"").unwrap_err(), PlanFactsError::Malformed);
        assert_eq!(plan_facts(b"[]").unwrap_err(), PlanFactsError::Malformed);
        assert_eq!(plan_facts(b"{\"viewport\":{}").unwrap_err(), PlanFactsError::Malformed);
        assert_eq!(plan_facts(b"{} trailing").unwrap_err(), PlanFactsError::Malformed);
        assert_eq!(plan_facts(b"{}").unwrap_err(), PlanFactsError::Viewport);
        assert_eq!(
            plan_facts(br#"{"viewport":{"logical":[400.5,240],"rasterDensity":1}}"#).unwrap_err(),
            PlanFactsError::Viewport
        );
        assert_eq!(
            plan_facts(br#"{"viewport":{"logical":[400,240],"rasterDensity":0}}"#).unwrap_err(),
            PlanFactsError::Viewport
        );
        assert_eq!(
            plan_facts(br#"{"viewport":{"logical":[400,240],"rasterDensity":1},"surfaces":{"auxiliary":{"logical":[320]}}}"#)
                .unwrap_err(),
            PlanFactsError::Auxiliary
        );
        let mut deep = std::vec::Vec::new();
        deep.extend(std::iter::repeat_n(b'[', 100));
        deep.extend(std::iter::repeat_n(b']', 100));
        assert_eq!(plan_facts(&deep).unwrap_err(), PlanFactsError::Malformed);
    }

    #[test]
    fn a_nested_key_does_not_shadow_the_top_level_one() {
        let plan = br#"{"modality":{"viewport":{"logical":[1,1],"rasterDensity":9}},"viewport":{"logical":[400,240],"rasterDensity":1}}"#;
        assert_eq!(plan_facts(plan).unwrap().viewport.width, 400);
    }
}
