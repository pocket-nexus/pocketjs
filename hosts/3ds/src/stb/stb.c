/* The two stb single-file libraries photos.c uses, compiled once here with
 * their own warnings kept out of the host's build log (Makefile). JPEG only:
 * the decoder reads what cameras write, the encoder writes what photos.c
 * saves. */

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"
