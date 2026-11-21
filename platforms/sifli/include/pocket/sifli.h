#pragma once
#include "pocket/render_sifli_epic.h"
#include "pocket_drivers.h"
#include "pocket_runtime.h"
#include <rtthread.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* ---- Hooks (hooks/hooks.c) ------------------------------------------------
 * The pocket_host_* allocator serves the Rust archive and the QuickJS guest
 * from one rt_memheap of POCKETJS_HEAP_KB in cached PSRAM. Call once before
 * creating a runtime. */
int32_t pocket_sifli_heap_init(void);
typedef struct {
  size_t total, used, max_used;
} pocket_sifli_heap_stats;
void pocket_sifli_heap_stats_get(pocket_sifli_heap_stats *out);

/* A package the program links into flash or RAM. */
typedef struct {
  const uint8_t *data;
  size_t size;
} pocket_sifli_package;
const pocket_package_source_v1 *pocket_sifli_package_vtable(void);

/* ---- EPIC and VG Lite executor (epic/) --------------------------------------
 * One instance owns the EPIC engine and, on SF32LB58 with
 * POCKETJS_EPIC_VGLITE, VG Lite. `framebuffers` are the RGB565
 * targets displays hand out: device handle N names framebuffers[N - 1].
 * They are `width` x `height` pixels, 64-byte aligned, in memory EPIC and
 * the LCD controller read without CPU cache maintenance. The array is
 * copied; the storage outlives the executor. */
typedef struct {
  size_t struct_size;
  uint16_t *const *framebuffers;
  uint32_t framebuffer_count;
  uint32_t width, height;
} pocket_sifli_epic_config;
typedef struct pocket_sifli_epic pocket_sifli_epic;
/* POCKET_STATUS_UNSUPPORTED when an executor already exists. */
int32_t pocket_sifli_epic_create(const pocket_sifli_epic_config *config,
                                 pocket_sifli_epic **out);
const pocket_epic_ops *pocket_sifli_epic_ops(pocket_sifli_epic *epic);
typedef struct {
  size_t struct_size;
  /* DWT cycles spent programming the engines and waiting for them. */
  uint64_t submit_cycles, wait_cycles;
  uint32_t transactions, rejected, engine_switches, vglite_commands;
  uint32_t textures;
} pocket_sifli_epic_profile;
/* Copies the counters; `reset` clears them afterwards. */
void pocket_sifli_epic_profile_get(pocket_sifli_epic *epic, pocket_sifli_epic_profile *out,
                                   bool reset);
/* Waits for the engines before releasing them. */
void pocket_sifli_epic_destroy(pocket_sifli_epic *epic);

/* ---- Display (display/display.c) -------------------------------------------
 * A ring of framebuffers presented through the RT-Thread LCD device with
 * draw_rect_async. Targets are device-owned: acquire returns handle N for
 * framebuffers[N - 1], the same array the EPIC executor receives. Each
 * framebuffer is its own buffer identity, so damage history follows the
 * pixels each one retains. Acquire never returns the framebuffer the panel
 * scans. Flush starts one asynchronous present of the whole framebuffer;
 * wait returns at its tx_complete, or POCKET_STATUS_FAILED after
 * `wait_timeout_ms`, which keeps that framebuffer reserved until the present
 * completes. */
typedef struct {
  size_t struct_size;
  const char *device; /* "lcd" when NULL */
  uint16_t *const *framebuffers;
  uint32_t framebuffer_count; /* 2 through 4 */
  uint32_t width, height;     /* the LCD's physical size */
  uint8_t brightness;         /* percent */
  uint32_t wait_timeout_ms;
} pocket_sifli_display_config;
typedef struct pocket_sifli_display pocket_sifli_display;
pocket_sifli_display *pocket_sifli_display_create(const pocket_sifli_display_config *config);
const pocket_display_output_v1 *pocket_sifli_display_vtable(void);
/* After external writes to a framebuffer, while no runtime call is active:
 * pending presents finish and the next frame repaints everything. */
void pocket_sifli_display_invalidate(pocket_sifli_display *display);
/* Waits for the pending present and closes the LCD device. The panel may
 * keep scanning the last framebuffer: it outlives the display. */
void pocket_sifli_display_destroy(pocket_sifli_display *display);

/* ---- Keys (input/keys.c) ----------------------------------------------------
 * Board pins sampled at poll. A key reports its buttons while its level
 * matches `active_high` and has held for `debounce_ms`. The program
 * configures pin mode; the mapping is copied. */
