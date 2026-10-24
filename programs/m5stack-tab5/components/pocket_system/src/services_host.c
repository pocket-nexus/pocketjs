/*
 * engine/host-services on ESP-IDF (host_services.h), and the store and app
 * lifecycle of pocket/system.h.
 *
 * A slot holds one committed package, `package.pocket`; its hash is the
 * file's footer. An install streams into `link-upload.pocket`, is admitted
 * (footer, FNV-1a64, a variant for the firmware's profile) and replaces
 * `package.pocket`. FAT refuses a rename onto an existing name, so the old
 * package is removed first: an interrupted install loses the app, never
 * leaves a package the firmware would refuse.
 *
 * Storage on the flash partition and the radio's NVS are flash, and a flash
 * access disables the cache, which a task with its stack in PSRAM cannot
 * survive. The guest's runner and the firmware's app task have PSRAM
 * stacks, so every system operation runs on one task with an internal stack
 * while its caller waits (system_run).
 */

#include "pocket/system.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "fs.h"
#include "host_services.h"
#include "jscan.h"
#include "launcher.h"
#include "link.h"
#include "sha256.h"
#include "system_internal.h"

#define PACKAGE_NAME "package.pocket"
#define STAGING_NAME "link-upload.pocket"
#define SLOT_PATH_BYTES 128
#define SYSTEM_TASK_STACK (12 * 1024)

static const char *TAG = "pocket_system";

struct pocketjs_system_app {
  /* A copy in PSRAM for installed apps; NULL for the embedded launcher. */
  uint8_t *owned;
  const uint8_t *bytes;
  size_t size;
  pocket_idf_package_facts facts;
  char slot[17];
  bool launcher;
};

static bool started;
static pocketjs_system_config_t config;
static char root_dir[64];
static char apps_dir[80];
static char link_dir[80];
static char launcher_slot[17];

// ---------------------------------------------------------------------------
// the system task
// ---------------------------------------------------------------------------

static TaskHandle_t system_task;
static SemaphoreHandle_t system_busy;
static SemaphoreHandle_t system_job_ready;
static SemaphoreHandle_t system_job_done;
static void (*system_job)(void *);
static void *system_job_context;

static void system_main(void *unused) {
  (void)unused;
  for (;;) {
    xSemaphoreTake(system_job_ready, portMAX_DELAY);
    system_job(system_job_context);
    xSemaphoreGive(system_job_done);
  }
}

static bool system_task_start(void) {
  if (system_task != NULL) return true;
  system_busy = xSemaphoreCreateMutex();
  system_job_ready = xSemaphoreCreateBinary();
  system_job_done = xSemaphoreCreateBinary();
  /* xTaskCreate takes the stack from internal RAM. */
  return system_busy != NULL && system_job_ready != NULL && system_job_done != NULL &&
         xTaskCreate(system_main, "pocket_sys", SYSTEM_TASK_STACK, NULL, 6, &system_task) == pdPASS;
}

