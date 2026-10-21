#pragma once
#include "pocket_drivers.h"
#ifdef __cplusplus
extern "C" {
#endif

/* Test-side observations, not production ABI. IDs identify physical buffers or
 * resource versions. Stop events require an independent completion probe; the
 * return of wait alone is not evidence that DMA/GPU access stopped. */
#define POCKET_DRIVER_KIT_CAPACITY 64
#define POCKET_DRIVER_KIT_CHUNK 256

typedef enum pocket_driver_kit_event_kind {
    POCKET_KIT_ACQUIRE, POCKET_KIT_RENDER, POCKET_KIT_USE_RESOURCE,
    POCKET_KIT_RENDER_STOPPED, POCKET_KIT_RENDER_WAITED, POCKET_KIT_FLUSH,
    POCKET_KIT_DISPLAY_STOPPED, POCKET_KIT_DISPLAY_WAITED, POCKET_KIT_RETIRE,
    POCKET_KIT_RELEASE_RESOURCE, POCKET_KIT_INVALIDATE, POCKET_KIT_FRAME_END,
    POCKET_KIT_DESTROY
} pocket_driver_kit_event_kind;
/* id=submission/transfer/resource/buffer for single-ID events;
 * Render: id=submission, buffer=buffer;
 * UseResource: id=submission, resource=resource;
 * Flush: id=transfer, submission=submission, buffer=buffer. */
typedef struct pocket_driver_kit_event {
    pocket_driver_kit_event_kind kind;
    uint64_t id, submission, buffer, resource;
    int failed;
} pocket_driver_kit_event;
typedef enum pocket_driver_kit_error {
    POCKET_KIT_OK, POCKET_KIT_CAPACITY_EXCEEDED, POCKET_KIT_UNKNOWN_ID,
    POCKET_KIT_DUPLICATE_ID, POCKET_KIT_BUFFER_BUSY, POCKET_KIT_WAIT_BEFORE_STOP,
    POCKET_KIT_FLUSH_BEFORE_RENDER_WAIT, POCKET_KIT_RETIRE_BEFORE_STOP,
    POCKET_KIT_RESOURCE_STILL_REFERENCED, POCKET_KIT_MISSING_INVALIDATION,
    POCKET_KIT_PENDING_WORK, POCKET_KIT_FAILURE_NOT_REPORTED, POCKET_KIT_MISSING_FRAME_END,
    POCKET_KIT_INVALID_ARGUMENT, POCKET_KIT_SOURCE_ERROR, POCKET_KIT_SOURCE_MISMATCH,
    POCKET_KIT_INPUT_MISMATCH
} pocket_driver_kit_error;
typedef struct pocket_driver_kit_job {
    uint64_t id, buffer;
    int stopped, waited, failed;
} pocket_driver_kit_job;
typedef struct pocket_driver_kit_transfer {
    uint64_t id, submission, buffer;
    int stopped;
} pocket_driver_kit_transfer;
typedef struct pocket_driver_kit_reference { uint64_t submission, resource; } pocket_driver_kit_reference;
typedef struct pocket_driver_kit_lifecycle {
    size_t capacity, event_index, violation_index;
    pocket_driver_kit_error violation;
    pocket_driver_kit_job jobs[POCKET_DRIVER_KIT_CAPACITY];
    pocket_driver_kit_transfer transfers[POCKET_DRIVER_KIT_CAPACITY];
    pocket_driver_kit_reference references[POCKET_DRIVER_KIT_CAPACITY];
    uint64_t acquired[POCKET_DRIVER_KIT_CAPACITY], dirty[POCKET_DRIVER_KIT_CAPACITY];
    size_t job_count, transfer_count, reference_count, acquired_count, dirty_count;
    int saw_failure, open_frame;
} pocket_driver_kit_lifecycle;
/* Capacity bounds each table. Errors are sticky; drain real hardware even
 * after the audit fails. The verifier never performs hardware cleanup. */
pocket_driver_kit_error pocket_driver_kit_init(pocket_driver_kit_lifecycle *, size_t capacity);
pocket_driver_kit_error pocket_driver_kit_observe(pocket_driver_kit_lifecycle *, pocket_driver_kit_event);
pocket_driver_kit_error pocket_driver_kit_finish(const pocket_driver_kit_lifecycle *);
/* Checks length, optional all, partial ranges, EOF, and zero-length reads.
 * Expected data is independent test evidence. Source callbacks must obey their
 * C memory contract; use ASan or guarded storage to catch illegal writes. */
pocket_driver_kit_error pocket_driver_kit_check_package(const pocket_package_source_v1 *, void *context,
    const uint8_t *expected, size_t length, size_t chunk_size);
/* Inspector executes inside append; it must inspect/copy before returning.
 * This check does not retain source-owned frame pointers after append. */
typedef int (*pocket_driver_kit_inspect_input)(void *, const pocket_input_frame *);
pocket_driver_kit_error pocket_driver_kit_check_input(const pocket_input_source_v1 *, void *context,
    uint32_t expected_classes, size_t expected_appends, pocket_driver_kit_inspect_input, void *inspector_context);
#ifdef __cplusplus
}
#endif
