#ifndef POCKET_NET_TRANSPORT_H
#define POCKET_NET_TRANSPORT_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*pocket_net_done_cb)(int32_t handle, uint16_t status,
    const char* url, const char* headers_json,
    const uint8_t* body, size_t body_len);

typedef void (*pocket_net_error_cb)(int32_t handle,
    const char* code, const char* message);

void pocket_net_set_callbacks(pocket_net_done_cb done, pocket_net_error_cb error);
void pocket_net_request(const char* url, const char* method,
    const char* headers_json, const uint8_t* body, size_t body_len,
    int32_t handle);

#ifdef __cplusplus
}
#endif

#endif
EOF   

