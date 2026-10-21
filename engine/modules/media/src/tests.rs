use alloc::vec::Vec;
use crate::spec;

/// Test-local mirror of spec.ts packbitsEncode (runs >= 2 become run records
/// capped at 129; literal stretches break before the next run of >= 3).
fn packbits_encode(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < src.len() {
        let mut run = 1usize;
        while run < 129 && i + run < src.len() && src[i + run] == src[i] {
            run += 1;
        }
        if run >= 2 {
            out.push((126 + run) as u8);
            out.push(src[i]);
            i += run;
            continue;
        }
        let mut end = i + 1;
        while end < src.len() && end - i < 128 {
            let mut r = 1usize;
            while r < 3 && end + r < src.len() && src[end + r] == src[end] {
                r += 1;
            }
            if r >= 3 {
                break;
            }
            end += 1;
        }
        out.push((end - i - 1) as u8);
        out.extend_from_slice(&src[i..end]);
        i = end;
    }
    out
}

#[test]
fn packbits_decodes_hand_built_spec_vectors() {
    use crate::codec::packbits_decode;
    // Each vector is the exact spec.ts packbitsEncode output for its plain text.
    let mut one = [0u8; 1];
    assert!(packbits_decode(&[0, 5], &mut one)); // single literal
    assert_eq!(one, [5]);
    let mut run3 = [0u8; 3];
    assert!(packbits_decode(&[129, 7], &mut run3)); // run of 3
    assert_eq!(run3, [7, 7, 7]);
    let mut lits = [0u8; 3];
    assert!(packbits_decode(&[2, 1, 2, 3], &mut lits)); // 3-literal stretch
    assert_eq!(lits, [1, 2, 3]);
    // 2-runs stay literal (spec.ts: "2-runs are cheaper literal").
    let mut two_run = [0u8; 4];
    assert!(packbits_decode(&[3, 1, 2, 2, 3], &mut two_run));
    assert_eq!(two_run, [1, 2, 2, 3]);
    // Run capped at 129, then the leftover byte as a literal.
    let mut long = [0u8; 130];
    assert!(packbits_decode(&[255, 9, 0, 9], &mut long));
    assert!(long.iter().all(|&b| b == 9));
    // Mixed run + literal tail.
    let mut mixed = [0u8; 6];
    assert!(packbits_decode(&[130, 1, 1, 2, 3], &mut mixed));
    assert_eq!(mixed, [1, 1, 1, 1, 2, 3]);
    // Empty stream <-> empty output.
    assert!(packbits_decode(&[], &mut []));
    assert!(!packbits_decode(&[], &mut one));
}

#[test]
fn packbits_round_trips_against_the_encoder_mirror() {
    use crate::codec::packbits_decode;
    // Deterministic LCG pixel-ish data: long runs + noise, both paths hit.
    let mut src = Vec::new();
    let mut state = 0x1234_5678u32;
    while src.len() < 4096 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let b = (state >> 24) as u8;
        let n = if state & 7 == 0 { (state >> 16 & 0xff) as usize + 1 } else { 1 };
        for _ in 0..n {
            src.push(b);
        }
    }
    src.truncate(4096);
    // Sanity-check the mirror against one spec.ts hand vector.
    assert_eq!(packbits_encode(&[1, 1, 1, 1, 2, 3]), alloc::vec![130, 1, 1, 2, 3]);
    let enc = packbits_encode(&src);
    assert!(enc.len() < src.len(), "the vector must actually compress");
    let mut dec = alloc::vec![0u8; src.len()];
    assert!(packbits_decode(&enc, &mut dec));
    assert_eq!(dec, src);
}

