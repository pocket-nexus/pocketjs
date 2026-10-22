#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef APP_DIRECTORY
#define APP_DIRECTORY "/Applications/PocketJSDemo.app"
#endif
#ifndef STAGE_DIRECTORY
#define STAGE_DIRECTORY "/Applications/.PocketJSDemo.app.pocketjs-stage"
#endif
#ifndef BACKUP_DIRECTORY
#define BACKUP_DIRECTORY "/Applications/.PocketJSDemo.app.pocketjs-backup"
#endif
#ifndef TRANSACTION_FILE
#define TRANSACTION_FILE "/private/var/tmp/pocketjs-iphone2g.transaction"
#endif
#ifndef TRANSACTION_TEMP
#define TRANSACTION_TEMP "/private/var/tmp/pocketjs-iphone2g.transaction.new"
#endif
#ifndef ACCEPTANCE_RECORD
#define ACCEPTANCE_RECORD "/private/var/tmp/pocketjs-iphone2g.status"
#endif
#define PATH_CAPACITY 512

typedef struct {
  const char *name;
  uint64_t maximum_size;
  mode_t mode;
} BundleFile;

static const unsigned char PACKAGE_MAGIC[8] = {'P', 'J', 'S', '2', 'G', '0', '0', '3'};

#define TRANSACTION_ID_LENGTH 32

typedef struct {
  char phase;
  int had_previous;
  char identifier[TRANSACTION_ID_LENGTH + 1];
} Transaction;

static const BundleFile BUNDLE_FILES[] = {
  {"PocketJSDemo", 8U * 1024U * 1024U, 0755},
  {"Info.plist", 256U * 1024U, 0644},
  {"PkgInfo", 64U, 0644},
  {"Icon.png", 1024U * 1024U, 0644},
  {"build-receipt.json", 1024U * 1024U, 0644},
};

#define BUNDLE_FILE_COUNT (sizeof(BUNDLE_FILES) / sizeof(BUNDLE_FILES[0]))

static volatile sig_atomic_t g_interrupted;

static int set_path_owner(const char *path) {
#ifdef POCKETJS_DEVICE_TEST
  (void)path;
  return 0;
#else
  return chown(path, 0, 0);
#endif
}

static int set_descriptor_owner(int descriptor) {
#ifdef POCKETJS_DEVICE_TEST
  (void)descriptor;
  return 0;
#else
  return fchown(descriptor, 0, 0);
#endif
}

static void interrupt_handler(int signal_number) {
  g_interrupted = signal_number;
}

static void install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = interrupt_handler;
  (void)sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  (void)sigaction(SIGHUP, &action, NULL);
  (void)sigaction(SIGINT, &action, NULL);
  (void)sigaction(SIGPIPE, &action, NULL);
  (void)sigaction(SIGTERM, &action, NULL);
}

