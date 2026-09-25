//! The P1 byte vectors, linked into the test binary.
//!
//! `tests/fixtures/relay/vectors/` is the shared acceptance set: the same
//! records the TypeScript codec and the C frame layer are held to. Each is a
//! complete wire record (`.bin`) plus the expected decode or the exact frame
//! error code (`.json`). `include_bytes!` pins them at compile time, so a
//! fixture that moves breaks the build rather than silently skipping.

// Each integration test binary uses a different part of this module.
#![allow(dead_code)]

pub mod json;

use json::Json;
use pocket_relay::{spec::header as h, CodecSet, FrameInput, FrameOptions, HEADER_BYTES};

pub struct Vector {
    pub name: &'static str,
    pub bin: &'static [u8],
    pub meta: &'static str,
}

macro_rules! vectors {
    ($($name:literal),* $(,)?) => {
        &[$(Vector {
            name: $name,
            bin: include_bytes!(concat!(
                "../../../../../tests/fixtures/relay/vectors/", $name, ".bin")),
            meta: include_str!(concat!(
                "../../../../../tests/fixtures/relay/vectors/", $name, ".json")),
        }),*]
    };
}

/// Every name in `tests/fixtures/relay/index.json`, in that file's order.
/// [`assert_covers_index`] proves the two lists agree.
pub const VECTORS: &[Vector] = vectors![
    "hello",
    "hello-response",
    "ready",
    "ready-response",
    "open",
    "open-response",
    "ping",
    "credit",
    "cancel",
    "invalidate",
    "get",
    "response-final",
    "push",
    "data-codec1-json",
    "example-map.get",
    "example-map.chunk1",
    "example-map.chunk2",
    "example-map.chunk3",
    "example-term.subscribe",
    "example-term.subscribed",
    "example-term.grid",
    "example-vault.rows",
    "example-vault.layout",
    "bad-magic",
    "bad-major",
    "bad-minor",
    "bad-type",
    "bad-flags",
    "bad-header-size",
    "bad-reserved",
    "length-inequality",
    "truncated",
    "short-header",
    "wire-too-large",
    "meta-too-large",
    "bad-session-pin",
    "seq-zero",
    "correlation-zero-request",
    "cancel-nonzero-stream",
    "codec-not-negotiated",
    "codec0-with-data",
    "meta-not-utf8",
    "meta-utf8-cut-at-data",
    "meta-duplicate-key",
    "meta-float-number",
    "meta-nan",
    "meta-lone-surrogate",
    "envelope-response-no-final",
];

const INDEX: &str = include_str!("../../../../../tests/fixtures/relay/index.json");

/// Fails when P1 adds a vector this crate does not read.
pub fn assert_covers_index() {
    let index = Json::parse(INDEX).expect("index.json parses");
    let listed: Vec<&str> = index
        .at("vectors")
        .and_then(Json::as_array)
        .expect("index.json has a vectors array")
        .iter()
        .map(|v| v.as_str().expect("vector name is a string"))
        .collect();
    let linked: Vec<&str> = VECTORS.iter().map(|v| v.name).collect();
    assert_eq!(listed, linked, "tests/common/mod.rs must link every vector in index.json");
}

/// Vectors this crate accepts and the layer above refuses: JSON semantics
/// (a duplicate key, fractional and NaN numbers, a lone surrogate escape) and
/// one envelope rule (a RESPONSE without `final`). Their metadata is valid
/// UTF-8, so the byte-level check here passes them on. The C frame layer's
/// test keeps the same five names; every other invalid vector is a frame-layer
/// refusal in all three languages.
pub const UPPER_LAYER_ONLY: &[&str] = &[
    "meta-duplicate-key",
    "meta-float-number",
    "meta-nan",
    "meta-lone-surrogate",
    "envelope-response-no-final",
];