#[test]
fn packbits_rejects_malformed_streams_without_panicking() {
    use crate::codec::packbits_decode;
    let mut out = [0u8; 4];
    assert!(!packbits_decode(&[3, 1, 2], &mut out), "truncated literal payload");
    assert!(!packbits_decode(&[130], &mut out), "run without a value byte");
    assert!(!packbits_decode(&[255, 1], &mut out), "run overruns dst");
    assert!(!packbits_decode(&[5, 1, 2, 3, 4, 5, 6], &mut out), "literal overruns dst");
    assert!(!packbits_decode(&[128, 1], &mut out), "src exhausted before dst full");
    let mut two = [0u8; 2];
    assert!(!packbits_decode(&[128, 5, 0, 1], &mut two), "trailing bytes after exact fit");
    assert!(packbits_decode(&[128, 5], &mut two));
    assert_eq!(two, [5, 5]);
}

// ---- STREAM container (.pkst) — stream.rs readers + the video plane ---------

/// Hand-assemble a valid 96-byte header block (spec.ts "STREAM container").
#[allow(clippy::too_many_arguments)]
fn stream_header_block(
    epoch: u32,
    flags: u16,
    w: u16,
    h: u16,
    slot_count: u32,
    v_latest: u32,
    chunk_frames: u32,
    chunk_count: u32,
    a_latest: u32,
) -> Vec<u8> {
    let slot_size =
        (spec::stream::SLOT_HEADER_SIZE as u32 + 1024 + w as u32 * h as u32).next_multiple_of(16);
    let mut b = alloc::vec![0u8; spec::stream::HEADER_BLOCK_SIZE];
    b[0..4].copy_from_slice(&spec::stream::MAGIC.to_le_bytes());
    b[4..6].copy_from_slice(&spec::stream::VERSION.to_le_bytes());
    b[6..8].copy_from_slice(&flags.to_le_bytes());
    b[8..12].copy_from_slice(&epoch.to_le_bytes());
    b[12..16].copy_from_slice(&(spec::stream::HEADER_BLOCK_SIZE as u32).to_le_bytes());
    let audio_off = spec::stream::HEADER_BLOCK_SIZE as u32 + slot_count * slot_size;
    b[16..20].copy_from_slice(&audio_off.to_le_bytes());
    let v = spec::stream::VRING_OFF;
    b[v..v + 4].copy_from_slice(&spec::stream::VRING_MAGIC.to_le_bytes());
    b[v + 4..v + 6].copy_from_slice(&w.to_le_bytes());
    b[v + 6..v + 8].copy_from_slice(&h.to_le_bytes());
    b[v + 8..v + 10].copy_from_slice(&15u16.to_le_bytes());
    b[v + 10..v + 12].copy_from_slice(&1u16.to_le_bytes());
    b[v + 12..v + 16].copy_from_slice(&slot_count.to_le_bytes());
    b[v + 16..v + 20].copy_from_slice(&slot_size.to_le_bytes());
    b[v + 20..v + 24].copy_from_slice(&v_latest.to_le_bytes());
    b[v + 24..v + 28].copy_from_slice(&900u32.to_le_bytes());
    let a = spec::stream::ARING_OFF;
    b[a..a + 4].copy_from_slice(&spec::stream::ARING_MAGIC.to_le_bytes());
    b[a + 4..a + 8].copy_from_slice(&22050u32.to_le_bytes());
    b[a + 8..a + 10].copy_from_slice(&2u16.to_le_bytes());
    b[a + 12..a + 16].copy_from_slice(&chunk_frames.to_le_bytes());
    b[a + 16..a + 20].copy_from_slice(&chunk_count.to_le_bytes());
    b[a + 20..a + 24].copy_from_slice(&a_latest.to_le_bytes());
    b
}