static int write_all(int descriptor, const void *bytes, size_t length) {
  const unsigned char *cursor = (const unsigned char *)bytes;
  while (length > 0) {
    if (g_interrupted) return -1;
    ssize_t written = write(descriptor, cursor, length);
    if (written < 0 && errno == EINTR && !g_interrupted) continue;
    if (written <= 0) return -1;
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int read_all(int descriptor, void *bytes, size_t length) {
  unsigned char *cursor = (unsigned char *)bytes;
  while (length > 0) {
    if (g_interrupted) return -1;
    ssize_t received = read(descriptor, cursor, length);
    if (received < 0 && errno == EINTR && !g_interrupted) continue;
    if (received <= 0) return -1;
    cursor += (size_t)received;
    length -= (size_t)received;
  }
  return 0;
}

static int joined_path(char *destination, const char *directory, const char *name) {
  int length = snprintf(destination, PATH_CAPACITY, "%s/%s", directory, name);
  return length > 0 && length < PATH_CAPACITY ? 0 : -1;
}

static const BundleFile *bundle_file_named(const char *name) {
  size_t index;
  for (index = 0; index < BUNDLE_FILE_COUNT; index += 1) {
    if (strcmp(BUNDLE_FILES[index].name, name) == 0) return &BUNDLE_FILES[index];
  }
  return NULL;
}

static int directory_is_known(const char *path) {
  DIR *directory;
  struct dirent *entry;
  struct stat status;
  char child[PATH_CAPACITY];
  size_t seen = 0;

  if (lstat(path, &status) < 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(status.st_mode)) return -1;
  directory = opendir(path);
  if (directory == NULL) return -1;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (bundle_file_named(entry->d_name) == NULL || joined_path(child, path, entry->d_name) < 0) {
      closedir(directory);
      return -1;
    }
    if (lstat(child, &status) < 0 || !S_ISREG(status.st_mode)) {
      closedir(directory);
      return -1;
    }
    seen += 1;
  }
  closedir(directory);
  return seen <= BUNDLE_FILE_COUNT ? 1 : -1;
}

static int clear_known_directory(const char *path) {
  DIR *directory;
  struct dirent *entry;
  char child[PATH_CAPACITY];
  int known = directory_is_known(path);

  if (known == 0) return 0;
  if (known < 0) return -1;
  directory = opendir(path);
  if (directory == NULL) return -1;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (joined_path(child, path, entry->d_name) < 0 || unlink(child) < 0) {
      closedir(directory);
      return -1;
    }
  }
  closedir(directory);
  return rmdir(path);
}

static int directory_is_complete(const char *path) {
  size_t index;
  char child[PATH_CAPACITY];
  struct stat status;
  if (directory_is_known(path) <= 0) return 0;
  for (index = 0; index < BUNDLE_FILE_COUNT; index += 1) {
    if (joined_path(child, path, BUNDLE_FILES[index].name) < 0 ||
        lstat(child, &status) < 0 || !S_ISREG(status.st_mode)) {
      return 0;
    }
  }
  return 1;
}

static int mount_is_read_write(const char *path) {
#ifdef POCKETJS_DEVICE_TEST
  (void)path;
  return 1;
#else
  struct statfs status;
  return statfs(path, &status) == 0 && (status.f_flags & MNT_RDONLY) == 0;
#endif
}

static int device_mounts_are_read_write(void) {
  return mount_is_read_write("/") && mount_is_read_write("/private/var");
}

static int valid_transaction_identifier(const char *identifier) {
  size_t index;
  if (identifier == NULL) return 0;
  for (index = 0; index < TRANSACTION_ID_LENGTH; index += 1) {
    char character = identifier[index];
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f'))) return 0;
  }
  return identifier[TRANSACTION_ID_LENGTH] == '\0';
}

/* 0 = absent, 1 = valid, -1 = malformed or unreadable. */
static int read_transaction_path(const char *path, Transaction *transaction) {
  unsigned char contents[36];
  int descriptor = open(path, O_RDONLY);
  ssize_t count;
  if (descriptor < 0) return errno == ENOENT ? 0 : -1;
  count = read(descriptor, contents, sizeof(contents));
  if (close(descriptor) < 0 || count != 35 || contents[34] != '\n') return -1;
  transaction->phase = (char)contents[0];
  transaction->had_previous = contents[1] == '1' ? 1 : contents[1] == '0' ? 0 : -1;
  memcpy(transaction->identifier, contents + 2, TRANSACTION_ID_LENGTH);
  transaction->identifier[TRANSACTION_ID_LENGTH] = '\0';
  if ((transaction->phase != 'L' && transaction->phase != 'P' &&
       transaction->phase != 'M' && transaction->phase != 'I' &&
       transaction->phase != 'R') ||
      transaction->had_previous < 0 ||
      (transaction->phase == 'M' && !transaction->had_previous) ||
      !valid_transaction_identifier(transaction->identifier)) return -1;
  return 1;
}

static int read_transaction(Transaction *transaction) {
  int state = read_transaction_path(TRANSACTION_FILE, transaction);
  return state == 0 ? read_transaction_path(TRANSACTION_TEMP, transaction) : state;
}

