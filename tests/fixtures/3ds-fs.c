/* Native harness for hosts/3ds/src/fs.c (tests/fs-3ds.test.ts).
 *
 * Reads one command a line from stdin and prints "<result>\t<lastError>" for
 * each. Strings travel hex-encoded so any bytes survive the line format:
 *
 *   bind <root-hex> <temp-hex> <quota>    hooks <no-replace> <crash-after-unlink>
 *   read <path-hex> <offset> <max>        write <path-hex> <data-hex> <mode>
 *   remove <path-hex> <recursive>         list <path-hex> <offset>
 *   stat <path-hex>   mkdir <path-hex>    rename <from-hex> <to-hex>
 *   usage             unbind              quota <plan-hex> */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../hosts/3ds/src/fs.h"

extern int fs_test_no_replace;
extern int fs_test_crash_after_unlink;

static size_t unhex(const char *hex, char *out) {
  size_t length = strlen(hex) / 2;
  for (size_t i = 0; i < length; i += 1) {
    unsigned value = 0;
    sscanf(hex + i * 2, "%2x", &value);
    out[i] = (char)value;
  }
  out[length] = '\0';
  return length;
}

int main(void) {
  static char input[1 << 20];
  static char a[1 << 19];
  static char b[1 << 19];
  while (fgets(input, sizeof input, stdin) != NULL) {
    input[strcspn(input, "\n")] = '\0';
    char *op = strtok(input, " ");
    if (op == NULL) continue;
    char *x = strtok(NULL, " ");
    char *y = strtok(NULL, " ");
    char *z = strtok(NULL, " ");
    size_t al = x != NULL ? unhex(x, a) : 0;
    if (strcmp(op, "bind") == 0) {
      unhex(y, b);
      printf("%d\t\n", fs_bind(a, b, strtoull(z, NULL, 10)) ? 1 : 0);
    } else if (strcmp(op, "hooks") == 0) {
      fs_test_no_replace = atoi(x);
      fs_test_crash_after_unlink = atoi(y);
      printf("0\t\n");
    } else if (strcmp(op, "unbind") == 0) {
      fs_unbind();
      printf("0\t\n");
    } else if (strcmp(op, "quota") == 0) {
      printf("%llu\t\n", (unsigned long long)fs_plan_quota(a, al));
    } else if (strcmp(op, "read") == 0) {
      const char *r = fs_read(a, al, atof(y), atof(z));
      printf("%s\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "write") == 0) {
      size_t bl = unhex(y, b);
      int r = fs_write(a, al, b, bl, atoi(z));
      printf("%d\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "remove") == 0) {
      int r = fs_remove(a, al, atoi(y));
      printf("%d\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "list") == 0) {
      const char *r = fs_list(a, al, atof(y));
      printf("%s\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "stat") == 0) {
      const char *r = fs_stat(a, al);
      printf("%s\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "mkdir") == 0) {
      int r = fs_mkdir(a, al);
      printf("%d\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "rename") == 0) {
      size_t bl = unhex(y, b);
      int r = fs_rename(a, al, b, bl);
      printf("%d\t%s\n", r, fs_last_error());
    } else if (strcmp(op, "usage") == 0) {
      const char *r = fs_usage();
      printf("%s\t%s\n", r, fs_last_error());
    } else {
      printf("?\tunknown command %s\n", op);
    }
    fflush(stdout);
  }
  fs_unbind();
  return 0;
}
