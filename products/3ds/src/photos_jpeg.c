/* JPEG through libjpeg — see photos_jpeg.h. */

#include "photos_jpeg.h"

#include <jpeglib.h>
#include <setjmp.h>
#include <stdlib.h>

/* libjpeg reports a fatal error by calling error_exit; this one returns to
 * the setjmp in the caller instead of exiting, and warnings print nothing. */
typedef struct {
  struct jpeg_error_mgr base;
  jmp_buf escape;
} JpegError;

static void jpeg_escape(j_common_ptr cinfo) {
  longjmp(((JpegError *)(void *)cinfo->err)->escape, 1);
}

static void jpeg_quiet(j_common_ptr cinfo, int level) {
  (void)cinfo;
  (void)level;
}

static void jpeg_errors(JpegError *error) {
  jpeg_std_error(&error->base);
  error->base.error_exit = jpeg_escape;
  error->base.emit_message = jpeg_quiet;
}

bool photo_jpeg_write(FILE *file, const uint8_t *rgb, uint32_t width, uint32_t height, int quality) {
  struct jpeg_compress_struct cinfo;
  JpegError error;
  cinfo.err = &error.base;
  jpeg_errors(&error);
  if (setjmp(error.escape)) {
    jpeg_destroy_compress(&cinfo);
    return false;
  }
  jpeg_create_compress(&cinfo);
  jpeg_stdio_dest(&cinfo, file);
  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality, TRUE);
  jpeg_start_compress(&cinfo, TRUE);
  while (cinfo.next_scanline < height) {
    JSAMPROW row = (JSAMPROW)(rgb + (size_t)cinfo.next_scanline * width * 3u);
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
  return true;
}

uint8_t *photo_jpeg_read(const uint8_t *jpeg, size_t length, uint32_t min_width, uint32_t min_height, uint32_t *width,
  uint32_t *height) {
  struct jpeg_decompress_struct cinfo;
  JpegError error;
  uint8_t *volatile rgb = NULL;
  cinfo.err = &error.base;
  jpeg_errors(&error);
  if (setjmp(error.escape)) {
    jpeg_destroy_decompress(&cinfo);
    free(rgb);
    return NULL;
  }
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, (unsigned char *)jpeg, (unsigned long)length);
  jpeg_read_header(&cinfo, TRUE);
  unsigned denominator = 8;
  while (denominator > 1 && ((cinfo.image_width + denominator - 1) / denominator < min_width ||
                             (cinfo.image_height + denominator - 1) / denominator < min_height)) {
    denominator /= 2;
  }
  cinfo.scale_num = 1;
  cinfo.scale_denom = denominator;
  cinfo.out_color_space = JCS_RGB;
  jpeg_start_decompress(&cinfo);
  uint32_t w = cinfo.output_width, h = cinfo.output_height;
  if (w == 0 || h == 0 || (uint64_t)w * h > PHOTO_DECODE_MAX_PIXELS || cinfo.output_components != 3) {
    jpeg_destroy_decompress(&cinfo);
    return NULL;
  }
  rgb = malloc((size_t)w * h * 3u);
  if (rgb == NULL) {
    jpeg_destroy_decompress(&cinfo);
    return NULL;
  }
  while (cinfo.output_scanline < h) {
    JSAMPROW row = (JSAMPROW)(rgb + (size_t)cinfo.output_scanline * w * 3u);
    jpeg_read_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  *width = w;
  *height = h;
  return rgb;
}
