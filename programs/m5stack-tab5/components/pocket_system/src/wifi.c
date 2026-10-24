/*
 * `globalThis.wifi` (contracts/spec/wifi.ts) on esp_wifi. The launcher is
 * the console's settings here, so the module also scans, joins and forgets.
 *
 * Saved connections are three NVS slots (SSID, passphrase, last use). At
 * start the radio joins the most recently used slot, then the others in
 * order of use. A join saves its network once an address is assigned,
 * replacing the least recently used slot.
 *
 * esp_wifi events arrive on the default event loop's task; the guest reads
 * on its own task. One mutex guards the state, and the status JSON is built
 * under it.
 */

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "jscan.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "system_internal.h"

#define WIFI_SLOTS 3
#define WIFI_MAX_NETWORKS 16
#define WIFI_SSID_BYTES 33
#define WIFI_PASSPHRASE_BYTES 65
#define WIFI_NVS "pocketwifi"
/* A connected network that drops is rejoined this many times. */
#define WIFI_RETRIES 3
/* RSSI is read over the coprocessor link; one read serves this long. */
#define WIFI_RSSI_MS 2000
/* The radio worker wakes this often for the calls that go over the link. */
#define WIFI_POLL_MS 200

static const char *TAG = "pocketjs_wifi";

typedef enum { WIFI_OFF, WIFI_IDLE, WIFI_CONNECTING, WIFI_CONNECTED } WifiState;

typedef struct {
  char ssid[WIFI_SSID_BYTES];
  char passphrase[WIFI_PASSPHRASE_BYTES];
  uint32_t used;
} SavedNetwork;

typedef struct {
  char ssid[WIFI_SSID_BYTES];
  int8_t rssi;
  bool secure;
} FoundNetwork;

static SemaphoreHandle_t lock;
static bool ready;
static bool enabled = true;
static WifiState state = WIFI_OFF;
static char current[WIFI_SSID_BYTES];
static int8_t rssi;
static int64_t rssi_read_us;
static char address[16];
static char error[96];
static bool scanning;
/* Work for the radio worker: a scan to start, a finished scan to collect. */
static bool scan_requested;
static bool scan_done;
static wifi_ap_record_t scan_records[24];
static FoundNetwork networks[WIFI_MAX_NETWORKS];
static size_t network_count;
static SavedNetwork saved[WIFI_SLOTS];
static uint32_t use_clock;

/* The connection being made: a join saves on success. */
static struct {
  bool save;
  char ssid[WIFI_SSID_BYTES];
  char passphrase[WIFI_PASSPHRASE_BYTES];
} attempt;
/* Saved slots the start-up join still has to try, most recent first. */
static int auto_order[WIFI_SLOTS];
static int auto_left;
static int retries;
/* A disconnect this module asked for is not a failure. */
static bool expect_disconnect;
static JsonBuffer status_out = { .limit = 8 * 1024 };

static void take(void) {
  xSemaphoreTake(lock, portMAX_DELAY);
}

static void give(void) {
  xSemaphoreGive(lock);
}

