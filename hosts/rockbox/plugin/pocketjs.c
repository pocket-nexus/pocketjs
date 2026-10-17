/* PocketJS Rockbox plugin: input, frame pacing and LCD updates around the
 * Rust host in hosts/rockbox/src/lib.rs. */

#include "plugin.h"

/* Not PLUGIN_DATA_DIR, which is /.rockbox/rocks on native targets. */
#define PJS_DATA_DIR ROCKBOX_DIR "/rocks.data/pocketjs"

#define STACK_SIZE (256 * 1024)
#define BUSY_PERIOD 3 /* ticks; the app clock runs at 33 Hz */
#define IDLE_PERIOD (HZ / 10)
#define IDLE_AFTER HZ
#define HOME_HOLD (HZ * 4 / 10) /* docs/HIG.md system chords: hold 400 ms */

#ifdef PJS_PERF_HUD
#define HUD_H 10
#define STACK_FILL 0xdeadbeef
#else
#define HUD_H 0
#endif

/* Button bits, shared with lib.rs */
#define PJ_UP     1
#define PJ_DOWN   2
#define PJ_SELECT 4
#define PJ_MENU   8
#define PJ_LEFT   16
#define PJ_RIGHT  32
#define PJ_PLAY   64

int pocketjs_init(void *heap, size_t heap_len, int w, int h);
int pocketjs_frame(fb_data *fb, int w, int h, unsigned buttons, int wheel,
                   int (*rects)[4]);
void pocketjs_timings(uint32_t *out);
void pocketjs_invalidate(void);

static unsigned long *stack;
static void *heap;
static size_t heap_len;
static enum plugin_status status = PLUGIN_OK;

uint32_t pocketjs_host_usec(void)
{
#ifdef USEC_TIMER
    return USEC_TIMER;
#else
    return *rb->current_tick * (1000000 / HZ);
#endif
}

int pocketjs_host_read(const char *path, unsigned char *buf, int max)
{
    char full[MAX_PATH];
    int fd, n;

    rb->snprintf(full, sizeof(full), PJS_DATA_DIR "/%s", path);
    fd = rb->open(full, O_RDONLY);
    if (fd < 0)
        return -1;
    n = buf ? rb->read(fd, buf, max) : (int)rb->lseek(fd, 0, SEEK_END);
    rb->close(fd);
    return n;
}

void pocketjs_host_panic(const char *msg) NORETURN_ATTR;
void pocketjs_host_panic(const char *msg)
{
    int y = 12, cols = LCD_WIDTH / 6;
    char line[64];

    rb->lcd_set_viewport(NULL);
    rb->lcd_set_drawmode(DRMODE_SOLID);
    rb->lcd_set_foreground(LCD_WHITE);
    rb->lcd_set_background(LCD_RGBPACK(160, 0, 0));
    rb->lcd_clear_display();
    rb->lcd_putsxy(0, 0, "PocketJS panic (MENU+SELECT to reset)");
    while (*msg && y < LCD_HEIGHT - 10) {
        int n = MIN((int)rb->strlen(msg), MIN(cols, (int)sizeof(line) - 1));
        rb->strlcpy(line, msg, n + 1);
        rb->lcd_putsxy(0, y, line);
        msg += n;
        y += 10;
    }
    rb->lcd_update();
    for (;;)
        rb->sleep(HZ);
}

static unsigned map_button(long b)
{
    unsigned bits = 0;
    if (b & BUTTON_SCROLL_BACK) bits |= PJ_UP;
    if (b & BUTTON_SCROLL_FWD)  bits |= PJ_DOWN;
    if (b & BUTTON_SELECT)      bits |= PJ_SELECT;
    if (b & BUTTON_MENU)        bits |= PJ_MENU;
    if (b & BUTTON_LEFT)        bits |= PJ_LEFT;
    if (b & BUTTON_RIGHT)       bits |= PJ_RIGHT;
    if (b & BUTTON_PLAY)        bits |= PJ_PLAY;
    return bits;
}

static void set_boost(bool *boosted, bool on)
{
#ifdef HAVE_ADJUSTABLE_CPU_FREQ
    if (*boosted != on)
        rb->cpu_boost(on);
#endif
    *boosted = on;
}

