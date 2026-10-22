/* iOS 6 MobileInstallation bridge. Runs as root over the pinned USB SSH
 * transport; application binaries remain ordinary, sandboxed User apps.
 * Like the legacy host, this uses runtime messaging to avoid modern ObjC
 * metadata in the historical ARMv7 linker. No installation cache is edited. */
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

typedef void *id;
typedef void *SEL;
extern id objc_getClass(const char *name);
extern SEL sel_registerName(const char *name);
extern void *objc_msgSend(void);

static id send0(id object, const char *selector) {
  return ((id (*)(id, SEL))objc_msgSend)(object, sel_registerName(selector));
}
static id send1(id object, const char *selector, id value) {
  return ((id (*)(id, SEL, id))objc_msgSend)(object, sel_registerName(selector), value);
}
static id string(const char *value) {
  return send1(objc_getClass("NSString"), "stringWithUTF8String:", (id)value);
}
static const char *utf8(id value) {
  return value ? (const char *)send0(value, "UTF8String") : "";
}
static id get(id object, const char *key) {
  return send1(object, "objectForKey:", string(key));
}
static int identifier_valid(const char *value) {
  if (!value[0] || value[0] == '.' || strlen(value) > 200) return 0;
  for (const char *c = value; *c; ++c)
    if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
          (*c >= '0' && *c <= '9') || *c == '.' || *c == '-')) return 0;
  return strchr(value, '.') != NULL && strstr(value, "..") == NULL;
}
static id lookup(const char *identifier, const char *type) {
  id cache = send1(objc_getClass("NSDictionary"), "dictionaryWithContentsOfFile:",
    string("/var/mobile/Library/Caches/com.apple.mobile.installation.plist"));
  return get(get(cache, type), identifier);
}
static id user_record(const char *identifier) {
  id record = lookup(identifier, "User");
  const char *path = utf8(get(record, "Path"));
  const char *container = utf8(get(record, "Container"));
  const char *prefix = "/private/var/mobile/Applications/";
  if (strncmp(container, prefix, strlen(prefix)) != 0) prefix = "/var/mobile/Applications/";
  if (strcmp(utf8(get(record, "ApplicationType")), "User") ||
      strcmp(utf8(get(record, "CFBundleIdentifier")), identifier) ||
      strncmp(container, prefix, strlen(prefix)) ||
      strlen(container) != strlen(prefix) + 36 || strstr(path, "/../") ||
      strncmp(path, container, strlen(container)) || path[strlen(container)] != '/' ||
      !path[strlen(container) + 1] || strchr(path + strlen(container) + 1, '/')) return NULL;
  const char *uuid = container + strlen(prefix);
  for (unsigned i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (uuid[i] != '-') return NULL; }
    else if (!((uuid[i] >= '0' && uuid[i] <= '9') || (uuid[i] >= 'a' && uuid[i] <= 'f') ||
               (uuid[i] >= 'A' && uuid[i] <= 'F'))) return NULL;
  }
  return record;
}
static void progress(id info, void *context) {
  (void)context;
  if (get(info, "Error")) fprintf(stderr, "%s\n", utf8(send0(info, "description")));
}
/* Migration refreshes the global System map, so all apps share one lock. */
static int acquire_lock(void) {
  int fd = open("/var/root/Library/PocketJS/deployment.lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB)) {
    perror("deployment busy (or lock unavailable)"); return -1;
  }
  return fd;
}
int main(int argc, char **argv) {
  if (argc < 3 || getuid() != 0) {
    fprintf(stderr, "usage (root): installer lookup|user-path|install|uninstall|bundle-id <value>; lock <id> <script>\n");
    return 2;
  }
  if (!strcmp(argv[1], "lock")) {
    if (argc != 4 || !identifier_valid(argv[2])) return 2;
    if (acquire_lock() < 0) return 73;
    /* No CLOEXEC: the shell keeps the kernel lock through install/readback.
     * Process exit releases it, including transport loss; no stale lease. */
    execl("/bin/sh", "sh", argv[3], (char *)NULL);
    perror("exec deployment"); return 1;
  }
  if (!strcmp(argv[1], "uninstall")) {
    if (!identifier_valid(argv[2])) return 2;
    if (acquire_lock() < 0) return 73;
  }
  id pool = send0(send0(objc_getClass("NSAutoreleasePool"), "alloc"), "init");
  int result = 1;
  if (!strcmp(argv[1], "ready")) {
    void *library = dlopen("/System/Library/PrivateFrameworks/MobileInstallation.framework/MobileInstallation", RTLD_NOW);
    id (*lookup_apps)(id) = library ? dlsym(library, "MobileInstallationLookup") : NULL;
    result = !lookup_apps || !lookup_apps(NULL);
  } else if (!strcmp(argv[1], "bundle-id")) {
    char path[4096];
    if (snprintf(path, sizeof(path), "%s/Info.plist", argv[2]) >= (int)sizeof(path)) return 2;
    id info = send1(objc_getClass("NSDictionary"), "dictionaryWithContentsOfFile:", string(path));
    const char *identifier = utf8(get(info, "CFBundleIdentifier"));
    if (*identifier) { puts(identifier); result = 0; }
  } else if (!strcmp(argv[1], "lookup") && identifier_valid(argv[2])) {
    id record = lookup(argv[2], "User");
    if (!record) record = lookup(argv[2], "System");
    if (!record) { puts("null"); result = 0; }
    else {
      id summary = send0(objc_getClass("NSMutableDictionary"), "dictionary");
      const char *keys[] = {"CFBundleIdentifier", "ApplicationType", "Path", "Container"};
      for (unsigned i = 0; i < 4; ++i) {
        id value = get(record, keys[i]);
        if (value) ((void (*)(id, SEL, id, id))objc_msgSend)(summary, sel_registerName("setObject:forKey:"), value, string(keys[i]));
      }
      id data = ((id (*)(id, SEL, id, unsigned long, id))objc_msgSend)(
        objc_getClass("NSJSONSerialization"), sel_registerName("dataWithJSONObject:options:error:"), summary, 0, NULL);
      if (data) {
        unsigned long length = ((unsigned long (*)(id, SEL))objc_msgSend)(data, sel_registerName("length"));
        fwrite(send0(data, "bytes"), 1, length, stdout); putchar('\n'); result = 0;
      }
    }
  } else if (!strcmp(argv[1], "user-path") && identifier_valid(argv[2])) {
    id record = user_record(argv[2]);
    if (record) { puts(utf8(get(record, "Path"))); result = 0; }
  } else if (!strcmp(argv[1], "install") || !strcmp(argv[1], "uninstall")) {
    void *library = dlopen("/System/Library/PrivateFrameworks/MobileInstallation.framework/MobileInstallation", RTLD_NOW);
    if (library) {
      id options = ((id (*)(id, SEL, id, id))objc_msgSend)(objc_getClass("NSDictionary"),
        sel_registerName("dictionaryWithObject:forKey:"), string("User"), string("ApplicationType"));
      if (!strcmp(argv[1], "install")) {
        int (*install)(id, id, void (*)(id, void *), id) = dlsym(library, "MobileInstallationInstall");
        if (install) result = install(string(argv[2]), options, progress, string(argv[2])) != 0;
      } else if (identifier_valid(argv[2]) && user_record(argv[2])) {
        int (*uninstall)(id, id, void (*)(id, void *)) = dlsym(library, "MobileInstallationUninstall");
        if (uninstall) result = uninstall(string(argv[2]), options, progress) != 0;
      }
    }
  }
  if (result) fprintf(stderr, "MobileInstallation %s failed\n", argv[1]);
  send0(pool, "drain");
  return result;
}
