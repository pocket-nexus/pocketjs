#include <stdio.h>

/* Every User app owns its tmp directory. Resolve it at runtime because iOS
 * chooses a container UUID at installation and may change it on update. */
extern void *NSTemporaryDirectory(void);
extern void *sel_registerName(const char *name);
extern void *objc_msgSend(void);
static const char *pocket_ipod_receipt_path(unsigned index, const char *suffix) {
  static char paths[4][4096];
  if (!paths[index][0]) {
    const char *tmp = ((const char *(*)(void *, void *))objc_msgSend)(
      NSTemporaryDirectory(), sel_registerName("UTF8String"));
    snprintf(paths[index], sizeof(paths[index]), "%spocketjs.%s", tmp, suffix);
  }
  return paths[index];
}
#define POCKET_ACCEPTANCE_PATH pocket_ipod_receipt_path(0, "status")
#define POCKET_ACCEPTANCE_TEMP pocket_ipod_receipt_path(1, "status.new")
#define POCKET_CAPTURE_REQUEST_PATH pocket_ipod_receipt_path(2, "capture")
#define POCKET_CAPTURE_OUTPUT_PATH pocket_ipod_receipt_path(3, "frame.rgba")

#include "host.c"
