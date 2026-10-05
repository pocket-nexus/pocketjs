#include <stdint.h>
#include <stddef.h>

static uint64_t pocket_wii_schedule_ticks(uint64_t elapsed,
                                          uint64_t ticks_per_second,
                                          uint64_t *phase) {
  uint64_t scaled_elapsed = *phase + elapsed * 60;
  *phase = scaled_elapsed % ticks_per_second;
  return scaled_elapsed / ticks_per_second;
}

#ifdef POCKET_WII_SCHEDULE_CHECK
#include <assert.h>
#define MEM_K0_TO_K1(pointer) \
  ((void *)((uintptr_t)(pointer) + UINT32_C(0x40000000)))
#else
#include <gccore.h>
#endif

static void *k0_to_k1_or_null(void *pointer) {
  return pointer != NULL ? MEM_K0_TO_K1(pointer) : NULL;
}

static int video_allocations_ready(const void *xfb0, const void *xfb1,
                                   const void *fifo) {
  return xfb0 != NULL && xfb1 != NULL && fifo != NULL;
}

#ifdef POCKET_WII_SCHEDULE_CHECK

static uint64_t simulate_video_rate(uint64_t video_hz) {
  const uint64_t ticks_per_second = 30000;
  uint64_t phase = 0;
  uint64_t ticks = 0;
  assert(ticks_per_second % video_hz == 0);
  for (uint64_t frame = 0; frame < video_hz; ++frame)
    ticks += pocket_wii_schedule_ticks(ticks_per_second / video_hz,
                                       ticks_per_second, &phase);
  assert(phase == 0);
  return ticks;
}

int main(void) {
  uint64_t phase = 0;
  assert((uintptr_t)MEM_K0_TO_K1(NULL) == UINT32_C(0x40000000));
  assert(k0_to_k1_or_null(NULL) == NULL);
  assert((uintptr_t)k0_to_k1_or_null((void *)(uintptr_t)0x80001234) ==
         UINT32_C(0xc0001234));
  assert(video_allocations_ready((void *)1, (void *)2, (void *)3));
  assert(!video_allocations_ready(NULL, (void *)2, (void *)3));
  assert(simulate_video_rate(50) == 60);
  assert(simulate_video_rate(60) == 60);
  assert(pocket_wii_schedule_ticks(499, 30000, &phase) == 0);
  assert(pocket_wii_schedule_ticks(1, 30000, &phase) == 1);
  assert(phase == 0);
  return 0;
}
#else
#include <errno.h>
#include <fat.h>
#include <malloc.h>
#include <ogc/lwp_watchdog.h>
#include <ogc/pad.h>
#include <ogc/system.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <wiiuse/wpad.h>

#include "pocket_wii.h"
#include "hero_package.h"
#include "input.h"

#define FIFO_SIZE (256 * 1024)
#define CADENCE_REPORT_TICKS secs_to_ticks(5)
#define HEAP_SAMPLE_TICKS secs_to_ticks(1)
#define HOST_LOG_PATH "sd:/apps/wii-pocketjs/wii-host.log"

static FILE *host_log;
static enum {
  W26_SD_PENDING,
  W26_SD_READY,
  W26_SD_INIT_FAILED,
  W26_SD_OPEN_FAILED,
  W26_SD_WRITE_FAILED
} host_log_status;

static void w26_logf(const char *format, ...) {
  va_list args;
  va_start(args, format);
  if (host_log != NULL) {
    int written = vfprintf(host_log, format, args);
    va_end(args);
    if (written >= 0 && fflush(host_log) == 0) return;

    FILE *failed_log = host_log;
    host_log = NULL;
    host_log_status = W26_SD_WRITE_FAILED;
    fclose(failed_log);
    va_start(args, format);
    vprintf(format, args);
    va_end(args);
    puts("W26 LOG ERROR: SD write failed; continuing on OSReport");
  } else {
    vprintf(format, args);
    va_end(args);
  }
  fflush(stdout);
}

