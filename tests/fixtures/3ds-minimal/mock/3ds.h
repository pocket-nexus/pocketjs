#ifndef TEST_3DS_H
#define TEST_3DS_H
#include <stdbool.h>
#include <stdint.h>
#define R_SUCCEEDED(value) ((value) >= 0)
#define KEY_A (1u << 0)
#define KEY_B (1u << 1)
#define KEY_SELECT (1u << 2)
#define KEY_START (1u << 3)
#define KEY_DUP (1u << 4)
#define KEY_DDOWN (1u << 5)
#define KEY_DLEFT (1u << 6)
#define KEY_DRIGHT (1u << 7)
#define KEY_R (1u << 8)
#define KEY_L (1u << 9)
#define KEY_X (1u << 10)
#define KEY_Y (1u << 11)
#define KEY_ZL (1u << 12)
#define KEY_ZR (1u << 13)
#define KEY_TOUCH (1u << 14)
typedef struct { int16_t dx, dy; } circlePosition;
typedef struct { uint16_t px, py; } touchPosition;
int APT_CheckNew3DS(bool *);
int irrstInit(void);
void irrstExit(void);
void irrstScanInput(void);
uint32_t irrstKeysHeld(void);
uint32_t hidKeysHeld(void);
uint32_t hidKeysDown(void);
void hidCircleRead(circlePosition *);
void irrstCstickRead(circlePosition *);
void hidTouchRead(touchPosition *);
#endif
