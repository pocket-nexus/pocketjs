/* The Tab5 keyboard (M5Stack A164): 70 keys behind an STM32 on Ext.Port1,
 * I2C address 0x6D with SDA on GPIO 0, SCL on GPIO 1 and its interrupt on
 * GPIO 50. The host runs it in character mode, where every press arrives
 * as the key's name (a character, or esc, del, tab, backspace, enter, up,
 * down, left, right) with the Ctrl and Alt state; the keyboard resolves
 * its own Sym and Aa layers. Each poll turns the pending presses into
 * pocket_text_event records: a character commits, a named key is a key
 * down and up pair named as KeyboardEvent.key names it (Enter, Backspace,
 * ArrowLeft), and a character with Ctrl or Alt held is a key pair named
 * Control+c or Alt+c. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocket_runtime.h"

/* Bring the keyboard up in character mode; false when none answers. */
bool tab5_keyboard_start(void);

/* Pending presses as text events. The events' text points into `storage`,
 * which the caller keeps until the input frame is appended. Returns the
 * count written, at most `capacity`. */
size_t tab5_keyboard_poll(pocket_text_event *events, size_t capacity,
                          char *storage, size_t storage_size);
