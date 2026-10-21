/*
 * The system agent's host side (agent.h, contracts/spec/agent.ts).
 *
 * Nothing here blocks a frame. The microphone writes into MICU's shared ring
 * and agent_pump copies what arrived since the last frame into an outbound
 * ring, which drains into the link's send buffer as space allows. A shot is
 * one display transfer of the touch screen's render target at the start of
 * the next frame, converted to RGB565 and drained the same way.
 */

#include "agent.h"

#include <3ds.h>
#include <malloc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jscan.h"
#include "link.h"
#include "pocket_core.h"
#include "stage.h"

/* contracts/spec/agent.ts */
#define AGENT_CHORD_FRAMES 6u
#define AGENT_MIC_RATE 16360u
#define AGENT_MIC_MAX_MS 30000u
#define AGENT_SHOT_W 320u
#define AGENT_SHOT_H 240u
#define AGENT_SHOT_BYTES (AGENT_SHOT_W * AGENT_SHOT_H * 2u)

/* contracts/spec/spec.ts BTN */
#define BTN_LTRIGGER 0x0100
#define BTN_RTRIGGER 0x0200
#define SHOULDERS (BTN_LTRIGGER | BTN_RTRIGGER)

/* contracts/spec/agent.ts AGENT_FONT_SLOT and AGENT_FONT_MAX_GLYPHS: an
 * atlas of 1200 15x18 cells plus its header and cmap. */
#define AGENT_FONT_SLOT 23u
#define GLYPHS_MAX_BYTES (16u + 1200u * 8u + 1200u * 15u * 18u)

#define MIC_SHARED_BYTES 0x30000u
/* MICU gain, 0..119 (about 0.5 dB a step). */
#define MIC_GAIN 0x40
#define MIC_RING_BYTES (96u * 1024u)
/* One data frame of microphone audio: 100 ms. */
#define MIC_CHUNK_BYTES 3272u
#define DATA_CHUNK (16u * 1024u)

static bool enabled;
static JsonBuffer events = {.limit = 64u * 1024u};
static JsonBuffer poll_out = {.limit = 66u * 1024u};
static JsonBuffer status_out = {.limit = 512u};
static bool was_available;

/* The chord. */
static int32_t previous_shoulders;
static int32_t held_back;
static uint32_t held_frames;
static int32_t pulse_out;
static bool chord;
static u64 chord_started;

/* The microphone. */
static u8 *mic_shared;
static bool mic_ready;
static bool listening;
static bool closing;
static bool close_send;
static uint32_t mic_stream;
static uint32_t mic_read;
static uint32_t mic_bytes;
static uint8_t *ring;
static uint32_t ring_head;
static uint32_t ring_tail;
static int32_t mic_level;
/* The loudest sample since listening began, and MICU's gain (status()). */
static int32_t mic_peak;
static uint8_t mic_gain;

/* A shot of the touch screen. */
static bool shot_wanted;
static uint32_t shot_stream;
static uint8_t *shot_rgb8;
static uint8_t *shot_pixels;
static uint32_t shot_sent;
static bool shot_streaming;

/* The agent's glyph atlas arriving. */
static uint8_t *glyph_bytes;
static uint32_t glyph_stream;
static uint32_t glyph_expected;
static uint32_t glyph_received;
static bool glyph_receiving;

/* A frame of the agent's own screen arriving. */
static uint8_t *own_pixels;
static uint32_t own_stream;
static uint32_t own_received;
static bool own_receiving;

static void event_text(const char *json) {
  if (!enabled) return;
  size_t mark = events.length;
  if (events.length > 0) jbuf_text(&events, ",");
  jbuf_text(&events, json);
  if (events.failed) {
    events.failed = false;
    events.length = mark;
    if (events.data != NULL) events.data[mark] = '\0';
  }
}

static void event_raw(const char *json, size_t length) {
  if (!enabled) return;
  size_t mark = events.length;
  if (events.length > 0) jbuf_text(&events, ",");
  jbuf_raw(&events, json, length);
  if (events.failed) {
    events.failed = false;
    events.length = mark;
    if (events.data != NULL) events.data[mark] = '\0';
  }
}

// ---------------------------------------------------------------------------
// microphone
// ---------------------------------------------------------------------------

