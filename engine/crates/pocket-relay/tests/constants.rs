//! Drift guard: the constants this crate compiles against must equal
//! `tests/fixtures/relay/constants.json`, the snapshot of
//! `contracts/spec/relay.ts` that the C and TypeScript layers also read.
//!
//! `src/generated.rs` is written by `gen-rust.ts` and byte-compared by
//! `tests/contract.ts` on the TypeScript side. This test closes the loop from
//! the other end: it reads the committed fixture and checks the values Rust
//! actually links, so a hand-edited generated file fails here even when the
//! generator is never run.

mod common;

use common::json::Json;
use pocket_relay::spec;

const CONSTANTS: &str = include_str!("../../../../tests/fixtures/relay/constants.json");

fn constants() -> Json {
    Json::parse(CONSTANTS).expect("constants.json parses")
}

fn num(root: &Json, path: &str) -> u64 {
    root.at(path)
        .and_then(Json::as_u64)
        .unwrap_or_else(|| panic!("constants.json has no integer at {path}"))
}

fn text<'a>(root: &'a Json, path: &str) -> &'a str {
    root.at(path)
        .and_then(Json::as_str)
        .unwrap_or_else(|| panic!("constants.json has no string at {path}"))
}

#[test]
fn magic_and_version_match_the_fixture() {
    let c = constants();
    assert_eq!(num(&c, "version"), spec::VERSION as u64);
    assert_eq!(text(&c, "magicText"), spec::MAGIC_TEXT);
    let magic: Vec<u8> = c
        .at("magic")
        .and_then(Json::as_array)
        .expect("magic array")
        .iter()
        .map(|v| v.as_u64().expect("magic byte") as u8)
        .collect();
    assert_eq!(magic.as_slice(), spec::MAGIC.as_slice());
    assert_eq!(core::str::from_utf8(&spec::MAGIC).unwrap(), spec::MAGIC_TEXT);
}

#[test]
fn frame_geometry_matches_the_fixture() {
    let c = constants();
    assert_eq!(num(&c, "frame.major"), spec::frame::MAJOR as u64);
    assert_eq!(num(&c, "frame.minor"), spec::frame::MINOR as u64);
    assert_eq!(num(&c, "frame.headerBytes"), spec::frame::HEADER_BYTES as u64);
    assert_eq!(num(&c, "frame.lengthPrefixBytes"), spec::frame::LENGTH_PREFIX_BYTES as u64);
    assert_eq!(num(&c, "frame.headerBodyBytes"), spec::frame::HEADER_BODY_BYTES as u64);
    // The identity every receiver checks: the prefix is not counted by
    // frameBytes, and the two add back up to the fixed header.
    assert_eq!(
        spec::frame::HEADER_BODY_BYTES + spec::frame::LENGTH_PREFIX_BYTES,
        spec::frame::HEADER_BYTES
    );
    assert_eq!(pocket_relay::HEADER_BYTES, 48);
}

#[test]
fn header_field_offsets_match_the_fixture() {
    let c = constants();
    use spec::header as h;
    let fields: &[(&str, usize, usize)] = &[
        ("frameBytes", h::FRAME_BYTES_OFFSET, h::FRAME_BYTES_WIDTH),
        ("magic", h::MAGIC_OFFSET, h::MAGIC_WIDTH),
        ("major", h::MAJOR_OFFSET, h::MAJOR_WIDTH),
        ("minor", h::MINOR_OFFSET, h::MINOR_WIDTH),
        ("type", h::TYPE_OFFSET, h::TYPE_WIDTH),
        ("flags", h::FLAGS_OFFSET, h::FLAGS_WIDTH),
        ("headerBytes", h::HEADER_BYTES_OFFSET, h::HEADER_BYTES_WIDTH),
        ("codec", h::CODEC_OFFSET, h::CODEC_WIDTH),
        ("session", h::SESSION_OFFSET, h::SESSION_WIDTH),
        ("seq", h::SEQ_OFFSET, h::SEQ_WIDTH),
        ("stream", h::STREAM_OFFSET, h::STREAM_WIDTH),
        ("correlation", h::CORRELATION_OFFSET, h::CORRELATION_WIDTH),
        ("metaBytes", h::META_BYTES_OFFSET, h::META_BYTES_WIDTH),
        ("dataBytes", h::DATA_BYTES_OFFSET, h::DATA_BYTES_WIDTH),
        ("reserved", h::RESERVED_OFFSET, h::RESERVED_WIDTH),
    ];
    let listed = match c.at("header") {
        Some(Json::Obj(m)) => m.len(),
        _ => panic!("constants.json has no header object"),
    };
    assert_eq!(listed, fields.len(), "the header gained or lost a field");

    let mut covered = 0;
    for (name, offset, width) in fields {
        assert_eq!(num(&c, &format!("header.{name}.offset")), *offset as u64, "{name} offset");
        assert_eq!(num(&c, &format!("header.{name}.width")), *width as u64, "{name} width");
        covered += width;
    }
    // Contiguous and exactly 48 bytes: no gap a sender could fill unchecked.
    assert_eq!(covered, pocket_relay::HEADER_BYTES, "header fields must tile the 48 bytes");
}

