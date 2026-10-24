/* The Tab5 keyboard over I2C (see tab5_keyboard.h). Register map of the
 * keyboard's firmware (m5stack/M5Tab5-Keyboard-Internal-FW, MIT):
 * 0x00 interrupt config, 0x01 interrupt status, 0x02 pending events, 0x10
 * mode (0 key, 1 HID, 2 character), 0x40 the next character event's byte
 * count, 0x50 the event itself (its modifier byte then the key's name;
 * reading pops it), 0xFE firmware version. */
#include "tab5_keyboard.h"

#include <ctype.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "pocket_spec.h"

#define KEYBOARD_ADDRESS 0x6D
#define KEYBOARD_SDA GPIO_NUM_0
#define KEYBOARD_SCL GPIO_NUM_1
/* The board's own bus (touch, IO expanders, camera) is I2C 1. */
#define KEYBOARD_PORT I2C_NUM_0
#define KEYBOARD_HZ 100000U
#define KEYBOARD_TIMEOUT_MS 20

#define REG_EVENT_COUNT 0x02
#define REG_MODE 0x10
#define REG_CHAR_LENGTH 0x40
#define REG_CHAR_EVENT 0x50
#define REG_VERSION 0xFE
#define MODE_CHARACTER 2

/* HID modifier bits in the event's first byte (left and right). */
#define MODIFIER_CTRL 0x11
#define MODIFIER_ALT 0x44

/* Presses taken per poll; the rest wait for the next frame. */
#define KEYBOARD_EVENTS_PER_POLL 8

static const char *TAG = "pocketjs_keyboard";
static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t device;

static bool read_registers(uint8_t reg, uint8_t *out, size_t count) {
  return i2c_master_transmit_receive(device, &reg, 1, out, count,
                                     KEYBOARD_TIMEOUT_MS) == ESP_OK;
}

static bool write_register(uint8_t reg, uint8_t value) {
  const uint8_t bytes[2] = {reg, value};
  return i2c_master_transmit(device, bytes, sizeof bytes,
                             KEYBOARD_TIMEOUT_MS) == ESP_OK;
}

bool tab5_keyboard_start(void) {
  const i2c_master_bus_config_t bus_config = {
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .i2c_port = KEYBOARD_PORT,
      .scl_io_num = KEYBOARD_SCL,
      .sda_io_num = KEYBOARD_SDA,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,
  };
  if (i2c_new_master_bus(&bus_config, &bus) != ESP_OK) {
    ESP_LOGW(TAG, "no I2C bus on GPIO %d/%d", KEYBOARD_SDA, KEYBOARD_SCL);
    return false;
  }
  if (i2c_master_probe(bus, KEYBOARD_ADDRESS, KEYBOARD_TIMEOUT_MS) != ESP_OK) {
    ESP_LOGI(TAG, "no keyboard at 0x%02x", KEYBOARD_ADDRESS);
    i2c_del_master_bus(bus);
    bus = NULL;
    return false;
  }
  const i2c_device_config_t device_config = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = KEYBOARD_ADDRESS,
      .scl_speed_hz = KEYBOARD_HZ,
  };
  if (i2c_master_bus_add_device(bus, &device_config, &device) != ESP_OK) {
    i2c_del_master_bus(bus);
    bus = NULL;
    return false;
  }
  uint8_t version = 0;
  if (!read_registers(REG_VERSION, &version, 1) ||
      !write_register(REG_MODE, MODE_CHARACTER)) {
    ESP_LOGW(TAG, "keyboard at 0x%02x does not answer", KEYBOARD_ADDRESS);
    i2c_master_bus_rm_device(device);
    i2c_del_master_bus(bus);
    device = NULL;
    bus = NULL;
    return false;
  }
  /* Presses made before the mode took effect carry the old format. */
  write_register(REG_EVENT_COUNT, 0);
  ESP_LOGI(TAG, "keyboard firmware %u, character mode", (unsigned)version);
  return true;
}