static bool mic_open(void) {
  if (mic_ready) return true;
  if (mic_shared == NULL) mic_shared = memalign(0x1000, MIC_SHARED_BYTES);
  if (ring == NULL) ring = malloc(MIC_RING_BYTES);
  if (mic_shared == NULL || ring == NULL) return false;
  if (R_FAILED(micInit(mic_shared, MIC_SHARED_BYTES))) return false;
  MICU_SetPower(true);
  /* The default gain leaves speech at arm's length near the noise floor. */
  MICU_SetGain(MIC_GAIN);
  MICU_GetGain(&mic_gain);
  mic_ready = true;
  return true;
}

static void mic_close(void) {
  if (!mic_ready) return;
  MICU_StopSampling();
  micExit();
  mic_ready = false;
}

static uint32_t ring_used(void) {
  return ring_head - ring_tail;
}

static void ring_put(const uint8_t *bytes, uint32_t length) {
  for (uint32_t i = 0; i < length; i += 1) {
    if (ring_used() >= MIC_RING_BYTES) ring_tail += 2; /* the oldest sample goes */
    ring[ring_head % MIC_RING_BYTES] = bytes[i];
    ring_head += 1;
  }
}

static void stop_listening(bool send) {
  if (!listening) return;
  MICU_StopSampling();
  listening = false;
  closing = true;
  close_send = send;
  if (!send) ring_tail = ring_head;
  mic_level = 0;
  stage_set_level(0.0f);
}

static void read_mic(void) {
  if (!listening) return;
  uint32_t size = micGetSampleDataSize();
  uint32_t last = micGetLastSampleOffset();
  if (size == 0) return;
  /* The microphone writes the ring behind the CPU's cache. */
  if (mic_read != last) {
    if (last > mic_read) {
      GSPGPU_InvalidateDataCache(mic_shared + mic_read, last - mic_read);
    } else {
      GSPGPU_InvalidateDataCache(mic_shared + mic_read, size - mic_read);
      GSPGPU_InvalidateDataCache(mic_shared, last);
    }
  }
  uint64_t energy = 0;
  uint32_t samples = 0;
  uint8_t chunk[256];
  uint32_t filled = 0;
  while (mic_read != last) {
    int16_t sample;
    memcpy(&sample, mic_shared + mic_read, 2);
    energy += (uint64_t)((int32_t)sample * (int32_t)sample);
    int32_t magnitude = sample < 0 ? -(int32_t)sample : sample;
    if (magnitude > mic_peak) mic_peak = magnitude;
    samples += 1;
    memcpy(chunk + filled, &sample, 2);
    filled += 2;
    if (filled == sizeof chunk) {
      ring_put(chunk, filled);
      filled = 0;
    }
    mic_read = (mic_read + 2) % size;
  }
  if (filled > 0) ring_put(chunk, filled);
  mic_bytes += samples * 2;
  if (samples > 0) {
    float rms = sqrtf((float)energy / (float)samples) / 32768.0f;
    float db = rms > 0.00001f ? 20.0f * log10f(rms) : -100.0f;
    float scaled = (db + 50.0f) / 42.0f;
    if (scaled < 0.0f) scaled = 0.0f;
    if (scaled > 1.0f) scaled = 1.0f;
    mic_level = (int32_t)(scaled * 100.0f);
    stage_set_level(scaled);
  }
  if ((uint64_t)mic_bytes * 1000u / (AGENT_MIC_RATE * 2u) >= AGENT_MIC_MAX_MS) {
    char event[96];
    snprintf(event, sizeof event, "{\"t\":\"mic.stop\",\"id\":%lu,\"reason\":\"limit\"}", (unsigned long)mic_stream);
    event_text(event);
    stop_listening(true);
  }
}

static void drain_mic(void) {
  if (!listening && !closing) return;
  while (ring_used() >= MIC_CHUNK_BYTES || (closing && ring_used() > 0)) {
    uint32_t take = ring_used();
    if (take > MIC_CHUNK_BYTES) take = MIC_CHUNK_BYTES;
    uint8_t chunk[MIC_CHUNK_BYTES];
    for (uint32_t i = 0; i < take; i += 1) chunk[i] = ring[(ring_tail + i) % MIC_RING_BYTES];
    if (!link_send_data(mic_stream, chunk, take)) return; /* no room: next frame */
    ring_tail += take;
  }
  if (closing) {
    char end[96];
    int length = snprintf(end, sizeof end, "{\"t\":\"agent.audio.end\",\"id\":%lu,\"send\":%s}",
                          (unsigned long)mic_stream, close_send ? "true" : "false");
    if (link_send_ctrl(end, (size_t)length)) {
      closing = false;
      mic_close();
    }
  }
}

