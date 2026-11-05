/* Strong override of the SDK's weak HCPU MPU table for SF32LB58x. The only
 * policy change splits the SDK's cached PSRAM region into cached PSRAM1 and
 * non-cacheable PSRAM2 (the framebuffers), without overlapping regions. It
 * runs at startup: adding the PSRAM2 region after the SDK table is live
 * raises DACCVIOL on the first framebuffer write. */
#include "rtconfig.h"

#ifdef POCKETJS_MPU_OVERRIDE

#include "bf0_hal.h"
#include "register.h"

#if !defined(SF32LB58X)
#error "POCKETJS_MPU_OVERRIDE encodes the SF32LB58x memory map"
#endif

enum { ATTR_CODE, ATTR_RAM, ATTR_DEVICE, ATTR_PSRAM_WB, ATTR_PSRAM_WT };

#define MPU_ATTR_CODE \
  ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(0, 0, 1, 0), ARM_MPU_ATTR_MEMORY_(0, 0, 1, 0))
#define MPU_ATTR_RAM ARM_MPU_ATTR(ARM_MPU_ATTR_NON_CACHEABLE, ARM_MPU_ATTR_NON_CACHEABLE)
#define MPU_ATTR_DEVICE ARM_MPU_ATTR(ARM_MPU_ATTR_DEVICE, ARM_MPU_ATTR_DEVICE_nGnRnE)
#define MPU_ATTR_PSRAM_WB \
  ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(0, 1, 1, 1), ARM_MPU_ATTR_MEMORY_(0, 1, 1, 1))
#define MPU_ATTR_PSRAM_WT \
  ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(0, 0, 1, 1), ARM_MPU_ATTR_MEMORY_(0, 0, 1, 1))

void mpu_config(void);

void mpu_config(void) {
  uint32_t region = 0;

  SCB_DisableDCache();
  SCB_DisableICache();
  ARM_MPU_Disable();
  for (uint32_t index = 0; index < MPU_REGION_NUM; ++index)
    ARM_MPU_ClrRegion(index);

  ARM_MPU_SetMemAttr(ATTR_CODE, MPU_ATTR_CODE);
  ARM_MPU_SetMemAttr(ATTR_RAM, MPU_ATTR_RAM);
  ARM_MPU_SetMemAttr(ATTR_DEVICE, MPU_ATTR_DEVICE);
  ARM_MPU_SetMemAttr(ATTR_PSRAM_WB, MPU_ATTR_PSRAM_WB);
  ARM_MPU_SetMemAttr(ATTR_PSRAM_WT, MPU_ATTR_PSRAM_WT);

#define SET_REGION(base, limit, share, read_only, non_privileged, execute_never, attr)       \
  ARM_MPU_SetRegion(region++,                                                               \
                    ARM_MPU_RBAR((base), (share), (read_only), (non_privileged),            \
                                 (execute_never)),                                          \
                    ARM_MPU_RLAR((limit), (attr)))

  SET_REGION(0x00000000U, 0x0000FFFFU, ARM_MPU_SH_NON, 1, 1, 1, ATTR_CODE);
  SET_REGION(0x00010000U, 0x0002FFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_RAM);
  SET_REGION(0x10000000U, 0x1FFFFFFFU, ARM_MPU_SH_NON, 1, 1, 0, ATTR_CODE);
  SET_REGION(0x20000000U, 0x2027FFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_RAM);
  SET_REGION(0x40000000U, 0x5FFFFFFFU, ARM_MPU_SH_NON, 0, 1, 1, ATTR_DEVICE);
#ifdef PSRAM_CACHE_WB
  SET_REGION(0x60000000U, 0x61FFFFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_PSRAM_WB);
#else
  SET_REGION(0x60000000U, 0x61FFFFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_PSRAM_WT);
#endif
  SET_REGION(0x62000000U, 0x62FFFFFFU, ARM_MPU_SH_NON, 0, 1, 1, ATTR_RAM);
  SET_REGION(0x203FC000U, 0x204FFFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_RAM);
  SET_REGION(0x20BFC000U, 0x20CBFFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_RAM);
  SET_REGION(0x20800000U, 0x208FFFFFU, ARM_MPU_SH_NON, 0, 1, 0, ATTR_CODE);
  SET_REGION(0x64000000U, 0x6FFFFFFFU, ARM_MPU_SH_NON, 1, 1, 0, ATTR_RAM);

#undef SET_REGION

  HAL_ASSERT(region <= MPU_REGION_NUM);
  ARM_MPU_Enable(MPU_CTRL_HFNMIENA_Msk);
  SCB_EnableDCache();
  SCB_EnableICache();
}

#endif /* POCKETJS_MPU_OVERRIDE */
