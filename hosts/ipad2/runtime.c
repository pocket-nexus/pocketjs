#define POCKET_ACCEPTANCE_PATH "/private/var/tmp/pocketjs-iphone4s.status"
#define POCKET_ACCEPTANCE_TEMP "/private/var/tmp/pocketjs-iphone4s.status.new"
#define POCKET_CAPTURE_REQUEST_PATH "/private/var/tmp/pocketjs-iphone4s.capture"
#define POCKET_CAPTURE_OUTPUT_PATH "/private/var/tmp/pocketjs-iphone4s.frame.rgba"
#define POCKET_PREFER_GL_PATH "/private/var/tmp/pocketjs-iphone4s.gles1"
#define POCKET_GL_DEFAULT 1
#define POCKET_REQUIRE_GL 1

/*
 * iOS 6 still supports the runtime-registered UIKit host used by the original
 * iPhone target. Keeping one implementation also keeps touch hit facts,
 * damage accounting, and hardware receipts identical across legacy Apple
 * devices; this wrapper only scopes device-local paths.
 */
#include "../ios-legacy/runtime.c"