static int write_transaction(char phase, int had_previous, const char *identifier) {
  unsigned char contents[35];
  struct stat status;
  Transaction temporary;
  int descriptor;
  int result = -1;
  if ((phase != 'L' && phase != 'P' && phase != 'M' && phase != 'I' && phase != 'R') ||
      !valid_transaction_identifier(identifier)) return -1;
  if (phase == 'L') {
    contents[0] = 'L';
    contents[1] = '0';
    memcpy(contents + 2, identifier, TRANSACTION_ID_LENGTH);
    contents[34] = '\n';
    descriptor = open(TRANSACTION_FILE, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) return -1;
    if (write_all(descriptor, contents, sizeof(contents)) == 0 &&
        fchmod(descriptor, 0600) == 0 && set_descriptor_owner(descriptor) == 0 &&
        fsync(descriptor) == 0) result = 0;
    (void)close(descriptor);
    if (result == 0) {
      sync();
      return 0;
    }
    (void)unlink(TRANSACTION_FILE);
    return -1;
  }
  if (lstat(TRANSACTION_TEMP, &status) == 0) {
    if (phase == 'P' || !S_ISREG(status.st_mode) ||
        read_transaction_path(TRANSACTION_TEMP, &temporary) != 1 ||
        strcmp(temporary.identifier, identifier) != 0 || unlink(TRANSACTION_TEMP) < 0) return -1;
  } else if (errno != ENOENT) {
    return -1;
  }
  contents[0] = (unsigned char)phase;
  contents[1] = had_previous ? '1' : '0';
  memcpy(contents + 2, identifier, TRANSACTION_ID_LENGTH);
  contents[34] = '\n';
  descriptor = open(TRANSACTION_TEMP, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (descriptor < 0) return -1;
  if (write_all(descriptor, contents, sizeof(contents)) == 0 &&
      fchmod(descriptor, 0600) == 0 && set_descriptor_owner(descriptor) == 0 &&
      fsync(descriptor) == 0) result = 0;
  (void)close(descriptor);
  if (result == 0 && rename(TRANSACTION_TEMP, TRANSACTION_FILE) == 0) {
    sync();
    return 0;
  }
  (void)unlink(TRANSACTION_TEMP);
  return -1;
}

static int clear_transaction_markers(void) {
  if (unlink(TRANSACTION_FILE) < 0 && errno != ENOENT) return -1;
  if (unlink(TRANSACTION_TEMP) < 0 && errno != ENOENT) return -1;
  sync();
  return 0;
}

static int reconcile_committed_state(int *had_previous) {
  int app_known = directory_is_known(APP_DIRECTORY);
  int backup_known = directory_is_known(BACKUP_DIRECTORY);
  if (app_known < 0 || backup_known < 0) return -1;
  if (app_known > 0 && !directory_is_complete(APP_DIRECTORY)) {
    if (!directory_is_complete(BACKUP_DIRECTORY) ||
        clear_known_directory(APP_DIRECTORY) < 0 ||
        rename(BACKUP_DIRECTORY, APP_DIRECTORY) < 0) return -1;
    sync();
    app_known = 1;
    backup_known = 0;
  }
  if (app_known == 0 && backup_known > 0) {
    if (!directory_is_complete(BACKUP_DIRECTORY) ||
        rename(BACKUP_DIRECTORY, APP_DIRECTORY) < 0) return -1;
    sync();
    app_known = 1;
    backup_known = 0;
  } else if (app_known > 0 && backup_known > 0) {
    if (clear_known_directory(BACKUP_DIRECTORY) < 0) return -1;
    backup_known = 0;
  }
  if (backup_known != 0 || (app_known > 0 && !directory_is_complete(APP_DIRECTORY))) return -1;
  *had_previous = app_known > 0 ? 1 : 0;
  return 0;
}

static int rollback_transaction_mounted(const char *identifier) {
  Transaction transaction;
  int state = read_transaction(&transaction);
  int app_known;
  int backup_known;
  if (state == 0) return clear_known_directory(STAGE_DIRECTORY);
  if (state < 0 || strcmp(transaction.identifier, identifier) != 0) return -1;
  if (transaction.phase == 'L') {
    int had_previous;
    if (reconcile_committed_state(&had_previous) < 0 ||
        clear_known_directory(STAGE_DIRECTORY) < 0) return -1;
    sync();
    return 0;
  }
  if (transaction.phase != 'R' &&
      write_transaction('R', transaction.had_previous, identifier) < 0) return -1;
  app_known = directory_is_known(APP_DIRECTORY);
  backup_known = directory_is_known(BACKUP_DIRECTORY);
  if (app_known < 0 || backup_known < 0) return -1;

  if (!transaction.had_previous) {
    if (backup_known != 0 || clear_known_directory(APP_DIRECTORY) < 0) return -1;
  } else if (backup_known == 0 && directory_is_complete(APP_DIRECTORY)) {
    /* The previous app is already in place. */
  } else {
    if (!directory_is_complete(BACKUP_DIRECTORY) ||
        clear_known_directory(APP_DIRECTORY) < 0 ||
        rename(BACKUP_DIRECTORY, APP_DIRECTORY) < 0) return -1;
  }
  if (clear_known_directory(STAGE_DIRECTORY) < 0) return -1;
  sync();
  return 0;
}

static int read_u64(uint64_t *value) {
  unsigned char encoded[8];
  size_t index;
  uint64_t result = 0;
  if (read_all(STDIN_FILENO, encoded, sizeof(encoded)) < 0) return -1;
  for (index = 0; index < sizeof(encoded); index += 1) {
    result = (result << 8) | encoded[index];
  }
  *value = result;
  return 0;
}

static int receive_file(const char *directory, const BundleFile *file) {
  unsigned char buffer[16384];
  char path[PATH_CAPACITY];
  uint64_t remaining;
  int descriptor = -1;
  int result = -1;

  if (read_u64(&remaining) < 0 || remaining == 0 || remaining > file->maximum_size) return -1;
  if (joined_path(path, directory, file->name) < 0) return -1;
  descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, file->mode);
  if (descriptor < 0) return -1;
  while (remaining > 0) {
    size_t amount = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
    if (read_all(STDIN_FILENO, buffer, amount) < 0 || write_all(descriptor, buffer, amount) < 0) {
      goto done;
    }
    remaining -= amount;
  }
  if (fchmod(descriptor, file->mode) < 0 || set_descriptor_owner(descriptor) < 0 || fsync(descriptor) < 0) {
    goto done;
  }
  result = 0;

done:
  close(descriptor);
  return result;
}