// ---------------------------------------------------------------------------
// shots
// ---------------------------------------------------------------------------

void agent_capture(C3D_RenderTarget *auxiliary) {
  if (!enabled || !shot_wanted || auxiliary == NULL) return;
  shot_wanted = false;
  if (shot_rgb8 == NULL) shot_rgb8 = linearAlloc(AGENT_SHOT_W * AGENT_SHOT_H * 3);
  if (shot_pixels == NULL) shot_pixels = malloc(AGENT_SHOT_BYTES);
  if (shot_rgb8 == NULL || shot_pixels == NULL) return;
  /* The target is 240 wide by 320 tall: rows run along the screen's width. */
  C3D_SyncDisplayTransfer(
    (u32 *)auxiliary->frameBuf.colorBuf,
    GX_BUFFER_DIM(AGENT_SHOT_H, AGENT_SHOT_W),
    (u32 *)shot_rgb8,
    GX_BUFFER_DIM(AGENT_SHOT_H, AGENT_SHOT_W),
    GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
      GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) | GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
      GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO)
  );
  GSPGPU_InvalidateDataCache(shot_rgb8, AGENT_SHOT_W * AGENT_SHOT_H * 3);
  /* B,G,R in rotated column-major order (tools/3ds-runtime-client.ts
   * decodePocketRuntimeSurface) to row-major RGB565, little-endian. */
  for (uint32_t y = 0; y < AGENT_SHOT_H; y += 1) {
    for (uint32_t x = 0; x < AGENT_SHOT_W; x += 1) {
      const uint8_t *source = shot_rgb8 + (x * AGENT_SHOT_H + (AGENT_SHOT_H - 1 - y)) * 3;
      uint16_t pixel = (uint16_t)(((source[2] >> 3) << 11) | ((source[1] >> 2) << 5) | (source[0] >> 3));
      uint8_t *out = shot_pixels + (y * AGENT_SHOT_W + x) * 2;
      out[0] = (uint8_t)pixel;
      out[1] = (uint8_t)(pixel >> 8);
    }
  }
  char head[160];
  int length = snprintf(head, sizeof head,
                        "{\"t\":\"agent.shot\",\"id\":%lu,\"width\":%u,\"height\":%u,\"format\":\"rgb565\",\"bytes\":%u}",
                        (unsigned long)shot_stream, AGENT_SHOT_W, AGENT_SHOT_H, AGENT_SHOT_BYTES);
  if (!link_send_ctrl(head, (size_t)length)) return;
  shot_sent = 0;
  shot_streaming = true;
}

static void drain_shot(void) {
  while (shot_streaming && shot_sent < AGENT_SHOT_BYTES) {
    uint32_t take = AGENT_SHOT_BYTES - shot_sent;
    if (take > DATA_CHUNK) take = DATA_CHUNK;
    if (!link_send_data(shot_stream, shot_pixels + shot_sent, take)) return;
    shot_sent += take;
  }
  shot_streaming = false;
}

// ---------------------------------------------------------------------------
// lifecycle and the chord
// ---------------------------------------------------------------------------

void agent_set_enabled(bool on) {
  if (!on) {
    stop_listening(false);
    jbuf_reset(&events);
    shot_wanted = false;
    shot_streaming = false;
    stage_set_mode(0);
    stage_set_screen(0);
  }
  if (on && !enabled) {
    was_available = link_agent_ready();
    stage_set_mode(0);
    stage_set_screen(0);
  }
  enabled = on;
  previous_shoulders = 0;
  held_back = 0;
  pulse_out = 0;
  chord = false;
}

bool agent_enabled(void) {
  return enabled;
}

void agent_shutdown(void) {
  stop_listening(false);
  closing = false;
  mic_close();
  if (mic_shared != NULL) free(mic_shared);
  mic_shared = NULL;
  free(ring);
  ring = NULL;
  if (shot_rgb8 != NULL) linearFree(shot_rgb8);
  shot_rgb8 = NULL;
  free(shot_pixels);
  shot_pixels = NULL;
  free(own_pixels);
  own_pixels = NULL;
  free(glyph_bytes);
  glyph_bytes = NULL;
  jbuf_free(&events);
  jbuf_free(&poll_out);
  jbuf_free(&status_out);
}

