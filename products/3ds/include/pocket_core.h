#ifndef POCKETJS_3DS_CORE_H
#define POCKETJS_3DS_CORE_H
#include <stddef.h>
#include <stdint.h>
#include <pocket_runtime.h>

/* Verified target variant borrowed from a caller-owned `.pocket` buffer. */
typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *worker_javascript;
  size_t worker_javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
  /* Read from the variant's plan when the package is opened: one runtime
   * serves every game, so none of these is compiled in. aux_width and
   * aux_height are 0 when the plan has no auxiliary surface. */
  uint32_t view_width;
  uint32_t view_height;
  uint32_t raster_density;
  uint32_t aux_width;
  uint32_t aux_height;
  uint32_t aux_raster_density;
  uint32_t features; /* POCKET_GUEST_FEATURE_* */
  /* First 16 hex digits of SHA-256(app id), NUL-terminated: the
   * application's state directory below sdmc:/pocketjs/runtime/apps. */
  char slot[17];
} PocketGuestPackage;

#define POCKET_GUEST_FEATURE_OFFLOAD 1u /* features["io.offload"] */
#define POCKET_GUEST_FEATURE_MEDIA 2u   /* features["media.playback"] */
#define POCKET_GUEST_FEATURE_AGENT 4u   /* features["system.agent"] */
#define POCKET_GUEST_FEATURE_FS 8u      /* features["data.fs"] */
#define POCKET_GUEST_FEATURE_CAMERA_QR 16u    /* features["camera.qr"] */
#define POCKET_GUEST_FEATURE_CAMERA_PHOTO 32u /* features["camera.photo"] */

/* 0 = admitted. The package footer, the first variant the exported profile
 * facts admit, its identity, plan and NUL-terminated JS section are all
 * checked before success; 7 = another binding generation; 9 = an unreadable
 * plan; 13, 14 and 15 name a plan whose JSON, viewport or auxiliary surface
 * cannot be read; 17 = malformed layout; 18 = worker declaration and section
 * disagree; 19-25 = the first failed admission item (raster density,
 * animation, rate, viewport, presentation, capability, auxiliary). The facts
 * and profile hash are compiled into the program, never read from the
 * package; the hash only orders variants. */
int32_t pocket_package_open(
  const uint8_t *bytes,
  size_t length,
  const pocket_profile_facts *facts,
  uint32_t host_abi,
  const uint8_t *profile_hash,
  PocketGuestPackage *out
);

/* Native camera/media/agent convenience calls into the active canonical
 * runtime. These functions own no retained UI, resources or package state. */
int32_t ui_upload_texture(const uint8_t *, size_t, uint32_t, uint32_t, uint32_t);
void ui_free_texture(int32_t handle);
int32_t ui_load_font_atlas(const uint8_t *, size_t);
#endif
