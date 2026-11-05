#pragma once
#include <stddef.h>
#include <stdint.h>
#include "pocket_runtime.h"
#include "pocket_spec.h"
#ifdef __cplusplus
extern "C" {
#endif
/* A program's own textures in the running guest's core, through the texture
 * operations (contracts/spec/ui-ops.ts): a camera plane, a video frame, a
 * decoded photo. Call between ticks on the task that runs the runtime; the
 * handles belong to the guest and go with it. */
static inline pocket_op_arg pocket_texture_arg_bytes(const void *bytes, size_t length) {
  return (pocket_op_arg){.struct_size = sizeof(pocket_op_arg),
                         .tag = POCKET_ARG_BYTES,
                         .bytes = bytes,
                         .byte_length = length};
}
static inline pocket_op_arg pocket_texture_arg_integer(int64_t value) {
  return (pocket_op_arg){.struct_size = sizeof(pocket_op_arg),
                         .tag = POCKET_ARG_INTEGER,
                         .integer = value};
}
/* Upload width x height texels in the DrawList format `psm`; -1 on failure. */
static inline int32_t pocket_texture_upload(pocket_runtime *runtime,
                                            const void *pixels, size_t length,
                                            uint32_t width, uint32_t height,
                                            uint32_t psm) {
  pocket_op_arg args[] = {pocket_texture_arg_bytes(pixels, length),
                          pocket_texture_arg_integer(width),
                          pocket_texture_arg_integer(height),
                          pocket_texture_arg_integer(psm)};
  pocket_result result = {.struct_size = sizeof result};
  return runtime && pocket_runtime_op(runtime, POCKET_OP_uploadTexture, args,
                                      sizeof args, &result) == POCKET_STATUS_OK
             ? (int32_t)result.integer
             : -1;
}
/* Upload a self-contained IMG entry (framework/compiler/pak.ts); -1 on
 * failure. */
static inline int32_t pocket_texture_upload_entry(pocket_runtime *runtime,
                                                  const void *entry,
                                                  size_t length) {
  pocket_op_arg arg = pocket_texture_arg_bytes(entry, length);
  pocket_result result = {.struct_size = sizeof result};
  return runtime && pocket_runtime_op(runtime, POCKET_OP_uploadImgEntry, &arg,
                                      sizeof arg, &result) == POCKET_STATUS_OK
             ? (int32_t)result.integer
             : -1;
}
static inline void pocket_texture_free(pocket_runtime *runtime, int32_t handle) {
  pocket_op_arg arg = pocket_texture_arg_integer(handle);
  pocket_result result = {.struct_size = sizeof result};
  if (runtime)
    pocket_runtime_op(runtime, POCKET_OP_freeTexture, &arg, sizeof arg, &result);
}
#ifdef __cplusplus
}
#endif
