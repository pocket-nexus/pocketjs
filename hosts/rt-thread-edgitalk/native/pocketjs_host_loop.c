/*
 * Portable PocketJS host loop for RT-Thread / Edgi-Talk.
 *
 * Adapted from PocketJS_for_Edgi-Talk/.../applications/pocketjs/pocketjs_app.c
 * Board-specific LCD / touch / product guest installs are weak hooks in
 * include/pocketjs/pocketjs_host_board.h — product overlay provides strong defs.
 *
 * Remaining extraction (document in native/README.md): overlay still owns the
 * full in-tree pocketjs_app.c until product binds these hooks and drops the
 * duplicate loop. Wi-Fi / BT / game / synth / music / dashboard stay in overlay.
 */

#include <rtthread.h>
#include <stdbool.h>
#include <stdint.h>

#include "pocketjs/guest.h"
#include "pocketjs/guest_quickjs.h"
#include "pocketjs/package.h"
#include "pocketjs/render_rgb565.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"

#include "pocketjs/pocketjs_app.h"
#include "pocketjs/pocketjs_host_board.h"

#define POCKETJS_TASK_STACK_SIZE   (128U * 1024U)
#define POCKETJS_TASK_PRIORITY     20U
#define POCKETJS_GUEST_HEAP_LIMIT  (6U * 1024U * 1024U)
#define POCKETJS_GUEST_STACK_LIMIT (96U * 1024U)
#define POCKETJS_SCRATCH_PHYS_ROWS 24U
#define POCKETJS_SCRATCH_MAX_WIDTH 800U

#ifndef POCKETJS_UI_CORE_ABI_VERSION
#define POCKETJS_UI_CORE_ABI_VERSION 1U
#endif

static struct rt_semaphore s_ready;
static rt_bool_t s_started;
static rt_err_t s_init_result = -RT_ERROR;

static pocketjs_board_display_t s_display;
static uint16_t s_scratch[POCKETJS_SCRATCH_MAX_WIDTH * POCKETJS_SCRATCH_PHYS_ROWS]
    __attribute__((aligned(32)));
static uint32_t s_tick_hz;

static pocketjs_package_t *s_package;
static pocketjs_package_variant_t s_app;
static pocketjs_guest_t *s_guest;
static pocketjs_ui_core_t *s_core;
static pocketjs_ui_qjs_t *s_binding;
static pocketjs_rgb565_renderer_t *s_renderer;
static pocketjs_rgb565_target_t *s_target;
static uint32_t s_ui_time_ms;
static uint32_t s_present_time_ms;
static uint32_t s_ui_max_ms;
static uint32_t s_present_max_ms;

volatile uint32_t g_pocketjs_frames;
volatile uint32_t g_pocketjs_ui_ms_total;
volatile uint32_t g_pocketjs_present_ms_total;
volatile uint32_t g_pocketjs_prepare_ms_total;
volatile uint32_t g_pocketjs_render_ms_total;
volatile uint32_t g_pocketjs_lcd_ms_total;
volatile uint32_t g_pocketjs_regions_total;
volatile uint32_t g_pocketjs_rows_total;

/* ---- weak board stubs (product overrides) ---- */

__attribute__((weak)) rt_err_t
pocketjs_board_open_display(pocketjs_board_display_t *out)
{
    (void)out;
    rt_kprintf("[PocketJS] board_open_display not bound\n");
    return -RT_ENOSYS;
}

__attribute__((weak)) rt_bool_t pocketjs_board_rect_present_supported(void)
{
    return RT_FALSE;
}

__attribute__((weak)) rt_bool_t
pocketjs_board_stage_rect_rgb565(uint32_t x, uint32_t y, uint32_t width,
                                 uint32_t height)
{
    (void)x;
    (void)y;
    (void)width;
    (void)height;
    return RT_FALSE;
}

__attribute__((weak)) rt_bool_t pocketjs_board_commit_rect_rgb565(void)
{
    return RT_FALSE;
}

__attribute__((weak)) rt_err_t pocketjs_board_full_present(void *opaque)
{
    (void)opaque;
    return -RT_ENOSYS;
}

__attribute__((weak)) void
pocketjs_board_sample_touch(pocketjs_ui_input_t *input,
                            pocketjs_ui_touch_t *contact,
                            uint32_t logical_width, uint32_t logical_height)
{
    (void)input;
    (void)contact;
    (void)logical_width;
    (void)logical_height;
}