#[test]
fn stream_header_block_round_trips() {
    let b = stream_header_block(3, spec::stream::FLAG_ENDED, 256, 128, 8, 42, 2048, 64, 17);
    let h = crate::stream::parse_header_block(&b).expect("valid header block");
    assert_eq!(h.epoch, 3);
    assert!(h.ended);
    assert_eq!((h.video.w, h.video.h), (256, 128));
    assert_eq!((h.video.fps_num, h.video.fps_den), (15, 1));
    assert_eq!((h.video.slot_count, h.video.latest_seq), (8, 42));
    assert_eq!(h.video.total_frames, 900);
    assert_eq!(h.video.slot_size, (32 + 1024 + 256 * 128u32).next_multiple_of(16));
    assert_eq!((h.audio.sample_rate, h.audio.channels), (22050, 2));
    assert_eq!((h.audio.chunk_frames, h.audio.chunk_count, h.audio.latest_seq), (2048, 64, 17));
    // Ring offsets: seq 1 sits at the ring base; seqs wrap modulo the count.
    assert_eq!(crate::stream::slot_offset(&h, 1), Some(h.video_off));
    assert_eq!(crate::stream::slot_offset(&h, 9), Some(h.video_off));
    assert_eq!(crate::stream::slot_offset(&h, 2), Some(h.video_off + h.video.slot_size));
    assert_eq!(crate::stream::slot_offset(&h, 0), None, "seqs start at 1");
    let chunk = crate::stream::chunk_size(2048, 2).unwrap();
    assert_eq!(chunk, 16 + 2048 * 2 * 2);
    assert_eq!(crate::stream::chunk_offset(&h, 65), Some(h.audio_off));
}

#[test]
fn stream_header_block_refuses_malformed() {
    use crate::stream::parse_header_block;
    let ok = stream_header_block(0, 0, 256, 128, 8, 0, 2048, 64, 0);
    assert!(parse_header_block(&ok).is_some());
    assert!(parse_header_block(&ok[..95]).is_none(), "short block");
    let mut bad = ok.clone();
    bad[0] = 0; // stream magic
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[4] = 99; // version
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[spec::stream::VRING_OFF] = 0; // vring magic
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[spec::stream::ARING_OFF] = 0; // aring magic
    assert!(parse_header_block(&bad).is_none());
    // Non-pow2 plane (240 wide) — the plane texture must be uploadable.
    assert!(parse_header_block(&stream_header_block(0, 0, 240, 128, 8, 0, 2048, 64, 0)).is_none());
    // A slot too small to carry palette + w*h pixels.
    let mut bad = ok.clone();
    let v = spec::stream::VRING_OFF;
    bad[v + 16..v + 20].copy_from_slice(&64u32.to_le_bytes());
    assert!(parse_header_block(&bad).is_none());
    // Zero rings / bad PCM shapes.
    assert!(parse_header_block(&stream_header_block(0, 0, 256, 128, 0, 0, 2048, 64, 0)).is_none());
    assert!(parse_header_block(&stream_header_block(0, 0, 256, 128, 8, 0, 0, 64, 0)).is_none());
    let mut bad = ok.clone();
    let a = spec::stream::ARING_OFF;
    bad[a + 8..a + 10].copy_from_slice(&3u16.to_le_bytes()); // channels
    assert!(parse_header_block(&bad).is_none());
    // Ring larger than a u32 file offset can address.
    let mut bad = ok;
    bad[v + 12..v + 16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_header_block(&bad).is_none());
}