/* The docs/HIG.md system sheet: the app pauses while Rockbox draws the menu
 * over its framebuffer, and repaints in full afterwards. */
static int system_menu(void)
{
    MENUITEM_STRINGLIST(menu, "PocketJS", NULL, "Resume", "Quit");
    int selected = 0, result;

    /* Wait for the Menu release; button_get also pumps simulator input. */
    while (rb->button_status() & BUTTON_MENU)
        rb->button_get_w_tmo(HZ / 20);
    rb->button_clear_queue();
    result = rb->do_menu(&menu, &selected, NULL, false);
    rb->lcd_set_viewport(NULL);
    rb->lcd_set_drawmode(DRMODE_SOLID);
    rb->lcd_set_foreground(LCD_WHITE);
    rb->lcd_set_background(LCD_BLACK);
    pocketjs_invalidate();
    return result;
}

#ifdef PJS_PERF_HUD
struct perf {
    unsigned frames;
    unsigned long phase[4]; /* µs: model, draw, raster, LCD */
    unsigned long area, stack;
    long since;
};

static void average(unsigned long *acc, unsigned long sample)
{
    *acc = *acc ? (*acc * 7 + sample) / 8 : sample;
}

static size_t stack_used(void)
{
    size_t i, words = STACK_SIZE / sizeof(*stack);
    for (i = 0; i < words && stack[i] == STACK_FILL; i++)
        ;
    return (words - i) * sizeof(*stack);
}

/* The strip repaints solid because the damage tracker keeps untouched pixels. */
static void draw_perf_hud(struct perf *perf, bool boosted)
{
    char text[64];
    long now = *rb->current_tick;

    if (!(perf->frames & 31))
        perf->stack = stack_used();
    rb->snprintf(text, sizeof(text), "%ld%c m%lu d%lu r%lu l%lu a%lu%% s%luK",
                 16 * HZ / MAX(now - perf->since, 1), boosted ? 'B' : 'i',
                 perf->phase[0] / 1000, perf->phase[1] / 1000,
                 perf->phase[2] / 1000, perf->phase[3] / 1000,
                 perf->area, perf->stack / 1024);
    perf->since = now;
    rb->lcd_set_drawmode(DRMODE_SOLID | DRMODE_INVERSEVID);
    rb->lcd_fillrect(0, LCD_HEIGHT - HUD_H, LCD_WIDTH, HUD_H);
    rb->lcd_set_drawmode(DRMODE_SOLID);
    rb->lcd_putsxy(2, LCD_HEIGHT - HUD_H + 1, text);
    rb->lcd_update_rect(0, LCD_HEIGHT - HUD_H, LCD_WIDTH, HUD_H);
}
#endif