typedef struct {
  rt_base_t pin;
  uint32_t buttons;
  bool active_high;
} pocket_sifli_key;
typedef struct {
  size_t struct_size;
  const pocket_sifli_key *keys;
  size_t key_count;
  uint32_t debounce_ms;
} pocket_sifli_keys_config;
typedef struct pocket_sifli_keys pocket_sifli_keys;
pocket_sifli_keys *pocket_sifli_keys_create(const pocket_sifli_keys_config *config);
const pocket_input_source_v1 *pocket_sifli_keys_vtable(void);
/* Buttons the last poll reported, for program shortcuts. */
uint32_t pocket_sifli_keys_state(const pocket_sifli_keys *keys);
void pocket_sifli_keys_destroy(pocket_sifli_keys *keys);

/* ---- Touch (input/touch.c) --------------------------------------------------
 * One contact from the RT-Thread touch device. Panel coordinates are divided
 * by `scale` into logical pixels. */
typedef struct {
  size_t struct_size;
  const char *device; /* "touch" when NULL */
  uint32_t scale;
  uint32_t logical_width, logical_height;
} pocket_sifli_touch_config;
typedef struct pocket_sifli_touch pocket_sifli_touch;
pocket_sifli_touch *pocket_sifli_touch_create(const pocket_sifli_touch_config *config);
const pocket_input_source_v1 *pocket_sifli_touch_vtable(void);
/* Releases the contact; the next poll reports it cancelled. */
void pocket_sifli_touch_cancel(pocket_sifli_touch *touch);
void pocket_sifli_touch_destroy(pocket_sifli_touch *touch);

/* ---- Guest (guest/guest.c) --------------------------------------------------
 * The generated QuickJS guest with a heap and stack limit and thread-safe
 * cancellation. */
typedef struct {
  size_t struct_size;
  size_t heap_limit, stack_limit;
} pocket_sifli_guest_config;
typedef struct pocket_sifli_guest pocket_sifli_guest;
pocket_sifli_guest *pocket_sifli_guest_create(const pocket_sifli_guest_config *config);
const pocket_guest_v1 *pocket_sifli_guest_vtable(void);
const char *pocket_sifli_guest_error(const pocket_sifli_guest *guest);
void pocket_sifli_guest_interrupt(pocket_sifli_guest *guest);
/* Only after pocket_runtime_destroy released the registered guest. */
void pocket_sifli_guest_destroy(pocket_sifli_guest *guest);

/* ---- Runner (runner/runner.c) -----------------------------------------------
 * The one thread that ticks a runtime at the profile rate. before_tick and
 * after_tick run on that thread between ticks, where a program switches
 * runtimes or reads statistics. */
typedef struct {
  size_t struct_size;
  const char *name;
  uint32_t stack_bytes;
  uint8_t priority;
  uint32_t tick_slice;
  uint64_t max_lag_us;
  uint32_t stop_timeout_ms;
  void (*before_tick)(void *user);
  void (*after_tick)(int32_t status, void *user);
  void (*interrupt)(void *user);
  void *user;
} pocket_sifli_runner_config;
typedef struct {
  size_t struct_size;
  uint32_t frames, frames_skipped, frame_errors, max_frame_us;
} pocket_sifli_runner_stats;
typedef struct pocket_sifli_runner pocket_sifli_runner;
void pocket_sifli_runner_config_defaults(pocket_sifli_runner_config *config);
/* The runtime is booted. The runner ticks at the cadence
 * pocket_runtime_get_timing reports; each tick advances its core_ticks. */
int32_t pocket_sifli_runner_start(pocket_runtime *runtime,
                                  const pocket_sifli_runner_config *config,
                                  pocket_sifli_runner **out);
/* Replaces the runtime between ticks; call from before_tick. A booted
 * replacement with another cadence restarts the schedule at it. */
void pocket_sifli_runner_set_runtime(pocket_sifli_runner *runner, pocket_runtime *runtime);
int32_t pocket_sifli_runner_stats_get(pocket_sifli_runner *runner, pocket_sifli_runner_stats *out);
/* Interrupts the guest, wakes the thread and joins it. POCKET_STATUS_FAILED
 * after `stop_timeout_ms` keeps the runner and its contexts alive. */
int32_t pocket_sifli_runner_stop(pocket_sifli_runner *runner);

#ifdef __cplusplus
}
#endif