static void init_host_log(void) {
  if (!fatInitDefault()) {
    host_log_status = W26_SD_INIT_FAILED;
    w26_logf("W26 LOG unavailable: libfat initialization failed; using OSReport\n");
    return;
  }
  host_log = fopen(HOST_LOG_PATH, "w");
  if (host_log == NULL) {
    host_log_status = W26_SD_OPEN_FAILED;
    w26_logf("W26 LOG unavailable: cannot overwrite %s: %s; using OSReport\n",
             HOST_LOG_PATH, strerror(errno));
    return;
  }
  host_log_status = W26_SD_READY;
  w26_logf("W26 LOG path=%s mode=overwrite\n", HOST_LOG_PATH);
}

static void close_host_log(void) {
  if (host_log == NULL) return;
  FILE *log = host_log;
  host_log = NULL;
  int failed = fflush(log) != 0;
  if (fclose(log) != 0) failed = 1;
  if (failed) {
    host_log_status = W26_SD_WRITE_FAILED;
    puts("W26 LOG ERROR: SD close failed; last records may be incomplete");
    fflush(stdout);
  }
}

static const char *video_standard(uint32_t vi_tv_mode) {
  switch (vi_tv_mode >> 2) {
    case VI_NTSC: return "NTSC-60Hz";
    case VI_PAL: return "PAL-50Hz";
    case VI_MPAL: return "MPAL-60Hz";
    case VI_DEBUG: return "debug-60Hz";
    case VI_DEBUG_PAL: return "debug-PAL-50Hz";
    case VI_EURGB60: return "EURGB60-60Hz";
    default: return "unknown";
  }
}

static int boot_hero(unsigned lifecycle) {
  if (pocket_wii_boot(hero_main_pocket, hero_main_pocket_len) != 0) {
    w26_logf("W26 FAIL: lifecycle=%u PocketJS boot: %s\n", lifecycle,
             pocket_wii_last_error());
    return 0;
  }
  w26_logf("W26 PASS: lifecycle=%u hero-main.pocket booted\n", lifecycle);
  return 1;
}

static GXColor wpad_indicator_color(const pocket_wii_input_t *input) {
  for (int channel = 0; channel < POCKET_WII_WPAD_CHANNELS; ++channel)
    if (input->wpad_probe[channel] == WPAD_ERR_NONE)
      return (GXColor){48, 255, 96, 255};

  if (input->wpad_status == WPAD_STATE_DISABLED)
    return (GXColor){255, 0, 255, 255};
  if (input->wpad_status == WPAD_STATE_ENABLING)
    return (GXColor){255, 192, 0, 255};
  return (GXColor){255, 48, 48, 255};
}

static GXColor pad1_indicator_color(const pocket_wii_input_t *input) {
  if (input->pad1_probe != PAD_ERR_NONE)
    return (GXColor){255, 48, 48, 255};
  if (input->pad1_raw_held != 0)
    return (GXColor){48, 192, 255, 255};
  return (GXColor){48, 255, 96, 255};
}

static GXColor sd_log_indicator_color(void) {
  switch (host_log_status) {
    case W26_SD_READY: return (GXColor){48, 255, 96, 255};
    case W26_SD_INIT_FAILED: return (GXColor){255, 48, 48, 255};
    case W26_SD_OPEN_FAILED: return (GXColor){255, 192, 0, 255};
    case W26_SD_WRITE_FAILED: return (GXColor){255, 48, 255, 255};
    default: return (GXColor){128, 128, 128, 255};
  }
}

static void log_wpad_state(const pocket_wii_input_t *input, int init_result,
                           int snapshot) {
  static int last_status = -1;
  static int last_probe[POCKET_WII_WPAD_CHANNELS] = {-100, -100, -100, -100};
  int changed = input->wpad_status != last_status;
  for (int channel = 0; channel < POCKET_WII_WPAD_CHANNELS; ++channel)
    if (input->wpad_probe[channel] != last_probe[channel]) changed = 1;

  if (changed) {
    w26_logf("W26 WPAD transition init_rc=%d status=%d probes=%d,%d,%d,%d\n",
             init_result, input->wpad_status, input->wpad_probe[0],
             input->wpad_probe[1], input->wpad_probe[2], input->wpad_probe[3]);
    last_status = input->wpad_status;
    for (int channel = 0; channel < POCKET_WII_WPAD_CHANNELS; ++channel)
      last_probe[channel] = input->wpad_probe[channel];
  }

  if (snapshot)
    w26_logf("W26 WPAD snapshot init_rc=%d status=%d probes=%d,%d,%d,%d\n",
             init_result, input->wpad_status, input->wpad_probe[0],
             input->wpad_probe[1], input->wpad_probe[2], input->wpad_probe[3]);
}

