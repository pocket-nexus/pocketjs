/* The generated QuickJS guest in a realm with a heap and stack limit. The
 * realm allocates from the shared pocket_host_* heap; cancellation is a flag
 * the interrupt handler reads. POCKET_QJS_BELLARD selects the allocator and
 * rejection-tracker signatures of the SDK's Bellard QuickJS. */
#include <rtthread.h>
#include <stdatomic.h>
#include <stddef.h>
#include <string.h>

#include "pocket/sifli.h"
#include "pocket_guest_quickjs.h"

typedef union {
  size_t size;
  max_align_t alignment;
} allocation_header;

typedef struct rejection {
  JSValue promise, reason;
  struct rejection *next;
} rejection;

struct pocket_sifli_guest {
  JSRuntime *runtime;
  JSContext *context;
  pocket_guest_quickjs *binding;
  atomic_bool interrupted;
  rejection *rejections;
  bool rejection_tracking_failed;
};

static void *heap_alloc(size_t size) {
  if (size == 0U || size > SIZE_MAX - sizeof(allocation_header))
    return NULL;
  allocation_header *header =
      pocket_host_alloc(sizeof(allocation_header) + size, _Alignof(allocation_header));
  if (header == NULL)
    return NULL;
  header->size = size;
  return header + 1;
}

static size_t heap_usable_size(const void *pointer) {
  return pointer == NULL ? 0U : (((const allocation_header *)pointer) - 1)->size;
}

static void heap_free(void *pointer) {
  if (pointer != NULL) {
    allocation_header *header = ((allocation_header *)pointer) - 1;
    pocket_host_free(header, sizeof(*header) + header->size, _Alignof(allocation_header));
  }
}

static void *heap_realloc(void *pointer, size_t size) {
  if (pointer == NULL)
    return heap_alloc(size);
  if (size == 0U) {
    heap_free(pointer);
    return NULL;
  }
  const size_t previous = heap_usable_size(pointer);
  void *next = heap_alloc(size);
  if (next == NULL)
    return NULL;
  memcpy(next, pointer, previous < size ? previous : size);
  heap_free(pointer);
  return next;
}

#if defined(POCKET_QJS_BELLARD)
typedef JS_BOOL guest_bool;
/* Bellard's runtime leaves malloc_limit to a custom allocator. */
static void *guest_malloc(JSMallocState *state, size_t size) {
  if (size > state->malloc_limit || state->malloc_size > state->malloc_limit - size)
    return NULL;
  void *pointer = heap_alloc(size);
  if (pointer != NULL) {
    state->malloc_count++;
    state->malloc_size += size;
  }
  return pointer;
}
static void guest_free(JSMallocState *state, void *pointer) {
  if (pointer == NULL)
    return;
  state->malloc_count--;
  state->malloc_size -= heap_usable_size(pointer);
  heap_free(pointer);
}
static void *guest_realloc(JSMallocState *state, void *pointer, size_t size) {
  const size_t previous = heap_usable_size(pointer);
  if (pointer != NULL && size != 0U && size > previous &&
      (size - previous > state->malloc_limit ||
       state->malloc_size > state->malloc_limit - (size - previous)))
    return NULL;
  if (pointer == NULL)
    return size == 0U ? NULL : guest_malloc(state, size);
  if (size == 0U) {
    guest_free(state, pointer);
    return NULL;
  }
  void *next = heap_realloc(pointer, size);
  if (next != NULL)
    state->malloc_size = state->malloc_size - previous + size;
  return next;
}
static const JSMallocFunctions GUEST_ALLOCATOR = {
    .js_malloc = guest_malloc,
    .js_free = guest_free,
    .js_realloc = guest_realloc,
    .js_malloc_usable_size = heap_usable_size,
};
#else
typedef bool guest_bool;
static void *guest_malloc(void *opaque, size_t size) {
  (void)opaque;
  return heap_alloc(size);
}
static void *guest_calloc(void *opaque, size_t count, size_t size) {
  (void)opaque;
  if (count != 0U && size > SIZE_MAX / count)
    return NULL;
  void *memory = heap_alloc(count * size);
  if (memory != NULL)
    memset(memory, 0, count * size);
  return memory;
}
static void guest_free(void *opaque, void *pointer) {
  (void)opaque;
  heap_free(pointer);
}
static void *guest_realloc(void *opaque, void *pointer, size_t size) {
  (void)opaque;
  return heap_realloc(pointer, size);
}
static const JSMallocFunctions GUEST_ALLOCATOR = {
    .js_calloc = guest_calloc,
    .js_malloc = guest_malloc,
    .js_free = guest_free,
    .js_realloc = guest_realloc,
    .js_malloc_usable_size = heap_usable_size,
};
#endif

static int interrupt_handler(JSRuntime *runtime, void *opaque) {
  (void)runtime;
  pocket_sifli_guest *guest = opaque;
  return atomic_load_explicit(&guest->interrupted, memory_order_relaxed);
}

static void promise_rejection(JSContext *context, JSValueConst promise, JSValueConst reason,
                              guest_bool handled, void *opaque) {
  pocket_sifli_guest *guest = opaque;
  rejection **slot = &guest->rejections;
  while (*slot != NULL && JS_VALUE_GET_PTR((*slot)->promise) != JS_VALUE_GET_PTR(promise))
    slot = &(*slot)->next;
  if (handled) {
    if (*slot != NULL) {
      rejection *entry = *slot;
      *slot = entry->next;
      JS_FreeValue(context, entry->promise);
      JS_FreeValue(context, entry->reason);
      heap_free(entry);
    }
    return;
  }
  if (*slot != NULL)
    return;
  rejection *entry = heap_alloc(sizeof(*entry));
  if (entry == NULL) {
    guest->rejection_tracking_failed = true;
    return;
  }
  entry->promise = JS_DupValue(context, promise);
  entry->reason = JS_DupValue(context, reason);
  entry->next = NULL;
  *slot = entry;
}

