#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "im2d_api/im2d.h"

typedef rga_buffer_t (*wrap_fd_fn)(int, int, int, int, int, int);
typedef IM_STATUS (*resize_fn)(const rga_buffer_t, rga_buffer_t, double, double, int, int);

struct pocket_rkrga {
    void *library;
    wrap_fd_fn wrap_fd;
    resize_fn resize;
    int src_fd;
    int dst_fd;
    void *src_map;
    void *dst_map;
    size_t src_size;
    size_t dst_size;
    int src_width;
    int src_height;
    int dst_width;
    int dst_height;
    int dst_stride_pixels;
    int dst_virtual_height;
    char error[192];
};

static char pocket_rkrga_open_error[192];

struct dma_heap_allocation_data {
    uint64_t len;
    uint32_t fd;
    uint32_t fd_flags;
    uint64_t heap_flags;
};

#define DMA_HEAP_IOCTL_ALLOC _IOWR('H', 0x0, struct dma_heap_allocation_data)
struct dma_buf_sync { uint64_t flags; };
#define DMA_BUF_SYNC_READ (1 << 0)
#define DMA_BUF_SYNC_WRITE (2 << 0)
#define DMA_BUF_SYNC_START (0 << 2)
#define DMA_BUF_SYNC_END (1 << 2)
#define DMA_BUF_IOCTL_SYNC _IOW('b', 0, struct dma_buf_sync)

static int dma_sync(int fd, uint64_t flags) {
    struct dma_buf_sync sync = { flags };
    return ioctl(fd, DMA_BUF_IOCTL_SYNC, &sync);
}

static int dma_heap_alloc(int heap, size_t length) {
    struct dma_heap_allocation_data allocation = {
        .len = length,
        .fd_flags = O_RDWR | O_CLOEXEC,
    };
    if (ioctl(heap, DMA_HEAP_IOCTL_ALLOC, &allocation) < 0)
        return -1;
    return (int)allocation.fd;
}

void *pocket_rkrga_open(const char *path) {
    struct pocket_rkrga *rga = calloc(1, sizeof(*rga));
    if (rga == NULL) {
        snprintf(pocket_rkrga_open_error, sizeof(pocket_rkrga_open_error),
                 "allocating RK RGA context failed");
        return NULL;
    }
    rga->src_fd = -1;
    rga->dst_fd = -1;
    rga->library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (rga->library == NULL) {
        snprintf(pocket_rkrga_open_error, sizeof(pocket_rkrga_open_error),
                 "dlopen(%s): %s", path, dlerror());
        free(rga);
        return NULL;
    }
    rga->wrap_fd = (wrap_fd_fn)dlsym(rga->library, "wrapbuffer_fd_t");
    rga->resize = (resize_fn)dlsym(rga->library, "imresize_t");
    if (rga->wrap_fd == NULL || rga->resize == NULL) {
        snprintf(pocket_rkrga_open_error, sizeof(pocket_rkrga_open_error),
                 "librga lacks required IM2D C symbols");
        dlclose(rga->library);
        free(rga);
        return NULL;
    }
    return rga;
}

const char *pocket_rkrga_last_open_error(void) {
    return pocket_rkrga_open_error;
}

int pocket_rkrga_prepare(void *opaque, int src_width, int src_height,
                         int dst_width, int dst_height,
                         int dst_stride_pixels, int dst_virtual_height) {
    struct pocket_rkrga *rga = opaque;
    if (src_width <= 0 || src_height <= 0 || dst_width <= 0 || dst_height <= 0 ||
        dst_stride_pixels < dst_width || dst_virtual_height < dst_height)
        return -1;
    if ((size_t)src_width > SIZE_MAX / (size_t)src_height / 4 ||
        (size_t)dst_stride_pixels > SIZE_MAX / (size_t)dst_virtual_height / 4)
        return -2;

    int heap = open("/dev/dma_heap/linux,cma", O_RDWR | O_CLOEXEC);
    if (heap < 0)
        return -3;

    rga->src_size = (size_t)src_width * (size_t)src_height * 4;
    rga->dst_size = (size_t)dst_stride_pixels * (size_t)dst_virtual_height * 4;
    rga->src_fd = dma_heap_alloc(heap, rga->src_size);
    if (rga->src_fd < 0) {
        close(heap);
        return -4;
    }
    rga->dst_fd = dma_heap_alloc(heap, rga->dst_size);
    close(heap);
    if (rga->dst_fd < 0)
        return -5;

    rga->src_map = mmap(NULL, rga->src_size, PROT_READ | PROT_WRITE,
                        MAP_SHARED, rga->src_fd, 0);
    rga->dst_map = mmap(NULL, rga->dst_size, PROT_READ | PROT_WRITE,
                        MAP_SHARED, rga->dst_fd, 0);
    if (rga->src_map == MAP_FAILED || rga->dst_map == MAP_FAILED)
        return -6;

    rga->src_width = src_width;
    rga->src_height = src_height;
    rga->dst_width = dst_width;
    rga->dst_height = dst_height;
    rga->dst_stride_pixels = dst_stride_pixels;
    rga->dst_virtual_height = dst_virtual_height;
    if (dma_sync(rga->src_fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_WRITE) < 0)
        return -7;
    return 0;
}