__attribute__((weak)) const pocketjs_embedded_package_t *
pocketjs_board_embedded_package(void)
{
    return RT_NULL;
}

__attribute__((weak)) const pocketjs_package_host_contract_t *
pocketjs_board_host_contract(void)
{
    return RT_NULL;
}

__attribute__((weak)) const uint8_t *pocketjs_board_embedded_package_end(void)
{
    return RT_NULL;
}

__attribute__((weak)) const char *pocketjs_board_guest_script_name(void)
{
    return "edgitalk-m55-smoke";
}

__attribute__((weak)) esp_err_t
pocketjs_board_install_guest_hooks(pocketjs_guest_t *guest)
{
    (void)guest;
    return ESP_OK;
}

__attribute__((weak)) void pocketjs_board_on_frame(void) {}

__attribute__((weak)) rt_bool_t pocketjs_board_suppress_frame_stats(void)
{
    return RT_FALSE;
}

/* ---- host loop ---- */

static void pocketjs_destroy(void)
{
    if (s_target != RT_NULL)
    {
        pocketjs_rgb565_target_destroy(s_target);
        s_target = RT_NULL;
    }
    if (s_renderer != RT_NULL)
    {
        pocketjs_rgb565_renderer_destroy(s_renderer);
        s_renderer = RT_NULL;
    }
    if (s_binding != RT_NULL)
    {
        pocketjs_ui_qjs_destroy(s_binding);
        s_binding = RT_NULL;
    }
    if (s_guest != RT_NULL)
    {
        pocketjs_guest_destroy(s_guest);
        s_guest = RT_NULL;
    }
    if (s_core != RT_NULL)
    {
        pocketjs_ui_core_destroy(s_core);
        s_core = RT_NULL;
    }
    if (s_package != RT_NULL)
    {
        pocketjs_package_close(s_package);
        s_package = RT_NULL;
    }
    s_app = (pocketjs_package_variant_t){0};
    rt_memset(&s_display, 0, sizeof(s_display));
}

static rt_err_t pocketjs_open_package(void)
{
    const pocketjs_package_host_contract_t *contract =
        pocketjs_board_host_contract();
    const pocketjs_embedded_package_t *embedded =
        pocketjs_board_embedded_package();
    const uint8_t *embedded_end = pocketjs_board_embedded_package_end();
    size_t embedded_package_size;
    esp_err_t result;

    if ((contract == RT_NULL) || (embedded == RT_NULL) ||
        (embedded->data == RT_NULL))
    {
        rt_kprintf("[PocketJS] board embedded package / contract not bound\n");
        return -RT_ENOSYS;
    }

    if ((s_display.width != contract->physical_width) ||
        (s_display.height != contract->physical_height) ||
        (contract->raster_density == 0U) ||
        (contract->logical_width !=
         (s_display.width / contract->raster_density)) ||
        (contract->logical_height !=
         (s_display.height / contract->raster_density)) ||
        (contract->host_abi != POCKETJS_UI_CORE_ABI_VERSION))
    {
        rt_kprintf("[PocketJS] package contract does not match this host\n");
        return -RT_EINVAL;
    }

    if (embedded_end != RT_NULL)
    {
        embedded_package_size = (size_t)((uintptr_t)embedded_end -
                                         (uintptr_t)embedded->data);
    }
    else
    {
        embedded_package_size = embedded->size;
    }

    if (embedded_package_size == 0U)
    {
        rt_kprintf("[PocketJS] embedded package is empty\n");
        return -RT_EINVAL;
    }

    result = pocketjs_package_open(embedded->data, embedded_package_size, 0U,
                                   &s_package);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] package open failed: %d\n", result);
        return -RT_ERROR;
    }

    s_app = (pocketjs_package_variant_t){.struct_size = sizeof(s_app)};
    result = pocketjs_package_select(s_package, contract, &s_app);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] package select failed: %d\n", result);
        return -RT_ERROR;
    }

    s_tick_hz = contract->tick_hz;
    rt_kprintf("[PocketJS] package accepted: js=%u pak=%u logical=%ux%u x%u\n",
               (uint32_t)s_app.javascript.size, (uint32_t)s_app.pak.size,
               contract->logical_width, contract->logical_height,
               contract->raster_density);
    return RT_EOK;
}