void system_run(void (*job)(void *), void *context) {
  if (system_task == NULL || xTaskGetCurrentTaskHandle() == system_task) {
    job(context);
    return;
  }
  xSemaphoreTake(system_busy, portMAX_DELAY);
  system_job = job;
  system_job_context = context;
  xSemaphoreGive(system_job_ready);
  xSemaphoreTake(system_job_done, portMAX_DELAY);
  xSemaphoreGive(system_busy);
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

static uint64_t footer_of(const uint8_t *bytes, size_t size) {
  uint64_t hash = 0;
  if (size < 8) return 0;
  for (int i = 7; i >= 0; i -= 1) hash = (hash << 8) | bytes[size - 8 + (size_t)i];
  return hash;
}

/* Admit `bytes` for the firmware's profile and read the variant's facts. */
static bool open_package(const uint8_t *bytes, size_t size, pocket_idf_package_facts *facts, char *error,
                         size_t capacity) {
  memset(facts, 0, sizeof *facts);
  facts->struct_size = sizeof *facts;
  const int32_t code = pocket_idf_package_open(bytes, size, (const uint8_t *)config.target, strlen(config.target),
                                               config.host_abi, config.profile_hash, facts);
  if (code == 0) return true;
  if (code == 6) snprintf(error, capacity, "the package has no variant for %s", config.target);
  else if (code == 7) snprintf(error, capacity, "the package was built for another binding generation");
  else if (code == 16) snprintf(error, capacity, "the package was built for another profile");
  else snprintf(error, capacity, "the package is damaged (%ld)", (long)code);
  return false;
}

static LauncherPackage facts_of(const pocket_idf_package_facts *facts, const uint8_t *bytes, size_t size) {
  return (LauncherPackage){
    .plan = (const char *)facts->plan,
    .plan_length = facts->plan_length,
    .hash = footer_of(bytes, size),
    .bytes = size,
  };
}

/* The whole file in PSRAM, 16-byte aligned like an embedded package. */
static uint8_t *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return NULL;
  uint8_t *bytes = NULL;
  long length = -1;
  if (fseek(file, 0, SEEK_END) == 0) length = ftell(file);
  if (length > 0 && fseek(file, 0, SEEK_SET) == 0) {
    bytes = heap_caps_aligned_alloc(16, (size_t)length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (bytes != NULL && fread(bytes, 1, (size_t)length, file) != (size_t)length) {
      heap_caps_free(bytes);
      bytes = NULL;
    }
  }
  fclose(file);
  if (bytes != NULL) *size = (size_t)length;
  return bytes;
}

/* The bytes a LauncherPackage borrows, released by services_host_release. */
typedef struct {
  uint8_t *bytes;
} HeldPackage;

static bool load_path(const char *path, uint64_t expected, LauncherPackage *out, void **held, char *error,
                      size_t capacity) {
  size_t size = 0;
  uint8_t *bytes = read_file(path, &size);
  if (bytes == NULL) {
    snprintf(error, capacity, "the package cannot be read");
    return false;
  }
  if (expected != 0 && footer_of(bytes, size) != expected) {
    heap_caps_free(bytes);
    snprintf(error, capacity, "the package does not match its declared hash");
    return false;
  }
  pocket_idf_package_facts facts;
  HeldPackage *keep = malloc(sizeof *keep);
  if (keep == NULL || !open_package(bytes, size, &facts, error, capacity)) {
    if (keep == NULL) snprintf(error, capacity, "out of memory");
    free(keep);
    heap_caps_free(bytes);
    return false;
  }
  keep->bytes = bytes;
  *out = facts_of(&facts, bytes, size);
  *held = keep;
  return true;
}

// ---------------------------------------------------------------------------
// host_services.h: clocks and randomness
// ---------------------------------------------------------------------------

uint64_t services_host_ms(void) {
  return (uint64_t)esp_timer_get_time() / 1000u;
}

uint64_t services_host_us(void) {
  return (uint64_t)esp_timer_get_time();
}

uint64_t services_host_epoch_ms(void) {
  struct timeval now;
  gettimeofday(&now, NULL);
  return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_usec / 1000u;
}

void services_host_random(uint8_t *out, size_t length) {
  esp_fill_random(out, length);
}

// ---------------------------------------------------------------------------
// host_services.h: packages
// ---------------------------------------------------------------------------

const char *launcher_host_apps_directory(void) {
  return apps_dir;
}

bool launcher_host_slot_path(const char *slot, const char *name, char *out, size_t capacity) {
  if (slot == NULL || strlen(slot) != 16) return false;
  int written = name == NULL ? snprintf(out, capacity, "%s/%s", apps_dir, slot)
                             : snprintf(out, capacity, "%s/%s/%s", apps_dir, slot, name);
  return written > 0 && (size_t)written < capacity;
}

bool launcher_host_active_hash(const char *slot, uint64_t *hash) {
  char path[SLOT_PATH_BYTES];
  if (!launcher_host_slot_path(slot, PACKAGE_NAME, path, sizeof path)) return false;
  FILE *file = fopen(path, "rb");
  if (file == NULL) return false;
  uint8_t footer[8];
  bool ok = fseek(file, -8, SEEK_END) == 0 && fread(footer, 1, sizeof footer, file) == sizeof footer;
  fclose(file);
  if (ok) *hash = footer_of(footer, sizeof footer);
  return ok;
}

bool launcher_host_load(const char *slot, uint64_t hash, LauncherPackage *out, void **held) {
  char path[SLOT_PATH_BYTES];
  char error[160];
  if (!launcher_host_slot_path(slot, PACKAGE_NAME, path, sizeof path)) return false;
  if (load_path(path, hash, out, held, error, sizeof error)) return true;
  ESP_LOGW(TAG, "slot %s: %s", slot, error);
  return false;
}

void services_host_release(void *held) {
  HeldPackage *keep = held;
  if (keep == NULL) return;
  heap_caps_free(keep->bytes);
  free(keep);
}

// ---------------------------------------------------------------------------
// host_services.h: the Pocket Link
// ---------------------------------------------------------------------------

const char *link_host_target(void) {
  return config.target;
}

void link_host_identity(char *name, size_t name_capacity, char *model, size_t model_capacity) {
  snprintf(name, name_capacity, "%s", config.device_name != NULL ? config.device_name : "ESP-IDF");
  snprintf(model, model_capacity, "%s", config.device_model != NULL ? config.device_model : "ESP-IDF");
}

const char *link_host_directory(void) {
  return link_dir;
}

bool link_host_net_ready(void) {
  return wifi_online();
}

void link_host_address(char *out, size_t capacity) {
  wifi_address(out, capacity);
}

bool link_host_staging_path(const char *slot, char *out, size_t capacity) {
  char directory[SLOT_PATH_BYTES];
  if (!launcher_host_slot_path(slot, NULL, directory, sizeof directory)) return false;
  mkdir(apps_dir, 0777);
  mkdir(directory, 0777);
  return launcher_host_slot_path(slot, STAGING_NAME, out, capacity);
}

bool link_host_install(const char *slot, const char *path, uint64_t hash, LauncherPackage *out, void **held,
                       char *error, size_t error_capacity) {
  if (!load_path(path, hash, out, held, error, error_capacity)) {
    remove(path);
    return false;
  }
  char committed[SLOT_PATH_BYTES];
  if (!launcher_host_slot_path(slot, PACKAGE_NAME, committed, sizeof committed)) {
    services_host_release(*held);
    snprintf(error, error_capacity, "install: bad slot");
    return false;
  }
  remove(committed);
  if (rename(path, committed) != 0) {
    services_host_release(*held);
    snprintf(error, error_capacity, "install: the package could not be committed");
    return false;
  }
  return true;
}

bool link_host_remove(const char *slot) {
  char directory[SLOT_PATH_BYTES];
  struct stat info;
  if (!launcher_host_slot_path(slot, NULL, directory, sizeof directory) || stat(directory, &info) != 0) {
    return false;
  }
  return fs_remove_tree(directory, FS_MAX_DEPTH + 2);
}

void link_host_linked(bool up) {
  (void)up;
}

bool link_host_ctrl(const char *json, size_t length) {
  (void)json;
  (void)length;
  return false;
}

bool link_host_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  (void)stream;
  (void)bytes;
  (void)length;
  return false;
}

