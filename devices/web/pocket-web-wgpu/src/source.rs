//! Ranges of a pack: every read of one goes through [`Source::range`].
//!
//! A pack is one file a runtime reads parts of: its tables at the start, then
//! a record when the eye comes near it. A source has two forms, chosen by what
//! its place names:
//!
//! - **The file itself.** In a tab each read is a request with a `Range`
//!   header, so the server must answer ranges (status 206). On the build
//!   machine it is a read of the file.
//! - **The file cut into pieces of one size**, each a file of its own, with a
//!   manifest that lists them (a place that ends in `.json`; [`Manifest`]).
//!   This is the form a host serves that limits the size of a file. A read
//!   fetches the pieces it lies in, whole and with plain requests, so the
//!   browser's own cache keeps them and the host needs no ranges. The last
//!   pieces read stay in memory, up to [`HELD`] bytes; two reads that need one
//!   piece at the same moment share one request.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// Bytes of pieces a source keeps in memory (outside the module's own memory, in a tab).
pub const HELD: u64 = 32 << 20;

/// What has been read so far.
#[derive(Clone, Copy, Debug, Default)]
pub struct Read {
    pub requests: u32,
    /// Bytes received: for a pack in pieces, the pieces fetched.
    pub bytes: u64,
}

/// A pack cut into pieces: a JSON object the tool that cuts it writes.
///
/// ```json
/// { "pack": "pocket-pack-pieces/1", "bytes": 177092176, "piece": 2097152, "sha256": "…",
///   "pieces": ["0f3a….bin", "77c1….bin"] }
/// ```
///
/// Every piece is `piece` bytes but the last, and their names are relative to the manifest's own place.
#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub bytes: u64,
    pub piece: u64,
    pub pieces: Vec<String>,
}

pub const MANIFEST: &str = "pocket-pack-pieces/1";

impl Manifest {
    /// Reads the members this kernel uses; the object is flat and its strings hold no escapes.
    pub fn parse(text: &str) -> Result<Manifest, String> {
        let after = |key: &str| text.split_once(&format!("\"{key}\"")).and_then(|(_, rest)| rest.trim_start().strip_prefix(':')).map(str::trim_start);
        let number = |key: &str| -> Result<u64, String> {
            let value = after(key).ok_or_else(|| format!("the manifest has no \"{key}\""))?;
            value[..value.find(|c: char| !c.is_ascii_digit()).unwrap_or(value.len())].parse().map_err(|_| format!("the manifest's \"{key}\" is not a number"))
        };
        if after("pack").and_then(|v| v.strip_prefix('"')).and_then(|v| v.split('"').next()) != Some(MANIFEST) {
            return Err(format!("the manifest is not a \"{MANIFEST}\""));
        }
        let list = after("pieces").and_then(|v| v.strip_prefix('[')).and_then(|v| v.split(']').next()).ok_or("the manifest has no \"pieces\"")?;
        let pieces: Vec<String> = list.split(',').map(|name| name.trim().trim_matches('"').to_string()).filter(|name| !name.is_empty()).collect();
        let manifest = Manifest { bytes: number("bytes")?, piece: number("piece")?, pieces };
        if manifest.piece == 0 || manifest.pieces.len() as u64 != manifest.bytes.div_ceil(manifest.piece) {
            return Err("the manifest's pieces do not make up its bytes".into());
        }
        Ok(manifest)
    }

    /// Bytes of piece `index`.
    pub fn size(&self, index: u64) -> u64 {
        (self.bytes - index * self.piece).min(self.piece)
    }

    /// The parts of the pieces a range lies in: each piece's index, and the bytes of it the range takes.
    pub fn parts(&self, offset: u64, size: u64) -> Result<Vec<(u64, std::ops::Range<usize>)>, String> {
        if offset + size > self.bytes {
            return Err(format!("a read of {size} bytes at {offset} runs past the pack's {}", self.bytes));
        }
        let mut parts = Vec::new();
        let mut at = offset;
        while at < offset + size {
            let index = at / self.piece;
            let to = (offset + size).min((index + 1) * self.piece);
            parts.push((index, (at - index * self.piece) as usize..(to - index * self.piece) as usize));
            at = to;
        }
        Ok(parts)
    }
}