static int bars(int8_t value) {
  return value >= -55 ? 3 : value >= -66 ? 2 : value >= -77 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// saved connections (NVS)
// ---------------------------------------------------------------------------

static void load_saved(void) {
  nvs_handle_t handle;
  if (nvs_open(WIFI_NVS, NVS_READONLY, &handle) != ESP_OK) return;
  uint8_t on = 1;
  if (nvs_get_u8(handle, "on", &on) == ESP_OK) enabled = on != 0;
  for (int slot = 0; slot < WIFI_SLOTS; slot += 1) {
    char key[4];
    size_t length = sizeof saved[slot].ssid;
    snprintf(key, sizeof key, "s%d", slot);
    if (nvs_get_str(handle, key, saved[slot].ssid, &length) != ESP_OK) saved[slot].ssid[0] = '\0';
    length = sizeof saved[slot].passphrase;
    snprintf(key, sizeof key, "p%d", slot);
    if (nvs_get_str(handle, key, saved[slot].passphrase, &length) != ESP_OK) saved[slot].passphrase[0] = '\0';
    snprintf(key, sizeof key, "u%d", slot);
    if (nvs_get_u32(handle, key, &saved[slot].used) != ESP_OK) saved[slot].used = 0;
    if (saved[slot].used > use_clock) use_clock = saved[slot].used;
  }
  nvs_close(handle);
}

static void store_slot(int slot) {
  nvs_handle_t handle;
  if (nvs_open(WIFI_NVS, NVS_READWRITE, &handle) != ESP_OK) return;
  char key[4];
  snprintf(key, sizeof key, "s%d", slot);
  nvs_set_str(handle, key, saved[slot].ssid);
  snprintf(key, sizeof key, "p%d", slot);
  nvs_set_str(handle, key, saved[slot].passphrase);
  snprintf(key, sizeof key, "u%d", slot);
  nvs_set_u32(handle, key, saved[slot].used);
  nvs_commit(handle);
  nvs_close(handle);
}

static void store_enabled(void) {
  nvs_handle_t handle;
  if (nvs_open(WIFI_NVS, NVS_READWRITE, &handle) != ESP_OK) return;
  nvs_set_u8(handle, "on", enabled ? 1 : 0);
  nvs_commit(handle);
  nvs_close(handle);
}

/* The slot a network joined just now goes to: its own, an empty one, or
 * the least recently used. */
static int slot_for(const char *ssid) {
  int empty = -1;
  int oldest = 0;
  for (int slot = 0; slot < WIFI_SLOTS; slot += 1) {
    if (strcmp(saved[slot].ssid, ssid) == 0) return slot;
    if (saved[slot].ssid[0] == '\0' && empty < 0) empty = slot;
    if (saved[slot].used < saved[oldest].used) oldest = slot;
  }
  return empty >= 0 ? empty : oldest;
}

// ---------------------------------------------------------------------------
// connecting
// ---------------------------------------------------------------------------

/* Caller holds the lock. */
static void begin(const char *ssid, const char *passphrase, bool save) {
  wifi_config_t config;
  memset(&config, 0, sizeof config);
  snprintf((char *)config.sta.ssid, sizeof config.sta.ssid, "%s", ssid);
  snprintf((char *)config.sta.password, sizeof config.sta.password, "%s", passphrase);
  config.sta.threshold.authmode = passphrase[0] != '\0' ? WIFI_AUTH_WEP : WIFI_AUTH_OPEN;
  config.sta.pmf_cfg.capable = true;
  snprintf(attempt.ssid, sizeof attempt.ssid, "%s", ssid);
  snprintf(attempt.passphrase, sizeof attempt.passphrase, "%s", passphrase);
  attempt.save = save;
  if (state == WIFI_CONNECTED || state == WIFI_CONNECTING) {
    /* A connected radio answers with one disconnect event; one still
     * connecting may answer with ASSOC_LEAVE (on_event skips both). */
    expect_disconnect = state == WIFI_CONNECTED;
    esp_wifi_disconnect();
  }
  snprintf(current, sizeof current, "%s", ssid);
  address[0] = '\0';
  state = WIFI_CONNECTING;
  retries = 0;
  esp_wifi_set_config(WIFI_IF_STA, &config);
  if (esp_wifi_connect() != ESP_OK) {
    state = WIFI_IDLE;
    snprintf(error, sizeof error, "The radio did not start the connection");
  }
}

/* The next saved slot of the start-up join; caller holds the lock. */
static bool auto_next(void) {
  while (auto_left > 0) {
    int slot = auto_order[WIFI_SLOTS - auto_left];
    auto_left -= 1;
    if (saved[slot].ssid[0] == '\0') continue;
    begin(saved[slot].ssid, saved[slot].passphrase, false);
    return true;
  }
  return false;
}

static void plan_auto_join(void) {
  for (int i = 0; i < WIFI_SLOTS; i += 1) auto_order[i] = i;
  for (int i = 0; i < WIFI_SLOTS; i += 1) {
    for (int j = i + 1; j < WIFI_SLOTS; j += 1) {
      if (saved[auto_order[j]].used > saved[auto_order[i]].used) {
        int swap = auto_order[i];
        auto_order[i] = auto_order[j];
        auto_order[j] = swap;
      }
    }
  }
  auto_left = WIFI_SLOTS;
}

static const char *reason_text(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
      return "Incorrect password";
    case WIFI_REASON_NO_AP_FOUND:
      return "The network was not found";
    default:
      return "The network did not accept the connection";
  }
}

