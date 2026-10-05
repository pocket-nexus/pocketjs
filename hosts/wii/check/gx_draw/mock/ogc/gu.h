#ifndef POCKET_WII_GX_DRAW_MOCK_GU_H
#define POCKET_WII_GX_DRAW_MOCK_GU_H

#include "gx.h"

typedef f32 Mtx[3][4];
typedef f32 Mtx44[4][4];

void guMtxIdentity(Mtx matrix);
void guOrtho(Mtx44 matrix, f32 top, f32 bottom, f32 left, f32 right,
             f32 near_z, f32 far_z);

#endif