int32_t agent_filter_buttons(int32_t buttons) {
  if (!enabled) return buttons;
  int32_t shoulders = buttons & SHOULDERS;
  int32_t pressed = shoulders & ~previous_shoulders;
  previous_shoulders = shoulders;
  int32_t out = buttons & ~SHOULDERS;

  if (chord) {
    if (shoulders == 0) {
      chord = false;
      char event[64];
      uint32_t held_ms = (uint32_t)((svcGetSystemTick() - chord_started) * 1000u / SYSCLOCK_ARM11);
      snprintf(event, sizeof event, "{\"t\":\"chord.up\",\"heldMs\":%lu}", (unsigned long)held_ms);
      event_text(event);
    }
    return out;
  }
  if (shoulders == SHOULDERS && (pressed != 0 || held_back != 0)) {
    chord = true;
    chord_started = svcGetSystemTick();
    held_back = 0;
    pulse_out = 0;
    event_text("{\"t\":\"chord.down\"}");
    return out;
  }
  /* A shoulder pressed alone waits for its partner. */
  held_back |= pressed;
  if (held_back != 0) held_frames += 1;
  if (pressed != 0) held_frames = 0;
  int32_t released = held_back & ~shoulders;
  if (released != 0) {
    /* Let go inside the window: the guest gets the press as one pulse. */
    pulse_out |= released;
    held_back &= ~released;
  }
  if (held_back != 0 && held_frames >= AGENT_CHORD_FRAMES) held_back = 0;
  out |= shoulders & ~held_back;
  out |= pulse_out;
  pulse_out = 0;
  return out;
}

void agent_pump(void) {
  if (!enabled) return;
  bool available = link_agent_ready();
  if (available != was_available) {
    was_available = available;
    event_text(available ? "{\"t\":\"link\",\"available\":true}" : "{\"t\":\"link\",\"available\":false}");
    if (!available) {
      stop_listening(false);
      closing = false;
      mic_close();
      shot_streaming = false;
      own_receiving = false;
    }
  }
  read_mic();
  drain_mic();
  drain_shot();
}

// ---------------------------------------------------------------------------
// the link
// ---------------------------------------------------------------------------

bool agent_link_ctrl(const char *json, size_t length) {
  JsonSpan message = json_span(json, length);
  char type[32];
  if (!json_find_string(message, "t", type, sizeof type) || strncmp(type, "agent.", 6) != 0) return false;
  if (strcmp(type, "agent.screen") == 0) {
    uint64_t stream = 0, bytes = 0, width = 0, height = 0;
    if (json_find_u64(message, "stream", &stream) && json_find_u64(message, "bytes", &bytes) &&
        json_find_u64(message, "width", &width) && json_find_u64(message, "height", &height) &&
        width == AGENT_SHOT_W && height == AGENT_SHOT_H && bytes == AGENT_SHOT_BYTES) {
      if (own_pixels == NULL) own_pixels = malloc(AGENT_SHOT_BYTES);
      if (own_pixels != NULL) {
        own_stream = (uint32_t)stream;
        own_received = 0;
        own_receiving = true;
      }
    }
    return true;
  }
  if (strcmp(type, "agent.glyphs") == 0) {
    uint64_t stream = 0, bytes = 0, slot = 0;
    if (json_find_u64(message, "stream", &stream) && json_find_u64(message, "bytes", &bytes) &&
        json_find_u64(message, "slot", &slot) && slot == AGENT_FONT_SLOT && bytes > 16 &&
        bytes <= GLYPHS_MAX_BYTES) {
      if (glyph_bytes == NULL) glyph_bytes = malloc(GLYPHS_MAX_BYTES);
      if (glyph_bytes != NULL) {
        glyph_stream = (uint32_t)stream;
        glyph_expected = (uint32_t)bytes;
        glyph_received = 0;
        glyph_receiving = true;
      }
    }
    return true;
  }
  if (strcmp(type, "agent.delta") == 0) stage_pulse();
  event_raw(json, length);
  return true;
}

