/* `globalThis.wifi` — see wifi.h. */

#include "wifi.h"

#include <stdio.h>

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)

#include <3ds.h>
#include <arpa/inet.h>
#include <string.h>
#include <unistd.h>

#include "jscan.h"
#include "soc.h"

#define WIFI_SAVED_SLOTS 3
#define WIFI_CONNECT_TIMEOUT_MS 30000u
/* Saved SSIDs change only in System Settings, which cannot run beside this
 * process; re-reading them now and then covers a sleep/resume. */
#define WIFI_SAVED_REFRESH_MS 10000u
/* OS_SharedConfig->network_state while wireless communication is disabled. */
#define WIFI_NETWORK_STATE_DISABLED 7u

static bool ac_ready;
static bool ac_tried;
static bool nwm_ready;
static bool radio_off;
static bool connecting;
static int32_t connecting_slot;
static Handle connect_event;
static uint64_t connect_started_ms;
static char saved[WIFI_SAVED_SLOTS][33];
static bool saved_known;
static uint64_t saved_read_ms;
static char error[160];
static JsonBuffer status_out = { .limit = 2048 };

static bool ensure_ac(void) {
  if (ac_ready) return true;
  if (ac_tried) return false;
  ac_tried = true;
  ac_ready = R_SUCCEEDED(acInit());
  if (!ac_ready) snprintf(error, sizeof error, "the AC service is unavailable");
  return ac_ready;
}

static void read_saved(void) {
  uint64_t now = osGetTime();
  if (saved_known && now - saved_read_ms < WIFI_SAVED_REFRESH_MS) return;
  saved_known = true;
  saved_read_ms = now;
  for (int slot = 0; slot < WIFI_SAVED_SLOTS; slot += 1) {
    saved[slot][0] = '\0';
    if (!ac_ready) continue;
    /* Loads the slot into AC's working copy only; the saved settings are
     * untouched. Both calls need ac:i and fail quietly on ac:u. */
    if (R_FAILED(ACI_LoadNetworkSetting((u32)slot))) continue;
    char ssid[0x20 + 1] = {0};
    if (R_SUCCEEDED(ACI_GetNetworkWirelessEssidSecuritySsid(ssid))) {
      ssid[0x20] = '\0';
      snprintf(saved[slot], sizeof saved[slot], "%s", ssid);
    }
  }
}

static void end_connect(void) {
  if (connect_event != 0) svcCloseHandle(connect_event);
  connect_event = 0;
  connecting = false;
}

void wifi_pump(void) {
  if (!connecting) return;
  if (svcWaitSynchronization(connect_event, 0) == 0) {
    u32 ap = 0;
    bool connected = R_SUCCEEDED(ACU_GetWifiStatus(&ap)) && ap != 0;
    if (!connected) {
      u32 code = 0;
      ACU_GetLastErrorCode(&code);
      snprintf(error, sizeof error, "could not connect through saved connection %ld (error %lu)",
        (long)connecting_slot + 1, (unsigned long)code);
    } else {
      error[0] = '\0';
    }
    end_connect();
    return;
  }
  if (osGetTime() - connect_started_ms > WIFI_CONNECT_TIMEOUT_MS) {
    snprintf(error, sizeof error, "saved connection %ld did not answer", (long)connecting_slot + 1);
    end_connect();
  }
}

static const char *state_name(u32 *ap_out) {
  u32 ap = 0;
  bool have_ap = ac_ready && R_SUCCEEDED(ACU_GetWifiStatus(&ap));
  *ap_out = have_ap ? ap : 0;
  if (radio_off || OS_SharedConfig->network_state == WIFI_NETWORK_STATE_DISABLED) return "off";
  if (have_ap && ap != 0) return "connected";
  if (connecting) return "connecting";
  return "idle";
}