/// A piece as it is held: in a tab an array of the page's (outside the module's memory), elsewhere bytes.
#[cfg(target_arch = "wasm32")]
type Piece = js_sys::Uint8Array;
#[cfg(not(target_arch = "wasm32"))]
type Piece = Rc<Vec<u8>>;

/// A piece that was asked for: in memory already, or on its way.
enum Coming {
    Here(Piece),
    #[cfg(target_arch = "wasm32")]
    Request(js_sys::Promise),
}

impl Coming {
    async fn arrive(self) -> Result<Piece, String> {
        match self {
            Coming::Here(piece) => Ok(piece),
            #[cfg(target_arch = "wasm32")]
            Coming::Request(promise) => {
                use wasm_bindgen::JsCast;
                let piece = wasm_bindgen_futures::JsFuture::from(promise).await.map_err(|e| e.as_string().unwrap_or_default())?;
                Ok(piece.unchecked_into())
            }
        }
    }
}

struct Pieces {
    manifest: Manifest,
    /// The pieces in memory, the one read last at the end.
    held: RefCell<Vec<(u64, Piece)>>,
    /// Requests under way, by piece: a second read of a piece waits for the first one's.
    #[cfg(target_arch = "wasm32")]
    coming: RefCell<Vec<(u64, js_sys::Promise)>>,
}

struct Inner {
    /// A URL in a tab, a path elsewhere: of the file, or of the manifest.
    place: String,
    pieces: Option<Pieces>,
    read: Cell<Read>,
}

#[derive(Clone)]
pub struct Source {
    inner: Rc<Inner>,
}

#[cfg(target_arch = "wasm32")]
mod tab {
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;

    pub fn said(place: &str, what: &str, e: JsValue) -> String {
        format!("{place}: {what}: {}", e.as_string().or_else(|| e.dyn_ref::<js_sys::Error>().and_then(|e| e.message().as_string())).unwrap_or_default())
    }

    /// The answer to a request for `place`, with a `Range` header when `range` gives the first and the last
    /// byte. (A tab's window, or a worker's scope.)
    pub async fn fetch(place: &str, range: Option<(u64, u64)>) -> Result<web_sys::Response, String> {
        let init = web_sys::RequestInit::new();
        if let Some((first, last)) = range {
            let headers = web_sys::Headers::new().map_err(|e| said(place, "headers", e))?;
            headers.set("Range", &format!("bytes={first}-{last}")).map_err(|e| said(place, "headers", e))?;
            init.set_headers(&headers);
        }
        let request = web_sys::Request::new_with_str_and_init(place, &init).map_err(|e| said(place, "request", e))?;
        let global = js_sys::global();
        let pending = match global.dyn_ref::<web_sys::Window>() {
            Some(window) => window.fetch_with_request(&request),
            None => global.unchecked_ref::<web_sys::WorkerGlobalScope>().fetch_with_request(&request),
        };
        Ok(JsFuture::from(pending).await.map_err(|e| said(place, "no answer", e))?.unchecked_into())
    }

    pub async fn body(place: &str, response: &web_sys::Response) -> Result<js_sys::Uint8Array, String> {
        let buffer = JsFuture::from(response.array_buffer().map_err(|e| said(place, "body", e))?).await.map_err(|e| said(place, "body", e))?;
        Ok(js_sys::Uint8Array::new(&buffer))
    }
}