bool agent_link_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  if (glyph_receiving && stream == glyph_stream) {
    if (length > glyph_expected - glyph_received) {
      glyph_receiving = false;
      return true;
    }
    memcpy(glyph_bytes + glyph_received, bytes, length);
    glyph_received += (uint32_t)length;
    /* Loaded before the link reads the next frame, so the message that
     * needs these glyphs reaches the guest after them. A guest that is not
     * an agent guest has no use for them. */
    if (glyph_received == glyph_expected) {
      glyph_receiving = false;
      if (enabled && ui_load_font_atlas(glyph_bytes, glyph_expected) != 0) event_text("{\"t\":\"glyphs\"}");
    }
    return true;
  }
  if (!own_receiving || stream != own_stream) return false;
  if (length > AGENT_SHOT_BYTES - own_received) {
    own_receiving = false;
    return true;
  }
  memcpy(own_pixels + own_received, bytes, length);
  own_received += (uint32_t)length;
  if (own_received == AGENT_SHOT_BYTES) {
    own_receiving = false;
    stage_own_frame(own_pixels, AGENT_SHOT_W, AGENT_SHOT_H);
  }
  return true;
}

void agent_link_changed(bool up) {
  if (!up) {
    own_receiving = false;
    glyph_receiving = false;
  }
}

// ---------------------------------------------------------------------------
// globalThis.agent
// ---------------------------------------------------------------------------

const char *agent_poll(void) {
  if (events.length == 0) return NULL;
  jbuf_reset(&poll_out);
  jbuf_text(&poll_out, "[");
  jbuf_raw(&poll_out, events.data, events.length);
  jbuf_text(&poll_out, "]");
  jbuf_reset(&events);
  return jbuf_cstr(&poll_out);
}

bool agent_send(const char *json, size_t length) {
  if (!enabled || length < 10 || !link_agent_ready()) return false;
  JsonSpan message = json_span(json, length);
  char type[32];
  if (!json_find_string(message, "t", type, sizeof type) || strncmp(type, "agent.", 6) != 0) return false;
  return link_send_ctrl(json, length);
}

void agent_stage(int mode, int screen) {
  stage_set_mode(mode);
  stage_set_screen(screen);
}

int32_t agent_listen(int32_t command) {
  if (command == 1) {
    if (!enabled || listening || closing || !link_agent_ready() || !mic_open()) return 0;
    uint32_t size = micGetSampleDataSize();
    if (R_FAILED(MICU_StartSampling(MICU_ENCODING_PCM16_SIGNED, MICU_SAMPLE_RATE_16360, 0, size, true))) {
      mic_close();
      return 0;
    }
    mic_stream = link_new_stream();
    char head[128];
    int length = snprintf(head, sizeof head, "{\"t\":\"agent.audio\",\"id\":%lu,\"rate\":%u,\"format\":\"s16le\"}",
                          (unsigned long)mic_stream, AGENT_MIC_RATE);
    if (!link_send_ctrl(head, (size_t)length)) {
      MICU_StopSampling();
      mic_close();
      return 0;
    }
    mic_read = micGetLastSampleOffset();
    mic_bytes = 0;
    mic_peak = 0;
    ring_head = ring_tail = 0;
    listening = true;
    closing = false;
    return (int32_t)mic_stream;
  }
  stop_listening(command == 0);
  return 0;
}

int32_t agent_level(void) {
  return listening ? mic_level : 0;
}

int32_t agent_shot(void) {
  if (!enabled || shot_wanted || shot_streaming || !link_agent_ready()) return 0;
  shot_stream = link_new_stream();
  shot_wanted = true;
  return (int32_t)shot_stream;
}

const char *agent_status_json(void) {
  jbuf_reset(&status_out);
  jbuf_text(&status_out, "{\"available\":");
  jbuf_text(&status_out, link_agent_ready() ? "true" : "false");
  jbuf_text(&status_out, ",\"listening\":");
  jbuf_text(&status_out, listening ? "true" : "false");
  jbuf_text(&status_out, ",\"recordedMs\":");
  jbuf_u64(&status_out, (uint64_t)mic_bytes * 1000u / (AGENT_MIC_RATE * 2u));
  jbuf_text(&status_out, ",\"chord\":");
  jbuf_text(&status_out, chord ? "true" : "false");
  jbuf_text(&status_out, ",\"peak\":");
  jbuf_u64(&status_out, (uint64_t)mic_peak);
  jbuf_text(&status_out, ",\"gain\":");
  jbuf_u64(&status_out, mic_gain);
  jbuf_text(&status_out, "}");
  return jbuf_cstr(&status_out);
}
