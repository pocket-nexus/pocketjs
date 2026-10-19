/* PocketJS MicroTS Hero: a Rockbox plugin for the iPod nano 2G.
 *
 * The Rust library (hosts/ipodnano/src/lib.rs) owns the app and a persistent
 * RGB565 framebuffer. This file owns the Rockbox side: the heap and stack in
 * the audio buffer below the overlay, the 30 Hz deadline loop, buttons, LCD copies of the
 * damaged rectangles, and the timing log.
 */

#include "plugin.h"
#include "lib/helper.h"

#define HERO_WIDTH 176
#define HERO_HEIGHT 132
#define HERO_TICK_HZ 30
#define HERO_MAX_REGIONS 8
#define HERO_STACK_BYTES (128 * 1024)
#define HERO_LOG ROCKBOX_DIR "/pockethero.log"

void pockethero_start(void *heap, size_t length);
int pockethero_frame(unsigned buttons, int *rects);
const fb_data *pockethero_pixels(void);
int pockethero_count(void);
unsigned pockethero_heap_peak(void);
void pockethero_stop(void);

/* plugin_crt0.c */
int rb_atexit(void (*fn)(void));
void exit(int status) __attribute__((noreturn));

/* plugin.lds: this overlay's load address, near the top of the audio buffer. */
extern unsigned char plugin_start_addr[];

/* Rust's core objects name the ARM EHABI personality routines in their
 * unwind tables; panics abort, so nothing unwinds. */
void __aeabi_unwind_cpp_pr0(void) {}
void __aeabi_unwind_cpp_pr1(void) {}
void __aeabi_unwind_cpp_pr2(void) {}

struct hero_stats {
    unsigned long frames;
    unsigned long missed;
    unsigned long work_us;
    unsigned long work_max_us;
    unsigned long blit_us;
    unsigned long regions;
    unsigned long pixels;
    unsigned long mount_us;
    long started;
};

static struct hero_stats stats;
static size_t heap_bytes;
static bool usb_connected;