impl Source {
    /// Opens a pack: the file at `place`, or, when `place` ends in `.json`, the pieces its manifest lists.
    pub async fn open(place: &str) -> Result<Source, String> {
        let mut inner = Inner { place: place.to_string(), pieces: None, read: Cell::new(Read::default()) };
        if place.split(['?', '#']).next().is_some_and(|path| path.ends_with(".json")) {
            #[cfg(target_arch = "wasm32")]
            let text = {
                let response = tab::fetch(place, None).await?;
                if !response.ok() {
                    return Err(format!("{place}: status {}", response.status()));
                }
                String::from_utf8(tab::body(place, &response).await?.to_vec()).map_err(|_| format!("{place}: not text"))?
            };
            #[cfg(not(target_arch = "wasm32"))]
            let text = std::fs::read_to_string(place).map_err(|e| format!("{place}: {e}"))?;
            let manifest = Manifest::parse(&text).map_err(|e| format!("{place}: {e}"))?;
            inner.pieces = Some(Pieces {
                manifest,
                held: RefCell::new(Vec::new()),
                #[cfg(target_arch = "wasm32")]
                coming: RefCell::new(Vec::new()),
            });
        }
        Ok(Source { inner: Rc::new(inner) })
    }

    pub fn place(&self) -> &str {
        &self.inner.place
    }

    /// The size of a piece, when the pack is in pieces.
    pub fn piece(&self) -> Option<u64> {
        self.inner.pieces.as_ref().map(|p| p.manifest.piece)
    }

    /// Requests made and bytes received since the start.
    pub fn read_so_far(&self) -> Read {
        self.inner.read.get()
    }

    /// `size` bytes from `offset`.
    pub async fn range(&self, offset: u64, size: u64) -> Result<Vec<u8>, String> {
        let Some(pieces) = &self.inner.pieces else { return self.inner.clone().whole(offset, size).await };
        let mut bytes = vec![0u8; size as usize];
        let mut at = 0;
        let parts = pieces.manifest.parts(offset, size)?;
        // Every piece the read needs is asked for before any is waited for: they come side by side.
        let coming = parts.iter().map(|(index, _)| self.inner.ask(*index)).collect::<Result<Vec<_>, _>>()?;
        for ((_, part), piece) in parts.iter().zip(coming) {
            let piece = piece.arrive().await?;
            let out = &mut bytes[at..at + part.len()];
            #[cfg(target_arch = "wasm32")]
            piece.subarray(part.start as u32, part.end as u32).copy_to(out);
            #[cfg(not(target_arch = "wasm32"))]
            out.copy_from_slice(&piece[part.clone()]);
            at += part.len();
        }
        Ok(bytes)
    }
}

impl Inner {
    fn count(&self, bytes: u64) {
        let was = self.read.get();
        self.read.set(Read { requests: was.requests + 1, bytes: was.bytes + bytes });
    }

    /// The place of a piece: beside the manifest.
    fn beside(&self, name: &str) -> String {
        let directory = self.place.rfind('/').map_or("", |slash| &self.place[..=slash]);
        format!("{directory}{name}")
    }

    /// A piece that was read is the one read last; the ones read longest ago go when `HELD` is full.
    fn hold(&self, index: u64, piece: &Piece) {
        let Some(pieces) = &self.pieces else { return };
        let mut held = pieces.held.borrow_mut();
        held.retain(|(i, _)| *i != index);
        held.push((index, piece.clone()));
        let room = (HELD / pieces.manifest.piece).max(1) as usize;
        if held.len() > room {
            let over = held.len() - room;
            held.drain(..over);
        }
    }

    fn held(&self, index: u64) -> Option<Piece> {
        let piece = self.pieces.as_ref()?.held.borrow().iter().find(|(i, _)| *i == index).map(|(_, p)| p.clone())?;
        self.hold(index, &piece);
        Some(piece)
    }