/* Fetch a finished scan's records over the link, then fold them into the
 * network list under the lock. */
static void collect_scan(void) {
  uint16_t count = 0;
  esp_wifi_scan_get_ap_num(&count);
  if (count > 24) count = 24;
  wifi_ap_record_t *records = scan_records;
  if (esp_wifi_scan_get_ap_records(&count, records) != ESP_OK) count = 0;
  take();
  network_count = 0;
  for (uint16_t i = 0; i < count; i += 1) {
    const char *ssid = (const char *)records[i].ssid;
    if (ssid[0] == '\0') continue;
    size_t found = network_count;
    for (size_t j = 0; j < network_count; j += 1) {
      if (strcmp(networks[j].ssid, ssid) == 0) found = j;
    }
    if (found < network_count) {
      if (records[i].rssi > networks[found].rssi) networks[found].rssi = records[i].rssi;
      continue;
    }
    if (network_count == WIFI_MAX_NETWORKS) continue;
    FoundNetwork *network = &networks[network_count++];
    snprintf(network->ssid, sizeof network->ssid, "%s", ssid);
    network->rssi = records[i].rssi;
    network->secure = records[i].authmode != WIFI_AUTH_OPEN;
  }
  for (size_t i = 0; i < network_count; i += 1) {
    for (size_t j = i + 1; j < network_count; j += 1) {
      if (networks[j].rssi > networks[i].rssi) {
        FoundNetwork swap = networks[i];
        networks[i] = networks[j];
        networks[j] = swap;
      }
    }
  }
  scanning = false;
  give();
}

/* Calls over the coprocessor link block for up to a second and need a
 * deep stack: the worker makes them, never the guest's frame or the event
 * loop's task. */
static void poll_radio(void *argument) {
  (void)argument;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(WIFI_POLL_MS));
    take();
    const bool start_scan = scan_requested;
    const bool finish_scan = scan_done;
    const bool read_rssi = state == WIFI_CONNECTED && esp_timer_get_time() - rssi_read_us > WIFI_RSSI_MS * 1000;
    scan_requested = false;
    scan_done = false;
    give();
    if (start_scan) {
      wifi_scan_config_t config;
      memset(&config, 0, sizeof config);
      const bool started = esp_wifi_scan_start(&config, false) == ESP_OK;
      take();
      if (!started) {
        scanning = false;
        snprintf(error, sizeof error, "The scan did not start");
      }
      give();
    }
    if (finish_scan) collect_scan();
    if (read_rssi) {
      wifi_ap_record_t record;
      const bool read = esp_wifi_sta_get_ap_info(&record) == ESP_OK;
      take();
      if (read) rssi = record.rssi;
      rssi_read_us = esp_timer_get_time();
      give();
    }
  }
}

