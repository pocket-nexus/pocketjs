/*
 * `globalThis.wifi` (contracts/spec/wifi.ts, capability system.wifi): the
 * console's radio and its three saved connections.
 *
 * Reads go through AC (ac:i when the process may open it: libctru's acInit
 * tries it first, which the ACI saved-slot reads need); radio on/off through
 * nwm::EXT. connect(slot) is asynchronous, the way Luma3DS Rosalina's "Force
 * wireless connection" asks AC: one ACU_ConnectAsync whose completion event
 * wifi_pump polls with a zero timeout, so no frame ever waits on the radio.
 * Nothing here writes a saved connection.
 */

#ifndef POCKETJS_3DS_WIFI_H
#define POCKETJS_3DS_WIFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The JSON WifiStatus; lives until the next call. */
const char *wifi_status_json(void);
bool wifi_set_enabled(bool on);
bool wifi_connect(int32_t slot);
/* Poll an asynchronous connect. Call once per frame. */
void wifi_pump(void);
void wifi_shutdown(void);

#endif
