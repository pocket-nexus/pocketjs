/* vapor/test/harness/mgba_runner.c — headless GBA scenario driver on
 * libmgba (Homebrew). Pocket Static lineage, plus a hex block-dump command
 * for reading the Pocket Vapor debug block (text grid + state) in one line.
 *
 *   mgba_runner <rom> <scenario.txt>
 *
 * Scenario: one command per line:
 *   A <frames>                       advance
 *   P <keymask-hex> <hold> <release> press keys, run hold frames, release,
 *                                    run release frames
 *   R <name> <addr-hex> <size>       read 1/2/4 bytes little-endian
 *   D <name> <addr-hex> <len>        read len bytes, emit as hex string
 *   S <path>                         screenshot (PPM P6)
 *   K <keymask-hex>                  set held keys (no frames run)
 *   M <frames> <prefix>              movie: run n frames, dumping every one
 *                                    as <prefix>NNNNN.ppm (for video capture)
 * Output: one JSON object on stdout: {"ok":true,"reads":{...}}.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>

/* stdout carries the JSON protocol: route mgba's logging to nowhere */
static void log_null(struct mLogger *logger, int category, enum mLogLevel level,
                     const char *format, va_list args) {
  (void)logger;
  (void)category;
  (void)level;
  (void)format;
  (void)args;
}
static struct mLogger nullLogger = { .log = log_null };

static struct mCore *core;
static uint32_t *videoBuffer;
static unsigned vw, vh;

static void run_frames(int n) {
  int i;
  for (i = 0; i < n; i++) core->runFrame(core);
}

static void screenshot(const char *path) {
  FILE *f = fopen(path, "wb");
  unsigned x, y;
  if (!f) return;
  fprintf(f, "P6\n%u %u\n255\n", vw, vh);
  for (y = 0; y < vh; y++) {
    for (x = 0; x < vw; x++) {
      uint32_t p = videoBuffer[y * vw + x];
      unsigned char rgb[3];
      rgb[0] = p & 0xff;
      rgb[1] = (p >> 8) & 0xff;
      rgb[2] = (p >> 16) & 0xff;
      fwrite(rgb, 1, 3, f);
    }
  }
  fclose(f);
}

int main(int argc, char **argv) {
  FILE *sc;
  char line[1024];
  int first_read = 1;

  if (argc != 3) {
    fprintf(stderr, "usage: mgba_runner <rom> <scenario.txt>\n");
    return 2;
  }

  mLogSetDefaultLogger(&nullLogger);
  core = mCoreFind(argv[1]);
  if (!core) {
    printf("{\"ok\":false,\"error\":\"no core for rom\"}\n");
    return 1;
  }
  core->init(core);
  mCoreConfigInit(&core->config, "mgba_runner");
  mCoreConfigSetDefaultValue(&core->config, "idleOptimization", "ignore");
  core->loadConfig(core, &core->config);

  core->desiredVideoDimensions(core, &vw, &vh);
  videoBuffer = malloc((size_t)vw * vh * 4);
  core->setVideoBuffer(core, (color_t *)videoBuffer, vw);
  core->setAudioBufferSize(core, 0x4000);

  if (!mCoreLoadFile(core, argv[1])) {
    printf("{\"ok\":false,\"error\":\"rom load failed\"}\n");
    return 1;
  }
  core->reset(core);

  sc = fopen(argv[2], "r");
  if (!sc) {
    printf("{\"ok\":false,\"error\":\"scenario open failed\"}\n");
    return 1;
  }

  printf("{\"ok\":true,\"reads\":{");
  while (fgets(line, sizeof line, sc)) {
    char op = line[0];
    if (op == 'A') {
      int n = 0;
      sscanf(line + 1, "%d", &n);
      run_frames(n);
    } else if (op == 'P') {
      unsigned mask = 0;
      int hold = 0, release = 0;
      sscanf(line + 1, "%x %d %d", &mask, &hold, &release);
      core->setKeys(core, mask);
      run_frames(hold);
      core->setKeys(core, 0);
      run_frames(release);
    } else if (op == 'R') {
      char name[256];
      unsigned addr = 0;
      int size = 1;
      uint32_t v = 0;
      sscanf(line + 1, "%255s %x %d", name, &addr, &size);
      v = core->busRead8(core, addr);
      if (size >= 2) v |= (uint32_t)core->busRead8(core, addr + 1) << 8;
      if (size == 4) {
        v |= (uint32_t)core->busRead8(core, addr + 2) << 16;
        v |= (uint32_t)core->busRead8(core, addr + 3) << 24;
      }
      printf("%s\"%s\":%u", first_read ? "" : ",", name, v);
      first_read = 0;
    } else if (op == 'D') {
      char name[256];
      unsigned addr = 0;
      int len = 0, i;
      sscanf(line + 1, "%255s %x %d", name, &addr, &len);
      printf("%s\"%s\":\"", first_read ? "" : ",", name);
      for (i = 0; i < len; i++) printf("%02x", core->busRead8(core, addr + (unsigned)i));
      printf("\"");
      first_read = 0;
    } else if (op == 'S') {
      char path[512];
      sscanf(line + 1, "%511s", path);
      screenshot(path);
    } else if (op == 'K') {
      unsigned mask = 0;
      sscanf(line + 1, "%x", &mask);
      core->setKeys(core, mask);
    } else if (op == 'M') {
      char prefix[400];
      char path[512];
      int n = 0, i;
      static int movie_at = 0;
      sscanf(line + 1, "%d %399s", &n, prefix);
      for (i = 0; i < n; i++) {
        core->runFrame(core);
        snprintf(path, sizeof path, "%s%05d.ppm", prefix, movie_at++);
        screenshot(path);
      }
    }
  }
  printf("}}\n");
  fclose(sc);
  core->deinit(core);
  return 0;
}