// ---------------------------------------------------------------------------
// pocket/system.h
// ---------------------------------------------------------------------------

typedef struct {
  const char *label;
  const char *root;
  esp_err_t result;
} FlashMount;

static void mount_flash(void *argument) {
  FlashMount *mount = argument;
  const esp_vfs_fat_mount_config_t options = {
      .format_if_mount_failed = true,
      .max_files = 8,
      .allocation_unit_size = CONFIG_WL_SECTOR_SIZE,
  };
  wl_handle_t handle = WL_INVALID_HANDLE;
  mount->result = esp_vfs_fat_spiflash_mount_rw_wl(mount->root, mount->label, &options, &handle);
}

esp_err_t pocketjs_system_mount_flash(const char *label, const char *root) {
  if (!system_task_start()) return ESP_ERR_NO_MEM;
  FlashMount mount = { .label = label, .root = root, .result = ESP_FAIL };
  system_run(mount_flash, &mount);
  return mount.result;
}

/* The store's directories, the launcher's slot and the link's identity. */
static void start_store(void *argument) {
  esp_err_t *result = argument;
  mkdir(apps_dir, 0777);
  pocket_idf_package_facts facts;
  char error[160];
  const uint8_t *bytes = config.launcher;
  if (!open_package(bytes, config.launcher_size, &facts, error, sizeof error)) {
    ESP_LOGE(TAG, "launcher: %s", error);
    *result = ESP_ERR_INVALID_ARG;
    return;
  }
  LauncherPackage package = facts_of(&facts, bytes, config.launcher_size);
  memcpy(launcher_slot, facts.slot, sizeof launcher_slot);
  launcher_init(launcher_slot, &package);
  link_init();
}

