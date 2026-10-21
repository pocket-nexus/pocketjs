#include "pocket_driver_kit.h"
#include <string.h>

#define REMOVE(table, count, at) ((table)[at] = (table)[--(count)])
static size_t find_id(const uint64_t *items, size_t count, uint64_t id) {
    size_t i; for (i = 0; i < count; i++) if (items[i] == id) break; return i;
}
static int busy(const pocket_driver_kit_lifecycle *s, uint64_t buffer) {
    size_t i;
    for (i = 0; i < s->job_count; i++) if (s->jobs[i].buffer == buffer) return 1;
    for (i = 0; i < s->transfer_count; i++) if (s->transfers[i].buffer == buffer) return 1;
    return 0;
}
static pocket_driver_kit_error failure(pocket_driver_kit_lifecycle *s, uint64_t buffer) {
    s->saw_failure = 1;
    if (find_id(s->dirty, s->dirty_count, buffer) == s->dirty_count) {
        if (s->dirty_count == s->capacity) return POCKET_KIT_CAPACITY_EXCEEDED;
        s->dirty[s->dirty_count++] = buffer;
    }
    return POCKET_KIT_OK;
}
pocket_driver_kit_error pocket_driver_kit_init(pocket_driver_kit_lifecycle *s, size_t capacity) {
    if (!s) return POCKET_KIT_INVALID_ARGUMENT;
    memset(s, 0, sizeof(*s));
    if (!capacity || capacity > POCKET_DRIVER_KIT_CAPACITY) return s->violation = POCKET_KIT_INVALID_ARGUMENT;
    s->capacity = capacity;
    return POCKET_KIT_OK;
}
static pocket_driver_kit_error apply(pocket_driver_kit_lifecycle *s, pocket_driver_kit_event e) {
    size_t i, j;
    switch (e.kind) {
    case POCKET_KIT_ACQUIRE:
        s->open_frame = 1;
        if (busy(s, e.id)) return POCKET_KIT_BUFFER_BUSY;
        if (find_id(s->acquired, s->acquired_count, e.id) == s->acquired_count) {
            if (s->acquired_count == s->capacity) return POCKET_KIT_CAPACITY_EXCEEDED;
            s->acquired[s->acquired_count++] = e.id;
        }
        break;
    case POCKET_KIT_RENDER:
        for (i = 0; i < s->job_count; i++) if (s->jobs[i].id == e.id) return POCKET_KIT_DUPLICATE_ID;
        if (busy(s, e.buffer)) return POCKET_KIT_BUFFER_BUSY;
        i = find_id(s->acquired, s->acquired_count, e.buffer);
        if (i == s->acquired_count) return POCKET_KIT_UNKNOWN_ID;
        if (s->job_count == s->capacity) return POCKET_KIT_CAPACITY_EXCEEDED;
        REMOVE(s->acquired, s->acquired_count, i);
        s->jobs[s->job_count++] = (pocket_driver_kit_job){e.id, e.buffer, 0, 0, 0};
        break;
    case POCKET_KIT_USE_RESOURCE:
        for (i = 0; i < s->job_count && s->jobs[i].id != e.id; i++) {}
        if (i == s->job_count) return POCKET_KIT_UNKNOWN_ID;
        for (i = 0; i < s->reference_count; i++)
            if (s->references[i].submission == e.id && s->references[i].resource == e.resource) return POCKET_KIT_OK;
        if (s->reference_count == s->capacity) return POCKET_KIT_CAPACITY_EXCEEDED;
        s->references[s->reference_count++] = (pocket_driver_kit_reference){e.id, e.resource};
        break;
    case POCKET_KIT_RENDER_STOPPED:
    case POCKET_KIT_RENDER_WAITED:
    case POCKET_KIT_RETIRE:
        for (i = 0; i < s->job_count && s->jobs[i].id != e.id; i++) {}
        if (i == s->job_count) return POCKET_KIT_UNKNOWN_ID;
        if (e.kind == POCKET_KIT_RENDER_STOPPED) s->jobs[i].stopped = 1;
        else if (e.kind == POCKET_KIT_RENDER_WAITED) {
            if (!s->jobs[i].stopped) return POCKET_KIT_WAIT_BEFORE_STOP;
            s->jobs[i].waited = 1; s->jobs[i].failed |= e.failed;
            if (e.failed) return failure(s, s->jobs[i].buffer);
        } else {
            if (!s->jobs[i].stopped) return POCKET_KIT_RETIRE_BEFORE_STOP;
            for (j = 0; j < s->transfer_count; j++) if (s->transfers[j].submission == e.id) return POCKET_KIT_RETIRE_BEFORE_STOP;
            REMOVE(s->jobs, s->job_count, i);
            for (j = 0; j < s->reference_count;) {
                if (s->references[j].submission == e.id) REMOVE(s->references, s->reference_count, j); else j++;
            }
        }
        break;
    case POCKET_KIT_FLUSH:
        for (i = 0; i < s->transfer_count; i++) if (s->transfers[i].id == e.id) return POCKET_KIT_DUPLICATE_ID;
        for (i = 0; i < s->job_count && s->jobs[i].id != e.submission; i++) {}
        if (i == s->job_count) return POCKET_KIT_UNKNOWN_ID;
        if (s->jobs[i].buffer != e.buffer || !s->jobs[i].waited || s->jobs[i].failed) return POCKET_KIT_FLUSH_BEFORE_RENDER_WAIT;
        for (i = 0; i < s->transfer_count; i++) if (s->transfers[i].buffer == e.buffer) return POCKET_KIT_BUFFER_BUSY;
        if (s->transfer_count == s->capacity) return POCKET_KIT_CAPACITY_EXCEEDED;
        s->transfers[s->transfer_count++] = (pocket_driver_kit_transfer){e.id, e.submission, e.buffer, 0};
        break;
    case POCKET_KIT_DISPLAY_STOPPED:
    case POCKET_KIT_DISPLAY_WAITED:
        for (i = 0; i < s->transfer_count && s->transfers[i].id != e.id; i++) {}
        if (i == s->transfer_count) return POCKET_KIT_UNKNOWN_ID;
        if (e.kind == POCKET_KIT_DISPLAY_STOPPED) s->transfers[i].stopped = 1;
        else {
            uint64_t buffer = s->transfers[i].buffer;
            if (!s->transfers[i].stopped) return POCKET_KIT_WAIT_BEFORE_STOP;
            REMOVE(s->transfers, s->transfer_count, i);
            if (e.failed) return failure(s, buffer);
        }
        break;
    case POCKET_KIT_RELEASE_RESOURCE:
        for (i = 0; i < s->reference_count; i++) if (s->references[i].resource == e.id) return POCKET_KIT_RESOURCE_STILL_REFERENCED;
        break;
    case POCKET_KIT_INVALIDATE:
        i = find_id(s->dirty, s->dirty_count, e.id);
        if (i < s->dirty_count) REMOVE(s->dirty, s->dirty_count, i);
        break;
    case POCKET_KIT_FRAME_END:
    case POCKET_KIT_DESTROY:
        if (s->job_count || s->transfer_count || s->reference_count) return POCKET_KIT_PENDING_WORK;
        if (e.kind == POCKET_KIT_FRAME_END) {
            if (s->saw_failure && !e.failed) return POCKET_KIT_FAILURE_NOT_REPORTED;
            if (s->dirty_count) return POCKET_KIT_MISSING_INVALIDATION;
        }
        s->dirty_count = s->acquired_count = 0; s->saw_failure = s->open_frame = 0;
        break;
    default: return POCKET_KIT_INVALID_ARGUMENT;
    }
    return POCKET_KIT_OK;
}
pocket_driver_kit_error pocket_driver_kit_observe(pocket_driver_kit_lifecycle *s, pocket_driver_kit_event event) {
    pocket_driver_kit_error error;
    if (!s || !s->capacity) return POCKET_KIT_INVALID_ARGUMENT;
    if (s->violation) return s->violation;
    error = apply(s, event);
    if (error) { s->violation = error; s->violation_index = s->event_index; }
    s->event_index++;
    return error;
}
pocket_driver_kit_error pocket_driver_kit_finish(const pocket_driver_kit_lifecycle *s) {
    if (!s || !s->capacity) return POCKET_KIT_INVALID_ARGUMENT;
    if (s->violation) return s->violation;
    if (s->job_count || s->transfer_count || s->reference_count) return POCKET_KIT_PENDING_WORK;
    if (s->dirty_count) return POCKET_KIT_MISSING_INVALIDATION;
    if (s->open_frame) return POCKET_KIT_MISSING_FRAME_END;
    return POCKET_KIT_OK;
}

