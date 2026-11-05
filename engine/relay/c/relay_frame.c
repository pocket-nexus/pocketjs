/* Relay L1 frame decoding. See relay_frame.h for the scope of this layer.
 *
 * The check order here is the check order of framework/src/relay/frame.ts:
 * both return the first violated rule, so a given record produces the same
 * code in both languages and the shared byte vectors pin one answer per
 * vector. Length and limit checks run before any payload byte is read. */
#include "relay_frame.h"

/* Codecs defined by v1. An extension codec (0x8000..0xffff) reaches this
 * layer only through a negotiated RelayFrameLimits.codecs list. [R5-P04] */
static const uint16_t relay_defined_codecs[] = {
    0x0000u, /* none */
    0x0001u, /* json */
    0x0101u, /* r5g6b5le@1 */
    0x0102u, /* pocket-map.pmh1@1 */
    0x0103u, /* coverage2-lsb@1 */
    0x0104u, /* indexed8-abgr@1 */
    0x0201u, /* pocket-font3@1 */
    0x0301u, /* opaque-bytes@1 */
};

static uint16_t relay_u16le(const unsigned char *p) {
  return (uint16_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8));
}

static uint32_t relay_u32le(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t relay_u64le(const unsigned char *p) {
  return (uint64_t)relay_u32le(p) | ((uint64_t)relay_u32le(p + 4) << 32);
}

/* Strict UTF-8 over the whole metadata region: no overlong form, no
 * surrogate code point, nothing above U+10FFFF. The accepted byte ranges are
 * those of the TS metadata reader, so a region this function rejects is a
 * region the JSON layer above would also refuse. */
static bool relay_utf8_ok(const unsigned char *p, uint32_t n) {
  uint32_t i = 0;
  while (i < n) {
    unsigned char a = p[i];
    uint32_t trail;    /* continuation bytes after the first */
    unsigned char lo;  /* accepted range of the first continuation byte */
    unsigned char hi;
    if (a < 0x80u) {
      i++;
      continue;
    }
    if (a >= 0xc2u && a <= 0xdfu) {
      trail = 1u; lo = 0x80u; hi = 0xbfu;
    } else if (a == 0xe0u) {
      trail = 2u; lo = 0xa0u; hi = 0xbfu; /* no overlong three-byte form */
    } else if ((a >= 0xe1u && a <= 0xecu) || a == 0xeeu || a == 0xefu) {
      trail = 2u; lo = 0x80u; hi = 0xbfu;
    } else if (a == 0xedu) {
      trail = 2u; lo = 0x80u; hi = 0x9fu; /* no U+D800..U+DFFF */
    } else if (a == 0xf0u) {
      trail = 3u; lo = 0x90u; hi = 0xbfu; /* no overlong four-byte form */
    } else if (a >= 0xf1u && a <= 0xf3u) {
      trail = 3u; lo = 0x80u; hi = 0xbfu;
    } else if (a == 0xf4u) {
      trail = 3u; lo = 0x80u; hi = 0x8fu; /* stops at U+10FFFF */
    } else {
      return false; /* 0x80..0xc1 continuation or overlong lead, 0xf5..0xff */
    }
    if ((uint64_t)i + 1u + trail > (uint64_t)n) return false;
    if (p[i + 1] < lo || p[i + 1] > hi) return false;
    for (uint32_t k = 2u; k <= trail; k++) {
      if (p[i + k] < 0x80u || p[i + k] > 0xbfu) return false;
    }
    i += 1u + trail;
  }
  return true;
}

static bool relay_codec_allowed(const RelayFrameLimits *limits, uint16_t codec) {
  const uint16_t *set = limits->codecs;
  size_t count = limits->codec_count;
  if (set == NULL) {
    set = relay_defined_codecs;
    count = sizeof relay_defined_codecs / sizeof relay_defined_codecs[0];
  }
  for (size_t i = 0; i < count; i++) {
    if (set[i] == codec) return true;
  }
  return false;
}

RelayFrameLimits relay_frame_limits_default(void) {
  RelayFrameLimits limits;
  limits.max_wire_bytes = RELAY_DEFAULT_MAX_WIRE_BYTES;
  limits.max_meta_bytes = RELAY_DEFAULT_MAX_META_BYTES;
  limits.codecs = NULL;
  limits.codec_count = 0;
  limits.session = 0;
  limits.session_pinned = false;
  return limits;
}

uint64_t relay_frame_declared_wire_bytes(const unsigned char *prefix, size_t length) {
  if (length < RELAY_FRAME_LENGTH_PREFIX_BYTES) return 0;
  uint64_t frame_bytes = relay_u32le(prefix + RELAY_OFF_FRAME_BYTES);
  if (frame_bytes < RELAY_FRAME_HEADER_BODY_BYTES) return 0;
  return frame_bytes + RELAY_FRAME_LENGTH_PREFIX_BYTES;
}

RelayFrameStatus relay_frame_decode(const unsigned char *record, size_t length,
                                    const RelayFrameLimits *limits, RelayFrame *out) {
  RelayFrameLimits fallback = relay_frame_limits_default();
  if (limits == NULL) limits = &fallback;
  if (length < RELAY_FRAME_HEADER_BYTES) return RELAY_FRAME_SHORT_HEADER;

  /* Every declared length is widened before it is summed or compared, so a
   * u32 near the top of its range cannot wrap past a check. */
  uint64_t frame_bytes = relay_u32le(record + RELAY_OFF_FRAME_BYTES);
  if (frame_bytes < RELAY_FRAME_HEADER_BODY_BYTES) return RELAY_FRAME_BAD_PREFIX;
  uint64_t wire_bytes = frame_bytes + RELAY_FRAME_LENGTH_PREFIX_BYTES;
  /* The limit is applied before the declared payload size is trusted. */
  if (limits->max_wire_bytes != 0 && wire_bytes > (uint64_t)limits->max_wire_bytes) {
    return RELAY_FRAME_WIRE_TOO_LARGE;
  }
  if ((uint64_t)length < wire_bytes) return RELAY_FRAME_TRUNCATED;
  if ((uint64_t)length != wire_bytes) return RELAY_FRAME_BAD_LENGTH;

  if (record[RELAY_OFF_MAGIC] != 0x50u || record[RELAY_OFF_MAGIC + 1] != 0x52u
      || record[RELAY_OFF_MAGIC + 2] != 0x4cu || record[RELAY_OFF_MAGIC + 3] != 0x59u) {
    return RELAY_FRAME_BAD_MAGIC;
  }
  if (record[RELAY_OFF_MAJOR] != RELAY_FRAME_MAJOR || record[RELAY_OFF_MINOR] != RELAY_FRAME_MINOR) {
    return RELAY_FRAME_BAD_VERSION;
  }
  uint8_t type = record[RELAY_OFF_TYPE];
  if (type < RELAY_TYPE_REQUEST || type > RELAY_TYPE_INVALIDATE) return RELAY_FRAME_BAD_TYPE;
  if (record[RELAY_OFF_FLAGS] != 0) return RELAY_FRAME_BAD_FLAGS;
  if (relay_u16le(record + RELAY_OFF_HEADER_BYTES) != RELAY_FRAME_HEADER_BYTES) {
    return RELAY_FRAME_BAD_HEADER_SIZE;
  }

  uint16_t codec = relay_u16le(record + RELAY_OFF_CODEC);
  uint64_t session = relay_u64le(record + RELAY_OFF_SESSION);
  uint32_t seq = relay_u32le(record + RELAY_OFF_SEQ);
  uint32_t stream = relay_u32le(record + RELAY_OFF_STREAM);
  uint32_t correlation = relay_u32le(record + RELAY_OFF_CORRELATION);
  uint64_t meta_bytes = relay_u32le(record + RELAY_OFF_META_BYTES);
  uint64_t data_bytes = relay_u32le(record + RELAY_OFF_DATA_BYTES);
  if (relay_u32le(record + RELAY_OFF_RESERVED) != 0) return RELAY_FRAME_BAD_RESERVED;

  if (frame_bytes != (uint64_t)RELAY_FRAME_HEADER_BODY_BYTES + meta_bytes + data_bytes) {
    return RELAY_FRAME_BAD_LENGTH;
  }
  if (limits->max_meta_bytes != 0 && meta_bytes > (uint64_t)limits->max_meta_bytes) {
    return RELAY_FRAME_META_TOO_LARGE;
  }
  if (!relay_codec_allowed(limits, codec)) return RELAY_FRAME_BAD_CODEC;
  if (codec == RELAY_CODEC_NONE && data_bytes != 0) return RELAY_FRAME_BAD_CODEC;
  if (limits->session_pinned && session != limits->session) return RELAY_FRAME_BAD_SESSION;
  if (seq == 0) return RELAY_FRAME_BAD_SEQ;

  bool correlation_required = type == RELAY_TYPE_REQUEST || type == RELAY_TYPE_RESPONSE
                              || type == RELAY_TYPE_CANCEL;
  if (correlation_required ? correlation == 0 : correlation != 0) return RELAY_FRAME_BAD_CORRELATION;
  /* §3.6: a CANCEL rides the control stream; the request it aborts is named
   * by metadata.targetStream, so the header field decides this here. */
  if (type == RELAY_TYPE_CANCEL && stream != 0) return RELAY_FRAME_BAD_CORRELATION;

  const unsigned char *metadata = record + RELAY_FRAME_HEADER_BYTES;
  if (!relay_utf8_ok(metadata, (uint32_t)meta_bytes)) return RELAY_FRAME_BAD_METADATA;

  if (out != NULL) {
    out->type = type;
    out->codec = codec;
    out->session = session;
    out->seq = seq;
    out->stream = stream;
    out->correlation = correlation;
    out->metadata = metadata;
    out->metadata_bytes = (uint32_t)meta_bytes;
    out->data = metadata + meta_bytes;
    out->data_bytes = (uint32_t)data_bytes;
  }
  return RELAY_FRAME_OK;
}

const char *relay_frame_status_name(RelayFrameStatus status) {
  switch (status) {
    case RELAY_FRAME_OK: return "OK";
    case RELAY_FRAME_SHORT_HEADER: return "SHORT_HEADER";
    case RELAY_FRAME_BAD_PREFIX: return "BAD_PREFIX";
    case RELAY_FRAME_BAD_MAGIC: return "BAD_MAGIC";
    case RELAY_FRAME_BAD_VERSION: return "BAD_VERSION";
    case RELAY_FRAME_BAD_TYPE: return "BAD_TYPE";
    case RELAY_FRAME_BAD_FLAGS: return "BAD_FLAGS";
    case RELAY_FRAME_BAD_HEADER_SIZE: return "BAD_HEADER_SIZE";
    case RELAY_FRAME_BAD_RESERVED: return "BAD_RESERVED";
    case RELAY_FRAME_BAD_LENGTH: return "BAD_LENGTH";
    case RELAY_FRAME_TRUNCATED: return "TRUNCATED";
    case RELAY_FRAME_WIRE_TOO_LARGE: return "WIRE_TOO_LARGE";
    case RELAY_FRAME_META_TOO_LARGE: return "META_TOO_LARGE";
    case RELAY_FRAME_BAD_CODEC: return "BAD_CODEC";
    case RELAY_FRAME_BAD_SESSION: return "BAD_SESSION";
    case RELAY_FRAME_BAD_SEQ: return "BAD_SEQ";
    case RELAY_FRAME_BAD_CORRELATION: return "BAD_CORRELATION";
    case RELAY_FRAME_BAD_METADATA: return "BAD_METADATA";
  }
  return "UNKNOWN";
}

RelayAdmitResult relay_frame_admit(RelayFrameQueue *q, const unsigned char *record, size_t length,
                                   const RelayFrameLimits *limits, RelayFrameStatus *status,
                                   RelayFrame *frame) {
  RelayFrame local;
  RelayFrameStatus decoded = relay_frame_decode(record, length, limits, &local);
  if (status != NULL) *status = decoded;
  if (decoded != RELAY_FRAME_OK) return RELAY_ADMIT_REJECTED;
  if (length > (size_t)RELAY_FRAME_QUEUE_BYTES) {
    if (status != NULL) *status = RELAY_FRAME_WIRE_TOO_LARGE;
    return RELAY_ADMIT_REJECTED;
  }
  if (!relay_frame_queue_push(q, record, (uint32_t)length, local.seq)) return RELAY_ADMIT_BUSY;
  if (frame != NULL) *frame = local;
  return RELAY_ADMIT_ACCEPTED;
}
