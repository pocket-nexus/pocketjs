/* Nintendo 3DS host development menu.
 *
 * This module emits a small host-owned DrawList. The existing PICA200 backend
 * renders it instead of the guest's auxiliary list while the menu is open.
 * Using one renderer and one GPU state model keeps the menu independent from
 * the guest without mixing Citro2D state into PocketJS's command buffer.
 */

#include "devmenu.h"

#include <ctype.h>
#include <stdio.h>

#include "devserver.h"

#define DRAW_RECT 1u
#define MENU_WORD_CAPACITY 12288u
#define ABGR(r, g, b, a) \
  ((uint32_t)(r) | ((uint32_t)(g) << 8) | ((uint32_t)(b) << 16) | ((uint32_t)(a) << 24))

static uint32_t words[MENU_WORD_CAPACITY];
static size_t word_count;
static bool initialized;
static bool visible;
static bool link_state_known;
static bool last_connected;
static char notice[32] = "WAITING FOR CLIENT";
/* The Pocket Link's state line (link_describe), handed in by main.c. */
static char link_line[48] = "NOT PAIRED";

/* Five-bit rows for 0-9 then A-Z. Lowercase input maps to uppercase so native
 * Runtime phases can be printed without carrying a second alphabet. */
static const uint8_t glyphs[36][7] = {
  { 0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e },
  { 0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e },
  { 0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f },
  { 0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e },
  { 0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02 },
  { 0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x1e },
  { 0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e },
  { 0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08 },
  { 0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e },
  { 0x0e, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e },
  { 0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11 },
  { 0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e },
  { 0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e },
  { 0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e },
  { 0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f },
  { 0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10 },
  { 0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f },
  { 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11 },
  { 0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e },
  { 0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c },
  { 0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11 },
  { 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f },
  { 0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11 },
  { 0x11, 0x19, 0x19, 0x15, 0x13, 0x13, 0x11 },
  { 0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e },
  { 0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10 },
  { 0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d },
  { 0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11 },
  { 0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e },
  { 0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04 },
  { 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e },
  { 0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04 },
  { 0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a },
  { 0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11 },
  { 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04 },
  { 0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f },
};

static const uint8_t *glyph_rows(char value) {
  static const uint8_t blank[7] = {0};
  static const uint8_t dot[7] = { 0, 0, 0, 0, 0, 0x06, 0x06 };
  static const uint8_t colon[7] = { 0, 0x04, 0x04, 0, 0x04, 0x04, 0 };
  static const uint8_t dash[7] = { 0, 0, 0, 0x0e, 0, 0, 0 };
  static const uint8_t slash[7] = { 0x01, 0x02, 0x04, 0x04, 0x08, 0x10, 0 };
  static const uint8_t question[7] = { 0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04 };
  unsigned char c = (unsigned char)value;
  if (c >= 'a' && c <= 'z') c = (unsigned char)toupper(c);
  if (c >= '0' && c <= '9') return glyphs[c - '0'];
  if (c >= 'A' && c <= 'Z') return glyphs[10 + c - 'A'];
  switch (c) {
    case ' ': return blank;
    case '.': return dot;
    case ':': return colon;
    case '-': return dash;
    case '/': return slash;
    default: return question;
  }
}

static uint32_t packed_xy(uint32_t x, uint32_t y) {
  return (x & 0xffffu) | ((y & 0xffffu) << 16);
}

static void rect(
  uint32_t x,
  uint32_t y,
  uint32_t width,
  uint32_t height,
  uint32_t color
) {
  if (width == 0 || height == 0 || word_count + 4 > MENU_WORD_CAPACITY) return;
  words[word_count++] = DRAW_RECT;
  words[word_count++] = packed_xy(x, y);
  words[word_count++] = packed_xy(width, height);
  words[word_count++] = color;
}

static void text(
  uint32_t x,
  uint32_t y,
  uint32_t pixel,
  uint32_t color,
  const char *value
) {
  if (value == NULL || pixel == 0) return;
  uint32_t pen = x;
  for (size_t index = 0; value[index] != '\0'; index += 1) {
    if (pen + 5 * pixel > 320) break;
    const uint8_t *rows = glyph_rows(value[index]);
    for (uint32_t row = 0; row < 7; row += 1) {
      uint32_t column = 0;
      while (column < 5) {
        while (column < 5 && (rows[row] & (1u << (4 - column))) == 0) column += 1;
        uint32_t start = column;
        while (column < 5 && (rows[row] & (1u << (4 - column))) != 0) column += 1;
        if (column > start) {
          rect(
            pen + start * pixel,
            y + row * pixel,
            (column - start) * pixel,
            pixel,
            color
          );
        }
      }
    }
    pen += 6 * pixel;
  }
}