static rt_err_t pocketjs_init(void)
{
    const pocketjs_package_host_contract_t *contract =
        pocketjs_board_host_contract();
    pocketjs_ui_core_config_t core_config;
    pocketjs_guest_config_t guest_config;
    pocketjs_ui_qjs_config_t binding_config;
    pocketjs_rgb565_renderer_config_t renderer_config;
    esp_err_t result;

    if (pocketjs_board_open_display(&s_display) != RT_EOK)
    {
        return -RT_ERROR;
    }
    if ((s_display.framebuffer == RT_NULL) || (s_display.width == 0U) ||
        (s_display.height == 0U))
    {
        rt_kprintf("[PocketJS] invalid board framebuffer\n");
        return -RT_EINVAL;
    }
    rt_kprintf("[PocketJS] RGB565 framebuffer %ux%u\n", s_display.width,
               s_display.height);

    if (pocketjs_open_package() != RT_EOK)
    {
        return -RT_ERROR;
    }

    pocketjs_ui_core_config_defaults(&core_config);
    core_config.logical_width = contract->logical_width;
    core_config.logical_height = contract->logical_height;
    core_config.raster_density = contract->raster_density;
    core_config.tick_hz = s_tick_hz;
    result = pocketjs_ui_core_create(&core_config, &s_core);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] UI core create failed: %d\n", result);
        return -RT_ENOMEM;
    }

    pocketjs_guest_config_defaults(&guest_config);
    guest_config.heap_limit = POCKETJS_GUEST_HEAP_LIMIT;
    guest_config.stack_limit = POCKETJS_GUEST_STACK_LIMIT;
    guest_config.prefer_psram = true;
    result = pocketjs_guest_create(&guest_config, &s_guest);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] QuickJS guest create failed: %d\n", result);
        return -RT_ENOMEM;
    }

    binding_config = (pocketjs_ui_qjs_config_t){
        .struct_size = sizeof(binding_config),
        .target_id = contract->target_id,
        .host_abi = contract->host_abi,
    };
    result = pocketjs_ui_qjs_create(s_guest, s_core, &binding_config, &s_binding);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] UI binding create failed: %d\n", result);
        return -RT_ERROR;
    }
    result = pocketjs_ui_qjs_feed_pak(s_binding, s_app.pak.data, s_app.pak.size);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] PAK load failed: %d\n", result);
        return -RT_ERROR;
    }
    result = pocketjs_ui_qjs_mount(s_binding);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] UI binding mount failed: %d\n", result);
        return -RT_ERROR;
    }
    result = pocketjs_board_install_guest_hooks(s_guest);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] board guest hooks failed: %d\n", result);
        return -RT_ERROR;
    }
    result = pocketjs_guest_eval(s_guest, (const char *)s_app.javascript.data,
                                 s_app.javascript.size - 1U,
                                 pocketjs_board_guest_script_name());
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] JavaScript app load failed: %d\n", result);
        return -RT_ERROR;
    }

    pocketjs_rgb565_renderer_config_defaults(&renderer_config);
    renderer_config.scale = core_config.raster_density;
    result = pocketjs_rgb565_renderer_create(&renderer_config, &s_renderer);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] RGB565 renderer create failed: %d\n", result);
        return -RT_ENOMEM;
    }
    result = pocketjs_rgb565_target_create(&s_target);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] RGB565 target create failed: %d\n", result);
        return -RT_ENOMEM;
    }

    rt_kprintf("[PocketJS] QuickJS guest mounted at %u Hz\n",
               core_config.tick_hz);
    return RT_EOK;
}

