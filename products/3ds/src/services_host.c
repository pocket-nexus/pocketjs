/*
 * engine/host-services on the 3DS: libctru clocks and randomness, the
 * console's CFG identity, soc:U, the SD card runtime slots (runtime.c) and
 * the agent channel (agent.c).
 */

#include "services_host.h"

#include <3ds.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "agent.h"
#include "sha256.h"
#include "soc.h"

#define LINK_DIR "sdmc:/pocketjs/link"

static PocketRuntimeState *runtime_state;

void services_host_bind_runtime(PocketRuntimeState *state) {
  runtime_state = state;
}

LauncherPackage launcher_package(const PocketRuntimePackage *package) {
  return (LauncherPackage){
    .plan = (const char *)package->guest.plan,
    .plan_length = package->guest.plan_length,
    .hash = package->guest.package_hash,
    .bytes = package->length,
  };
}

// ---------------------------------------------------------------------------
// clocks and randomness
// ---------------------------------------------------------------------------

uint64_t services_host_ms(void) {
  return osGetTime();
}

uint64_t services_host_us(void) {
  return (uint64_t)((double)svcGetSystemTick() * (1000000.0 / SYSCLOCK_ARM11));
}

/* osGetTime() counts milliseconds from 1900-01-01; the epoch is 1970. */
uint64_t services_host_epoch_ms(void) {
  return osGetTime() - 2208988800000ULL;
}

void services_host_random(uint8_t *out, size_t length) {
  static bool tried;
  static bool ps_ready;
  if (!tried) {
    ps_ready = R_SUCCEEDED(psInit());
    tried = true;
  }
  if (ps_ready && R_SUCCEEDED(PS_GenerateRandomBytes(out, length))) return;
  /* Without ps:ps, hash the free-running tick counter: the nonces only have
   * to be fresh, and the key itself is minted by the companion. */
  static uint64_t counter;
  while (length > 0) {
    uint64_t seed[4] = { svcGetSystemTick(), osGetTime(), ++counter, (uint64_t)(uintptr_t)out };
    uint8_t digest[SHA256_BYTES];
    sha256(seed, sizeof seed, digest);
    size_t take = length < sizeof digest ? length : sizeof digest;
    memcpy(out, digest, take);
    out += take;
    length -= take;
  }
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

const char *launcher_host_apps_directory(void) {
  return POCKET_RUNTIME_APPS;
}

bool launcher_host_slot_path(const char *slot, const char *name, char *out, size_t capacity) {
  return runtime_slot_path(slot, name, out, capacity);
}

bool launcher_host_active_hash(const char *slot, uint64_t *hash) {
  PocketRuntimeState state;
  if (!runtime_slot_state(slot, &state)) return false;
  *hash = state.active_hash;
  return true;
}

bool launcher_host_load(const char *slot, uint64_t hash, LauncherPackage *out, void **held) {
  char error[192] = {0};
  PocketRuntimePackage *package = runtime_slot_package_load(slot, hash, error, sizeof error);
  if (package == NULL) return false;
  *out = launcher_package(package);
  *held = package;
  return true;
}

void services_host_release(void *held) {
  runtime_package_free(held);
}

// ---------------------------------------------------------------------------
// the Pocket Link
// ---------------------------------------------------------------------------

const char *link_host_target(void) {
  return POCKETJS_TARGET_ID;
}

/* UTF-16LE (the CFG block) to UTF-8, stopping at NUL. */
static void utf16_to_text(const uint16_t *text, size_t units, char *out, size_t capacity) {
  size_t used = 0;
  for (size_t i = 0; i < units && text[i] != 0; i += 1) {
    uint32_t code = text[i];
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < units && text[i + 1] >= 0xdc00 && text[i + 1] < 0xe000) {
      code = 0x10000 + ((code - 0xd800) << 10) + (text[i + 1] - 0xdc00);
      i += 1;
    }
    char encoded[4];
    size_t bytes;
    if (code < 0x80) {
      encoded[0] = (char)code;
      bytes = 1;
    } else if (code < 0x800) {
      encoded[0] = (char)(0xc0 | (code >> 6));
      encoded[1] = (char)(0x80 | (code & 0x3f));
      bytes = 2;
    } else if (code < 0x10000) {
      encoded[0] = (char)(0xe0 | (code >> 12));
      encoded[1] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[2] = (char)(0x80 | (code & 0x3f));
      bytes = 3;
    } else {
      encoded[0] = (char)(0xf0 | (code >> 18));
      encoded[1] = (char)(0x80 | ((code >> 12) & 0x3f));
      encoded[2] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[3] = (char)(0x80 | (code & 0x3f));
      bytes = 4;
    }
    if (used + bytes >= capacity) break;
    memcpy(out + used, encoded, bytes);
    used += bytes;
  }
  out[used] = '\0';
}