static void log_pad_state(const pocket_wii_input_t *input,
                          uint32_t init_result) {
  w26_logf("W26 PAD snapshot init_rc=%lu scan_mask=0x%08lx port1_probe=%d raw_held=0x%04x\n",
           (unsigned long)init_result, (unsigned long)input->pad_scan_mask,
           input->pad1_probe, (unsigned)input->pad1_raw_held);
}

static void caller_gx_state(const GXRModeObj *mode) {
  Mtx identity;
  Mtx44 projection;
  guMtxIdentity(identity);
  guOrtho(projection, 0.0f, (f32)mode->efbHeight, 0.0f,
          (f32)mode->fbWidth, 0.0f, 1.0f);
  GX_LoadPosMtxImm(identity, GX_PNMTX0);
  GX_SetCurrentMtx(GX_PNMTX0);
  GX_LoadProjectionMtx(projection, GX_ORTHOGRAPHIC);
  GX_SetViewport(0.0f, 0.0f, (f32)mode->fbWidth, (f32)mode->efbHeight,
                 0.0f, 1.0f);
  GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XY, GX_F32, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
  GX_SetNumChans(1);
  GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_VTX, GX_SRC_VTX,
                 GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
  GX_SetNumTexGens(0);
  GX_SetNumTevStages(1);
  GX_SetNumIndStages(0);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
  GX_SetCullMode(GX_CULL_NONE);
  GX_SetZMode(GX_DISABLE, GX_ALWAYS, GX_FALSE);
  GX_SetBlendMode(GX_BM_BLEND, GX_BL_SRCALPHA, GX_BL_INVSRCALPHA, GX_LO_CLEAR);
  GX_SetAlphaCompare(GX_ALWAYS, 0, GX_AOP_AND, GX_ALWAYS, 0);
  GX_SetColorUpdate(GX_TRUE);
  GX_SetAlphaUpdate(GX_TRUE);
}

static void draw_caller_rect(f32 x, f32 y, f32 size, GXColor color) {
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 6);
  GX_Position2f32(x, y); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_Position2f32(x + size, y); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_Position2f32(x + size, y + size); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_Position2f32(x, y); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_Position2f32(x + size, y + size); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_Position2f32(x, y + size); GX_Color4u8(color.r, color.g, color.b, color.a);
  GX_End();
}

static int init_video(GXRModeObj **mode_out, void **xfb, void **fifo_raw_out) {
  *fifo_raw_out = NULL;
  VIDEO_Init();
  GXRModeObj *mode = VIDEO_GetPreferredMode(NULL);
  if (mode == NULL) return 0;
  void *raw_xfb[2] = {
    SYS_AllocateFramebuffer(mode), SYS_AllocateFramebuffer(mode)
  };
  void *fifo_raw = memalign(32, FIFO_SIZE);
  if (!video_allocations_ready(raw_xfb[0], raw_xfb[1], fifo_raw)) {
    /* ponytail: leave partial XFBs to process exit; libogc ownership is unclear. */
    free(fifo_raw);
    return 0;
  }
  xfb[0] = k0_to_k1_or_null(raw_xfb[0]);
  xfb[1] = k0_to_k1_or_null(raw_xfb[1]);
  void *fifo_k1 = k0_to_k1_or_null(fifo_raw);
  *fifo_raw_out = fifo_raw;

  memset(fifo_k1, 0, FIFO_SIZE);
  VIDEO_Configure(mode);
  VIDEO_SetNextFramebuffer(xfb[0]);
  VIDEO_SetBlack(true);
  VIDEO_Flush();
  VIDEO_WaitVSync();

  GX_Init(fifo_k1, FIFO_SIZE);
  GX_SetPixelFmt(GX_PF_RGB8_Z24, GX_ZC_LINEAR);
  GX_SetCopyClear((GXColor){0, 0, 0, 255}, GX_MAX_Z24);
  GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
  GX_SetDispCopySrc(0, 0, mode->fbWidth, mode->efbHeight);
  GX_SetDispCopyDst(mode->fbWidth, mode->xfbHeight);
  GX_SetDispCopyYScale(GX_GetYScaleFactor(mode->efbHeight, mode->xfbHeight));
  GX_SetCopyFilter(mode->aa, mode->sample_pattern, GX_TRUE, mode->vfilter);
  caller_gx_state(mode);
  *mode_out = mode;
  return 1;
}

