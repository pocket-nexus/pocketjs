/* Pocket Link wire facts — see link_proto.h. */

#include "link_proto.h"

#include <string.h>

#include "sha256.h"

bool link_valid_id(const char *text, size_t length) {
  if (text == NULL || length != LINK_ID_HEX) return false;
  for (size_t i = 0; i < length; i += 1) {
    char c = text[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

/* Dotted-quad IPv4 with each part 0..255. */
static bool valid_ipv4(const char *text, size_t length) {
  if (length == 0 || length > 15) return false;
  unsigned parts = 0;
  unsigned value = 0;
  unsigned digits = 0;
  for (size_t i = 0; i <= length; i += 1) {
    if (i == length || text[i] == '.') {
      if (digits == 0 || value > 255) return false;
      parts += 1;
      value = 0;
      digits = 0;
      continue;
    }
    if (text[i] < '0' || text[i] > '9' || digits == 3) return false;
    value = value * 10 + (unsigned)(text[i] - '0');
    digits += 1;
  }
  return parts == 4;
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Percent-decode (and '+' as space) into out; false when it does not fit. */
static bool percent_decode(const char *text, size_t length, char *out, size_t capacity) {
  size_t used = 0;
  for (size_t i = 0; i < length; i += 1) {
    char c = text[i];
    if (c == '%') {
      if (i + 2 >= length) return false;
      int high = hex_nibble(text[i + 1]);
      int low = hex_nibble(text[i + 2]);
      if (high < 0 || low < 0) return false;
      c = (char)((high << 4) | low);
      i += 2;
    } else if (c == '+') {
      c = ' ';
    }
    if (c == '\0' || used + 1 >= capacity) return false;
    out[used++] = c;
  }
  out[used] = '\0';
  return true;
}

bool link_parse_pair_uri(const char *uri, size_t length, LinkPairUri *out) {
  static const char SCHEME[] = "pocketlink://pair?";
  if (uri == NULL || out == NULL || length > 512) return false;
  memset(out, 0, sizeof *out);
  /* Codes are often trailed by whitespace from a scanner. */
  while (length > 0 && (uri[length - 1] == '\n' || uri[length - 1] == '\r' || uri[length - 1] == ' ')) {
    length -= 1;
  }
  if (length < sizeof SCHEME - 1 || memcmp(uri, SCHEME, sizeof SCHEME - 1) != 0) return false;
  bool have_version = false, have_secret = false;
  size_t at = sizeof SCHEME - 1;
  while (at < length) {
    size_t end = at;
    while (end < length && uri[end] != '&') end += 1;
    const char *pair = uri + at;
    size_t pair_length = end - at;
    const char *equals = memchr(pair, '=', pair_length);
    if (equals != NULL && equals - pair == 1) {
      const char *value = equals + 1;
      size_t value_length = pair_length - 2;
      switch (pair[0]) {
        case 'v':
          if (value_length != 1 || value[0] != '1') return false;
          have_version = true;
          break;
        case 'c':
          if (!link_valid_id(value, value_length)) return false;
          memcpy(out->companion, value, LINK_ID_HEX);
          out->companion[LINK_ID_HEX] = '\0';
          break;
        case 'h': {
          size_t host_at = 0;
          while (host_at <= value_length && out->host_count < LINK_PAIR_MAX_HOSTS) {
            size_t host_end = host_at;
            while (host_end < value_length && value[host_end] != ',') host_end += 1;
            /* `,` may arrive percent-encoded from a strict encoder. */
            size_t host_length = host_end - host_at;
            if (valid_ipv4(value + host_at, host_length)) {
              memcpy(out->hosts[out->host_count], value + host_at, host_length);
              out->hosts[out->host_count][host_length] = '\0';
              out->host_count += 1;
            } else if (host_length > 0) {
              char decoded[64];
              if (!percent_decode(value + host_at, host_length, decoded, sizeof decoded)) return false;
              /* Split the decoded list again. */
              char *cursor = decoded;
              while (*cursor != '\0' && out->host_count < LINK_PAIR_MAX_HOSTS) {
                char *comma = strchr(cursor, ',');
                size_t part = comma == NULL ? strlen(cursor) : (size_t)(comma - cursor);
                if (!valid_ipv4(cursor, part)) return false;
                memcpy(out->hosts[out->host_count], cursor, part);
                out->hosts[out->host_count][part] = '\0';
                out->host_count += 1;
                if (comma == NULL) break;
                cursor = comma + 1;
              }
            }
            host_at = host_end + 1;
          }
          break;
        }
        case 'p': {
          unsigned port = 0;
          if (value_length == 0 || value_length > 5) return false;
          for (size_t i = 0; i < value_length; i += 1) {
            if (value[i] < '0' || value[i] > '9') return false;
            port = port * 10 + (unsigned)(value[i] - '0');
          }
          if (port == 0 || port > 65535) return false;
          out->port = (uint16_t)port;
          break;
        }
        case 's':
          if (!hex_decode(value, value_length, out->secret, LINK_PAIR_SECRET_BYTES)) return false;
          have_secret = true;
          break;
        case 'n':
          if (!percent_decode(value, value_length, out->name, sizeof out->name)) return false;
          break;
        default:
          break; /* unknown parameters are ignored */
      }
    }
    at = end + 1;
  }
  return have_version && have_secret && out->companion[0] != '\0' && out->host_count > 0 && out->port != 0;
}

bool link_parse_beacon(const uint8_t *datagram, size_t length, LinkBeacon *out) {
  if (datagram == NULL || out == NULL || length < LINK_BEACON_BYTES) return false;
  if (link_read_u32(datagram) != LINK_BEACON_MAGIC || datagram[4] != LINK_VERSION) return false;
  memset(out, 0, sizeof *out);
  out->flags = datagram[5];
  out->port = (uint16_t)(datagram[6] | (datagram[7] << 8));
  if (out->port == 0) return false;
  if (!link_valid_id((const char *)datagram + 8, LINK_ID_HEX)) return false;
  memcpy(out->companion, datagram + 8, LINK_ID_HEX);
  size_t name_length = 0;
  while (name_length < LINK_BEACON_NAME_BYTES && datagram[24 + name_length] != 0) name_length += 1;
  memcpy(out->name, datagram + 24, name_length);
  out->name[name_length] = '\0';
  return true;
}

void link_write_preamble(uint8_t out[LINK_PREAMBLE_BYTES]) {
  link_write_u32(out, LINK_MAGIC);
  out[4] = LINK_VERSION;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
}

void link_write_header(uint8_t out[LINK_HEADER_BYTES], uint8_t type, uint32_t length) {
  out[0] = type;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  link_write_u32(out + 4, length);
}

static void update_text(HmacSha256 *hmac, const char *text) {
  hmac_sha256_update(hmac, text, strlen(text));
}

void link_proof(
  const uint8_t *secret,
  size_t secret_length,
  const char *label,
  const char *device_nonce,
  const char *companion_nonce,
  const char *device,
  const char *companion,
  uint8_t out[32]
) {
  HmacSha256 hmac;
  hmac_sha256_init(&hmac, secret, secret_length);
  update_text(&hmac, label);
  update_text(&hmac, "\n");
  update_text(&hmac, device_nonce);
  update_text(&hmac, "\n");
  update_text(&hmac, companion_nonce);
  update_text(&hmac, "\n");
  update_text(&hmac, device);
  update_text(&hmac, "\n");
  update_text(&hmac, companion);
  hmac_sha256_final(&hmac, out);
}

void link_key_mask(
  const uint8_t *secret,
  size_t secret_length,
  const char *device_nonce,
  const char *companion_nonce,
  uint8_t out[32]
) {
  HmacSha256 hmac;
  hmac_sha256_init(&hmac, secret, secret_length);
  update_text(&hmac, LINK_LABEL_KEY);
  update_text(&hmac, "\n");
  update_text(&hmac, device_nonce);
  update_text(&hmac, "\n");
  update_text(&hmac, companion_nonce);
  hmac_sha256_final(&hmac, out);
}
