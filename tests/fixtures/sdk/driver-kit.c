#include <pocket/pocket_driver_kit.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define EVENT(k, ...) (pocket_driver_kit_event){.kind=POCKET_KIT_##k, __VA_ARGS__}
#define OBS(k, ...) assert(pocket_driver_kit_observe(&s, EVENT(k, __VA_ARGS__)) == POCKET_KIT_OK)
static void begin(pocket_driver_kit_lifecycle *s) {
    assert(pocket_driver_kit_init(s, 8) == POCKET_KIT_OK);
    assert(pocket_driver_kit_observe(s, EVENT(ACQUIRE, .id=10)) == POCKET_KIT_OK);
    assert(pocket_driver_kit_observe(s, EVENT(RENDER, .id=1, .buffer=10)) == POCKET_KIT_OK);
}
static void lifecycle(void) {
    pocket_driver_kit_lifecycle s;
    begin(&s);
    OBS(USE_RESOURCE, .id=1, .resource=100);
    OBS(ACQUIRE, .id=20); OBS(RENDER, .id=2, .buffer=20);
    OBS(USE_RESOURCE, .id=2, .resource=100);
    OBS(RENDER_STOPPED, .id=2); OBS(RENDER_WAITED, .id=2);
    OBS(FLUSH, .id=22, .submission=2, .buffer=20);
    OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1);
    OBS(FLUSH, .id=11, .submission=1, .buffer=10);
    OBS(DISPLAY_STOPPED, .id=22); OBS(DISPLAY_WAITED, .id=22);
    OBS(RETIRE, .id=2);
    OBS(DISPLAY_STOPPED, .id=11); OBS(DISPLAY_WAITED, .id=11);
    OBS(RETIRE, .id=1); OBS(RELEASE_RESOURCE, .id=100);
    assert(pocket_driver_kit_finish(&s) == POCKET_KIT_MISSING_FRAME_END);
    OBS(FRAME_END, .failed=0); assert(pocket_driver_kit_finish(&s) == POCKET_KIT_OK);
    OBS(DESTROY, .id=0);

    begin(&s); OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1, .failed=1);
    OBS(RETIRE, .id=1); OBS(INVALIDATE, .id=10); OBS(FRAME_END, .failed=1);
    assert(pocket_driver_kit_finish(&s) == POCKET_KIT_OK);
    begin(&s); OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1);
    OBS(FLUSH, .id=3, .submission=1, .buffer=10); OBS(DISPLAY_STOPPED, .id=3);
    OBS(DISPLAY_WAITED, .id=3, .failed=1); OBS(RETIRE, .id=1);
    OBS(INVALIDATE, .id=10); OBS(FRAME_END, .failed=1);

    begin(&s);
    assert(pocket_driver_kit_observe(&s, EVENT(RENDER_WAITED, .id=1, .failed=1)) == POCKET_KIT_WAIT_BEFORE_STOP);
    assert(s.violation_index == 2);
    assert(pocket_driver_kit_observe(&s, EVENT(DESTROY, .id=0)) == POCKET_KIT_WAIT_BEFORE_STOP);
    begin(&s); OBS(USE_RESOURCE, .id=1, .resource=99);
    assert(pocket_driver_kit_observe(&s, EVENT(RELEASE_RESOURCE, .id=99)) == POCKET_KIT_RESOURCE_STILL_REFERENCED);
    begin(&s);
    assert(pocket_driver_kit_observe(&s, EVENT(ACQUIRE, .id=10)) == POCKET_KIT_BUFFER_BUSY);
    begin(&s);
    assert(pocket_driver_kit_observe(&s, EVENT(FLUSH, .id=3, .submission=1, .buffer=10)) == POCKET_KIT_FLUSH_BEFORE_RENDER_WAIT);
    begin(&s);
    assert(pocket_driver_kit_observe(&s, EVENT(RETIRE, .id=1)) == POCKET_KIT_RETIRE_BEFORE_STOP);
    begin(&s); OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1);
    OBS(FLUSH, .id=3, .submission=1, .buffer=10);
    assert(pocket_driver_kit_observe(&s, EVENT(DISPLAY_WAITED, .id=3)) == POCKET_KIT_WAIT_BEFORE_STOP);
    begin(&s); OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1, .failed=1); OBS(RETIRE, .id=1);
    assert(pocket_driver_kit_observe(&s, EVENT(FRAME_END, .failed=1)) == POCKET_KIT_MISSING_INVALIDATION);
    begin(&s); OBS(RENDER_STOPPED, .id=1); OBS(RENDER_WAITED, .id=1, .failed=1); OBS(RETIRE, .id=1); OBS(INVALIDATE, .id=10);
    assert(pocket_driver_kit_observe(&s, EVENT(FRAME_END, .failed=0)) == POCKET_KIT_FAILURE_NOT_REPORTED);
    begin(&s);
    assert(pocket_driver_kit_observe(&s, EVENT(DESTROY, .id=0)) == POCKET_KIT_PENDING_WORK);
    assert(pocket_driver_kit_init(&s, 1) == POCKET_KIT_OK);
    OBS(ACQUIRE, .id=1);
    assert(pocket_driver_kit_observe(&s, EVENT(ACQUIRE, .id=2)) == POCKET_KIT_CAPACITY_EXCEEDED);
}
static const uint8_t bytes[] = {1, 2, 3, 4, 5};
static int32_t length(void *ctx, size_t *out) { (void)ctx; *out=sizeof(bytes); return 0; }
static int32_t all(void *ctx, const uint8_t **out, size_t *n) { (void)ctx; *out=bytes; *n=sizeof(bytes); return 0; }
static int32_t range(void *ctx, size_t off, uint8_t *out, size_t cap, size_t *n) {
    int bad = *(int *)ctx;
    if (off > sizeof(bytes)) return POCKET_STATUS_INVALID;
    *n = sizeof(bytes) - off;
    if (*n > cap) *n = cap;
    if (*n > 2) *n = 2; /* conforming short reads */
    if (*n) memcpy(out, bytes + off, *n);
    if (bad == 1) *n = cap + 1;
    if (bad == 2 && *n) out[0] ^= 1;
    return 0;
}
static uint32_t classes(void *ctx) { (void)ctx; return POCKET_INPUT_CLASS_BUTTONS; }
static int32_t poll(void *ctx, pocket_input_frame_builder *builder) {
    pocket_input_frame frame = {.struct_size=sizeof(frame), .buttons=8};
    if (*(int *)ctx) frame.contact_count = 1;
    return builder->append(builder->context, &frame);
}
static int inspect(void *ctx, const pocket_input_frame *frame) { (*(int *)ctx)++; return frame->buttons == 8; }
int main(void) {
    int bad=0, calls=0;
    pocket_package_source_v1 source = {sizeof(source), length, all, range, NULL};
    pocket_input_source_v1 input = {sizeof(input), classes, poll};
    lifecycle();
    assert(pocket_driver_kit_check_package(&source, &bad, bytes, sizeof(bytes), 3) == POCKET_KIT_OK);
    source.all = NULL;
    assert(pocket_driver_kit_check_package(&source, &bad, bytes, sizeof(bytes), 1) == POCKET_KIT_OK);
    bad=1; assert(pocket_driver_kit_check_package(&source, &bad, bytes, sizeof(bytes), 3) == POCKET_KIT_SOURCE_MISMATCH);
    bad=2; assert(pocket_driver_kit_check_package(&source, &bad, bytes, sizeof(bytes), 3) == POCKET_KIT_SOURCE_MISMATCH);
    bad=0;
    assert(pocket_driver_kit_check_input(&input, &bad, POCKET_INPUT_CLASS_BUTTONS, 1, inspect, &calls) == POCKET_KIT_OK && calls == 1);
    bad=1;
    assert(pocket_driver_kit_check_input(&input, &bad, POCKET_INPUT_CLASS_BUTTONS, 1, inspect, &calls) == POCKET_KIT_INPUT_MISMATCH);
    assert(calls == 1); /* invalid class/pointer rejected before inspector */
    puts("C driver kit: delayed multiscreen, terminal failures, source/input negative controls passed");
    return 0;
}