#[test]
fn stream_slot_and_chunk_headers_validate() {
    let b = stream_header_block(0, 0, 256, 128, 8, 1, 2048, 64, 1);
    let h = crate::stream::parse_header_block(&b).unwrap();
    let mut slot = alloc::vec![0u8; spec::stream::SLOT_HEADER_SIZE];
    slot[0..4].copy_from_slice(&7u32.to_le_bytes());
    slot[4..8].copy_from_slice(&123u32.to_le_bytes());
    slot[8..10].copy_from_slice(&256u16.to_le_bytes());
    slot[10..12].copy_from_slice(&128u16.to_le_bytes());
    let sh = crate::stream::parse_slot_header(&slot, &h.video).expect("valid slot");
    assert_eq!((sh.seq, sh.frame_index, sh.w, sh.h), (7, 123, 256, 128));
    // Dim disagreement with the ring header = torn/malformed, refuse.
    slot[8..10].copy_from_slice(&64u16.to_le_bytes());
    assert!(crate::stream::parse_slot_header(&slot, &h.video).is_none());
    slot[8..10].copy_from_slice(&256u16.to_le_bytes()); // dims valid again…
    slot[0..4].copy_from_slice(&0u32.to_le_bytes()); // …but seq 0 = never written
    assert!(crate::stream::parse_slot_header(&slot, &h.video).is_none());

    let mut chunk = alloc::vec![0u8; spec::stream::CHUNK_HEADER_SIZE];
    chunk[0..4].copy_from_slice(&5u32.to_le_bytes());
    chunk[4..8].copy_from_slice(&40960u32.to_le_bytes());
    let ch = crate::stream::parse_chunk_header(&chunk).expect("valid chunk");
    assert_eq!((ch.seq, ch.start_frame), (5, 40960));
    chunk[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(crate::stream::parse_chunk_header(&chunk).is_none(), "seq 0 = never written");
    assert!(crate::stream::parse_chunk_header(&chunk[..8]).is_none(), "short header");
}

/// Cross-language contract: the committed .pkst golden is WRITTEN by the TS
/// stream writer (now in pocket-nexus/pocket-youtube, host/ring.ts;
/// regenerated there by UPDATE=1 bun test tests/host.test.ts and copied here)
/// and PARSED by this crate — if either side's byte layout drifts, one of
/// the two suites breaks. The fixture is frozen alongside the spec.
#[test]
fn stream_golden_fixture_parses() {
    let bytes: &[u8] = include_bytes!("../tests/fixtures/youtube-golden.pkst");
    let h = crate::stream::parse_header_block(bytes).expect("TS-written header parses");
    assert_eq!(h.epoch, 0);
    assert!(!h.ended);
    assert_eq!((h.video.w, h.video.h), (16, 16));
    assert_eq!((h.video.fps_num, h.video.fps_den), (15, 1));
    assert_eq!((h.video.slot_count, h.video.latest_seq, h.video.total_frames), (4, 2, 30));
    assert_eq!((h.audio.sample_rate, h.audio.channels), (22050, 2));
    assert_eq!((h.audio.chunk_frames, h.audio.chunk_count, h.audio.latest_seq), (64, 4, 1));

    // Frame 2 (seq 2): palette bytes are (i + 2) & 255, indices (i * 3) & 255.
    let off = crate::stream::slot_offset(&h, 2).unwrap() as usize;
    let slot = &bytes[off..off + h.video.slot_size as usize];
    let sh = crate::stream::parse_slot_header(slot, &h.video).expect("slot 2 parses");
    assert_eq!((sh.seq, sh.frame_index), (2, 1));
    let pal = &slot[spec::stream::SLOT_HEADER_SIZE..spec::stream::SLOT_HEADER_SIZE + 1024];
    assert!(pal.iter().enumerate().all(|(i, &b)| b == ((i + 2) & 255) as u8));
    let px = &slot[spec::stream::SLOT_HEADER_SIZE + 1024..spec::stream::SLOT_HEADER_SIZE + 1024 + 256];
    assert!(px.iter().enumerate().all(|(i, &b)| b == ((i * 3) & 255) as u8));

    // Audio chunk 1: s16 LE samples i * 3 - 64.
    let coff = crate::stream::chunk_offset(&h, 1).unwrap() as usize;
    let chunk = &bytes[coff..];
    let ch = crate::stream::parse_chunk_header(chunk).expect("chunk 1 parses");
    assert_eq!((ch.seq, ch.start_frame), (1, 0));
    let pcm = &chunk[spec::stream::CHUNK_HEADER_SIZE..];
    for i in 0..(64 * 2usize) {
        let v = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]);
        assert_eq!(v as i32, i as i32 * 3 - 64);
    }


}

// ---- SVC WIRE (PKNT) — wire.rs codec + stream_rx.rs RAM ring ---------------

#[test]
fn wire_frame_header_round_trips_and_rejects_oversize() {
    use crate::wire::{encode_frame_header, parse_frame_header};
    let mut out = [0u8; 8];
    assert!(encode_frame_header(spec::wire::MSG_VIDEO_SLOT, 1, 1040, &mut out));
    let h = parse_frame_header(&out).expect("round trip");
    assert_eq!((h.kind, h.flags, h.len), (spec::wire::MSG_VIDEO_SLOT, 1, 1040));
    assert!(parse_frame_header(&out[..7]).is_none(), "short header");
    assert!(
        !encode_frame_header(0x10, 0, spec::wire::MAX_PAYLOAD as u32 + 1, &mut out),
        "oversize refused at encode"
    );
    out[4..8].copy_from_slice(&(spec::wire::MAX_PAYLOAD as u32 + 1).to_le_bytes());
    assert!(parse_frame_header(&out).is_none(), "oversize refused at parse");
}

