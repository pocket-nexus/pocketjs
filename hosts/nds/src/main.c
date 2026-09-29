/* ARM9 display and input for the compiled MicroTS Hero. No JavaScript VM. */
#include <nds.h>
#include <stdio.h>
#include <string.h>
#include "pocket_nds.h"
#include "pocket_nds_present.h"

volatile PocketNdsTelemetry pocket_nds_telemetry = {
    .magic = 0x53444e50, .version = 2, .touch_x = -1, .touch_y = -1,
    .target_fps = POCKET_NDS_TARGET_FPS,
};

static volatile uint32_t vblank_count;
static void count_vblank(void) { ++vblank_count; }

/* Timers 2 and 3 belong to Calico on current libnds. Use only 0 and 1. */
static void clock_init(void) {
    TIMER_CR(0) = 0;
    TIMER_CR(1) = 0;
    TIMER_DATA(0) = 0;
    TIMER_DATA(1) = 0;
    TIMER_CR(1) = TIMER_ENABLE | TIMER_CASCADE;
    TIMER_CR(0) = TIMER_ENABLE | TIMER_DIV_64;
}

uint32_t pocket_nds_clock_ticks(void) {
    uint16_t high, low;
    do {
        high = TIMER_DATA(1);
        low = TIMER_DATA(0);
    } while (high != TIMER_DATA(1));
    return ((uint32_t)high << 16) | low;
}

static uint32_t ticks_to_us(uint32_t ticks) {
    return (uint32_t)((uint64_t)ticks * 64000000 / BUS_CLOCK);
}

uint32_t pocket_nds_critical_enter(void) {
    return (uint32_t)enterCriticalSection();
}

void pocket_nds_critical_leave(uint32_t state) {
    leaveCriticalSection((int)state);
}

void pocket_nds_fatal(uint32_t code, const uint8_t *message, size_t length) {
    pocket_nds_telemetry.status = code;
    iprintf("\x1b[2JMicroTS Hero / Nintendo DS\n\nError %lu\n", (unsigned long)code);
    for (size_t index = 0; index < length; ++index) iprintf("%c", message[index]);
    iprintf("\n");
    for (;;) swiWaitForVBlank();
}

/* Pocket buttons use the same stable masks on every host. A activates the
 * focused action; B, X and Y retain their south/north/west face positions. */
static uint32_t pocket_buttons(uint32_t keys) {
    uint32_t buttons = 0;
    if (keys & KEY_A) buttons |= 0x2000;
    if (keys & KEY_B) buttons |= 0x4000;
    if (keys & KEY_X) buttons |= 0x1000;
    if (keys & KEY_Y) buttons |= 0x8000;
    if (keys & KEY_SELECT) buttons |= 0x0001;
    if (keys & KEY_START) buttons |= 0x0008;
    if (keys & KEY_UP) buttons |= 0x0010;
    if (keys & KEY_RIGHT) buttons |= 0x0020;
    if (keys & KEY_DOWN) buttons |= 0x0040;
    if (keys & KEY_LEFT) buttons |= 0x0080;
    if (keys & KEY_L) buttons |= 0x0100;
    if (keys & KEY_R) buttons |= 0x0200;
    return buttons;
}

static void diagnostics(void) {
    iprintf("\x1b[0;0HMicroTS Hero / Nintendo DS\n");
    iprintf("ARM9 / 256 x 192 / 30 FPS\n\n");
    iprintf("Frames: %-10lu\n", (unsigned long)pocket_nds_telemetry.frames);
    iprintf("Present: %lu.%02lu FPS     \n", (unsigned long)pocket_nds_telemetry.fps_x100 / 100,
        (unsigned long)pocket_nds_telemetry.fps_x100 % 100);
    iprintf("CPU: %lu.%03lu ms         \n", (unsigned long)pocket_nds_telemetry.frame_us / 1000,
        (unsigned long)pocket_nds_telemetry.frame_us % 1000);
    iprintf("Update: %-7lu us\n", (unsigned long)pocket_nds_telemetry.update_us);
    iprintf("Draw:   %-7lu us\n", (unsigned long)pocket_nds_telemetry.draw_us);
    iprintf("Raster: %-7lu us\n", (unsigned long)pocket_nds_telemetry.raster_us);
    iprintf("Copy:   %-7lu us\n", (unsigned long)pocket_nds_telemetry.present_us);
    iprintf("Draw words: %-8lu\n", (unsigned long)pocket_nds_telemetry.draw_words);
    iprintf("Counter: %-10lu\n", (unsigned long)pocket_nds_telemetry.counter);
    iprintf("Damage: %-10lu px\n", (unsigned long)pocket_nds_telemetry.damage_pixels);
    iprintf("Copied: %-10lu px\n", (unsigned long)pocket_nds_telemetry.copied_pixels);
    iprintf("Late frames: %-7lu\n\n", (unsigned long)pocket_nds_telemetry.deadline_misses);
    iprintf("D-pad: focus\nA: press / stylus: tap\n\n");
    iprintf("Live hardware input\n");
}

