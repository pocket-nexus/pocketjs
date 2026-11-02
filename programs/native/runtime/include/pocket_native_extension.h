#ifndef POCKET_NATIVE_EXTENSION_H
#define POCKET_NATIVE_EXTENSION_H

#include <stddef.h>
#include <stdint.h>

typedef struct JSContext JSContext;

#ifdef __cplusplus
extern "C" {
#endif

enum {
    POCKET_NATIVE_EXTENSION_ABI_V1 = 1,
    POCKET_NATIVE_EXTENSION_DEPTH_BUFFER = 1u << 0
};

enum {
    POCKET_NATIVE_KEY_MOVE_FORWARD = 1u << 0,
    POCKET_NATIVE_KEY_MOVE_BACK = 1u << 1,
    POCKET_NATIVE_KEY_MOVE_LEFT = 1u << 2,
    POCKET_NATIVE_KEY_MOVE_RIGHT = 1u << 3,
    POCKET_NATIVE_KEY_LOOK_UP = 1u << 4,
    POCKET_NATIVE_KEY_LOOK_DOWN = 1u << 5,
    POCKET_NATIVE_KEY_LOOK_LEFT = 1u << 6,
    POCKET_NATIVE_KEY_LOOK_RIGHT = 1u << 7,
    POCKET_NATIVE_KEY_FIRE = 1u << 8,
    POCKET_NATIVE_KEY_JUMP = 1u << 9,
    POCKET_NATIVE_KEY_RELOAD = 1u << 10,
    POCKET_NATIVE_KEY_WALK = 1u << 11
};

/*
 * Optional, statically linked application extension. The native host owns
 * QuickJS, the GL context and the immutable PAK bytes. Callbacks are
 * synchronous on that one UI/render thread. `boot` may borrow `pak` until
 * `shutdown`; every other pointer is call-scoped.
 */
typedef struct PocketNativeExtensionV1 {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t flags;
    int32_t (*boot)(
        JSContext *context,
        const uint8_t *pak,
        size_t pak_len,
        int32_t viewport_width,
        int32_t viewport_height
    );
    /*
     * `gl_context_current` is non-zero only while the owning GLES context is
     * live and current. Extensions must abandon handles without issuing GL
     * calls when it is zero.
     */
    void (*shutdown)(int32_t gl_context_current);
    int32_t (*before_guest)(
        JSContext *context,
        uint32_t buttons,
        uint32_t analog,
        uint32_t native_keys
    );
    int32_t (*after_guest)(JSContext *context);
    void (*resize)(int32_t viewport_width, int32_t viewport_height);
    int32_t (*render)(
        int32_t target_x,
        int32_t target_y,
        int32_t target_width,
        int32_t target_height,
        int32_t window_width,
        int32_t window_height
    );
} PocketNativeExtensionV1;

/* Optional tail: base.struct_size covers this complete table. The V1 prefix
 * remains binary compatible. release_graphics drops only GPU resources;
 * guest and simulation state survive. The next render lazily restores them. */
typedef struct PocketNativeGraphicsExtensionV1 {
    PocketNativeExtensionV1 base;
    void (*release_graphics)(int32_t gl_context_current);
} PocketNativeGraphicsExtensionV1;

/*
 * Every core exports this provider. The stock core returns null; a custom
 * core disables that default Cargo feature and supplies its own table. An
 * explicit null provider avoids ELF weak relocations unsupported by E32.
 */
const PocketNativeExtensionV1 *pocket_native_extension_v1(void);

#ifdef __cplusplus
}
#endif

#endif