int main(void) {
  SYS_STDIO_Report(true);
  init_host_log();
  GXRModeObj *mode = NULL;
  void *xfb[2] = { NULL, NULL };
  void *fifo_raw = NULL;
  if (!init_video(&mode, xfb, &fifo_raw)) {
    w26_logf("W26 FAIL: video or GX setup failed\n");
    free(fifo_raw);
    close_host_log();
    return 1;
  }

  w26_logf("W26 VIDEO standard=%s viTVMode=%u vi=%ux%u efb=%ux%u xfb=%ux%u\n",
           video_standard(mode->viTVMode), (unsigned)mode->viTVMode,
           (unsigned)mode->viWidth, (unsigned)mode->viHeight,
           (unsigned)mode->fbWidth, (unsigned)mode->efbHeight,
           (unsigned)mode->fbWidth, (unsigned)mode->xfbHeight);
  w26_logf("W26 INFO: press Wiimote HOME to shutdown and re-boot hero-main.pocket\n");

  uint32_t pad_init_result = 0;
  int wpad_init_result = pocket_wii_input_init(&pad_init_result);
  w26_logf("W26 WPAD startup init_rc=%d status=%d\n", wpad_init_result,
           WPAD_GetStatus());
  w26_logf("W26 PAD startup init_rc=%lu\n", (unsigned long)pad_init_result);
  unsigned lifecycle = 1;
  struct mallinfo heap = mallinfo();
  size_t heap_peak = heap.uordblks;
  int guest_active = boot_hero(lifecycle);
  if (!guest_active) {
    pocket_wii_shutdown();
    free(fifo_raw);
    close_host_log();
    return 2;
  }
  heap = mallinfo();
  if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;

  unsigned framebuffer = 0;
  pocket_wii_input_t input;
  uint64_t run_start = gettime();
  uint64_t last_time = run_start;
  uint64_t last_report = run_start;
  uint64_t last_heap_sample = run_start;
  uint64_t frames = 0, ticks = 0;
  uint64_t reported_frames = 0, reported_ticks = 0;
  uint64_t tick_phase = 0;
  for (;;) {
    pocket_wii_input_poll(&input);
    log_wpad_state(&input, wpad_init_result, 0);

    int restart = 0;
    for (int channel = WPAD_CHAN_0; channel <= WPAD_CHAN_3; ++channel) {
      if (WPAD_ButtonsDown(channel) & WPAD_BUTTON_HOME) {
        restart = 1;
        break;
      }
    }
    if (restart) {
      w26_logf("W26 LIFECYCLE shutdown lifecycle=%u hotkey=Wiimote-HOME\n",
               lifecycle);
      pocket_wii_shutdown();
      heap = mallinfo();
      if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;
      w26_logf("W26 HEAP lifecycle=%u stage=shutdown current=%lu peak_sampled=%lu arena=%lu free=%lu\n",
               lifecycle, (unsigned long)heap.uordblks,
               (unsigned long)heap_peak, (unsigned long)heap.arena,
               (unsigned long)heap.fordblks);

      ++lifecycle;
      heap = mallinfo();
      heap_peak = heap.uordblks;
      guest_active = boot_hero(lifecycle);
      heap = mallinfo();
      if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;
      run_start = last_time = last_report = last_heap_sample = gettime();
      frames = ticks = reported_frames = reported_ticks = 0;
      tick_phase = 0;
    }

    uint64_t now = gettime();
    uint64_t ticks_due = guest_active
        ? pocket_wii_schedule_ticks(diff_ticks(last_time, now),
                                    PPC_TIMER_CLOCK, &tick_phase)
        : 0;
    last_time = now;
    int tick_failed = 0;
    /* ponytail: drain all overdue ticks; cap catch-up only if stalls cause persistent lag. */
    while (ticks_due != 0) {
      --ticks_due;
      if (pocket_wii_tick(input.buttons, input.analog) != 0) {
        w26_logf("W26 FAIL: lifecycle=%u PocketJS tick: %s\n", lifecycle,
                 pocket_wii_last_error());
        tick_failed = 1;
        break;
      }
      ++ticks;
    }
    if (tick_failed) {
      break;
    }

    caller_gx_state(mode);
    draw_caller_rect(12.0f, 12.0f, 24.0f, wpad_indicator_color(&input));
    draw_caller_rect(44.0f, 12.0f, 24.0f, pad1_indicator_color(&input));
    if (guest_active) {
      if (pocket_wii_draw(80, 80, 480, 272) != 0) {
        w26_logf("W26 FAIL: lifecycle=%u PocketJS draw: %s\n", lifecycle,
                 pocket_wii_last_error());
        break;
      }
      /* pocket_wii_draw owns GX state until the caller binds its state again. */
      caller_gx_state(mode);
    }
    draw_caller_rect((f32)mode->fbWidth - 36.0f, 12.0f, 24.0f,
                     sd_log_indicator_color());

    GX_CopyDisp(xfb[framebuffer], GX_TRUE);
    GX_DrawDone();
    VIDEO_SetNextFramebuffer(xfb[framebuffer]);
    VIDEO_SetBlack(false);
    VIDEO_Flush();
    VIDEO_WaitVSync();
    framebuffer ^= 1;
    ++frames;

    now = gettime();
    if (diff_ticks(last_heap_sample, now) >= HEAP_SAMPLE_TICKS) {
      /* ponytail: sampled baselines miss sub-second spikes; allocator hooks for exact peaks. */
      heap = mallinfo();
      if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;
      last_heap_sample = now;
    }
    if (diff_ticks(last_report, now) >= CADENCE_REPORT_TICKS) {
      log_wpad_state(&input, wpad_init_result, 1);
      log_pad_state(&input, pad_init_result);
      heap = mallinfo();
      if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;
      uint64_t window_ms = ticks_to_millisecs(diff_ticks(last_report, now));
      uint64_t elapsed_ms = ticks_to_millisecs(diff_ticks(run_start, now));
      uint64_t window_frames = frames - reported_frames;
      uint64_t window_ticks = ticks - reported_ticks;
      uint64_t fps_x100 = window_ms ? window_frames * 100000 / window_ms : 0;
      uint64_t tps_x100 = window_ms ? window_ticks * 100000 / window_ms : 0;
      w26_logf("W26 CADENCE lifecycle=%u guest=%s monotonic_ms=%llu window_ms=%llu frames=%llu ticks=%llu fps=%llu.%02llu tps=%llu.%02llu total_frames=%llu total_ticks=%llu\n",
               lifecycle, guest_active ? "active" : "boot-failed",
               (unsigned long long)elapsed_ms, (unsigned long long)window_ms,
               (unsigned long long)window_frames,
               (unsigned long long)window_ticks,
               (unsigned long long)(fps_x100 / 100),
               (unsigned long long)(fps_x100 % 100),
               (unsigned long long)(tps_x100 / 100),
               (unsigned long long)(tps_x100 % 100),
               (unsigned long long)frames, (unsigned long long)ticks);
      w26_logf("W26 HEAP lifecycle=%u current=%lu peak_sampled=%lu arena=%lu free=%lu\n",
               lifecycle, (unsigned long)heap.uordblks,
               (unsigned long)heap_peak, (unsigned long)heap.arena,
               (unsigned long)heap.fordblks);
      reported_frames = frames;
      reported_ticks = ticks;
      last_report = now;
    }
  }

  w26_logf("W26 LIFECYCLE shutdown lifecycle=%u reason=host-loop-error\n",
           lifecycle);
  pocket_wii_shutdown();
  heap = mallinfo();
  if (heap.uordblks > heap_peak) heap_peak = heap.uordblks;
  w26_logf("W26 HEAP lifecycle=%u stage=shutdown current=%lu peak_sampled=%lu arena=%lu free=%lu\n",
           lifecycle, (unsigned long)heap.uordblks,
           (unsigned long)heap_peak, (unsigned long)heap.arena,
           (unsigned long)heap.fordblks);
  free(fifo_raw);
  close_host_log();
  return 3;
}
#endif