#[test]
fn wire_hello_and_beacon_parse() {
    use crate::wire::{encode_hello, parse_beacon, parse_hello_ack};
    let mut out = [0u8; 80];
    let n = encode_hello("youtube", &mut out).expect("encodes");
    assert_eq!(n, 7 + 7);
    assert_eq!(&out[0..4], &spec::wire::MAGIC.to_le_bytes());
    assert_eq!(out[4], spec::wire::VERSION);
    assert_eq!(out[6] as usize, 7);
    assert_eq!(&out[7..14], b"youtube");
    assert!(encode_hello("", &mut out).is_none());

    let mut ack = [0u8; 8];
    ack[0..4].copy_from_slice(&spec::wire::MAGIC.to_le_bytes());
    ack[4] = 1;
    assert_eq!(parse_hello_ack(&ack), Some(1));
    ack[0] = 0;
    assert_eq!(parse_hello_ack(&ack), None);

    let mut beacon = Vec::new();
    beacon.extend_from_slice(&spec::wire::BEACON_MAGIC.to_le_bytes());
    beacon.push(spec::wire::VERSION);
    beacon.push(0);
    beacon.extend_from_slice(&spec::wire::PORT.to_le_bytes());
    beacon.push(7);
    beacon.extend_from_slice(b"youtube");
    beacon.push(3);
    beacon.extend_from_slice(b"Mac");
    let (port, app, name) = parse_beacon(&beacon).expect("beacon parses");
    assert_eq!((port, app, name), (spec::wire::PORT, "youtube", "Mac"));
    // Truncations must fail cleanly at every length.
    for cut in 0..beacon.len() {
        assert!(parse_beacon(&beacon[..cut]).is_none(), "cut at {cut}");
    }
}

#[test]
fn wire_payload_parsers_validate_and_survive_truncation() {
    use crate::wire::{
        parse_audio_chunk, parse_file, parse_stream_mark, parse_stream_open, parse_video_slot,
    };

    // file: pathLen · path · blob
    let mut file = Vec::new();
    file.extend_from_slice(&9u16.to_le_bytes());
    file.extend_from_slice(b"thumbs/a0");
    file.extend_from_slice(&[1, 2, 3, 4]);
    let (path, blob) = parse_file(&file).expect("file parses");
    assert_eq!((path, blob), ("thumbs/a0", &[1u8, 2, 3, 4][..]));
    for cut in 0..11 {
        assert!(parse_file(&file[..cut]).is_none(), "cut at {cut}");
    }

    // streamOpen requires exactly a 96-byte header block after the path.
    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 4, 0);
    let mut open = Vec::new();
    open.extend_from_slice(&7u16.to_le_bytes());
    open.extend_from_slice(b"media/v");
    open.extend_from_slice(&block);
    let (path, got) = parse_stream_open(&open).expect("streamOpen parses");
    assert_eq!(path, "media/v");
    assert_eq!(got, &block[..]);
    assert!(parse_stream_open(&open[..open.len() - 1]).is_none(), "short block refused");

    // videoSlot: header · palette · indices.
    let mut slot = Vec::new();
    slot.extend_from_slice(&2u32.to_le_bytes()); // seq
    slot.extend_from_slice(&7u32.to_le_bytes()); // frameIndex
    slot.extend_from_slice(&32u16.to_le_bytes());
    slot.extend_from_slice(&16u16.to_le_bytes());
    slot.extend_from_slice(&0u16.to_le_bytes()); // flags
    slot.extend_from_slice(&0u16.to_le_bytes());
    slot.extend_from_slice(&[9u8; 1024]);
    slot.extend_from_slice(&[5u8; 32 * 16]);
    let msg = parse_video_slot(&slot).expect("slot parses");
    assert_eq!((msg.seq, msg.frame_index, msg.w, msg.h, msg.rle), (2, 7, 32, 16, false));
    assert_eq!(msg.palette.len(), 1024);
    assert_eq!(msg.indices.len(), 32 * 16);
    assert!(parse_video_slot(&slot[..1039]).is_none(), "short slot refused");
    let mut zero_seq = slot.clone();
    zero_seq[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(parse_video_slot(&zero_seq).is_none(), "seq 0 refused");

    // audioChunk + streamMark.
    let mut chunk = Vec::new();
    chunk.extend_from_slice(&1u32.to_le_bytes());
    chunk.extend_from_slice(&2048u32.to_le_bytes());
    chunk.extend_from_slice(&[0u8; 64 * 2 * 2]);
    let msg = parse_audio_chunk(&chunk).expect("chunk parses");
    assert_eq!((msg.seq, msg.start_frame, msg.pcm.len()), (1, 2048, 64 * 2 * 2));
    assert!(parse_audio_chunk(&chunk[..7]).is_none());

    let mut mark = Vec::new();
    mark.extend_from_slice(&3u32.to_le_bytes());
    mark.extend_from_slice(&spec::wire::MARK_FLAG_ENDED.to_le_bytes());
    mark.extend_from_slice(&0u16.to_le_bytes());
    let msg = parse_stream_mark(&mark).expect("mark parses");
    assert!(msg.ended);
    assert_eq!(msg.epoch, 3);
    assert!(parse_stream_mark(&mark[..7]).is_none());
}