bool devmenu_init(void) {
  initialized = true;
  visible = false;
  link_state_known = false;
  return true;
}

void devmenu_shutdown(void) {
  initialized = false;
  visible = false;
  word_count = 0;
}

bool devmenu_visible(void) {
  return initialized && visible;
}

void devmenu_toggle(void) {
  if (initialized) visible = !visible;
}

void devmenu_hide(void) {
  visible = false;
}

void devmenu_set_link_line(const char *value) {
  snprintf(link_line, sizeof link_line, "%s", value == NULL ? "" : value);
}

void devmenu_set_notice(const char *value) {
  snprintf(notice, sizeof notice, "%s", value == NULL ? "" : value);
}

const uint32_t *devmenu_draw_list(size_t *length) {
  if (length == NULL) return NULL;
  *length = 0;
  if (!devmenu_visible()) return NULL;

  DevserverSnapshot state;
  devserver_snapshot(&state);
  if (!link_state_known || state.connected != last_connected) {
    snprintf(
      notice,
      sizeof notice,
      "%s",
      state.connected ? "CLIENT READY" : "WAITING FOR CLIENT"
    );
    last_connected = state.connected;
    link_state_known = true;
  }
  word_count = 0;

  const uint32_t white = ABGR(248, 250, 252, 255);
  const uint32_t muted = ABGR(148, 163, 184, 255);
  const uint32_t cyan = ABGR(103, 232, 249, 255);
  const uint32_t link = state.connected
    ? ABGR(74, 222, 128, 255)
    : state.discoverable
      ? ABGR(250, 204, 21, 255)
      : ABGR(248, 113, 113, 255);

  rect(0, 0, 320, 240, ABGR(7, 13, 29, 255));
  rect(0, 0, 320, 32, ABGR(16, 27, 52, 255));
  rect(0, 32, 4, 208, ABGR(34, 211, 238, 255));
  text(12, 8, 2, white, "POCKET RUNTIME");

  char line[96];
  snprintf(line, sizeof line, "3DS ABI %u", (unsigned)state.host_abi);
  text(238, 12, 1, cyan, line);
  text(14, 43, 1, muted, "DEV LINK");
  text(
    94,
    39,
    2,
    link,
    state.connected
      ? "CONNECTED"
      : state.discoverable
        ? "DISCOVERABLE"
        : state.enabled
          ? "TCP ONLY"
          : "NOT PAIRED"
  );

  if (state.enabled) snprintf(line, sizeof line, "%s:%u", state.ip, (unsigned)state.port);
  else snprintf(line, sizeof line, "START FTPD THEN PAIR --HOST IP");
  text(14, 67, state.enabled ? 2 : 1, white, line);

  snprintf(
    line,
    sizeof line,
    "ID %016llX  GEN %lu",
    (unsigned long long)state.device_id,
    (unsigned long)state.generation
  );
  text(14, 91, 1, muted, line);
  snprintf(
    line,
    sizeof line,
    "RUN %016llX  %s",
    (unsigned long long)state.running_hash,
    state.phase
  );
  text(14, 105, 1, white, line);
  snprintf(
    line,
    sizeof line,
    "UP %lu SHOT %lu CONN %lu ERR %lu",
    (unsigned long)state.uploads,
    (unsigned long)state.screenshots,
    (unsigned long)state.connects,
    (unsigned long)(state.auth_failures + state.timeouts)
  );
  text(14, 119, 1, muted, line);
  snprintf(line, sizeof line, "POCKET LINK %s", link_line);
  text(14, 131, 1, cyan, line);

  rect(12, 143, 296, 58, ABGR(15, 23, 42, 255));
  text(20, 151, 1, cyan, "ON YOUR MAC AUTO DISCOVERY");
  text(20, 169, 1, white, "BUN RUN 3DS:DEV DEV --NO-PUSH");
  text(14, 217, 1, muted, "X SCREENSHOT  B CLOSE");
  text(188, 217, 1, cyan, notice);

  *length = word_count;
  return words;
}