static rt_err_t pocketjs_present(const pocketjs_ui_frame_view_t *frame)
{
    const pocketjs_package_host_contract_t *contract =
        pocketjs_board_host_contract();
    pocketjs_rgb565_damage_plan_t plan = {.struct_size = sizeof(plan)};
    const uint32_t scale = contract->raster_density;
    esp_err_t result;

    if ((scale == 0U) || (scale > POCKETJS_SCRATCH_PHYS_ROWS) ||
        (s_display.width > POCKETJS_SCRATCH_MAX_WIDTH))
    {
        return -RT_EINVAL;
    }

    {
        rt_tick_t t_prep = rt_tick_get();
        result = pocketjs_rgb565_prepare(s_renderer, s_target, frame, &plan);
        g_pocketjs_prepare_ms_total += (uint32_t)(rt_tick_get() - t_prep);
    }
    g_pocketjs_regions_total += plan.region_count;
    {
        rt_tick_t t_render = rt_tick_get();
        if (result != ESP_OK)
        {
            rt_kprintf("[PocketJS] damage preparation failed: %d\n", result);
            pocketjs_rgb565_abort(s_renderer, s_target);
            return -RT_ERROR;
        }

        for (uint32_t index = 0U; index < plan.region_count; ++index)
        {
            const pocketjs_rgb565_rect_t region = plan.regions[index];
            g_pocketjs_rows_total += region.height * region.width / 100U;
            uint32_t row = region.y;
            uint32_t remaining = region.height;

            while (remaining != 0U)
            {
                const uint32_t max_rows = POCKETJS_SCRATCH_PHYS_ROWS / scale;
                const uint32_t rows = remaining > max_rows ? max_rows : remaining;
                const uint32_t physical_row = row * scale;
                const uint32_t physical_rows = rows * scale;
                const pocketjs_rgb565_rect_t strip = {
                    .x = region.x,
                    .y = row,
                    .width = region.width,
                    .height = rows,
                };
                pocketjs_rgb565_render_stats_t stats = {
                    .struct_size = sizeof(stats)};

                if ((physical_row >= s_display.height) ||
                    (physical_rows > (s_display.height - physical_row)))
                {
                    rt_kprintf(
                        "[PocketJS] invalid physical render strip %u+%u/%u\n",
                        physical_row, physical_rows, s_display.height);
                    pocketjs_rgb565_abort(s_renderer, s_target);
                    return -RT_EINVAL;
                }

                result = pocketjs_rgb565_render_strip(
                    s_renderer, frame, s_scratch,
                    (size_t)s_display.width * physical_rows, strip, RT_NULL,
                    &stats);
                if (result != ESP_OK)
                {
                    rt_kprintf("[PocketJS] RGB565 strip render failed: %d\n",
                               result);
                    pocketjs_rgb565_abort(s_renderer, s_target);
                    return -RT_ERROR;
                }
                {
                    const size_t copy_bytes =
                        (size_t)region.width * scale * sizeof(uint16_t);
                    for (uint32_t line = 0U; line < physical_rows; ++line)
                    {
                        rt_memcpy(
                            s_display.framebuffer +
                                ((size_t)(physical_row + line) *
                                 s_display.width) +
                                (size_t)region.x * scale,
                            s_scratch + ((size_t)line * s_display.width) +
                                (size_t)region.x * scale,
                            copy_bytes);
                    }
                }
                row += rows;
                remaining -= rows;
            }
        }
        g_pocketjs_render_ms_total += (uint32_t)(rt_tick_get() - t_render);
    }

    {
        rt_tick_t t_lcd = rt_tick_get();
        rt_bool_t partial = RT_FALSE;
        if ((plan.region_count != 0U) && pocketjs_board_rect_present_supported())
        {
            partial = RT_TRUE;
            for (uint32_t index = 0U; index < plan.region_count; ++index)
            {
                const pocketjs_rgb565_rect_t region = plan.regions[index];
                if (!pocketjs_board_stage_rect_rgb565(
                        region.x * scale, region.y * scale, region.width * scale,
                        region.height * scale))
                {
                    partial = RT_FALSE;
                    break;
                }
            }
            if (partial)
            {
                partial = pocketjs_board_commit_rect_rgb565();
            }
        }
        if ((plan.region_count != 0U) && !partial &&
            (pocketjs_board_full_present(s_display.opaque) != RT_EOK))
        {
            rt_kprintf("[PocketJS] LCD present failed\n");
            pocketjs_rgb565_abort(s_renderer, s_target);
            return -RT_ERROR;
        }
        g_pocketjs_lcd_ms_total += (uint32_t)(rt_tick_get() - t_lcd);
    }

    result = pocketjs_rgb565_commit(s_renderer, s_target, frame);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] damage commit failed: %d\n", result);
        return -RT_ERROR;
    }
    return RT_EOK;
}