#[test]
fn message_types_and_codes_match_the_fixture() {
    let c = constants();
    assert_eq!(num(&c, "types.REQUEST"), spec::type_::REQUEST as u64);
    assert_eq!(num(&c, "types.RESPONSE"), spec::type_::RESPONSE as u64);
    assert_eq!(num(&c, "types.PUSH"), spec::type_::PUSH as u64);
    assert_eq!(num(&c, "types.CANCEL"), spec::type_::CANCEL as u64);
    assert_eq!(num(&c, "types.INVALIDATE"), spec::type_::INVALIDATE as u64);

    use spec::frame_error as e;
    for (path, value) in [
        ("frameErrors.SHORT_HEADER", e::SHORT_HEADER),
        ("frameErrors.BAD_PREFIX", e::BAD_PREFIX),
        ("frameErrors.BAD_MAGIC", e::BAD_MAGIC),
        ("frameErrors.BAD_VERSION", e::BAD_VERSION),
        ("frameErrors.BAD_TYPE", e::BAD_TYPE),
        ("frameErrors.BAD_FLAGS", e::BAD_FLAGS),
        ("frameErrors.BAD_HEADER_SIZE", e::BAD_HEADER_SIZE),
        ("frameErrors.BAD_RESERVED", e::BAD_RESERVED),
        ("frameErrors.BAD_LENGTH", e::BAD_LENGTH),
        ("frameErrors.TRUNCATED", e::TRUNCATED),
        ("frameErrors.WIRE_TOO_LARGE", e::WIRE_TOO_LARGE),
        ("frameErrors.META_TOO_LARGE", e::META_TOO_LARGE),
        ("frameErrors.BAD_CODEC", e::BAD_CODEC),
        ("frameErrors.BAD_SESSION", e::BAD_SESSION),
        ("frameErrors.BAD_SEQ", e::BAD_SEQ),
        ("frameErrors.BAD_CORRELATION", e::BAD_CORRELATION),
        ("frameErrors.BAD_METADATA", e::BAD_METADATA),
        ("frameErrors.BAD_ENVELOPE", e::BAD_ENVELOPE),
    ] {
        assert_eq!(text(&c, path), value, "{path}");
    }
    let listed = match c.at("frameErrors") {
        Some(Json::Obj(m)) => m.len(),
        _ => panic!("constants.json has no frameErrors object"),
    };
    assert_eq!(listed, 18, "the frame error vocabulary changed size");
}

#[test]
fn codecs_match_the_fixture() {
    let c = constants();
    use spec::codec as k;
    for (path, value) in [
        ("codecs.NONE", k::NONE),
        ("codecs.JSON", k::JSON),
        ("codecs.R5G6B5LE", k::R5G6B5LE),
        ("codecs.PMH1", k::PMH1),
        ("codecs.COVERAGE2_LSB", k::COVERAGE2_LSB),
        ("codecs.INDEXED8_ABGR", k::INDEXED8_ABGR),
        ("codecs.FONT3", k::FONT3),
        ("codecs.OPAQUE_BYTES", k::OPAQUE_BYTES),
        ("codecs.EXTENSION_MIN", k::EXTENSION_MIN),
        ("codecs.EXTENSION_MAX", k::EXTENSION_MAX),
    ] {
        assert_eq!(num(&c, path), value as u64, "{path}");
    }
    // The v1 set this crate accepts by default is exactly the eight defined
    // codecs; the extension range is negotiated, never assumed.
    let defined = pocket_relay::CodecSet::DEFINED;
    assert_eq!(defined.len(), 8);
    for codec in [k::NONE, k::JSON, k::R5G6B5LE, k::PMH1, k::COVERAGE2_LSB, k::INDEXED8_ABGR,
                  k::FONT3, k::OPAQUE_BYTES] {
        assert!(defined.contains(codec), "{codec} missing from the v1 set");
    }
    assert!(!defined.contains(k::EXTENSION_MIN));
    assert!(!defined.contains(k::EXTENSION_MAX));
}

