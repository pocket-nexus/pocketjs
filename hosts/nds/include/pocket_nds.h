#ifndef POCKETJS_NDS_H
#define POCKETJS_NDS_H

#include <stddef.h>
#include <stdint.h>

#define POCKET_NDS_WIDTH 256
#define POCKET_NDS_HEIGHT 192
#define POCKET_NDS_TARGET_FPS 30
#define POCKET_NDS_VBLANKS_PER_FRAME 2

typedef struct PocketNdsApp PocketNdsApp;
typedef struct {
    uint32_t frames;
    uint32_t draw_words;
    int32_t focused;
    uint32_t counter;
    uint32_t damage_pixels;
    uint32_t damage_regions;
    uint32_t update_ticks;
    uint32_t draw_ticks;
    uint32_t raster_ticks;
} PocketNdsFrameStats;

typedef struct {
    uint16_t x0, y0, x1, y1;
} PocketNdsDamageRect;

/* Symbol retained for emulator memory inspection; fields are u32 little endian. */
typedef struct {
    uint32_t magic;          /* 0x53444e50: PNDS */
    uint32_t version;
    uint32_t status;         /* 0 booting, 1 running, 2 panic, 3 OOM, 4 assets, 5 raster */
    uint32_t frames;
    uint32_t buttons;
    uint32_t counter;
    uint32_t focused;
    uint32_t draw_words;
    uint32_t damage_pixels;
    uint32_t frame_us;
    uint32_t fps_x100;
    int32_t touch_x;
    int32_t touch_y;
    uint32_t update_us;
    uint32_t draw_us;
    uint32_t raster_us;
    uint32_t present_us;
    uint32_t copied_pixels;
    uint32_t deadline_misses; /* Cumulative late app frames, including initial drawing and interactions. */
    uint32_t target_fps;
} PocketNdsTelemetry;

extern volatile PocketNdsTelemetry pocket_nds_telemetry;
PocketNdsApp *pocket_nds_create(void);
int32_t pocket_nds_frame(PocketNdsApp *app, uint32_t buttons, int32_t touch_x, int32_t touch_y);
const uint16_t *pocket_nds_pixels(const PocketNdsApp *app);
const PocketNdsDamageRect *pocket_nds_damage(const PocketNdsApp *app);
void pocket_nds_stats(const PocketNdsApp *app, PocketNdsFrameStats *output);
void pocket_nds_destroy(PocketNdsApp *app);
void pocket_nds_fatal(uint32_t code, const uint8_t *message, size_t length) __attribute__((noreturn));
uint32_t pocket_nds_critical_enter(void);
void pocket_nds_critical_leave(uint32_t state);
uint32_t pocket_nds_clock_ticks(void);

#endif
