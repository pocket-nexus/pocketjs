#include "esp_heap_caps.h"
#include "esp_log.h"
#include "pocket/guest_idf.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
static const char *TAG = "pocket_guest_quickjs";
typedef union {
  size_t size;
  max_align_t alignment;
} allocation_header_t;
typedef struct rejection {
  JSValue promise, reason;
  struct rejection *next;
} rejection_t;
struct pocket_guest_idf {
  JSRuntime *runtime;
  JSContext *context;
  pocket_guest_quickjs *binding;
  bool prefer_psram;
  atomic_bool interrupted;
  rejection_t *rejections;
  bool rejection_tracking_failed;
};
static void *guest_malloc(void *opaque, size_t size) {
  pocket_guest_idf *guest = opaque;
  if (size == 0U || size > SIZE_MAX - sizeof(allocation_header_t)) {
    return NULL;
  }
  const size_t total = sizeof(allocation_header_t) + size;
  allocation_header_t *header = NULL;
  if (guest != NULL && guest->prefer_psram) {
    header = heap_caps_malloc(total, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  if (header == NULL) {
    header = heap_caps_malloc(total, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  if (header == NULL) {
    return NULL;
  }
  header->size = size;
  return header + 1;
}

static void *guest_calloc(void *opaque, size_t count, size_t size) {
  if (count != 0U && size > SIZE_MAX / count) {
    return NULL;
  }
  const size_t total = count * size;
  void *memory = guest_malloc(opaque, total);
  if (memory != NULL) {
    memset(memory, 0, total);
  }
  return memory;
}

static void guest_free(void *opaque, void *pointer) {
  (void)opaque;
  if (pointer != NULL) {
    heap_caps_free(((allocation_header_t *)pointer) - 1);
  }
}

static size_t guest_usable_size(const void *pointer) {
  return pointer == NULL ? 0U
                         : (((const allocation_header_t *)pointer) - 1)->size;
}

static void *guest_realloc(void *opaque, void *pointer, size_t size) {
  if (pointer == NULL) {
    return guest_malloc(opaque, size);
  }
  if (size == 0U) {
    guest_free(opaque, pointer);
    return NULL;
  }
  const size_t previous_size = guest_usable_size(pointer);
  void *next = guest_malloc(opaque, size);
  if (next == NULL) {
    return NULL;
  }
  memcpy(next, pointer, previous_size < size ? previous_size : size);
  guest_free(opaque, pointer);
  return next;
}

static const JSMallocFunctions GUEST_ALLOCATOR = {
    .js_calloc = guest_calloc,
    .js_malloc = guest_malloc,
    .js_free = guest_free,
    .js_realloc = guest_realloc,
    .js_malloc_usable_size = guest_usable_size,
};

static int interrupt_handler(JSRuntime *runtime, void *opaque) {
  (void)runtime;
  pocket_guest_idf *guest = opaque;
  return atomic_load_explicit(&guest->interrupted, memory_order_relaxed);
}
static void promise_rejection(JSContext *context, JSValueConst promise,
                              JSValueConst reason, bool handled, void *opaque) {
  pocket_guest_idf *guest = opaque;
  rejection_t **slot = &guest->rejections;
  while (*slot &&
         JS_VALUE_GET_PTR((*slot)->promise) != JS_VALUE_GET_PTR(promise))
    slot = &(*slot)->next;
  if (handled) {
    if (*slot) {
      rejection_t *entry = *slot;
      *slot = entry->next;
      JS_FreeValue(context, entry->promise);
      JS_FreeValue(context, entry->reason);
      free(entry);
    }
    return;
  }
  if (*slot)
    return;
  rejection_t *entry = calloc(1, sizeof(*entry));
  if (!entry) {
    guest->rejection_tracking_failed = true;
    return;
  }
  entry->promise = JS_DupValue(context, promise);
  entry->reason = JS_DupValue(context, reason);
  *slot = entry;
}

static int32_t report_rejections(pocket_guest_idf *guest) {
  bool failed = guest->rejection_tracking_failed;
  guest->rejection_tracking_failed = false;
  size_t pending = 0;
  for (rejection_t *entry = guest->rejections; entry; entry = entry->next)
    ++pending;
  while (pending--) {
    rejection_t *entry = guest->rejections;
    if (!entry)
      break;
    guest->rejections = entry->next;
    failed = true;
    /* Detach before toString can reenter the tracker. Reported promises no
     * longer need a retained reference; a later handled event is ignored. */
    const char *text = JS_ToCString(guest->context, entry->reason);
    ESP_LOGE(TAG, "Unhandled Promise rejection: %s", text ? text : "<value>");
    if (text)
      JS_FreeCString(guest->context, text);
    else
      JS_FreeValue(guest->context, JS_GetException(guest->context));
    JS_FreeValue(guest->context, entry->reason);
    JS_FreeValue(guest->context, entry->promise);
    free(entry);
  }
  return failed ? POCKET_STATUS_FAILED : POCKET_STATUS_OK;
}

pocket_guest_idf *
pocket_guest_idf_create(const pocket_guest_idf_config *config) {
  if (!config || !config->heap_limit || !config->stack_limit)
    return NULL;
  pocket_guest_idf *guest = calloc(1, sizeof(*guest));
  if (!guest)
    return NULL;
  guest->prefer_psram = config->prefer_psram;
  atomic_init(&guest->interrupted, false);
  guest->runtime = JS_NewRuntime2(&GUEST_ALLOCATOR, guest);
  if (!guest->runtime)
    goto failed;
  JS_SetMemoryLimit(guest->runtime, config->heap_limit);
  JS_SetMaxStackSize(guest->runtime, config->stack_limit);
  JS_SetInterruptHandler(guest->runtime, interrupt_handler, guest);
  JS_SetHostPromiseRejectionTracker(guest->runtime, promise_rejection, guest);
  guest->context = JS_NewContext(guest->runtime);
  if (!guest->context)
    goto failed;
  guest->binding = pocket_guest_quickjs_attach(guest->context, POCKET_QJS_IDF);
  if (!guest->binding)
    goto failed;
  return guest;
failed:
  pocket_guest_idf_destroy(guest);
  return NULL;
}
static int32_t initialize(void *opaque, pocket_runtime *runtime,
                          const pocket_guest_environment *environment) {
  pocket_guest_idf *guest = opaque;
  return pocket_guest_quickjs_vtable()->initialize(guest->binding, runtime,
                                                   environment);
}
static int32_t evaluate(void *opaque, pocket_runtime *runtime,
                        const uint8_t *code, size_t size) {
  pocket_guest_idf *guest = opaque;
  int32_t status = pocket_guest_quickjs_vtable()->evaluate(guest->binding,
                                                           runtime, code, size);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}
static int32_t frame(void *opaque, const pocket_guest_frame *input) {
  pocket_guest_idf *guest = opaque;
  int32_t status = pocket_guest_quickjs_vtable()->frame(guest->binding, input);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}
static int32_t collect(void *opaque) {
  pocket_guest_idf *guest = opaque;
  int32_t status = pocket_guest_quickjs_vtable()->collect(guest->binding);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}
static void shutdown(void *opaque) {
  pocket_guest_idf *guest = opaque;
  pocket_guest_quickjs_vtable()->shutdown(guest->binding);
}
static const pocket_guest_v1 VTABLE = {sizeof(VTABLE), evaluate, frame,
                                       collect,        shutdown, initialize};
const pocket_guest_v1 *pocket_guest_idf_vtable(void) { return &VTABLE; }
const char *pocket_guest_idf_error(const pocket_guest_idf *guest) {
  return guest ? pocket_guest_quickjs_error(guest->binding) : "invalid guest";
}
void pocket_guest_idf_interrupt(pocket_guest_idf *guest) {
  if (guest)
    atomic_store_explicit(&guest->interrupted, true, memory_order_relaxed);
}
void pocket_guest_idf_destroy(pocket_guest_idf *guest) {
  if (!guest)
    return;
  if (guest->binding)
    pocket_guest_quickjs_destroy(guest->binding);
  while (guest->rejections) {
    rejection_t *entry = guest->rejections;
    guest->rejections = entry->next;
    JS_FreeValue(guest->context, entry->promise);
    JS_FreeValue(guest->context, entry->reason);
    free(entry);
  }
  if (guest->context)
    JS_FreeContext(guest->context);
  if (guest->runtime)
    JS_FreeRuntime(guest->runtime);
  free(guest);
}