#[test]
fn limits_match_the_fixture() {
    let c = constants();
    use spec::limits as l;
    for (path, value) in [
        ("limits.bootstrapMaxWireBytes", l::BOOTSTRAP_MAX_WIRE_BYTES),
        ("limits.controlMaxWireBytes", l::CONTROL_MAX_WIRE_BYTES),
        ("limits.controlWindowFrames", l::CONTROL_WINDOW_FRAMES),
        ("limits.controlWindowBytes", l::CONTROL_WINDOW_BYTES),
        ("limits.sidebandSlots", l::SIDEBAND_SLOTS),
        ("limits.sidebandSlotBytes", l::SIDEBAND_SLOT_BYTES),
        ("limits.sidebandCreditTable", l::SIDEBAND_CREDIT_TABLE),
        ("limits.maxPending", l::MAX_PENDING),
        ("limits.bulkMaxWireBytes", l::BULK_MAX_WIRE_BYTES),
        ("limits.bulkMaxMetaBytes", l::BULK_MAX_META_BYTES),
        ("limits.bulkWindowFrames", l::BULK_WINDOW_FRAMES),
        ("limits.bulkWindowBytes", l::BULK_WINDOW_BYTES),
        ("limits.bulkMaxAssemblies", l::BULK_MAX_ASSEMBLIES),
        ("limits.defaultMaxWireBytes", l::DEFAULT_MAX_WIRE_BYTES),
        ("limits.defaultMaxMetaBytes", l::DEFAULT_MAX_META_BYTES),
        ("limits.maxBulkAttachments", l::MAX_BULK_ATTACHMENTS),
        ("limits.maxStreams", l::MAX_STREAMS),
        ("limits.pingIntervalMs", l::PING_INTERVAL_MS),
        ("limits.stallMs", l::STALL_MS),
        ("limits.retryMs", l::RETRY_MS),
        ("limits.jsonMaxDepth", l::JSON_MAX_DEPTH),
        ("limits.opMaxLength", l::OP_MAX_LENGTH),
        ("limits.errorMessageMaxBytes", l::ERROR_MESSAGE_MAX_BYTES),
        ("limits.cancelReasonMaxBytes", l::CANCEL_REASON_MAX_BYTES),
        ("limits.dependsMax", l::DEPENDS_MAX),
    ] {
        assert_eq!(num(&c, path), value as u64, "{path}");
    }
    let listed = match c.at("limits") {
        Some(Json::Obj(m)) => m.len(),
        _ => panic!("constants.json has no limits object"),
    };
    assert_eq!(listed, 25, "the limits table gained or lost an entry");
}

#[test]
fn resource_handshake_and_op_bounds_match_the_fixture() {
    let c = constants();
    assert_eq!(num(&c, "resource.nsMaxBytes"), spec::resource::NS_MAX_BYTES as u64);
    assert_eq!(num(&c, "resource.keyMaxBytes"), spec::resource::KEY_MAX_BYTES as u64);
    assert_eq!(num(&c, "resource.revisionMaxBytes"), spec::resource::REVISION_MAX_BYTES as u64);
    assert_eq!(num(&c, "resource.renditionMaxBytes"), spec::resource::RENDITION_MAX_BYTES as u64);
    assert_eq!(num(&c, "handshake.nonceBytes"), spec::handshake::NONCE_BYTES as u64);
    assert_eq!(num(&c, "handshake.sessionHexLength"), spec::handshake::SESSION_HEX_LENGTH as u64);
    assert_eq!(num(&c, "handshake.appMaxBytes"), spec::handshake::APP_MAX_BYTES as u64);
    assert_eq!(num(&c, "handshake.versionsMax"), spec::handshake::VERSIONS_MAX as u64);
    assert_eq!(num(&c, "handshake.profilesMax"), spec::handshake::PROFILES_MAX as u64);
    assert_eq!(text(&c, "opPattern"), spec::OP_PATTERN);
    // A u64 session renders as 16 hex characters; the handshake constant and
    // the header width are two statements of the same fact.
    assert_eq!(
        spec::handshake::SESSION_HEX_LENGTH as usize,
        spec::header::SESSION_WIDTH * 2
    );
}

#[test]
fn preset_limits_come_from_the_fixture() {
    use pocket_relay::RxLimits;
    let c = constants();
    assert_eq!(RxLimits::CONTROL.max_wire_bytes as u64, num(&c, "limits.controlMaxWireBytes"));
    assert_eq!(RxLimits::CONTROL.window_frames as u64, num(&c, "limits.controlWindowFrames"));
    assert_eq!(RxLimits::CONTROL.window_bytes as u64, num(&c, "limits.controlWindowBytes"));
    assert_eq!(RxLimits::BULK.max_wire_bytes as u64, num(&c, "limits.bulkMaxWireBytes"));
    assert_eq!(RxLimits::BULK.max_meta_bytes as u64, num(&c, "limits.bulkMaxMetaBytes"));
    assert_eq!(RxLimits::BULK.max_assemblies as u64, num(&c, "limits.bulkMaxAssemblies"));
    assert_eq!(
        RxLimits::BOOTSTRAP.max_wire_bytes as u64,
        num(&c, "limits.bootstrapMaxWireBytes")
    );
    // Every preset must admit its own largest frame, or the window it pairs
    // with can never move.
    for preset in [RxLimits::CONTROL, RxLimits::BULK, RxLimits::BOOTSTRAP] {
        assert!(preset.window_bytes >= preset.max_wire_bytes, "{preset:?}");
    }
}