static void on_event(void *argument, esp_event_base_t base, int32_t id, void *data) {
  (void)argument;
  take();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    plan_auto_join();
    if (!auto_next()) state = WIFI_IDLE;
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_STOP) {
    state = WIFI_OFF;
    address[0] = '\0';
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
    scan_done = true;
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    const wifi_event_sta_disconnected_t *event = data;
    address[0] = '\0';
    if (expect_disconnect || event->reason == WIFI_REASON_ASSOC_LEAVE) {
      expect_disconnect = false;
    } else if (state == WIFI_CONNECTED && retries < WIFI_RETRIES) {
      retries += 1;
      state = WIFI_CONNECTING;
      esp_wifi_connect();
    } else if (state != WIFI_OFF) {
      bool failed_join = attempt.save;
      attempt.save = false;
      snprintf(error, sizeof error, "%s", reason_text(event->reason));
      state = WIFI_IDLE;
      if (!failed_join) auto_next();
    }
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    const ip_event_got_ip_t *event = data;
    snprintf(address, sizeof address, IPSTR, IP2STR(&event->ip_info.ip));
    state = WIFI_CONNECTED;
    error[0] = '\0';
    auto_left = 0;
    retries = 0;
    rssi_read_us = 0;
    int slot = slot_for(current);
    if (attempt.save || strcmp(saved[slot].ssid, current) == 0) {
      snprintf(saved[slot].ssid, sizeof saved[slot].ssid, "%s", attempt.ssid);
      snprintf(saved[slot].passphrase, sizeof saved[slot].passphrase, "%s", attempt.passphrase);
      saved[slot].used = ++use_clock;
      store_slot(slot);
    }
    attempt.save = false;
  }
  give();
}

static void bring_up(void *argument) {
  esp_err_t (*prepare)(void) = (esp_err_t (*)(void))argument;
  esp_err_t result = nvs_flash_init();
  if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    result = nvs_flash_init();
  }
  take();
  load_saved();
  give();
  esp_netif_init();
  esp_event_loop_create_default();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
  result = prepare != NULL ? prepare() : ESP_OK;
  if (result == ESP_OK) result = esp_wifi_init(&config);
  if (result == ESP_OK) result = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (result == ESP_OK) result = esp_wifi_set_mode(WIFI_MODE_STA);
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
  take();
  if (result != ESP_OK) {
    snprintf(error, sizeof error, "The radio did not start (%s)", esp_err_to_name(result));
    ESP_LOGE(TAG, "%s", error);
  } else {
    ready = true;
    state = WIFI_IDLE;
  }
  bool start = ready && enabled;
  if (ready && !enabled) state = WIFI_OFF;
  give();
  if (start) esp_wifi_start();
  vTaskDelete(NULL);
}

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------

void wifi_start(esp_err_t (*prepare)(void)) {
  if (lock != NULL) return;
  lock = xSemaphoreCreateMutex();
  xTaskCreate(bring_up, "pocketjs_wifi", 6 * 1024, (void *)prepare, 3, NULL);
  xTaskCreate(poll_radio, "pocketjs_radio", 8 * 1024, NULL, 2, NULL);
}

static void status_network(JsonBuffer *out, const char *ssid, int strength, bool secure) {
  jbuf_text(out, "{\"ssid\":");
  jbuf_cstring(out, ssid);
  jbuf_text(out, ",\"strength\":");
  jbuf_u64(out, (uint64_t)strength);
  jbuf_text(out, secure ? ",\"secure\":true}" : ",\"secure\":false}");
}

const char *wifi_status_json(void) {
  if (lock == NULL) return "{\"state\":\"off\",\"ssid\":\"\",\"strength\":0,\"address\":\"\",\"saved\":[],\"error\":\"\"}";
  take();
  static const char *const NAMES[] = { "off", "idle", "connecting", "connected" };
  JsonBuffer *out = &status_out;
  jbuf_reset(out);
  jbuf_text(out, "{\"state\":\"");
  jbuf_text(out, NAMES[state]);
  jbuf_text(out, "\",\"ssid\":");
  jbuf_cstring(out, state == WIFI_CONNECTED || state == WIFI_CONNECTING ? current : "");
  jbuf_text(out, ",\"strength\":");
  jbuf_u64(out, state == WIFI_CONNECTED ? (uint64_t)bars(rssi) : 0);
  jbuf_text(out, ",\"address\":");
  jbuf_cstring(out, address);
  jbuf_text(out, ",\"saved\":[");
  for (int slot = 0; slot < WIFI_SLOTS; slot += 1) {
    if (slot > 0) jbuf_text(out, ",");
    jbuf_text(out, "{\"slot\":");
    jbuf_u64(out, (uint64_t)slot);
    jbuf_text(out, ",\"ssid\":");
    jbuf_cstring(out, saved[slot].ssid);
    jbuf_text(out, "}");
  }
  jbuf_text(out, "],\"error\":");
  jbuf_cstring(out, error);
  jbuf_text(out, scanning ? ",\"scanning\":true,\"networks\":[" : ",\"scanning\":false,\"networks\":[");
  for (size_t i = 0; i < network_count; i += 1) {
    if (i > 0) jbuf_text(out, ",");
    status_network(out, networks[i].ssid, bars(networks[i].rssi), networks[i].secure);
  }
  jbuf_text(out, "]}");
  const char *text = jbuf_cstr(out);
  give();
  return text == NULL ? "{\"state\":\"off\",\"error\":\"wifi: status overflow\"}" : text;
}