static void run(void)
{
    struct viewport *vp = rb->lcd_set_viewport(NULL);
    fb_data *fb = vp->buffer->fb_ptr;
    int rects[8][4], count, ret;
    long b = BUTTON_NONE, menu_down = 0, now, left, frame_start, last_active;
    bool boosted = false, menu_held = false;
    size_t i;
#ifdef PJS_PERF_HUD
    struct perf perf = { 0 };
    uint32_t t[3], lcd_start;
#endif

    set_boost(&boosted, true);
    ret = pocketjs_init(heap, heap_len, LCD_WIDTH, LCD_HEIGHT);
    if (ret != 0) {
        set_boost(&boosted, false);
        rb->splashf(HZ * 4, ret == -2
                    ? "PocketJS: font or image missing in " PJS_DATA_DIR
                    : "PocketJS: init failed (%d)", ret);
        status = PLUGIN_ERROR;
        return;
    }
    last_active = *rb->current_tick;
#ifdef PJS_PERF_HUD
    perf.since = last_active;
#endif
    rb->lcd_set_foreground(LCD_WHITE);
    rb->lcd_set_background(LCD_BLACK);

    for (;;) {
        unsigned held = map_button(rb->button_status()) & ~(PJ_UP | PJ_DOWN | PJ_MENU);
        int wheel = 0;

        frame_start = *rb->current_tick;
        /* Holding Menu opens the system menu and never reaches the app.
         * A shorter press reaches the app as back for one frame on release.
         * Wheel steps are summed per frame and delivered as a relative axis. */
        if (b == BUTTON_NONE)
            b = rb->button_get(false);
        for (; b != BUTTON_NONE; b = rb->button_get(false)) {
            if (b & SYS_EVENT) {
                if (rb->default_event_handler(b) == SYS_USB_CONNECTED) {
                    status = PLUGIN_USB_CONNECTED;
                    goto out;
                }
            } else if (b == BUTTON_MENU) {
                menu_held = true;
                menu_down = frame_start;
            } else if (b == (BUTTON_MENU | BUTTON_REL)) {
                if (menu_held)
                    held |= PJ_MENU;
                menu_held = false;
            } else if (!(b & BUTTON_REL)) {
                if (b & BUTTON_SCROLL_FWD)
                    wheel++;
                else if (b & BUTTON_SCROLL_BACK)
                    wheel--;
            }
        }
        if (menu_held && TIME_AFTER(frame_start, menu_down + HOME_HOLD)) {
            menu_held = false;
            b = BUTTON_NONE;
            switch (system_menu()) {
            case 1:
                goto out;
            case MENU_ATTACHED_USB:
                status = PLUGIN_USB_CONNECTED;
                goto out;
            }
            continue;
        }

        if (held || wheel) {
            set_boost(&boosted, true);
            last_active = frame_start;
        }
        count = pocketjs_frame(fb, LCD_WIDTH, LCD_HEIGHT, held, wheel, rects);
#ifdef PJS_PERF_HUD
        lcd_start = pocketjs_host_usec();
#endif
        for (i = 0; i < (size_t)count; i++) {
            int *r = rects[i];
            int h = MIN(r[3], LCD_HEIGHT - HUD_H - r[1]);
            if (h > 0)
                rb->lcd_update_rect(r[0], r[1], r[2], h);
        }

        if (count) {
            set_boost(&boosted, true);
            last_active = frame_start;
        }
#ifdef PJS_PERF_HUD
        pocketjs_timings(t);
        for (i = 0; i < 3; i++)
            average(&perf.phase[i], t[i]);
        if (count) {
            unsigned long px = 0;
            for (i = 0; i < (size_t)count; i++)
                px += rects[i][2] * rects[i][3];
            perf.area = px * 100 / (LCD_WIDTH * LCD_HEIGHT);
            average(&perf.phase[3], pocketjs_host_usec() - lcd_start);
        }
        if (!(++perf.frames & 15))
            draw_perf_hud(&perf, boosted);
#endif

        now = *rb->current_tick;
        if (boosted && TIME_AFTER(now, last_active + IDLE_AFTER))
            set_boost(&boosted, false);
        left = frame_start + (boosted ? BUSY_PERIOD : IDLE_PERIOD) - now;
        b = left > 0 ? rb->button_get_w_tmo(left) : BUTTON_NONE;
    }
out:
    set_boost(&boosted, false);
    rb->lcd_set_drawmode(DRMODE_SOLID);
}

#ifndef SIMULATOR
static void run_thread(void)
{
    run();
    rb->thread_exit();
}
#endif

enum plugin_status plugin_start(const void *parameter)
{
    size_t buf_len;
    char *buf = rb->plugin_get_audio_buffer(&buf_len);

    (void)parameter;
    stack = (unsigned long *)(((uintptr_t)buf + 7) & ~(uintptr_t)7);
    heap = (char *)stack + STACK_SIZE;
    heap_len = buf_len - ((char *)heap - buf);
#ifdef PJS_PERF_HUD
    for (size_t i = 0; i < STACK_SIZE / sizeof(*stack); i++)
        stack[i] = STACK_FILL;
#endif

#ifdef SIMULATOR
    /* Host stacks are large enough, and the macOS simulator pumps window
     * events in button_get(), which must run on the main thread. */
    run();
#else
    /* Like the SDL ports, run on a thread with a bigger stack than the
     * 8 KB main thread stack plugins start on. */
    unsigned int thread = rb->create_thread(run_thread, stack, STACK_SIZE, 0,
                                            "pocketjs"
                                            IF_PRIO(, PRIORITY_USER_INTERFACE)
                                            IF_COP(, CPU));
    if (thread == 0)
        return PLUGIN_ERROR;
    rb->thread_wait(thread);
#endif
    return status;
}
