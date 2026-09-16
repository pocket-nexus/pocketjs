/* Private, line-oriented worker helper. Each bounded transcript is evaluated
 * in a fresh session against a schema with user learning disabled. */
#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define SELECT 0x1000000
#define SELECT_ABSOLUTE 0x2000000
#define BROWSE_SIZE 15
/* Trackpad steps are bounded raw-input character moves. The schema navigator
 * handles syllable navigation and can wrap Left from the start of a segment. */
static void move_caret(RimeApi *api, RimeSessionId session, int direction) {
  const char *input = api->get_input(session);
  size_t length = input ? strlen(input) : 0;
  size_t caret = api->get_caret_pos(session), next = caret > length ? length : caret;
  if (direction < 0 && next) {
    do { next--; } while (next && ((unsigned char)input[next] & 0xc0) == 0x80);
  } else if (direction > 0 && next < length) {
    do { next++; } while (next < length && ((unsigned char)input[next] & 0xc0) == 0x80);
  }
  if (next != caret) api->set_caret_pos(session, next);
}
/* Rime reports a UTF-8 byte offset; the guest slices UTF-16 strings. */
static int caret_utf16(const char *s, int bytes) {
  int units = 0;
  if (s) for (int i = 0; i < bytes && s[i]; i++) {
    unsigned char c = (unsigned char)s[i];
    if ((c & 0xc0) != 0x80) units += c >= 0xf0 ? 2 : 1;
  }
  return units;
}
static void string(const char *s) {
  putchar('"');
  if (s) for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static size_t json_bytes(const char *s) {
  size_t bytes = 2;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++)
    bytes += *p < 32 ? 6 : (*p == '"' || *p == '\\') ? 2 : 1;
  return bytes;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  RimeApi *api = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = argv[1]; traits.user_data_dir = argv[1];
  traits.app_name = "rime.pocketjs"; traits.min_log_level = 2;
  api->setup(&traits); api->initialize(&traits);
  char line[2048];
  while (fgets(line, sizeof line, stdin)) {
    RimeSessionId session = api->create_session();
    if (!session || !api->select_schema(session, "pocket_pinyin")) {
      if (session) api->destroy_session(session);
      puts("{\"error\":\"Rime schema unavailable\"}"); fflush(stdout); continue;
    }
    api->set_option(session, "ascii_mode", False);
    char committed[2048] = {0};
    char *p = line;
    unsigned count = 0;
    while (*p && *p != '\n' && count++ < 128) {
      char *end; long key = strtol(p, &end, 10);
      if (end == p) break;
      p = *end == ',' ? end + 1 : end;
      if (key >= SELECT && key < SELECT + 5) api->select_candidate_on_current_page(session, (size_t)(key - SELECT));
      else if (key >= SELECT_ABSOLUTE && key < SELECT_ABSOLUTE + 512) api->select_candidate(session, (size_t)(key - SELECT_ABSOLUTE));
      else if (key == 0xff51 || key == 0xff53) move_caret(api, session, key == 0xff51 ? -1 : 1);
      else api->process_key(session, (int)key, 0);
      RIME_STRUCT(RimeCommit, commit);
      if (api->get_commit(session, &commit)) {
        if (commit.text && strlen(committed) + strlen(commit.text) < sizeof committed) strcat(committed, commit.text);
        api->free_commit(&commit);
      }
    }
    /* A read-only candidate window follows the transcript after ';'. It never
     * becomes a key action, changes composition, or consumes replay capacity. */
    if (*p == ';') {
      int offset = atoi(p + 1), n = 0, more = 0; size_t bytes = 128;
      RimeCandidateListIterator it = {0};
      printf("{\"offset\":%d,\"candidates\":[", offset);
      if (offset >= 0 && offset < 512 && api->candidate_list_from_index(session, &it, offset)) {
        while (api->candidate_list_next(&it)) {
          size_t item_bytes = json_bytes(it.candidate.text);
          if (n == BROWSE_SIZE || offset + n >= 512 || (n && bytes + item_bytes > 2500)) { more = offset + n < 512; break; }
          bytes += item_bytes + 1;
          if (n++) putchar(','); string(it.candidate.text);
        }
        api->candidate_list_end(&it);
      }
      printf("],\"last\":%s}\n", more ? "false" : "true"); fflush(stdout);
      api->destroy_session(session); continue;
    }
    RIME_STRUCT(RimeContext, ctx);
    int has = api->get_context(session, &ctx);
    printf("{\"commit\":"); string(committed);
    printf(",\"preedit\":"); string(has ? ctx.composition.preedit : "");
    const char *raw = api->get_input(session);
    printf(",\"raw\":"); string(raw);
    printf(",\"rawCaret\":%d", caret_utf16(raw, (int)api->get_caret_pos(session)));
    printf(",\"caret\":%d,\"page\":%d,\"last\":%s,\"candidates\":[",
      has ? caret_utf16(ctx.composition.preedit, ctx.composition.cursor_pos) : 0, has ? ctx.menu.page_no : 0, !has || ctx.menu.is_last_page ? "true" : "false");
    if (has) for (int i = 0; i < ctx.menu.num_candidates && i < 5; i++) {
      if (i) putchar(','); string(ctx.menu.candidates[i].text);
    }
    puts("]}"); fflush(stdout);
    if (has) api->free_context(&ctx);
    api->destroy_session(session);
  }
  api->finalize(); return 0;
}
