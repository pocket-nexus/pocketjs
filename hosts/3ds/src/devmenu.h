#ifndef POCKETJS_3DS_DEVMENU_H
#define POCKETJS_3DS_DEVMENU_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Host-owned development menu. While visible, its native DrawList replaces
 * the guest's auxiliary list and never enters the guest tree, HostOps, or
 * capability contract. */
bool devmenu_init(void);
void devmenu_shutdown(void);
bool devmenu_visible(void);
void devmenu_toggle(void);
void devmenu_hide(void);
void devmenu_set_notice(const char *notice);
/* One line of Pocket Link state (link_describe) for the menu to show. */
void devmenu_set_link_line(const char *line);
const uint32_t *devmenu_draw_list(size_t *length);

#endif
