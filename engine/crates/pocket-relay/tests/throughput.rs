//! Decode throughput, reported as milliseconds per 1e6 frames.
//!
//! `decode` reads the 48-byte header and slices the two payload regions; it
//! never scans metadata or data, so the figure to read is frames per
//! millisecond. Record bytes are printed for scale only — a throughput in MB/s
//! would describe bytes the decoder never touches.
//!
//! Ignored by default: run it on purpose and in release, where the numbers
//! mean something.
//!
//!     cargo test -p pocket-relay --release --test throughput -- --ignored --nocapture

mod common;

use common::VECTORS;
use pocket_relay::{decode, encode_into, FrameInput, FrameOptions};
use std::hint::black_box;
use std::time::Instant;

const FRAMES: usize = 1_000_000;

fn report(label: &str, frames: usize, bytes: usize, elapsed: std::time::Duration) {
    let ms = elapsed.as_secs_f64() * 1000.0;
    let per_million = ms * (FRAMES as f64 / frames as f64);
    println!(
        "{label}: {frames} frames over {:.1} MB of records in {ms:.2} ms \
         = {per_million:.2} ms/1e6 frames",
        bytes as f64 / 1_000_000.0
    );
}

/// One representative control frame, decoded a million times.
#[test]
#[ignore = "benchmark"]
fn decodes_one_million_frames() {
    let case = VECTORS
        .iter()
        .map(|v| v.case())
        .find(|c| c.name == "get")
        .expect("the get vector");
    let record = case.bin;

    // Warm the caches before the timed run.
    for _ in 0..10_000 {
        black_box(decode(black_box(record), &case.options)).ok();
    }

    let start = Instant::now();
    let mut accepted = 0usize;
    for _ in 0..FRAMES {
        if let Ok(frame) = decode(black_box(record), &case.options) {
            accepted += black_box(frame.header.seq) as usize;
        }
    }
    let elapsed = start.elapsed();
    assert_eq!(accepted, FRAMES, "every decode must succeed");
    report("decode get (219 B)", FRAMES, FRAMES * record.len(), elapsed);
}

/// The same count spread over every legal vector, so header shape and payload
/// size vary from frame to frame.
#[test]
#[ignore = "benchmark"]
fn decodes_one_million_mixed_frames() {
    let cases: Vec<_> = VECTORS
        .iter()
        .map(|v| v.case())
        .filter(|c| c.outcome.is_ok())
        .collect();
    let mut bytes = 0usize;

    let start = Instant::now();
    let mut accepted = 0usize;
    for i in 0..FRAMES {
        let case = &cases[i % cases.len()];
        if let Ok(frame) = decode(black_box(case.bin), &case.options) {
            accepted += black_box(frame.header.seq).min(1) as usize;
            bytes += case.bin.len();
        }
    }
    let elapsed = start.elapsed();
    assert_eq!(accepted, FRAMES);
    report("decode mixed (23 vectors)", FRAMES, bytes, elapsed);
}

/// Encoding for the same frame count, for the other half of the round trip.
#[test]
#[ignore = "benchmark"]
fn encodes_one_million_frames() {
    let case = VECTORS
        .iter()
        .map(|v| v.case())
        .find(|c| c.name == "get")
        .expect("the get vector");
    let frame = decode(case.bin, &case.options).expect("it decodes");
    let input = FrameInput {
        kind: frame.header.kind,
        codec: frame.header.codec,
        session: frame.header.session,
        seq: frame.header.seq,
        stream: frame.header.stream,
        correlation: frame.header.correlation,
        meta: frame.meta,
        data: frame.data,
    };
    let mut out = vec![0u8; 4096];

    let start = Instant::now();
    let mut written = 0usize;
    for _ in 0..FRAMES {
        written += encode_into(black_box(&input), black_box(&mut out), &case.options)
            .expect("it encodes");
    }
    let elapsed = start.elapsed();
    assert_eq!(written, FRAMES * case.bin.len());
    report("encode get (219 B)", FRAMES, written, elapsed);
}

/// Reassembly cost with the transport splitting mid-record, which is the shape
/// a real socket delivers.
#[test]
#[ignore = "benchmark"]
fn reassembles_one_million_frames() {
    use pocket_relay::RecordReader;
    let case = VECTORS
        .iter()
        .map(|v| v.case())
        .find(|c| c.name == "get")
        .expect("the get vector");
    let chunk_size = 64;
    let mut storage = vec![0u8; 4096];
    let mut reader = RecordReader::new(&mut storage).unwrap();
    let opts = FrameOptions::unbounded();

    let start = Instant::now();
    let mut seen = 0usize;
    for _ in 0..FRAMES {
        let mut offset = 0;
        while offset < case.bin.len() {
            let end = (offset + chunk_size).min(case.bin.len());
            let mut chunk = &case.bin[offset..end];
            offset = end;
            while !chunk.is_empty() {
                let taken = reader.feed(chunk).expect("well-formed");
                chunk = &chunk[taken..];
                if let Some(record) = reader.record() {
                    black_box(decode(record, &opts)).ok();
                    seen += 1;
                    reader.consume_record();
                }
            }
        }
    }
    let elapsed = start.elapsed();
    assert_eq!(seen, FRAMES);
    report("reassemble + decode (64 B chunks)", FRAMES, FRAMES * case.bin.len(), elapsed);
}