    /// A range of the file itself.
    #[cfg(not(target_arch = "wasm32"))]
    async fn whole(self: Rc<Self>, offset: u64, size: u64) -> Result<Vec<u8>, String> {
        use std::io::{Read as _, Seek, SeekFrom};
        let mut file = std::fs::File::open(&self.place).map_err(|e| format!("{}: {e}", self.place))?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| format!("{}: {e}", self.place))?;
        let mut bytes = vec![0u8; size as usize];
        file.read_exact(&mut bytes).map_err(|e| format!("{}: {e}", self.place))?;
        self.count(size);
        Ok(bytes)
    }

    /// Asks for a piece: the file is read here and now.
    #[cfg(not(target_arch = "wasm32"))]
    fn ask(self: &Rc<Self>, index: u64) -> Result<Coming, String> {
        if let Some(piece) = self.held(index) {
            return Ok(Coming::Here(piece));
        }
        let pieces = self.pieces.as_ref().ok_or("the pack is not in pieces")?;
        let place = self.beside(&pieces.manifest.pieces[index as usize]);
        let bytes = std::fs::read(&place).map_err(|e| format!("{place}: {e}"))?;
        if bytes.len() as u64 != pieces.manifest.size(index) {
            return Err(format!("{place}: {} bytes for a piece of {}", bytes.len(), pieces.manifest.size(index)));
        }
        self.count(bytes.len() as u64);
        let piece = Rc::new(bytes);
        self.hold(index, &piece);
        Ok(Coming::Here(piece))
    }

    /// A range of the file itself.
    #[cfg(target_arch = "wasm32")]
    async fn whole(self: Rc<Self>, offset: u64, size: u64) -> Result<Vec<u8>, String> {
        let response = tab::fetch(&self.place, Some((offset, offset + size - 1))).await?;
        // A server that sends the whole file for a range would have a tab download all of a pack for each read.
        if response.status() != 206 {
            return Err(format!("{}: status {} for a range (the server must answer byte ranges with 206)", self.place, response.status()));
        }
        let bytes = tab::body(&self.place, &response).await?.to_vec();
        if bytes.len() as u64 != size {
            return Err(format!("{}: {} bytes for a range of {size}", self.place, bytes.len()));
        }
        self.count(size);
        Ok(bytes)
    }

    /// Asks for a piece: its request starts now, unless the piece is in memory or a request for it is under way.
    #[cfg(target_arch = "wasm32")]
    fn ask(self: &Rc<Self>, index: u64) -> Result<Coming, String> {
        use wasm_bindgen::JsValue;
        if let Some(piece) = self.held(index) {
            return Ok(Coming::Here(piece));
        }
        let pieces = self.pieces.as_ref().ok_or("the pack is not in pieces")?;
        if let Some((_, promise)) = pieces.coming.borrow().iter().find(|(i, _)| *i == index) {
            return Ok(Coming::Request(promise.clone()));
        }
        let inner = self.clone();
        let promise = wasm_bindgen_futures::future_to_promise(async move {
            let fetched = inner.clone().fetch_piece(index).await;
            if let Some(pieces) = &inner.pieces {
                pieces.coming.borrow_mut().retain(|(i, _)| *i != index);
            }
            fetched.map(JsValue::from).map_err(|e| JsValue::from_str(&e))
        });
        pieces.coming.borrow_mut().push((index, promise.clone()));
        Ok(Coming::Request(promise))
    }

    #[cfg(target_arch = "wasm32")]
    async fn fetch_piece(self: Rc<Self>, index: u64) -> Result<Piece, String> {
        let pieces = self.pieces.as_ref().ok_or("the pack is not in pieces")?;
        let place = self.beside(&pieces.manifest.pieces[index as usize]);
        let response = tab::fetch(&place, None).await?;
        if !response.ok() {
            return Err(format!("{place}: status {}", response.status()));
        }
        let piece = tab::body(&place, &response).await?;
        if piece.length() as u64 != pieces.manifest.size(index) {
            return Err(format!("{place}: {} bytes for a piece of {}", piece.length(), pieces.manifest.size(index)));
        }
        self.count(piece.length() as u64);
        self.hold(index, &piece);
        Ok(piece)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest::parse(r#"{ "pack": "pocket-pack-pieces/1", "bytes": 2500, "piece": 1000, "sha256": "ab", "pieces": ["a.bin", "b.bin", "c.bin"] }"#).unwrap()
    }

    #[test]
    fn a_manifest_lists_the_pieces() {
        let m = manifest();
        assert_eq!((m.bytes, m.piece, m.pieces.len()), (2500, 1000, 3));
        assert_eq!(m.pieces[2], "c.bin");
        assert_eq!((m.size(0), m.size(2)), (1000, 500));
        // Pieces that do not make up the bytes, and another kind of object, are refused.
        assert!(Manifest::parse(r#"{"pack":"pocket-pack-pieces/1","bytes":2500,"piece":1000,"pieces":["a.bin","b.bin"]}"#).is_err());
        assert!(Manifest::parse(r#"{"pack":"something else","bytes":1,"piece":1,"pieces":["a"]}"#).is_err());
        assert!(Manifest::parse(r#"{"pack":"pocket-pack-pieces/1","bytes":0,"piece":0,"pieces":[]}"#).is_err());
    }

    #[test]
    fn a_range_takes_parts_of_the_pieces_it_lies_in() {
        let m = manifest();
        assert_eq!(m.parts(0, 10).unwrap(), [(0, 0..10)]);
        assert_eq!(m.parts(990, 20).unwrap(), [(0, 990..1000), (1, 0..10)]);
        assert_eq!(m.parts(500, 2000).unwrap(), [(0, 500..1000), (1, 0..1000), (2, 0..500)]);
        assert_eq!(m.parts(1000, 1000).unwrap(), [(1, 0..1000)]);
        assert_eq!(m.parts(2499, 1).unwrap(), [(2, 499..500)]);
        assert!(m.parts(2400, 101).is_err());
        assert!(m.parts(10, 0).unwrap().is_empty());
    }

    /// A pack in pieces reads as the file does, whatever the pieces' size; the pieces kept are the last read.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn pieces_read_as_the_file_does() {
        let directory = std::env::temp_dir().join(format!("pocket-web-wgpu-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let whole: Vec<u8> = (0..250_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
        std::fs::write(directory.join("whole.pack"), &whole).unwrap();
        let piece = 4096u64;
        let names: Vec<String> = whole.chunks(piece as usize).enumerate().map(|(i, bytes)| {
            let name = format!("{i:03}.bin");
            std::fs::write(directory.join(&name), bytes).unwrap();
            format!("\"{name}\"")
        }).collect();
        std::fs::write(directory.join("pieces.json"), format!("{{\"pack\":\"{MANIFEST}\",\"bytes\":{},\"piece\":{piece},\"pieces\":[{}]}}", whole.len(), names.join(","))).unwrap();
        let path = |name: &str| directory.join(name).to_string_lossy().into_owned();
        let (file, pieces) = (pollster::block_on(Source::open(&path("whole.pack"))).unwrap(), pollster::block_on(Source::open(&path("pieces.json"))).unwrap());
        for (offset, size) in [(0u64, 16u64), (4090, 12), (0, 250_000), (123_456, 7_890), (249_999, 1), (8192, 4096)] {
            let (a, b) = (pollster::block_on(file.range(offset, size)).unwrap(), pollster::block_on(pieces.range(offset, size)).unwrap());
            assert_eq!(a, whole[offset as usize..(offset + size) as usize]);
            assert_eq!(a, b, "{size} bytes at {offset}");
        }
        assert!(pollster::block_on(pieces.range(249_999, 2)).is_err());
        // A piece read again comes from memory.
        let before = pieces.read_so_far().requests;
        pollster::block_on(pieces.range(8192, 4096)).unwrap();
        assert_eq!(pieces.read_so_far().requests, before);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