/// Independent reference writer: build the .pkst image with direct byte
/// writes straight off the spec.ts layout comment — a different code path
/// from RamStream, so equality below is a real check, not a tautology.
fn reference_write_slot(
    buf: &mut [u8],
    h: &crate::stream::StreamHeaders,
    seq: u32,
    frame_index: u32,
    palette: &[u8],
    indices: &[u8],
) {
    let off = (h.video_off + ((seq - 1) % h.video.slot_count) * h.video.slot_size) as usize;
    buf[off..off + 4].copy_from_slice(&seq.to_le_bytes());
    buf[off + 4..off + 8].copy_from_slice(&frame_index.to_le_bytes());
    buf[off + 8..off + 10].copy_from_slice(&(h.video.w as u16).to_le_bytes());
    buf[off + 10..off + 12].copy_from_slice(&(h.video.h as u16).to_le_bytes());
    for b in &mut buf[off + 12..off + 32] {
        *b = 0;
    }
    buf[off + 32..off + 32 + 1024].copy_from_slice(palette);
    buf[off + 1056..off + 1056 + indices.len()].copy_from_slice(indices);
    let v = spec::stream::VRING_OFF;
    buf[v + 20..v + 24].copy_from_slice(&seq.to_le_bytes());
}

fn reference_write_chunk(
    buf: &mut [u8],
    h: &crate::stream::StreamHeaders,
    seq: u32,
    start_frame: u32,
    pcm: &[u8],
) {
    let size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let off = (h.audio_off + ((seq - 1) % h.audio.chunk_count) * size) as usize;
    buf[off..off + 4].copy_from_slice(&seq.to_le_bytes());
    buf[off + 4..off + 8].copy_from_slice(&start_frame.to_le_bytes());
    for b in &mut buf[off + 8..off + 16] {
        *b = 0;
    }
    buf[off + 16..off + 16 + pcm.len()].copy_from_slice(pcm);
    let a = spec::stream::ARING_OFF;
    buf[a + 20..a + 24].copy_from_slice(&seq.to_le_bytes());
}