esp_err_t pocketjs_system_start(const pocketjs_system_config_t *settings) {
  if (started) return ESP_ERR_INVALID_STATE;
  if (settings == NULL || settings->struct_size < sizeof *settings || settings->target == NULL ||
      settings->profile_hash == NULL || settings->launcher == NULL || settings->root == NULL ||
      strlen(settings->root) >= sizeof root_dir - 8) {
    return ESP_ERR_INVALID_ARG;
  }
  config = *settings;
  snprintf(root_dir, sizeof root_dir, "%s", settings->root);
  snprintf(apps_dir, sizeof apps_dir, "%s/apps", root_dir);
  snprintf(link_dir, sizeof link_dir, "%s/link", root_dir);
  if (!system_task_start()) return ESP_ERR_NO_MEM;
  esp_err_t result = ESP_OK;
  system_run(start_store, &result);
  if (result != ESP_OK) return result;
  if (settings->wifi) wifi_start(settings->wifi_prepare);
  started = true;
  return ESP_OK;
}

static esp_err_t finish_app(pocketjs_system_app_t *app, const uint8_t *bytes, size_t size,
                            pocketjs_system_app_t **out) {
  char error[160];
  app->bytes = bytes;
  app->size = size;
  if (!open_package(bytes, size, &app->facts, error, sizeof error)) {
    ESP_LOGE(TAG, "slot %s: %s", app->slot, error);
    pocketjs_system_app_free(app);
    return ESP_ERR_INVALID_RESPONSE;
  }
  *out = app;
  return ESP_OK;
}

esp_err_t pocketjs_system_load_launcher(pocketjs_system_app_t **out_app) {
  if (!started || out_app == NULL) return ESP_ERR_INVALID_STATE;
  pocketjs_system_app_t *app = calloc(1, sizeof *app);
  if (app == NULL) return ESP_ERR_NO_MEM;
  memcpy(app->slot, launcher_slot, sizeof app->slot);
  app->launcher = true;
  return finish_app(app, config.launcher, config.launcher_size, out_app);
}

typedef struct {
  const char *slot;
  uint8_t *bytes;
  size_t size;
} SlotRead;

static void read_slot(void *argument) {
  SlotRead *read = argument;
  char path[SLOT_PATH_BYTES];
  if (launcher_host_slot_path(read->slot, PACKAGE_NAME, path, sizeof path)) read->bytes = read_file(path, &read->size);
}

esp_err_t pocketjs_system_load_slot(const char *slot, pocketjs_system_app_t **out_app) {
  if (!started || out_app == NULL || slot == NULL || strlen(slot) != 16) return ESP_ERR_INVALID_ARG;
  if (strcmp(slot, launcher_slot) == 0) return pocketjs_system_load_launcher(out_app);
  SlotRead read = { .slot = slot };
  system_run(read_slot, &read);
  uint8_t *bytes = read.bytes;
  size_t size = read.size;
  if (bytes == NULL) return ESP_ERR_NOT_FOUND;
  pocketjs_system_app_t *app = calloc(1, sizeof *app);
  if (app == NULL) {
    heap_caps_free(bytes);
    return ESP_ERR_NO_MEM;
  }
  app->owned = bytes;
  snprintf(app->slot, sizeof app->slot, "%s", slot);
  return finish_app(app, bytes, size, out_app);
}

