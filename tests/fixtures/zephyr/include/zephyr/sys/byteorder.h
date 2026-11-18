#pragma once
#include <stdint.h>
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define sys_cpu_to_le16(val) (val)
#define sys_cpu_to_le32(val) (val)
#define sys_cpu_to_be16(val) __builtin_bswap16(val)
#else
#define sys_cpu_to_le16(val) __builtin_bswap16(val)
#define sys_cpu_to_le32(val) __builtin_bswap32(val)
#define sys_cpu_to_be16(val) (val)
#endif