bool wifi_set_enabled(bool on) {
  if (lock == NULL) return false;
  take();
  bool was = enabled;
  enabled = on;
  error[0] = '\0';
  bool act = ready && was != on;
  give();
  if (was != on) store_enabled();
  if (!act) return ready || !on;
  return (on ? esp_wifi_start() : esp_wifi_stop()) == ESP_OK;
}

bool wifi_connect(int slot) {
  if (lock == NULL || slot < 0 || slot >= WIFI_SLOTS) return false;
  take();
  bool ok = ready && state != WIFI_OFF && saved[slot].ssid[0] != '\0';
  if (!ok) {
    snprintf(error, sizeof error, "%s", state == WIFI_OFF ? "Wi-Fi is off" : "That slot holds no connection");
  } else {
    error[0] = '\0';
    auto_left = 0;
    saved[slot].used = ++use_clock;
    begin(saved[slot].ssid, saved[slot].passphrase, false);
  }
  give();
  return ok;
}

bool wifi_scan(void) {
  if (lock == NULL) return false;
  take();
  bool ok = ready && state != WIFI_OFF;
  if (!ok) snprintf(error, sizeof error, "Wi-Fi is off");
  if (ok) {
    scanning = true;
    scan_requested = true;
  }
  give();
  return ok;
}

bool wifi_join(const char *ssid, size_t ssid_length, const char *passphrase, size_t passphrase_length) {
  if (lock == NULL || ssid_length == 0 || ssid_length >= WIFI_SSID_BYTES ||
      passphrase_length >= WIFI_PASSPHRASE_BYTES) {
    return false;
  }
  char name[WIFI_SSID_BYTES];
  char secret[WIFI_PASSPHRASE_BYTES];
  memcpy(name, ssid, ssid_length);
  name[ssid_length] = '\0';
  memcpy(secret, passphrase, passphrase_length);
  secret[passphrase_length] = '\0';
  take();
  bool ok = ready && state != WIFI_OFF;
  if (!ok) {
    snprintf(error, sizeof error, "Wi-Fi is off");
  } else {
    error[0] = '\0';
    auto_left = 0;
    begin(name, secret, true);
  }
  give();
  return ok;
}

bool wifi_forget(int slot) {
  if (lock == NULL || slot < 0 || slot >= WIFI_SLOTS) return false;
  take();
  bool ok = saved[slot].ssid[0] != '\0';
  bool drop = ok && strcmp(current, saved[slot].ssid) == 0 && (state == WIFI_CONNECTED || state == WIFI_CONNECTING);
  if (ok) {
    memset(&saved[slot], 0, sizeof saved[slot]);
    store_slot(slot);
  }
  if (drop) {
    expect_disconnect = true;
    state = WIFI_IDLE;
    address[0] = '\0';
  }
  give();
  if (drop) esp_wifi_disconnect();
  return ok;
}

bool wifi_online(void) {
  if (lock == NULL) return false;
  take();
  bool online = state == WIFI_CONNECTED && address[0] != '\0';
  give();
  return online;
}

void wifi_address(char *out, size_t capacity) {
  out[0] = '\0';
  if (lock == NULL) return;
  take();
  snprintf(out, capacity, "%s", state == WIFI_CONNECTED ? address : "");
  give();
}