int main(void) {
    /* Main bitmap engine drives the lower touch LCD. Sub text engine reports
     * diagnostics on the upper LCD. A/B provide two 128 KiB bitmap pages. */
    videoSetMode(MODE_5_2D);
    videoSetModeSub(MODE_0_2D);
    vramSetBankA(VRAM_A_MAIN_BG_0x06000000);
    vramSetBankB(VRAM_B_MAIN_BG_0x06020000);
    vramSetBankC(VRAM_C_SUB_BG);
    lcdMainOnBottom();
    int background = bgInit(2, BgType_Bmp16, BgSize_B16_256x256, 0, 0);
    consoleInit(NULL, 0, BgType_Text4bpp, BgSize_T_256x256, 31, 0, false, true);
    iprintf("MicroTS Hero / Nintendo DS\n\nLoading compiled view...\n");
    clock_init();
    irqSet(IRQ_VBLANK, count_vblank);
    irqEnable(IRQ_VBLANK);

    PocketNdsApp *app = pocket_nds_create();
    if (!app) {
        static const uint8_t message[] = "Could not load baked styles/fonts/images";
        pocket_nds_fatal(4, message, sizeof(message) - 1);
    }
    consoleClear();

    unsigned int back_page = 1;
    PocketNdsPending pending[2];
    pocket_nds_pending_init(&pending[0]);
    pocket_nds_pending_init(&pending[1]);
    uint32_t deadline = vblank_count + POCKET_NDS_VBLANKS_PER_FRAME;
    uint32_t sample_start = pocket_nds_clock_ticks();
    uint32_t sample_frames = 0;
    for (;;) {
        scanKeys();
        uint32_t keys = keysHeld();
        uint32_t buttons = pocket_buttons(keys);
        int32_t touch_x = -1, touch_y = -1;
        if (keys & KEY_TOUCH) {
            touchPosition touch;
            touchRead(&touch);
            touch_x = touch.px;
            touch_y = touch.py;
        }
        uint32_t start = pocket_nds_clock_ticks();
        if (!pocket_nds_frame(app, buttons, touch_x, touch_y)) {
            static const uint8_t message[] = "DrawList rasterization failed";
            pocket_nds_fatal(5, message, sizeof(message) - 1);
        }
        PocketNdsFrameStats stats;
        pocket_nds_stats(app, &stats);
        uint32_t copy_start = pocket_nds_clock_ticks();
        const PocketNdsDamageRect *damage = pocket_nds_damage(app);
        uint32_t copied = 0;
        if (stats.damage_regions) {
            for (unsigned int region = 0; region < stats.damage_regions; ++region) {
                pocket_nds_pending_add(&pending[0], damage[region]);
                pocket_nds_pending_add(&pending[1], damage[region]);
            }
            const uint16_t *source = pocket_nds_pixels(app);
            volatile uint16_t *destination = (volatile uint16_t *)(0x06000000 + back_page * 0x20000);
            copied = pocket_nds_pending_copy(&pending[back_page], source, destination);
        }
        uint32_t rendered = pocket_nds_clock_ticks();

        /* Work consumes this interval's budget. Wait only for the remaining
         * VBlanks, or the next safe boundary after an overrun. Rebase there so
         * a slow frame cannot trigger a burst of catch-up updates. */
        do {
            swiWaitForVBlank();
        } while (!pocket_nds_deadline_reached(vblank_count, deadline));
        uint32_t presented = vblank_count;
        if (presented != deadline) ++pocket_nds_telemetry.deadline_misses;
        deadline = presented + POCKET_NDS_VBLANKS_PER_FRAME;
        if (copied) {
            bgSetMapBase(background, back_page * 8);
            back_page ^= 1;
        }

        pocket_nds_telemetry.buttons = buttons;
        pocket_nds_telemetry.counter = stats.counter;
        pocket_nds_telemetry.focused = (uint32_t)stats.focused;
        pocket_nds_telemetry.draw_words = stats.draw_words;
        pocket_nds_telemetry.damage_pixels = stats.damage_pixels;
        /* Publish every duration for this completed frame together. Writing
         * these before the wait would expose next-frame CPU/copy timings
         * alongside the previous frame's update/draw/raster timings. */
        pocket_nds_telemetry.frame_us = ticks_to_us(rendered - start);
        pocket_nds_telemetry.present_us = ticks_to_us(rendered - copy_start);
        pocket_nds_telemetry.update_us = ticks_to_us(stats.update_ticks);
        pocket_nds_telemetry.draw_us = ticks_to_us(stats.draw_ticks);
        pocket_nds_telemetry.raster_us = ticks_to_us(stats.raster_ticks);
        pocket_nds_telemetry.copied_pixels = copied;
        pocket_nds_telemetry.touch_x = touch_x;
        pocket_nds_telemetry.touch_y = touch_y;
        pocket_nds_telemetry.status = 1;
        /* Publish the frame number after all per-frame telemetry fields. */
        pocket_nds_telemetry.frames = stats.frames;
        ++sample_frames;
        uint32_t sample_end = pocket_nds_clock_ticks();
        uint32_t elapsed = sample_end - sample_start;
        if (stats.frames == 1 || elapsed >= BUS_CLOCK / 64) {
            if (elapsed) pocket_nds_telemetry.fps_x100 = (uint32_t)((uint64_t)sample_frames * BUS_CLOCK * 100 / (elapsed * (uint64_t)64));
            diagnostics();
            sample_start = sample_end;
            sample_frames = 0;
        }
    }
}
