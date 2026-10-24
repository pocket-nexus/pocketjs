#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "quickjs.h"

/* wifi.c: `globalThis.wifi` (contracts/spec/wifi.ts) over esp_wifi. The radio
 * comes up on its own task, after `prepare`; every call below is safe before
 * it has. */
void wifi_start(esp_err_t (*prepare)(void));
const char *wifi_status_json(void);
bool wifi_set_enabled(bool on);
bool wifi_connect(int slot);
bool wifi_scan(void);
bool wifi_join(const char *ssid, size_t ssid_length, const char *passphrase, size_t passphrase_length);
bool wifi_forget(int slot);
/* An address is assigned: sockets reach the LAN. */
bool wifi_online(void);
void wifi_address(char *out, size_t capacity);

/* services_host.c: run `job` on the system task, whose stack is internal
 * (flash access), and return when it has finished. */
void system_run(void (*job)(void *), void *context);

/* qjs.c: install the system namespaces into the guest's realm. */
esp_err_t system_qjs_install(JSContext *ctx);