pocket_driver_kit_error pocket_driver_kit_check_package(const pocket_package_source_v1 *s, void *context,
    const uint8_t *expected, size_t length, size_t chunk) {
    uint8_t buffer[POCKET_DRIVER_KIT_CHUNK + 1];
    const uint8_t *all = NULL;
    size_t actual = 0, offset = 0, count, capacity;
    int32_t status;
    if (!s || s->struct_size < offsetof(pocket_package_source_v1, range) + sizeof(s->range) || !s->length || !s->range ||
        (!expected && length) || !chunk || chunk > POCKET_DRIVER_KIT_CHUNK) return POCKET_KIT_INVALID_ARGUMENT;
    if (s->length(context, &actual)) return POCKET_KIT_SOURCE_ERROR;
    if (actual != length) return POCKET_KIT_SOURCE_MISMATCH;
    if (s->all) {
        status = s->all(context, &all, &actual);
        if (status != POCKET_STATUS_OK && status != POCKET_STATUS_UNSUPPORTED) return POCKET_KIT_SOURCE_ERROR;
        if (!status && (actual != length || (!all && actual) || (actual && memcmp(all, expected, actual)))) return POCKET_KIT_SOURCE_MISMATCH;
    }
    while (offset < length) {
        capacity = length - offset < chunk ? length - offset : chunk;
        memset(buffer, 0xa5, sizeof(buffer)); count = SIZE_MAX;
        if (s->range(context, offset, buffer, capacity, &count)) return POCKET_KIT_SOURCE_ERROR;
        if (!count || count > capacity || buffer[capacity] != 0xa5 || memcmp(buffer, expected + offset, count)) return POCKET_KIT_SOURCE_MISMATCH;
        offset += count;
    }
    count = SIZE_MAX; buffer[0] = 0xa5;
    if (s->range(context, length, buffer, 1, &count)) return POCKET_KIT_SOURCE_ERROR;
    if (count || buffer[0] != 0xa5) return POCKET_KIT_SOURCE_MISMATCH;
    count = SIZE_MAX;
    if (s->range(context, 0, buffer, 0, &count)) return POCKET_KIT_SOURCE_ERROR;
    if (count || buffer[0] != 0xa5) return POCKET_KIT_SOURCE_MISMATCH;
    if (length < SIZE_MAX && s->range(context, length + 1, buffer, 1, &count) != POCKET_STATUS_INVALID) return POCKET_KIT_SOURCE_MISMATCH;
    if (s->length(context, &actual) || actual != length) return POCKET_KIT_SOURCE_MISMATCH;
    return POCKET_KIT_OK;
}