/* The KeyboardEvent.key name of a key the keyboard names, NULL for a key
 * the host does not forward (the layer keys and the modifiers). */
static const char *named_key(const char *name) {
  static const struct {
    const char *keyboard;
    const char *key;
  } NAMES[] = {
      {"esc", "Escape"},    {"del", "Delete"},       {"tab", "Tab"},
      {"backspace", "Backspace"}, {"enter", "Enter"}, {"up", "ArrowUp"},
      {"down", "ArrowDown"}, {"left", "ArrowLeft"},  {"right", "ArrowRight"},
  };
  for (size_t i = 0; i < sizeof NAMES / sizeof NAMES[0]; i++) {
    const char *a = NAMES[i].keyboard;
    const char *b = name;
    while (*a && *b && *a == (char)tolower((unsigned char)*b)) {
      ++a;
      ++b;
    }
    if (*a == '\0' && *b == '\0')
      return NAMES[i].key;
  }
  return NULL;
}

/* Append text to the storage; NULL when it does not fit. */
static char *store(char *storage, size_t storage_size, size_t *used,
                   const char *prefix, const char *text) {
  const size_t length = strlen(prefix) + strlen(text);
  if (*used + length > storage_size)
    return NULL;
  char *at = storage + *used;
  memcpy(at, prefix, strlen(prefix));
  memcpy(at + strlen(prefix), text, strlen(text));
  *used += length;
  return at;
}

static void key_pair(pocket_text_event *events, size_t *count,
                     const char *text, size_t length) {
  for (uint32_t kind = POCKET_TEXT_KEY_DOWN; kind <= POCKET_TEXT_KEY_UP;
       kind++) {
    events[(*count)++] = (pocket_text_event){
        .struct_size = sizeof(pocket_text_event),
        .kind = kind,
        .text = (const uint8_t *)text,
        .byte_length = length};
  }
}

size_t tab5_keyboard_poll(pocket_text_event *events, size_t capacity,
                          char *storage, size_t storage_size) {
  if (!device || capacity < 2)
    return 0;
  uint8_t pending = 0;
  if (!read_registers(REG_EVENT_COUNT, &pending, 1))
    return 0;
  size_t count = 0;
  size_t used = 0;
  for (unsigned taken = 0;
       pending > 0 && taken < KEYBOARD_EVENTS_PER_POLL && count + 2 <= capacity;
       ++taken, --pending) {
    uint8_t length = 0;
    if (!read_registers(REG_CHAR_LENGTH, &length, 1) || length < 2 ||
        length > 16)
      break;
    uint8_t packet[17];
    if (!read_registers(REG_CHAR_EVENT, packet, length))
      break;
    /* The event's first byte carries the Ctrl and Alt state, but keyboard
     * firmware 1 keeps Ctrl set in every event once the key was pressed
     * (its release never clears it), so the byte says nothing. Until a
     * firmware releases it, every press is plain. */
    const uint8_t modifier = 0;
    char name[16];
    memcpy(name, packet + 1, length - 1U);
    name[length - 1U] = '\0';
    const char *key = named_key(name);
    const bool character = key == NULL && strlen(name) == 1;
    if (!key && !character)
      continue;
    const char *prefix = (modifier & MODIFIER_CTRL)  ? "Control+"
                         : (modifier & MODIFIER_ALT) ? "Alt+"
                                                     : "";
    if (character && prefix[0] == '\0') {
      char *text = store(storage, storage_size, &used, "", name);
      if (!text)
        break;
      events[count++] = (pocket_text_event){
          .struct_size = sizeof(pocket_text_event),
          .kind = POCKET_TEXT_COMMIT,
          .text = (const uint8_t *)text,
          .byte_length = 1};
      continue;
    }
    if (character)
      name[0] = (char)tolower((unsigned char)name[0]);
    char *text = store(storage, storage_size, &used, prefix,
                       character ? name : key);
    if (!text)
      break;
    key_pair(events, &count, text, strlen(prefix) + strlen(character ? name : key));
  }
  return count;
}