static void write_log(const char *reason)
{
    int fd = rb->open(HERO_LOG, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if (fd < 0)
        return;
    unsigned long frames = stats.frames ? stats.frames : 1;
    long elapsed = *rb->current_tick - stats.started;
    rb->fdprintf(fd, "exit: %s\n", reason);
    rb->fdprintf(fd, "frames: %lu\n", stats.frames);
    rb->fdprintf(fd, "elapsed_ticks: %ld (HZ %d)\n", elapsed, HZ);
    rb->fdprintf(fd, "missed_deadlines: %lu\n", stats.missed);
    rb->fdprintf(fd, "mount_us: %lu\n", stats.mount_us);
    rb->fdprintf(fd, "frame_us_avg: %lu\n", stats.work_us / frames);
    rb->fdprintf(fd, "frame_us_max: %lu\n", stats.work_max_us);
    rb->fdprintf(fd, "blit_us_avg: %lu\n", stats.blit_us / frames);
    rb->fdprintf(fd, "damage_regions: %lu\n", stats.regions);
    rb->fdprintf(fd, "damage_pixels: %lu\n", stats.pixels);
    rb->fdprintf(fd, "heap_peak: %u of %lu\n", pockethero_heap_peak(), (unsigned long)heap_bytes);
    rb->fdprintf(fd, "count: %d\n", pockethero_count());
    rb->fdprintf(fd, "cpu_hz: %ld\n", (long)*rb->cpu_frequency);
    rb->close(fd);
}

static void restore(void)
{
    backlight_use_settings();
    rb->cpu_boost(false);
}

/* Called by the Rust panic handler. exit() long-jumps back through
 * plugin_crt0, off the hero stack. */
void pockethero_fail(unsigned code, unsigned line)
{
    char reason[48];
    rb->snprintf(reason, sizeof reason, "fail %u at line %u", code, line);
    write_log(reason);
    rb->splashf(4 * HZ, "PocketJS: %s", reason);
    exit(1);
}

/* Wheel notches arrive as events; center, Play/Pause, previous and next are
 * read as held state. MENU leaves the plugin. */
static unsigned read_buttons(bool *quit)
{
    unsigned wheel = 0;
    long event;
    while ((event = rb->button_get(false)) != BUTTON_NONE) {
        if (event & SYS_EVENT) {
            if (rb->default_event_handler(event) == SYS_USB_CONNECTED) {
                usb_connected = true;
                *quit = true;
            }
            continue;
        }
        if ((event & BUTTON_MENU) && (event & BUTTON_REL))
            *quit = true;
        wheel |= event & (BUTTON_SCROLL_FWD | BUTTON_SCROLL_BACK);
    }
    return wheel | (rb->button_status() & (BUTTON_SELECT | BUTTON_PLAY | BUTTON_LEFT | BUTTON_RIGHT));
}

static void blit(const int *rects, int count)
{
    const fb_data *pixels = pockethero_pixels();
    for (int i = 0; i < count; i++) {
        const int *r = rects + i * 4;
        rb->lcd_bitmap_part(pixels, r[0], r[1], HERO_WIDTH, r[0], r[1], r[2], r[3]);
        rb->lcd_update_rect(r[0], r[1], r[2], r[3]);
        stats.pixels += (unsigned long)(r[2] * r[3]);
    }
    stats.regions += (unsigned long)count;
}

static void hero_main(void *heap)
{
    int rects[HERO_MAX_REGIONS * 4];
    unsigned long begin = USEC_TIMER;
    pockethero_start(heap, heap_bytes);
    stats.mount_us = USEC_TIMER - begin;
    stats.started = *rb->current_tick;

    /* Frame n is due at started + n * HZ / 30 ticks. A late frame moves the
     * schedule instead of queueing catch-up frames. */
    unsigned long due = 0;
    long base = stats.started;
    bool quit = false;
    while (!quit) {
        unsigned buttons = read_buttons(&quit);
        if (quit)
            break;
        unsigned long work = USEC_TIMER;
        int count = pockethero_frame(buttons, rects);
        unsigned long drawn = USEC_TIMER;
        blit(rects, count);
        unsigned long done = USEC_TIMER;
        unsigned long cost = drawn - work;
        stats.work_us += cost;
        if (cost > stats.work_max_us)
            stats.work_max_us = cost;
        stats.blit_us += done - drawn;
        stats.frames++;

        due++;
        long deadline = base + (long)(due * HZ / HERO_TICK_HZ);
        long now = *rb->current_tick;
        if (TIME_AFTER(now, deadline)) {
            stats.missed++;
            base = now;
            due = 0;
        } else {
            rb->sleep(deadline - now);
        }
    }
    write_log(usb_connected ? "usb" : "menu");
    pockethero_stop();
}

/* Runs fn(arg) with sp at stack_top. The main thread's 8 KiB IRAM stack is
 * too small for layout and rasterization. */
static void __attribute__((noinline)) call_on_stack(void (*fn)(void *), void *arg, void *stack_top)
{
    asm volatile(
        "mov r4, sp\n"
        "mov sp, %2\n"
        "mov r0, %1\n"
        "mov lr, pc\n"
        "bx %0\n"
        "mov sp, r4\n"
        :
        : "r"(fn), "r"(arg), "r"(stack_top)
        : "r0", "r1", "r2", "r3", "r4", "r12", "lr", "memory", "cc");
}

enum plugin_status plugin_start(const void *parameter)
{
    (void)parameter;
    size_t size;
    unsigned char *buffer = rb->plugin_get_audio_buffer(&size);
    /* run_overlay loaded this code at the top of the same buffer. */
    unsigned char *end = buffer + size;
    if (plugin_start_addr > buffer && plugin_start_addr < end)
        end = plugin_start_addr;
    if ((size_t)(end - buffer) < HERO_STACK_BYTES + 1024 * 1024) {
        rb->splash(2 * HZ, "PocketJS: audio buffer too small");
        return PLUGIN_ERROR;
    }
    /* Stack below the overlay, 8-byte aligned; heap below the stack. */
    unsigned char *stack_top = (unsigned char *)((uintptr_t)end & ~(uintptr_t)7);
    heap_bytes = (size_t)(stack_top - HERO_STACK_BYTES - buffer) & ~(size_t)7;

    rb->memset(&stats, 0, sizeof stats);
    usb_connected = false;
    rb_atexit(restore);
    rb->cpu_boost(true);
    backlight_ignore_timeout();
    rb->lcd_clear_display();
    rb->lcd_update();

    call_on_stack(hero_main, buffer, stack_top);
    restore();
    return usb_connected ? PLUGIN_USB_CONNECTED : PLUGIN_OK;
}