void *pocket_rkrga_source_address(void *opaque) {
    return ((struct pocket_rkrga *)opaque)->src_map;
}

size_t pocket_rkrga_source_size(void *opaque) {
    return ((struct pocket_rkrga *)opaque)->src_size;
}

int pocket_rkrga_present(void *opaque, void *dst_addr) {
    struct pocket_rkrga *rga = opaque;
    if (dst_addr == NULL)
        return -1;
    if (dma_sync(rga->src_fd, DMA_BUF_SYNC_END | DMA_BUF_SYNC_WRITE) < 0) {
        snprintf(rga->error, sizeof(rga->error), "ending source DMA write failed");
        return -2;
    }

    rga_buffer_t src = rga->wrap_fd(rga->src_fd, rga->src_width, rga->src_height,
                                    rga->src_width, rga->src_height,
                                    RK_FORMAT_BGRX_8888);
    rga_buffer_t dst = rga->wrap_fd(rga->dst_fd, rga->dst_width, rga->dst_height,
                                    rga->dst_stride_pixels, rga->dst_virtual_height,
                                    RK_FORMAT_BGRX_8888);
    IM_STATUS status = rga->resize(src, dst, 0.0, 0.0, INTER_NEAREST, 1);
    if (status != IM_STATUS_SUCCESS) {
        snprintf(rga->error, sizeof(rga->error), "imresize_t returned %d", status);
        dma_sync(rga->src_fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_WRITE);
        return status == 0 ? -3 : status;
    }
    if (dma_sync(rga->dst_fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_READ) < 0) {
        snprintf(rga->error, sizeof(rga->error), "starting destination DMA read failed");
        dma_sync(rga->src_fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_WRITE);
        return -4;
    }

    const size_t visible_row_bytes = (size_t)rga->dst_width * 4;
    const size_t stride_bytes = (size_t)rga->dst_stride_pixels * 4;
    for (int y = 0; y < rga->dst_height; y++) {
        memcpy((uint8_t *)dst_addr + (size_t)y * stride_bytes,
               (const uint8_t *)rga->dst_map + (size_t)y * stride_bytes,
               visible_row_bytes);
    }

    int result = 0;
    if (dma_sync(rga->dst_fd, DMA_BUF_SYNC_END | DMA_BUF_SYNC_READ) < 0) {
        snprintf(rga->error, sizeof(rga->error), "ending destination DMA read failed");
        result = -5;
    }
    if (dma_sync(rga->src_fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_WRITE) < 0) {
        snprintf(rga->error, sizeof(rga->error), "starting source DMA write failed");
        result = -6;
    }
    return result;
}

const char *pocket_rkrga_last_error(void *opaque) {
    return ((struct pocket_rkrga *)opaque)->error;
}

void pocket_rkrga_close(void *opaque) {
    struct pocket_rkrga *rga = opaque;
    if (rga == NULL)
        return;
    if (rga->src_map != NULL && rga->src_map != MAP_FAILED)
        munmap(rga->src_map, rga->src_size);
    if (rga->dst_map != NULL && rga->dst_map != MAP_FAILED)
        munmap(rga->dst_map, rga->dst_size);
    if (rga->src_fd >= 0)
        close(rga->src_fd);
    if (rga->dst_fd >= 0)
        close(rga->dst_fd);
    if (rga->library != NULL)
        dlclose(rga->library);
    free(rga);
}
