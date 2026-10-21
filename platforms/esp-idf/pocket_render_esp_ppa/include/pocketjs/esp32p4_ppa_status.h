#pragma once
#include "esp_err.h"
#include "pocket/render_esp_ppa.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct pocketjs_esp32p4_ppa pocketjs_esp32p4_ppa_t;
esp_err_t pocketjs_esp32p4_ppa_create(pocketjs_esp32p4_ppa_t **out_ppa);
const pocket_ppa_ops *pocketjs_esp32p4_ppa_status_ops(pocketjs_esp32p4_ppa_t *ppa);
void pocketjs_esp32p4_ppa_destroy(pocketjs_esp32p4_ppa_t *ppa);
#ifdef __cplusplus
}
#endif
