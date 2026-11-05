/* Process-wide libctru socket service ownership for devserver, companion
 * transport and the offload worker. Transport shutdown never closes SOC. */
#ifndef POCKETJS_3DS_SOC_H
#define POCKETJS_3DS_SOC_H

#include <stdbool.h>
#include <stddef.h>

/* Initialize once, without waiting for a competing initializer. A failed
 * init can retry after a three-second cooldown (WiFi may be reconnecting).
 * Offload calls this on its worker; UI callers never wait on that worker.
 * On false, error (when provided) describes why SOC is not yet usable. */
bool soc_ensure(char *error, size_t error_length);
bool soc_active(void);

/* Call only after all transports stop and the offload worker is joined. */
void soc_shutdown(void);

#endif