#[test]
fn ram_stream_image_equals_the_reference_file_writer() {
    use crate::wire::{AudioChunkMsg, StreamMarkMsg, VideoSlotMsg};

    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 2, 0);
    let h = crate::stream::parse_header_block(&block).unwrap();
    let chunk_size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let total = (h.audio_off + h.audio.chunk_count * chunk_size) as usize;

    // Reference image: header block + direct writes (3 slots so seq 3 laps
    // slot 1's position, 2 chunks) + an epoch/ended mark.
    let mut reference = alloc::vec![0u8; total];
    reference[..96].copy_from_slice(&block);
    let pal = |seed: u8| -> Vec<u8> { (0..1024).map(|i| (i as u8).wrapping_add(seed)).collect() };
    let px = |seed: u8| -> Vec<u8> { (0..32 * 16).map(|i| (i as u8).wrapping_mul(seed)).collect() };
    let pcm = |seed: u8| -> Vec<u8> { (0..64 * 2 * 2).map(|i| (i as u8) ^ seed).collect() };
    for seq in 1..=3u32 {
        reference_write_slot(&mut reference, &h, seq, seq * 2, &pal(seq as u8), &px(seq as u8));
    }
    for seq in 1..=2u32 {
        reference_write_chunk(&mut reference, &h, seq, seq * 64, &pcm(seq as u8));
    }
    reference[8..12].copy_from_slice(&5u32.to_le_bytes()); // epoch
    reference[6..8].copy_from_slice(&spec::stream::FLAG_ENDED.to_le_bytes());

    // RamStream fed the same content as WIRE messages.
    let mut ram = crate::stream_rx::RamStream::open(&block).expect("opens");
    for seq in 1..=3u32 {
        let palette = pal(seq as u8);
        let indices = px(seq as u8);
        assert!(ram.apply_slot(&VideoSlotMsg {
            seq,
            frame_index: seq * 2,
            w: 32,
            h: 16,
            rle: false,
            palette: &palette,
            indices: &indices,
        }));
    }
    for seq in 1..=2u32 {
        let bytes = pcm(seq as u8);
        assert!(ram.apply_chunk(&AudioChunkMsg { seq, start_frame: seq * 64, pcm: &bytes }));
    }
    ram.apply_mark(&StreamMarkMsg { epoch: 5, ended: true });

    assert_eq!(ram.buf().len(), reference.len());
    assert_eq!(ram.buf(), &reference[..], "RAM ring == file ring, byte for byte");

    // And the shared readers see the expected world.
    let live = crate::stream::parse_header_block(ram.buf()).unwrap();
    assert_eq!((live.epoch, live.ended), (5, true));
    assert_eq!(live.video.latest_seq, 3);
    assert_eq!(live.audio.latest_seq, 2);
    let off = crate::stream::slot_offset(&live, 3).unwrap() as usize;
    let sh = crate::stream::parse_slot_header(&ram.buf()[off..], &live.video).unwrap();
    assert_eq!((sh.seq, sh.frame_index), (3, 6));
}

#[test]
fn ram_stream_decodes_rle_slots_and_rejects_bad_geometry() {
    use crate::wire::VideoSlotMsg;
    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 2, 0);
    let mut ram = crate::stream_rx::RamStream::open(&block).unwrap();

    let raw: Vec<u8> = (0..32 * 16).map(|i| if i < 300 { 7 } else { (i % 5) as u8 }).collect();
    let rle = packbits_encode(&raw);
    assert!(rle.len() < raw.len(), "fixture should actually compress");
    let palette = alloc::vec![1u8; 1024];
    assert!(ram.apply_slot(&VideoSlotMsg {
        seq: 1,
        frame_index: 0,
        w: 32,
        h: 16,
        rle: true,
        palette: &palette,
        indices: &rle,
    }));
    let h = crate::stream::parse_header_block(ram.buf()).unwrap();
    let off = crate::stream::slot_offset(&h, 1).unwrap() as usize;
    assert_eq!(&ram.buf()[off + 1056..off + 1056 + raw.len()], &raw[..]);

    // Wrong plane, wrong palette size, wrong index count, truncated RLE.
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 16, h: 16, rle: false, palette: &palette, indices: &raw,
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: false, palette: &palette[..512], indices: &raw,
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: false, palette: &palette, indices: &raw[..100],
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: true, palette: &palette, indices: &rle[..rle.len() / 2],
    }));
    // Failures must not publish a cursor.
    let h = crate::stream::parse_header_block(ram.buf()).unwrap();
    assert_eq!(h.video.latest_seq, 1);
}