static int install_bundle(void) {
  unsigned char magic[sizeof(PACKAGE_MAGIC)];
  unsigned char extra;
  char identifier[TRANSACTION_ID_LENGTH + 1];
  Transaction transaction;
  size_t index;
  int transaction_started = 0;
  int rollback_completed = 0;
  int transaction_state;
  int existing;
  int result = 1;

  if (read_all(STDIN_FILENO, magic, sizeof(magic)) < 0 ||
      memcmp(magic, PACKAGE_MAGIC, sizeof(magic)) != 0) {
    fprintf(stderr, "invalid PocketJS package header\n");
    return 2;
  }
  if (read_all(STDIN_FILENO, identifier, TRANSACTION_ID_LENGTH) < 0) {
    fprintf(stderr, "missing PocketJS transaction identifier\n");
    return 2;
  }
  identifier[TRANSACTION_ID_LENGTH] = '\0';
  if (!valid_transaction_identifier(identifier)) {
    fprintf(stderr, "invalid PocketJS transaction identifier\n");
    return 2;
  }
  transaction_state = read_transaction(&transaction);
  if (transaction_state != 0) {
    fprintf(stderr, "an unfinished PocketJS transaction requires rollback\n");
    return 3;
  }
  if (!device_mounts_are_read_write()) {
    fprintf(stderr, "iPhone OS 3.1.3 root/data mount policy is not read/write\n");
    return 3;
  }
  if (write_transaction('L', 0, identifier) < 0) {
    fprintf(stderr, "could not acquire the durable transaction lock\n");
    return 3;
  }
  transaction_started = 1;
  if (g_interrupted) goto done;
  if (reconcile_committed_state(&existing) < 0) {
    fprintf(stderr, "could not reconcile the committed app and backup state\n");
    goto done;
  }
  if (write_transaction('P', existing, identifier) < 0) {
    fprintf(stderr, "could not persist the prepared transaction phase\n");
    goto done;
  }
  if (clear_known_directory(STAGE_DIRECTORY) < 0 ||
      mkdir(STAGE_DIRECTORY, 0755) < 0 ||
      set_path_owner(STAGE_DIRECTORY) < 0) {
    fprintf(stderr, "could not prepare the scoped staging directory\n");
    goto done;
  }
  for (index = 0; index < BUNDLE_FILE_COUNT; index += 1) {
    if (receive_file(STAGE_DIRECTORY, &BUNDLE_FILES[index]) < 0) {
      fprintf(stderr, "bundle transfer failed at %s\n", BUNDLE_FILES[index].name);
      goto done;
    }
  }
  if (read(STDIN_FILENO, &extra, 1) != 0) {
    fprintf(stderr, "bundle stream has trailing bytes\n");
    goto done;
  }
  if (unlink(ACCEPTANCE_RECORD) < 0 && errno != ENOENT) {
    fprintf(stderr, "could not clear the previous runtime acceptance record\n");
    goto done;
  }
  if (existing > 0) {
    if (rename(APP_DIRECTORY, BACKUP_DIRECTORY) < 0) {
      fprintf(stderr, "could not move the previous app aside\n");
      goto done;
    }
    sync();
    if (g_interrupted || write_transaction('M', 1, identifier) < 0) {
      fprintf(stderr, "could not persist the moved-app transaction phase\n");
      goto done;
    }
  }
  if (rename(STAGE_DIRECTORY, APP_DIRECTORY) < 0) {
    fprintf(stderr, "could not commit the staged app\n");
    goto done;
  }
  sync();
  if (g_interrupted || write_transaction('I', existing, identifier) < 0) {
    fprintf(stderr, "could not persist the installed-app transaction phase\n");
    goto done;
  }
  result = 0;

done:
  if (result != 0 && transaction_started) {
    if (rollback_transaction_mounted(identifier) < 0) {
      fprintf(stderr, "automatic transaction rollback failed\n");
    } else {
      rollback_completed = 1;
    }
  } else if (!transaction_started) {
    (void)clear_known_directory(STAGE_DIRECTORY);
  }
  sync();
  if (!device_mounts_are_read_write()) {
    fprintf(stderr, "iPhone OS 3.1.3 root/data mount policy changed\n");
    return 4;
  }
  if (rollback_completed && clear_transaction_markers() < 0) {
    fprintf(stderr, "rolled back, but could not clear the durable transaction marker\n");
    return 5;
  }
  if (result == 0) printf("installed=PocketJSDemo.app\ntransaction=pending\nmount_policy=rw-root-data\n");
  return result;
}

