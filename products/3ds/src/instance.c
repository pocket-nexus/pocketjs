#include "pocket_spec.h"
#if POCKETJS_HOST_ABI != POCKET_BINDING_GENERATION
#error "POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION"
#endif
/* 3DS drivers on a native program's runtime: the package source, input
 * source, product op provider, PICA renderer and both displays. The program
 * and its facade (programs/native/quickjs) own the runtime; qjs.c attaches
 * these before boot. */
#include "instance.h"
#include "input_source.h"
#include "devserver.h"
#include "gfx.h"
#include "launcher.h"
#include "link.h"
#include "pocket_profile.h"
#include "svcwire.h"
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static pocket_runtime *active;
static pocket_3ds_input_source input;
static char provider_text[8193];

static int32_t package_length(void *context, size_t *out) {
  const PocketRuntimePackage *source = context;
  *out = source->length;
  return 0;
}
static int32_t package_all(void *context, const uint8_t **out, size_t *length) {
  const PocketRuntimePackage *source = context;
  *out = source->bytes;
  *length = source->length;
  return 0;
}
static int32_t package_range(void *context, size_t offset, uint8_t *bytes,
                             size_t capacity, size_t *read) {
  const PocketRuntimePackage *source = context;
  if (offset > source->length)
    return POCKET_STATUS_INVALID;
  size_t n = source->length - offset;
  if (n > capacity)
    n = capacity;
  if (n)
    memcpy(bytes, source->bytes + offset, n);
  *read = n;
  return 0;
}
void instance_input(uint32_t held, uint32_t analog, const uint32_t *touches,
                    size_t count, uint32_t right) {
  pocket_3ds_input_source_set(&input, held, analog, touches, count, right);
}
static int32_t provider(void *context, uint16_t op, const pocket_op_arg *args,
                        size_t length, pocket_result *out) {
  (void)context;
  out->tag = POCKET_RESULT_NONE;
  out->integer = 0;
  out->real = 0;
  out->bytes = NULL;
  out->byte_length = 0;
  const char *text = NULL;
  size_t n = 0;
  if (op == POCKET_3DS_OP_svcOpen || op == POCKET_3DS_OP_svcSend ||
      op == POCKET_3DS_OP_appLaunch) {
    if (!args || length < sizeof *args || args->struct_size < sizeof *args ||
        args->tag != POCKET_ARG_BYTES || args->byte_length > 8192)
      return POCKET_STATUS_INVALID;
    n = args->byte_length;
    if (n)
      memcpy(provider_text, args->bytes, n);
    provider_text[n] = 0;
    text = provider_text;
  }
  switch (op) {
  case POCKET_3DS_OP_svcOpen:
    out->tag = POCKET_RESULT_I64;
    out->integer = svcwire_open(text);
    break;
  case POCKET_3DS_OP_svcSend:
    svcwire_send_line(text, n);
    break;
  case POCKET_3DS_OP_svcPoll:
    n = svcwire_recv_lines(provider_text, sizeof provider_text);
    if (n) {
      out->tag = POCKET_RESULT_BYTES;
      out->bytes = (uint8_t *)provider_text;
      out->byte_length = n;
    }
    break;
  case POCKET_3DS_OP_debugStats:
    text = devserver_debug_stats();
    out->tag = POCKET_RESULT_BYTES;
    out->bytes = (const uint8_t *)text;
    out->byte_length = strlen(text);
    break;
#ifdef POCKETJS_LINK
  case POCKET_3DS_OP_appTable:
    text = launcher_table_json();
    out->tag = POCKET_RESULT_BYTES;
    out->bytes = (const uint8_t *)text;
    out->byte_length = strlen(text);
    break;
  case POCKET_3DS_OP_appLaunch:
    out->tag = POCKET_RESULT_I64;
    out->integer = launcher_launch(text);
    break;
  case POCKET_3DS_OP_appShot:
    out->tag = POCKET_RESULT_I64;
    out->integer = -1;
    break;
#endif
  default:
    return POCKET_STATUS_UNSUPPORTED;
  }
  return 0;
}
static const pocket_package_source_v1 source_api = {
    sizeof source_api, package_length, package_all, package_range, NULL};
static const pocket_op_provider_v1 provider_api = {sizeof provider_api,
                                                   provider};
const pocket_package_source_v1 *instance_package_source(void) {
  return &source_api;
}
bool instance_attach(pocket_runtime *runtime) {
  if (active || !runtime)
    return false;
  active = runtime;
  instance_input(0, 0x8080, NULL, 0, 0x8080);
  const uint16_t operations[] = {
      POCKET_3DS_OP_svcOpen,    POCKET_3DS_OP_svcPoll,   POCKET_3DS_OP_svcSend,
      POCKET_3DS_OP_debugStats,
#ifdef POCKETJS_LINK
      POCKET_3DS_OP_appTable,   POCKET_3DS_OP_appLaunch, POCKET_3DS_OP_appShot,
#endif
  };
  if (pocket_runtime_add_input_source(active, pocket_3ds_input_source_vtable(), &input) ||
      pocket_runtime_add_op_provider(active, &provider_api, NULL, operations,
                                     sizeof operations / sizeof *operations) ||
      !gfx_register(active)) {
    instance_detach();
    return false;
  }
  return true;
}
void instance_detach(void) { active = NULL; }
static pocket_op_arg integer(int64_t value) {
  return (pocket_op_arg){.struct_size = sizeof(pocket_op_arg),
                         .tag = POCKET_ARG_INTEGER,
                         .integer = value};
}
static pocket_op_arg bytes(const uint8_t *data, size_t length) {
  return (pocket_op_arg){.struct_size = sizeof(pocket_op_arg),
                         .tag = POCKET_ARG_BYTES,
                         .bytes = data,
                         .byte_length = length};
}
int32_t ui_upload_texture(const uint8_t *data, size_t length, uint32_t w,
                          uint32_t h, uint32_t psm) {
  pocket_op_arg args[] = {bytes(data, length), integer(w), integer(h),
                          integer(psm)};
  pocket_result result = {.struct_size = sizeof result};
  return active && !pocket_runtime_op(active, POCKET_3DS_OP_uploadTexture, args,
                                      sizeof args, &result)
             ? (int32_t)result.integer
             : -1;
}
void ui_free_texture(int32_t handle) {
  pocket_op_arg arg = integer(handle);
  pocket_result result = {.struct_size = sizeof result};
  if (active)
    pocket_runtime_op(active, POCKET_3DS_OP_freeTexture, &arg, sizeof arg,
                      &result);
}
int32_t ui_load_font_atlas(const uint8_t *data, size_t length) {
  pocket_op_arg arg = bytes(data, length);
  pocket_result result = {.struct_size = sizeof result};
  return active && !pocket_runtime_op(active, POCKET_3DS_OP_loadFontAtlas, &arg,
                                      sizeof arg, &result)
             ? (int32_t)result.integer
             : 0;
}