void link_host_identity(char *name, size_t name_capacity, char *model, size_t model_capacity) {
  snprintf(name, name_capacity, "Nintendo 3DS");
  snprintf(model, model_capacity, "Nintendo 3DS");
  if (R_FAILED(cfguInit())) return;
  /* Block 0x000A0000: the owner's user name, 10 UTF-16 units + NUL. */
  uint16_t user[0x1c / 2] = {0};
  if (R_SUCCEEDED(CFGU_GetConfigInfoBlk2(0x1c, 0x000a0000, user))) {
    char text[64];
    utf16_to_text(user, 10, text, sizeof text);
    if (text[0] != '\0') snprintf(name, name_capacity, "%s", text);
  }
  static const char *const MODELS[] = {
    "Nintendo 3DS", "Nintendo 3DS XL", "New Nintendo 3DS",
    "Nintendo 2DS", "New Nintendo 3DS XL", "New Nintendo 2DS XL",
  };
  u8 index = 0;
  if (R_SUCCEEDED(CFGU_GetSystemModel(&index)) && index < sizeof MODELS / sizeof MODELS[0]) {
    snprintf(model, model_capacity, "%s", MODELS[index]);
  }
  cfguExit();
}

const char *link_host_directory(void) {
  mkdir("sdmc:/pocketjs", 0777);
  return LINK_DIR;
}

bool link_host_net_ready(void) {
  return soc_active() || soc_ensure(NULL, 0);
}

void link_host_address(char *out, size_t capacity) {
  out[0] = '\0';
  if (!soc_active()) return;
  struct in_addr address;
  address.s_addr = (in_addr_t)gethostid();
  if (address.s_addr != 0) snprintf(out, capacity, "%s", inet_ntoa(address));
}

bool link_host_staging_path(const char *slot, char *out, size_t capacity) {
  char path[96];
  mkdir("sdmc:/pocketjs", 0777);
  mkdir(POCKET_RUNTIME_ROOT, 0777);
  mkdir(POCKET_RUNTIME_APPS, 0777);
  if (runtime_slot_path(slot, NULL, path, sizeof path)) mkdir(path, 0777);
  return runtime_slot_path(slot, "link-upload.pocket", out, capacity);
}

bool link_host_install(
  const char *slot,
  const char *path,
  uint64_t hash,
  LauncherPackage *out,
  void **held,
  char *error,
  size_t error_capacity
) {
  PocketRuntimePackage *package = runtime_slot_install(slot, path, hash, runtime_state, error, error_capacity);
  if (package == NULL) {
    runtime_slot_write_error(slot, "link-install", error);
    return false;
  }
  *out = launcher_package(package);
  *held = package;
  return true;
}

bool link_host_remove(const char *slot) {
  char root[96];
  struct stat info;
  if (!runtime_slot_path(slot, NULL, root, sizeof root) || stat(root, &info) != 0) return false;
  char error[160];
  return runtime_slot_remove(slot, error, sizeof error);
}

void link_host_linked(bool up) {
  agent_link_changed(up);
}

bool link_host_ctrl(const char *json, size_t length) {
  return agent_link_ctrl(json, length);
}

bool link_host_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  return agent_link_data(stream, bytes, length);
}