static int commit_bundle(const char *identifier) {
  Transaction transaction;
  int state;
  int backup_known;
  if (!valid_transaction_identifier(identifier)) return 2;
  state = read_transaction(&transaction);
  backup_known = directory_is_known(BACKUP_DIRECTORY);
  if (state != 1 || strcmp(transaction.identifier, identifier) != 0 ||
      transaction.phase != 'I' || backup_known < 0 ||
      ((!transaction.had_previous && backup_known != 0) ||
       (transaction.had_previous && !directory_is_complete(BACKUP_DIRECTORY))) ||
      !directory_is_complete(APP_DIRECTORY)) return 1;
  if (!device_mounts_are_read_write()) return 3;
  if (g_interrupted) return 4;
  if (clear_transaction_markers() < 0) return 1;
  printf("committed=PocketJSDemo.app\nmount_policy=rw-root-data\n");
  return 0;
}

static int rollback_bundle(const char *identifier) {
  Transaction transaction;
  int state;
  int result;
  if (!valid_transaction_identifier(identifier)) return 2;
  state = read_transaction(&transaction);
  if (state < 0 || (state == 1 && strcmp(transaction.identifier, identifier) != 0)) return 1;
  if (state == 0) {
    if (!device_mounts_are_read_write()) return 3;
    printf("rollback=not-needed\nmount_policy=rw-root-data\n");
    return 0;
  }
  if (!device_mounts_are_read_write()) return 2;
  result = rollback_transaction_mounted(identifier) < 0 ? 1 : 0;
  if (!device_mounts_are_read_write()) return 3;
  if (result == 0 && clear_transaction_markers() < 0) {
    result = 1;
  }
  if (result == 0) printf("rollback=complete\nmount_policy=rw-root-data\n");
  return result;
}