/// Rebuilds the encoder's input from a record's raw bytes without going
/// through `decode`, so a record `decode` refuses can still be offered to
/// `encode_into`. The record must hold a full header whose `metaBytes` fits
/// inside it; the data region is whatever follows the metadata.
pub fn raw_input(record: &[u8]) -> FrameInput<'_> {
    let u32_at = |off: usize| u32::from_le_bytes(record[off..off + 4].try_into().unwrap());
    let meta_end = HEADER_BYTES + u32_at(h::META_BYTES_OFFSET) as usize;
    FrameInput {
        kind: record[h::TYPE_OFFSET],
        codec: u16::from_le_bytes(record[h::CODEC_OFFSET..h::CODEC_OFFSET + 2].try_into().unwrap()),
        session: u64::from_le_bytes(
            record[h::SESSION_OFFSET..h::SESSION_OFFSET + 8].try_into().unwrap(),
        ),
        seq: u32_at(h::SEQ_OFFSET),
        stream: u32_at(h::STREAM_OFFSET),
        correlation: u32_at(h::CORRELATION_OFFSET),
        meta: &record[HEADER_BYTES..meta_end],
        data: &record[meta_end..],
    }
}

pub struct Expect {
    pub kind: u8,
    pub codec: u16,
    pub session: u64,
    pub seq: u32,
    pub stream: u32,
    pub correlation: u32,
    pub meta_bytes: u32,
    pub data_bytes: u32,
}

pub struct Case {
    pub name: &'static str,
    pub bin: &'static [u8],
    pub options: FrameOptions,
    pub wire_bytes: usize,
    /// `Ok` for a legal vector, `Err(code)` for the exact refusal expected.
    pub outcome: Result<Expect, String>,
}

fn hex_u64(s: &str) -> u64 {
    u64::from_str_radix(s, 16).unwrap_or_else(|_| panic!("session hex {s:?}"))
}

impl Vector {
    pub fn case(&self) -> Case {
        let meta = Json::parse(self.meta).unwrap_or_else(|e| panic!("{}.json: {e}", self.name));

        let mut options = FrameOptions::unbounded();
        if let Some(n) = meta.at("options.maxWireBytes").and_then(Json::as_u32) {
            options.max_wire_bytes = Some(n);
        }
        if let Some(n) = meta.at("options.maxMetaBytes").and_then(Json::as_u32) {
            options.max_meta_bytes = Some(n);
        }
        if let Some(list) = meta.at("options.codecs").and_then(Json::as_array) {
            let codecs: Vec<u16> = list
                .iter()
                .map(|v| v.as_u64().expect("codec is an integer") as u16)
                .collect();
            options.codecs = CodecSet::from_slice(&codecs).expect("codec set fits");
        }
        if let Some(s) = meta.at("options.session").and_then(Json::as_str) {
            options.session = Some(hex_u64(s));
        }

        let kind = meta.at("kind").and_then(Json::as_str).expect("vector kind");
        let outcome = match kind {
            "valid" => Ok(Expect {
                kind: meta.at("expect.type").and_then(Json::as_u32).expect("expect.type") as u8,
                codec: meta.at("expect.codec").and_then(Json::as_u32).expect("expect.codec") as u16,
                session: hex_u64(
                    meta.at("expect.session").and_then(Json::as_str).expect("expect.session"),
                ),
                seq: meta.at("expect.seq").and_then(Json::as_u32).expect("expect.seq"),
                stream: meta.at("expect.stream").and_then(Json::as_u32).expect("expect.stream"),
                correlation: meta
                    .at("expect.correlation")
                    .and_then(Json::as_u32)
                    .expect("expect.correlation"),
                meta_bytes: meta
                    .at("expect.metaBytes")
                    .and_then(Json::as_u32)
                    .expect("expect.metaBytes"),
                data_bytes: meta
                    .at("expect.dataBytes")
                    .and_then(Json::as_u32)
                    .expect("expect.dataBytes"),
            }),
            "invalid" => Err(meta
                .at("errorCode")
                .and_then(Json::as_str)
                .expect("invalid vector carries errorCode")
                .to_string()),
            other => panic!("{}: unknown vector kind {other:?}", self.name),
        };

        Case {
            name: self.name,
            bin: self.bin,
            options,
            wire_bytes: meta.at("wireBytes").and_then(Json::as_u32).expect("wireBytes") as usize,
            outcome,
        }
    }
}