typedef struct input_check {
    uint32_t classes;
    size_t count;
    pocket_driver_kit_inspect_input inspect;
    void *context;
    int bad;
} input_check;
static int32_t inspect_frame(void *context, const pocket_input_frame *f) {
    input_check *c = context;
    uint32_t used = 0;
    if (!f || f->struct_size < sizeof(*f)) { c->bad = 1; return POCKET_STATUS_INVALID; }
    if (f->buttons) used |= POCKET_INPUT_CLASS_BUTTONS;
    if (f->axis_count) used |= POCKET_INPUT_CLASS_AXIS_ABSOLUTE;
    if (f->relative_count) used |= POCKET_INPUT_CLASS_AXIS_RELATIVE;
    if (f->pointer) used |= POCKET_INPUT_CLASS_POINTER;
    if (f->contact_count || f->cancelled_count) used |= POCKET_INPUT_CLASS_CONTACT;
    if (f->text_count) used |= POCKET_INPUT_CLASS_TEXT;
    if (f->motion) used |= POCKET_INPUT_CLASS_MOTION;
    if ((used & ~c->classes) || (f->axis_count && !f->axes) || (f->relative_count && !f->relative) ||
        (f->contact_count && !f->contacts) || (f->cancelled_count && !f->cancelled) || (f->text_count && !f->text) ||
        (c->inspect && !c->inspect(c->context, f))) { c->bad = 1; return POCKET_STATUS_INVALID; }
    c->count++;
    return POCKET_STATUS_OK;
}
pocket_driver_kit_error pocket_driver_kit_check_input(const pocket_input_source_v1 *source, void *context,
    uint32_t expected_classes, size_t expected_appends, pocket_driver_kit_inspect_input inspect, void *inspector_context) {
    input_check check = {expected_classes, 0, inspect, inspector_context, 0};
    pocket_input_frame_builder builder = {sizeof(builder), &check, inspect_frame};
    const uint32_t known = POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_AXIS_ABSOLUTE | POCKET_INPUT_CLASS_AXIS_RELATIVE | POCKET_INPUT_CLASS_POINTER | POCKET_INPUT_CLASS_CONTACT | POCKET_INPUT_CLASS_TEXT | POCKET_INPUT_CLASS_MOTION;
    if (!source || source->struct_size < sizeof(*source) || !source->classes || !source->poll) return POCKET_KIT_INVALID_ARGUMENT;
    if ((expected_classes & ~known) || source->classes(context) != expected_classes) return POCKET_KIT_INPUT_MISMATCH;
    if (source->poll(context, &builder) || check.bad || check.count != expected_appends ||
        builder.struct_size != sizeof(builder) || builder.context != &check || builder.append != inspect_frame) return POCKET_KIT_INPUT_MISMATCH;
    return POCKET_KIT_OK;
}