bool pocketjs_system_take_switch(char slot[17], bool *launcher) {
  LauncherTarget target;
  if (!launcher_take_request(&target)) return false;
  memcpy(slot, target.slot, 17);
  *launcher = target.home;
  return true;
}

void pocketjs_system_app_free(pocketjs_system_app_t *app) {
  if (app == NULL) return;
  heap_caps_free(app->owned);
  free(app);
}

const uint8_t *pocketjs_system_app_bytes(const pocketjs_system_app_t *app, size_t *size) {
  if (app == NULL) {
    if (size != NULL) *size = 0;
    return NULL;
  }
  if (size != NULL) *size = app->size;
  return app->bytes;
}

const pocket_idf_package_facts *pocketjs_system_app_facts(const pocketjs_system_app_t *app) {
  return app == NULL ? NULL : &app->facts;
}

bool pocketjs_system_app_is_launcher(const pocketjs_system_app_t *app) {
  return app != NULL && app->launcher;
}

static void bind_app(void *argument) {
  const pocketjs_system_app_t *app = argument;
  LauncherPackage package = facts_of(&app->facts, app->bytes, app->size);
  /* The link names the running app in every net request; the guest's top
   * level may already fetch. */
  launcher_set_current(app->slot, &package);
  if ((app->facts.features & POCKET_IDF_FEATURE_FS) != 0U) {
    char data[SLOT_PATH_BYTES];
    char temp[SLOT_PATH_BYTES];
    char directory[SLOT_PATH_BYTES];
    if (launcher_host_slot_path(app->slot, NULL, directory, sizeof directory) &&
        launcher_host_slot_path(app->slot, "data", data, sizeof data) &&
        launcher_host_slot_path(app->slot, "fs-tmp", temp, sizeof temp)) {
      mkdir(apps_dir, 0777);
      mkdir(directory, 0777);
      const char *plan = (const char *)app->facts.plan;
      if (!fs_bind(data, temp, fs_plan_quota(plan, app->facts.plan_length))) {
        ESP_LOGW(TAG, "slot %s: data.fs unavailable: %s", app->slot, fs_last_error());
      }
    }
  }
}

esp_err_t pocketjs_system_bind(JSContext *realm, const pocketjs_system_app_t *app) {
  if (!started || realm == NULL || app == NULL) return ESP_ERR_INVALID_ARG;
  system_run(bind_app, (void *)app);
  return system_qjs_install(realm);
}

static void unbind(void *unused) {
  (void)unused;
  link_reset_guest();
  fs_unbind();
}

void pocketjs_system_unbind(void) {
  system_run(unbind, NULL);
}

typedef struct {
  const char *output;
  const char *table;
  bool launched;
} LauncherCall;

static void app_table(void *argument) {
  LauncherCall *call = argument;
  call->table = launcher_table_json();
}

static void launch(void *argument) {
  LauncherCall *call = argument;
  call->launched = launcher_launch(call->output);
}

const char *pocketjs_system_app_table(void) {
  LauncherCall call = {0};
  system_run(app_table, &call);
  return call.table;
}

bool pocketjs_system_launch(const char *output) {
  if (output == NULL) return false;
  LauncherCall call = { .output = output };
  system_run(launch, &call);
  return call.launched;
}

static void pump(void *unused) {
  (void)unused;
  link_pump();
}

void pocketjs_system_pump(void) {
  system_run(pump, NULL);
}

bool pocketjs_system_switch_pending(void) {
  return launcher_pending();
}

void pocketjs_system_summon(void) {
  launcher_summon();
}

bool pocketjs_system_launcher_running(void) {
  return launcher_home_running();
}

void pocketjs_system_report_failure(const char *message) {
  launcher_report_failure(launcher_current_output(), message);
}