static int32_t report_rejections(pocket_sifli_guest *guest) {
  bool failed = guest->rejection_tracking_failed;
  guest->rejection_tracking_failed = false;
  size_t pending = 0;
  for (rejection *entry = guest->rejections; entry != NULL; entry = entry->next)
    ++pending;
  while (pending--) {
    rejection *entry = guest->rejections;
    if (entry == NULL)
      break;
    guest->rejections = entry->next;
    failed = true;
    /* Detach before toString can reenter the tracker. */
    const char *text = JS_ToCString(guest->context, entry->reason);
    rt_kprintf("[PocketJS] unhandled Promise rejection: %s\n", text != NULL ? text : "<value>");
    if (text != NULL)
      JS_FreeCString(guest->context, text);
    else
      JS_FreeValue(guest->context, JS_GetException(guest->context));
    JS_FreeValue(guest->context, entry->reason);
    JS_FreeValue(guest->context, entry->promise);
    heap_free(entry);
  }
  return failed ? POCKET_STATUS_FAILED : POCKET_STATUS_OK;
}

pocket_sifli_guest *pocket_sifli_guest_create(const pocket_sifli_guest_config *config) {
  if (config == NULL || config->struct_size < sizeof(*config) || config->heap_limit == 0U ||
      config->stack_limit == 0U)
    return NULL;
  pocket_sifli_guest *guest = rt_calloc(1, sizeof(*guest));
  if (guest == NULL)
    return NULL;
  atomic_init(&guest->interrupted, false);
  guest->runtime = JS_NewRuntime2(&GUEST_ALLOCATOR, guest);
  if (guest->runtime == NULL)
    goto failed;
  JS_SetMemoryLimit(guest->runtime, config->heap_limit);
  JS_SetMaxStackSize(guest->runtime, config->stack_limit);
  JS_SetInterruptHandler(guest->runtime, interrupt_handler, guest);
  JS_SetHostPromiseRejectionTracker(guest->runtime, promise_rejection, guest);
  guest->context = JS_NewContext(guest->runtime);
  if (guest->context == NULL)
    goto failed;
  guest->binding = pocket_guest_quickjs_attach(guest->context, POCKET_QJS_CANONICAL);
  if (guest->binding == NULL)
    goto failed;
  return guest;
failed:
  pocket_sifli_guest_destroy(guest);
  return NULL;
}

static int32_t initialize(void *opaque, pocket_runtime *runtime,
                          const pocket_guest_environment *environment) {
  pocket_sifli_guest *guest = opaque;
  return pocket_guest_quickjs_vtable()->initialize(guest->binding, runtime, environment);
}

static int32_t evaluate(void *opaque, pocket_runtime *runtime, const uint8_t *code,
                        size_t size) {
  pocket_sifli_guest *guest = opaque;
  JS_UpdateStackTop(guest->runtime);
  const int32_t status =
      pocket_guest_quickjs_vtable()->evaluate(guest->binding, runtime, code, size);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}

static int32_t frame(void *opaque, const pocket_guest_frame *input) {
  pocket_sifli_guest *guest = opaque;
  /* The stack limit counts from the calling thread's stack: the runner
   * thread ticks a runtime that another thread booted. */
  JS_UpdateStackTop(guest->runtime);
  const int32_t status = pocket_guest_quickjs_vtable()->frame(guest->binding, input);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}

static int32_t collect(void *opaque) {
  pocket_sifli_guest *guest = opaque;
  const int32_t status = pocket_guest_quickjs_vtable()->collect(guest->binding);
  return status == POCKET_STATUS_OK ? report_rejections(guest) : status;
}

static void shutdown(void *opaque) {
  pocket_sifli_guest *guest = opaque;
  pocket_guest_quickjs_vtable()->shutdown(guest->binding);
}

static const pocket_guest_v1 VTABLE = {sizeof(VTABLE), evaluate, frame,
                                       collect,        shutdown, initialize,
                                       NULL};

const pocket_guest_v1 *pocket_sifli_guest_vtable(void) { return &VTABLE; }

const char *pocket_sifli_guest_error(const pocket_sifli_guest *guest) {
  return guest != NULL ? pocket_guest_quickjs_error(guest->binding) : "invalid guest";
}

void pocket_sifli_guest_interrupt(pocket_sifli_guest *guest) {
  if (guest != NULL)
    atomic_store_explicit(&guest->interrupted, true, memory_order_relaxed);
}

void pocket_sifli_guest_destroy(pocket_sifli_guest *guest) {
  if (guest == NULL)
    return;
  if (guest->binding != NULL)
    pocket_guest_quickjs_destroy(guest->binding);
  while (guest->rejections != NULL) {
    rejection *entry = guest->rejections;
    guest->rejections = entry->next;
    JS_FreeValue(guest->context, entry->promise);
    JS_FreeValue(guest->context, entry->reason);
    heap_free(entry);
  }
  if (guest->context != NULL)
    JS_FreeContext(guest->context);
  if (guest->runtime != NULL)
    JS_FreeRuntime(guest->runtime);
  rt_free(guest);
}
