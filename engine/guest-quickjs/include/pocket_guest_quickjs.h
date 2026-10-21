#ifndef POCKET_GUEST_QUICKJS_H
#define POCKET_GUEST_QUICKJS_H
#include "pocket_runtime.h"
#include "quickjs.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct pocket_guest_quickjs pocket_guest_quickjs;
typedef enum { POCKET_QJS_CANONICAL, POCKET_QJS_LEGACY_C, POCKET_QJS_IDF } pocket_qjs_profile;
/* The owned form creates a realm during initialize. The attached form leaves
 * the caller's context/runtime alive; destroy it only after guest shutdown.
 * Shutdown removes this guest's ui/__pak properties and invalidates callbacks.
 * Package buffers copy the source by default. Only builds with a verified
 * immutable-buffer patch may define POCKET_QJS_VERIFIED_IMMUTABLE_PAK to borrow
 * canonical/IDF package bytes; the LegacyC profile always owns a copy. */
pocket_guest_quickjs *pocket_guest_quickjs_create(pocket_qjs_profile profile);
pocket_guest_quickjs *pocket_guest_quickjs_attach(JSContext *context, pocket_qjs_profile profile);
const pocket_guest_v1 *pocket_guest_quickjs_vtable(void);
const char *pocket_guest_quickjs_error(const pocket_guest_quickjs *guest);
JSContext *pocket_guest_quickjs_context(pocket_guest_quickjs *guest);
void pocket_guest_quickjs_destroy(pocket_guest_quickjs *guest);
#ifdef __cplusplus
}
#endif
#endif