/// Cross-language: rebuild the committed TS-written .pkst golden through
/// RamStream (slots/chunks re-fed as WIRE messages) and require the byte-
/// identical file image — the socket transport IS the file transport.
#[test]
fn ram_stream_reconstructs_the_committed_golden() {
    use crate::wire::{AudioChunkMsg, StreamMarkMsg, VideoSlotMsg};
    let golden: &[u8] = include_bytes!("../tests/fixtures/youtube-golden.pkst");
    let h = crate::stream::parse_header_block(golden).expect("golden parses");

    // Open from a PRISTINE header (cursors zeroed, epoch 0, flags 0) — the
    // exact block a streamOpen would carry before any writes.
    let mut pristine = golden[..96].to_vec();
    pristine[6..8].copy_from_slice(&0u16.to_le_bytes());
    pristine[8..12].copy_from_slice(&0u32.to_le_bytes());
    let v = spec::stream::VRING_OFF;
    let a = spec::stream::ARING_OFF;
    pristine[v + 20..v + 24].copy_from_slice(&0u32.to_le_bytes());
    pristine[a + 20..a + 24].copy_from_slice(&0u32.to_le_bytes());
    let mut ram = crate::stream_rx::RamStream::open(&pristine).expect("opens");

    // Re-feed every RESIDENT slot/chunk in seq order (the ring holds the
    // last slot_count/chunk_count writes; lapped history is gone by design).
    let mut slots: Vec<(u32, usize)> = Vec::new();
    for idx in 0..h.video.slot_count {
        let off = (h.video_off + idx * h.video.slot_size) as usize;
        if let Some(sh) = crate::stream::parse_slot_header(&golden[off..], &h.video) {
            slots.push((sh.seq, off));
        }
    }
    slots.sort();
    for (seq, off) in slots {
        let sh = crate::stream::parse_slot_header(&golden[off..], &h.video).unwrap();
        let pal = &golden[off + 32..off + 32 + 1024];
        let px = &golden[off + 1056..off + 1056 + (h.video.w * h.video.h) as usize];
        assert!(ram.apply_slot(&VideoSlotMsg {
            seq,
            frame_index: sh.frame_index,
            w: h.video.w,
            h: h.video.h,
            rle: false,
            palette: pal,
            indices: px,
        }));
    }
    let chunk_size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let pcm_bytes = (h.audio.chunk_frames * h.audio.channels * 2) as usize;
    let mut chunks: Vec<(u32, usize)> = Vec::new();
    for idx in 0..h.audio.chunk_count {
        let off = (h.audio_off + idx * chunk_size) as usize;
        if let Some(ch) = crate::stream::parse_chunk_header(&golden[off..]) {
            chunks.push((ch.seq, off));
        }
    }
    chunks.sort();
    for (seq, off) in chunks {
        let ch = crate::stream::parse_chunk_header(&golden[off..]).unwrap();
        assert!(ram.apply_chunk(&AudioChunkMsg {
            seq,
            start_frame: ch.start_frame,
            pcm: &golden[off + 16..off + 16 + pcm_bytes],
        }));
    }
    ram.apply_mark(&StreamMarkMsg { epoch: h.epoch, ended: h.ended });
    // Restore the golden's final cursors exactly (a lapped ring's latest may
    // exceed the highest resident seq; apply_* published the resident max).
    let final_v = h.video.latest_seq;
    let final_a = h.audio.latest_seq;
    let buf_len = ram.buf().len();
    assert_eq!(buf_len, golden.len(), "same preallocated image size");
    let mut image = ram.buf().to_vec();
    image[v + 20..v + 24].copy_from_slice(&final_v.to_le_bytes());
    image[a + 20..a + 24].copy_from_slice(&final_a.to_le_bytes());
    assert_eq!(&image[..], golden, "socket-fed RAM ring == TS-written file, byte for byte");
}
