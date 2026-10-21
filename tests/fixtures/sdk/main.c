#define _POSIX_C_SOURCE 200112L
#include <pocket/runtime.h>
#include <pocket/pocket_guest_quickjs.h>
#include "profile.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t allocations;
void *pocket_host_alloc(size_t size, size_t alignment) {
    void *pointer = NULL;
    if (alignment < sizeof(void *)) alignment = sizeof(void *);
    if (posix_memalign(&pointer, alignment, size ? size : 1)) return NULL;
    allocations++;
    return pointer;
}
void pocket_host_free(void *pointer, size_t size, size_t alignment) {
    (void)size; (void)alignment;
    if (pointer) { assert(allocations); allocations--; free(pointer); }
}
void *pocket_host_realloc(void *pointer, size_t old_size, size_t alignment, size_t size) {
    void *next = pocket_host_alloc(size, alignment);
    if (!next) return NULL;
    if (pointer) memcpy(next, pointer, old_size < size ? old_size : size);
    pocket_host_free(pointer, old_size, alignment);
    return next;
}
void pocket_host_panic(const char *message, size_t length) { fwrite(message, 1, length, stderr); abort(); }
void pocket_host_log(int32_t level, const char *message, size_t length) { (void)level; (void)message; (void)length; }
void pocket_host_boot_stage(int32_t stage) { (void)stage; }

static uint8_t pixels[64];
static pocket_rect region;
static pocket_surface surface;
static int flushes, waits;
static int32_t package_length(void *self, size_t *out) { (void)self; *out = sizeof(package_bytes); return 0; }
static int32_t package_all(void *self, const uint8_t **out, size_t *length) { (void)self; *out = package_bytes; *length = sizeof(package_bytes); return 0; }
static int32_t package_range(void *self, size_t offset, uint8_t *out, size_t capacity, size_t *read) {
    (void)self; if (offset > sizeof(package_bytes)) return POCKET_STATUS_INVALID;
    size_t remaining = sizeof(package_bytes) - offset; *read = remaining < capacity ? remaining : capacity;
    if (*read) memcpy(out, package_bytes + offset, *read);
    return 0;
}
static int32_t descriptor(void *self, pocket_display_descriptor *out) {
    (void)self; memset(out, 0, sizeof(*out)); out->struct_size = sizeof(*out);
    out->role = POCKET_DISPLAY_ROLE_PRIMARY; out->width = 4; out->height = 4;
    out->pixel_format = POCKET_PIXEL_FORMAT_RGBA8888; out->stride_bytes = 16;
    out->target_kind = POCKET_TARGET_CPU_VISIBLE;
    out->refresh_width = out->refresh_height = out->window_x_alignment = out->window_y_alignment = 1;
    return 0;
}
static int32_t acquire(void *self, const pocket_rect *requested, pocket_target *out) {
    (void)self; region = *requested;
    surface = (pocket_surface){sizeof(surface), pixels, sizeof(pixels), &region, 16, POCKET_PIXEL_FORMAT_RGBA8888};
    *out = (pocket_target){sizeof(*out), POCKET_TARGET_CPU_VISIBLE, &region, POCKET_PIXEL_FORMAT_RGBA8888, &surface, 0};
    return 0;
}
static int32_t flush(void *self, const pocket_rect *regions, size_t count, uint64_t *token) { (void)self; assert(regions && count); *token = (uint64_t)++flushes; return 0; }
static int32_t wait_display(void *self, uint64_t token) { (void)self; assert(token > 0); waits++; return 0; }

int main(void) {
    pocket_runtime_config config = {0};
    config.struct_size = sizeof(config);
    memcpy(config.profile_hash, profile_hash, sizeof(profile_hash));
    config.host_abi = POCKET_BINDING_GENERATION;
    config.tick_hz = 60;
    config.heap_limit = 1024 * 1024;
    config.frame_buffer_budget = 1024;
    config.profile_json = (const uint8_t *)profile_json;
    config.profile_json_length = sizeof(profile_json) - 1;
    pocket_runtime *runtime = pocket_runtime_create(&config);
    assert(runtime);
    pocket_guest_quickjs *guest = pocket_guest_quickjs_create(POCKET_QJS_CANONICAL);
    assert(guest);
    assert(pocket_runtime_set_guest(runtime, pocket_guest_quickjs_vtable(), guest) == POCKET_STATUS_OK);
    pocket_package_source_v1 source = {sizeof(source), package_length, package_all, package_range};
    pocket_display_output_v1 display = {.struct_size=sizeof(display), .descriptor=descriptor, .acquire=acquire, .flush=flush, .wait=wait_display};
    assert(pocket_runtime_set_package_source(runtime, &source, NULL) == POCKET_STATUS_OK);
    assert(pocket_runtime_add_display(runtime, &display, NULL, POCKET_RENDERER_SOFTWARE) == POCKET_STATUS_OK);
    assert(pocket_runtime_supports_op(runtime, 1)); /* createNode */
    assert(pocket_runtime_boot(runtime) == POCKET_STATUS_OK);
    assert(pocket_runtime_tick(runtime) == POCKET_STATUS_OK);
    JSContext *ctx = pocket_guest_quickjs_context(guest);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue value = JS_GetPropertyStr(ctx, global, "frameCount");
    int32_t frames = 0; assert(JS_ToInt32(ctx, &frames, value) == 0 && frames == 1);
    JS_FreeValue(ctx, value); JS_FreeValue(ctx, global);
    assert(flushes > 0 && waits == flushes);
    pocket_runtime_destroy(runtime);
    pocket_guest_quickjs_destroy(guest);
    assert(allocations == 0);
    puts("relocated SDK: one Rust archive, C guest, six hooks, zero leaks");
    return 0;
}