static rt_err_t pocketjs_turn(void)
{
    const pocketjs_package_host_contract_t *contract =
        pocketjs_board_host_contract();
    pocketjs_ui_touch_t touch = {0};
    pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
    pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
    rt_tick_t started;
    uint32_t elapsed;
    esp_err_t result;

    started = rt_tick_get();
    pocketjs_board_sample_touch(&input, &touch, contract->logical_width,
                                contract->logical_height);
    (void)(rt_tick_get() - started);

    started = rt_tick_get();
    result = pocketjs_ui_turn(s_binding, &input, &frame);
    if (result != ESP_OK)
    {
        rt_kprintf("[PocketJS] JavaScript frame failed: %d\n", result);
        return -RT_ERROR;
    }
    elapsed = (uint32_t)(rt_tick_get() - started);
    s_ui_time_ms += elapsed;
    g_pocketjs_ui_ms_total += elapsed;
    if (elapsed > s_ui_max_ms)
    {
        s_ui_max_ms = elapsed;
    }

    started = rt_tick_get();
    if (pocketjs_present(&frame) != RT_EOK)
    {
        return -RT_ERROR;
    }
    elapsed = (uint32_t)(rt_tick_get() - started);
    s_present_time_ms += elapsed;
    g_pocketjs_present_ms_total += elapsed;
    if (elapsed > s_present_max_ms)
    {
        s_present_max_ms = elapsed;
    }
    pocketjs_board_on_frame();
    ++g_pocketjs_frames;
    return RT_EOK;
}

static void pocketjs_task(void *parameter)
{
    rt_tick_t last_report = rt_tick_get();
    rt_tick_t next_frame;
    rt_tick_t now;
    rt_tick_t frame_ticks;
    uint32_t frame_fraction = 0U;
    uint32_t frame_remainder;
    uint32_t presented = 0U;

    (void)parameter;
    s_init_result = pocketjs_init();
    if (s_init_result == RT_EOK)
    {
        s_init_result = pocketjs_turn();
    }
    rt_sem_release(&s_ready);

    if (s_init_result != RT_EOK)
    {
        pocketjs_destroy();
        return;
    }
    frame_ticks = RT_TICK_PER_SECOND / s_tick_hz;
    frame_remainder = RT_TICK_PER_SECOND % s_tick_hz;
    next_frame = rt_tick_get();

    while (1)
    {
        if (pocketjs_turn() == RT_EOK)
        {
            ++presented;
        }

        if (((rt_tick_get() - last_report) >= rt_tick_from_millisecond(5000)) &&
            !pocketjs_board_suppress_frame_stats())
        {
            rt_kprintf("[PocketJS] frames=%u ui=%u/%u ms lcd=%u/%u ms\n",
                       presented,
                       presented == 0U ? 0U : s_ui_time_ms / presented,
                       s_ui_max_ms,
                       presented == 0U ? 0U : s_present_time_ms / presented,
                       s_present_max_ms);
            last_report = rt_tick_get();
            presented = 0U;
            s_ui_time_ms = 0U;
            s_present_time_ms = 0U;
            s_ui_max_ms = 0U;
            s_present_max_ms = 0U;
        }
        next_frame += frame_ticks;
        frame_fraction += frame_remainder;
        if (frame_fraction >= s_tick_hz)
        {
            ++next_frame;
            frame_fraction -= s_tick_hz;
        }
        now = rt_tick_get();
        if ((rt_int32_t)(next_frame - now) > 0)
        {
            rt_thread_delay(next_frame - now);
        }
        else
        {
            next_frame = now;
        }
    }
}

rt_err_t pocketjs_app_start(void)
{
    rt_thread_t thread;

    if (s_started)
    {
        return -RT_EBUSY;
    }
    if (rt_sem_init(&s_ready, "pjsready", 0, RT_IPC_FLAG_FIFO) != RT_EOK)
    {
        return -RT_ERROR;
    }

    thread = rt_thread_create("pocketjs", pocketjs_task, RT_NULL,
                              POCKETJS_TASK_STACK_SIZE, POCKETJS_TASK_PRIORITY,
                              10U);
    if (thread == RT_NULL)
    {
        rt_sem_detach(&s_ready);
        return -RT_ENOMEM;
    }
    s_started = RT_TRUE;
    rt_thread_startup(thread);
    return RT_EOK;
}

rt_err_t pocketjs_app_wait_ready(rt_int32_t timeout)
{
    if (!s_started)
    {
        return -RT_EINVAL;
    }
    if (rt_sem_take(&s_ready, timeout) != RT_EOK)
    {
        return -RT_ETIMEOUT;
    }
    return s_init_result;
}
