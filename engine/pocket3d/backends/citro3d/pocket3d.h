#ifndef POCKET3D_CITRO3D_H
#define POCKET3D_CITRO3D_H
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
/* P3M1 ColorVertex layout: position.xyz, color.rgba; renderer owns GPU memory.
 */
typedef struct {
  float position[3], color[4];
} P3D_ColorVertex;
typedef struct {
  P3D_ColorVertex *vertices;
  size_t count, capacity;
  C3D_BufInfo buffer;
} P3D_Mesh;
/* 87 matrix rows + projection + shader constants fit the 96 float uniforms. */
#define P3D_SKIN_MAX_JOINTS 29
typedef struct {
  float position[3], normal[3], color[3], matrix_row;
} P3D_RigidVertex;
typedef struct {
  uint32_t first, count;
  uint16_t joints[3], reserved;
} P3D_RigidRange;
typedef struct { float rows[3][4]; } P3D_SkinMatrix;
typedef struct {
  const P3D_RigidVertex *vertices;
  const uint16_t *indices;
  const P3D_RigidRange *ranges;
  uint32_t vertex_count, index_count, range_count, joint_count;
} P3D_SkinSource;
typedef struct {
  void *memory;
  uint16_t *indices;
  P3D_RigidRange *ranges;
  uint32_t range_count, joint_count;
  C3D_BufInfo buffer;
} P3D_SkinMesh;
bool p3d_skin_init(const void *shader, size_t size);
bool p3d_skin_create(P3D_SkinMesh *, const P3D_SkinSource *);
void p3d_skin_free(P3D_SkinMesh *);
typedef struct { float direction[3], ambient, diffuse; } P3D_SkinLight;
/* Returns false for invalid lighting; no render state is changed. */
bool p3d_skin_begin(const C3D_Mtx *view_projection, const P3D_SkinLight *light);
uint32_t p3d_skin_visible(const P3D_SkinMatrix *, uint32_t count);
uint32_t p3d_skin_count(const P3D_SkinMesh *, uint32_t visible);
void p3d_skin_draw(const P3D_SkinMesh *, const P3D_SkinMatrix *, uint32_t visible);
bool p3d_init(const void *shader, size_t size);
void p3d_exit(void);
bool p3d_mesh_create(P3D_Mesh *mesh, size_t capacity);
bool p3d_mesh_upload(P3D_Mesh *mesh, const P3D_ColorVertex *vertices,
                     size_t count);
void p3d_mesh_free(P3D_Mesh *mesh);
void p3d_begin(const C3D_Mtx *view_projection);
void p3d_draw(const P3D_Mesh *mesh);
#endif