static int clear_acceptance_record(void) {
  if (unlink(ACCEPTANCE_RECORD) < 0 && errno != ENOENT) return 1;
  printf("acceptance_record=cleared\n");
  return 0;
}

static int print_transaction_state(void) {
  Transaction transaction;
  int state = read_transaction(&transaction);
  if (state < 0) return 1;
  if (state == 0) {
    printf("state=none\n");
  } else {
    printf(
      "state=pending\nphase=%c\nhad_previous=%d\nid=%s\n",
      transaction.phase,
      transaction.had_previous,
      transaction.identifier
    );
  }
  return 0;
}

static int stream_file(const char *path) {
  unsigned char buffer[16384];
  int descriptor = open(path, O_RDONLY);
  if (descriptor < 0) return 1;
  for (;;) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR && !g_interrupted) continue;
    if (count < 0 || (count > 0 && write_all(STDOUT_FILENO, buffer, (size_t)count) < 0)) {
      close(descriptor);
      return 1;
    }
    if (count == 0) break;
  }
  close(descriptor);
  return 0;
}

static int read_bundle_file(const char *name) {
  char path[PATH_CAPACITY];
  if (bundle_file_named(name) == NULL || joined_path(path, APP_DIRECTORY, name) < 0) return 2;
  return stream_file(path);
}

static int remove_bundle(void) {
  Transaction transaction;
  int result;
  if (!device_mounts_are_read_write()) return 2;
  if (read_transaction(&transaction) != 0) {
    result = 1;
  } else {
    result = clear_known_directory(APP_DIRECTORY) < 0 ||
      clear_known_directory(STAGE_DIRECTORY) < 0 ||
      clear_known_directory(BACKUP_DIRECTORY) < 0 ? 1 : 0;
  }
  sync();
  if (!device_mounts_are_read_write()) return 3;
  if (result == 0 && unlink(ACCEPTANCE_RECORD) < 0 && errno != ENOENT) result = 1;
  if (result == 0) printf("removed=PocketJSDemo.app\nmount_policy=rw-root-data\n");
  return result;
}

int main(int argc, char **argv) {
  install_signal_handlers();
  if (argc == 2 && strcmp(argv[1], "install") == 0) return install_bundle();
  if (argc == 3 && strcmp(argv[1], "commit") == 0) return commit_bundle(argv[2]);
  if (argc == 3 && strcmp(argv[1], "rollback") == 0) return rollback_bundle(argv[2]);
  if (argc == 3 && strcmp(argv[1], "read") == 0) return read_bundle_file(argv[2]);
  if (argc == 2 && strcmp(argv[1], "self") == 0) {
    return stream_file("/usr/libexec/pocketjs-device");
  }
  if (argc == 2 && strcmp(argv[1], "mount-state") == 0) {
    if (!device_mounts_are_read_write()) return 1;
    printf("root_readwrite=1\ndata_readwrite=1\n");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "status") == 0) return stream_file(ACCEPTANCE_RECORD);
  if (argc == 2 && strcmp(argv[1], "transaction-state") == 0) return print_transaction_state();
  if (argc == 2 && strcmp(argv[1], "clear-status") == 0) return clear_acceptance_record();
  if (argc == 2 && strcmp(argv[1], "remove") == 0) return remove_bundle();
  if (argc == 2 && strcmp(argv[1], "version") == 0) {
    printf("pocketjs-iphone2g-device 4\n");
    return 0;
  }
  fprintf(stderr, "usage: pocketjs-device <install|commit ID|rollback ID|read NAME|self|mount-state|transaction-state|status|clear-status|remove|version>\n");
  return 64;
}
