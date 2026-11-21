/* A game's packs as pieces, for a host written in C.
 *
 * The functions are in the game's Rust library when it builds the
 * `pocket3d-packs` crate with its `cabi` feature. The host reads the manifest's
 * text from a file, parses it once, and reads a pack through
 * `p3d_packs_read` with one function of its own that copies a range of a
 * piece's file into memory. A piece's file is `<20 hexadecimal digits>.bin`
 * beside the manifest. */
#ifndef POCKET3D_PACKS_H
#define POCKET3D_PACKS_H

#include <stdint.h>

#define P3D_PACK_NAME_BYTES 24
#define P3D_PIECE_FILE_BYTES 25

typedef struct P3dPacks P3dPacks;

/* Copies `bytes` bytes at `at` of the piece's file into `into`. Returns 0 when it did. */
typedef int32_t (*P3dPieceRead)(void *user, const char *file, uint32_t at, uint8_t *into, uint32_t bytes);

/* Null when the text is refused. */
P3dPacks *p3d_packs_parse(const uint8_t *text, uint32_t bytes);
void p3d_packs_free(P3dPacks *manifest);
uint32_t p3d_packs_count(const P3dPacks *manifest);
/* The index of the pack of that name, or -1. */
int32_t p3d_packs_find(const P3dPacks *manifest, const char *name);
/* Writes the pack's name into `into` (P3D_PACK_NAME_BYTES + 1 bytes) and returns the pack's size in bytes. */
uint64_t p3d_packs_name(const P3dPacks *manifest, uint32_t pack, char *into);
uint32_t p3d_packs_pieces(const P3dPacks *manifest, uint32_t pack);
/* Writes the piece's file name into `file` (P3D_PIECE_FILE_BYTES bytes) and returns the piece's size. */
uint32_t p3d_packs_piece(const P3dPacks *manifest, uint32_t pack, uint32_t piece, char *file);
/* 0 when the bytes were read, 1 for a range outside the pack, otherwise what `read` returned. */
int32_t p3d_packs_read(const P3dPacks *manifest, uint32_t pack, uint64_t offset, uint8_t *into, uint32_t bytes, P3dPieceRead read, void *user);

#endif