const char *wifi_status_json(void) {
  ensure_ac();
  wifi_pump();
  u32 ap = 0;
  const char *state = state_name(&ap);
  char ssid[0x20 + 1] = {0};
  char address[16] = {0};
  bool connected = strcmp(state, "connected") == 0;
  if (connected) {
    if (R_FAILED(ACU_GetSSID(ssid))) ssid[0] = '\0';
    ssid[0x20] = '\0';
    if (soc_active()) {
      struct in_addr in;
      in.s_addr = (in_addr_t)gethostid();
      if (in.s_addr != 0) snprintf(address, sizeof address, "%s", inet_ntoa(in));
    }
  }
  read_saved();
  u32 ac_status = 0;
  if (ac_ready) ACU_GetStatus(&ac_status);
  JsonBuffer *out = &status_out;
  jbuf_reset(out);
  jbuf_text(out, "{\"state\":\"");
  jbuf_text(out, state);
  jbuf_text(out, "\",\"ssid\":");
  jbuf_cstring(out, ssid);
  jbuf_text(out, ",\"strength\":");
  jbuf_u64(out, connected ? osGetWifiStrength() : 0);
  jbuf_text(out, ",\"address\":");
  jbuf_cstring(out, address);
  jbuf_text(out, ",\"saved\":[");
  for (int slot = 0; slot < WIFI_SAVED_SLOTS; slot += 1) {
    if (slot > 0) jbuf_text(out, ",");
    jbuf_text(out, "{\"slot\":");
    jbuf_u64(out, (uint64_t)slot);
    jbuf_text(out, ",\"ssid\":");
    jbuf_cstring(out, saved[slot]);
    jbuf_text(out, "}");
  }
  jbuf_text(out, "],\"error\":");
  jbuf_cstring(out, error);
  /* Host diagnostics beyond WifiStatus: the raw AC and shared-page facts the
   * state above is derived from, and the slot an AP type names. */
  jbuf_text(out, ",\"acStatus\":");
  jbuf_u64(out, ac_status);
  jbuf_text(out, ",\"apType\":");
  jbuf_u64(out, ap);
  jbuf_text(out, ",\"networkState\":");
  jbuf_u64(out, OS_SharedConfig->network_state);
  jbuf_text(out, "}");
  const char *text = jbuf_cstr(out);
  return text == NULL ? "{\"state\":\"idle\",\"ssid\":\"\",\"strength\":0,\"address\":\"\",\"saved\":[],\"error\":\"wifi: status overflow\"}" : text;
}

bool wifi_set_enabled(bool on) {
  if (!nwm_ready) {
    Result result = nwmExtInit();
    if (R_FAILED(result)) {
      snprintf(error, sizeof error, "the radio service is unavailable (0x%08lx)", (unsigned long)result);
      return false;
    }
    nwm_ready = true;
  }
  Result result = NWMEXT_ControlWirelessEnabled(on);
  if (R_FAILED(result)) {
    snprintf(error, sizeof error, "the radio refused to turn %s (0x%08lx)", on ? "on" : "off", (unsigned long)result);
    return false;
  }
  radio_off = !on;
  if (!on) end_connect();
  error[0] = '\0';
  return true;
}

bool wifi_connect(int32_t slot) {
  if (slot < 0 || slot >= WIFI_SAVED_SLOTS) {
    snprintf(error, sizeof error, "saved connection %ld does not exist", (long)slot + 1);
    return false;
  }
  if (!ensure_ac()) return false;
  if (radio_off || OS_SharedConfig->network_state == WIFI_NETWORK_STATE_DISABLED) {
    snprintf(error, sizeof error, "the radio is off");
    return false;
  }
  if (connecting) {
    snprintf(error, sizeof error, "a connection is already being made");
    return false;
  }
  read_saved();
  if (saved[slot][0] == '\0') {
    snprintf(error, sizeof error, "saved connection %ld is empty", (long)slot + 1);
    return false;
  }
  acuConfig config;
  memset(&config, 0, sizeof config);
  Handle event = 0;
  if (R_FAILED(svcCreateEvent(&event, RESET_ONESHOT))) {
    snprintf(error, sizeof error, "event allocation failed");
    return false;
  }
  Result result = ACU_CreateDefaultConfig(&config);
  if (R_SUCCEEDED(result)) result = ACU_SetNetworkArea(&config, 2);
  if (R_SUCCEEDED(result)) result = ACU_SetAllowApType(&config, (u8)(1u << slot));
  if (R_SUCCEEDED(result)) result = ACU_SetRequestEulaVersion(&config);
  if (R_SUCCEEDED(result)) result = ACU_ConnectAsync(&config, event);
  if (R_FAILED(result)) {
    svcCloseHandle(event);
    snprintf(error, sizeof error, "AC refused the connection (0x%08lx)", (unsigned long)result);
    return false;
  }
  connect_event = event;
  connecting = true;
  connecting_slot = slot;
  connect_started_ms = osGetTime();
  error[0] = '\0';
  return true;
}

void wifi_shutdown(void) {
  end_connect();
  if (nwm_ready) nwmExtExit();
  nwm_ready = false;
  if (ac_ready) acExit();
  ac_ready = false;
  ac_tried = false;
  jbuf_free(&status_out);
}

#else /* capture and offload builds */

const char *wifi_status_json(void) {
  return "{\"state\":\"off\",\"ssid\":\"\",\"strength\":0,\"address\":\"\",\"saved\":[],"
         "\"error\":\"this build has no wifi module\"}";
}

bool wifi_set_enabled(bool on) {
  (void)on;
  return false;
}

bool wifi_connect(int32_t slot) {
  (void)slot;
  return false;
}

void wifi_pump(void) {}
void wifi_shutdown(void) {}

#endif
