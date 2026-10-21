#include <linux/fb.h>
#include <linux/input.h>
#include <stddef.h>
#include <stdio.h>
_Static_assert(sizeof(struct fb_var_screeninfo) == 160, "fb_var_screeninfo layout");
_Static_assert(offsetof(struct fb_fix_screeninfo, line_length) == (sizeof(unsigned long) == 8 ? 48 : 44), "fb_fix_screeninfo stride");
_Static_assert(sizeof(struct fb_fix_screeninfo) == (sizeof(unsigned long) == 8 ? 80 : 68), "fb_fix_screeninfo layout");
_Static_assert(sizeof(struct input_event) == sizeof(long) * 2 + 8, "input_event layout");
int main(void) { printf("kernel ABI: fb_var=%zu fb_fix=%zu event=%zu\n", sizeof(struct fb_var_screeninfo), sizeof(struct fb_fix_screeninfo), sizeof(struct input_event)); }
