/* Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/pocketjs_rt_compat.c
 * HyperRAM ≈ SPIRAM heap_caps + strong memcmp for Rust damage tracker.
 */

#include <rtthread.h>
#include <stdint.h>

#include "esp_heap_caps.h"

#if defined(BSP_USING_HYPERAM) && defined(RT_USING_MEMHEAP_AS_HEAP)
extern struct rt_memheap *drv_hyperam_get_memheap(void);

static void *pocketjs_hyperam_alloc(size_t size)
{
    struct rt_memheap *heap = drv_hyperam_get_memheap();

    return heap == RT_NULL ? RT_NULL : rt_memheap_alloc(heap, size);
}

static rt_bool_t pocketjs_is_hyperam_pointer(const void *pointer)
{
    const uintptr_t address = (uintptr_t)pointer;
    const uintptr_t start = 0x64400000UL;
    const uintptr_t end = start + BSP_USING_HYPERAM_SIZE;

    return (address >= start) && (address < end);
}
#endif

static size_t pocketjs_alignment(size_t alignment)
{
    if (alignment < sizeof(void *))
    {
        alignment = sizeof(void *);
    }
    return alignment;
}

void *heap_caps_malloc(size_t size, unsigned int caps)
{
    void *pointer;

    if (size == 0U)
    {
        return RT_NULL;
    }

#if defined(BSP_USING_HYPERAM) && defined(RT_USING_MEMHEAP_AS_HEAP)
    if ((caps & MALLOC_CAP_SPIRAM) != 0U)
    {
        pointer = pocketjs_hyperam_alloc(size);
        if (pointer != RT_NULL)
        {
            return pointer;
        }
    }
#else
    (void)caps;
#endif

    return rt_malloc_align(size, RT_ALIGN_SIZE);
}

void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned int caps)
{
    void *pointer;

    if ((size == 0U) || (alignment == 0U) ||
        ((alignment & (alignment - 1U)) != 0U))
    {
        return RT_NULL;
    }
#if defined(BSP_USING_HYPERAM) && defined(RT_USING_MEMHEAP_AS_HEAP)
    /* rt_memheap_alloc provides the RT-Thread natural alignment. Rust's UI
     * core only routes layouts up to that boundary here; larger layouts keep
     * using the system aligned allocator below. */
    if (((caps & MALLOC_CAP_SPIRAM) != 0U) && (alignment <= RT_ALIGN_SIZE))
    {
        pointer = pocketjs_hyperam_alloc(size);
        if (pointer != RT_NULL)
        {
            return pointer;
        }
    }
#else
    (void)caps;
#endif
    return rt_malloc_align(size, pocketjs_alignment(alignment));
}

void heap_caps_free(void *pointer)
{
    if (pointer != RT_NULL)
    {
#if defined(BSP_USING_HYPERAM) && defined(RT_USING_MEMHEAP_AS_HEAP)
        if (pocketjs_is_hyperam_pointer(pointer))
        {
            rt_memheap_free(pointer);
            return;
        }
#endif
        rt_free_align(pointer);
    }
}

/* The Rust static libraries carry a weak byte-at-a-time memcmp (the damage
 * tracker compares whole scene buffers with it every frame). Provide a strong
 * word-at-a-time version; the linker prefers it over the weak definition. */
__attribute__((optimize("no-tree-loop-distribute-patterns")))
int memcmp(const void *left, const void *right, size_t count)
{
    const unsigned char *a = (const unsigned char *)left;
    const unsigned char *b = (const unsigned char *)right;

    if ((((uintptr_t)a | (uintptr_t)b) & 3U) == 0U)
    {
        const uint32_t *wa = (const uint32_t *)a;
        const uint32_t *wb = (const uint32_t *)b;

        while (count >= 16U)
        {
            if (((wa[0] ^ wb[0]) | (wa[1] ^ wb[1]) | (wa[2] ^ wb[2]) |
                 (wa[3] ^ wb[3])) != 0U)
            {
                break;
            }
            wa += 4;
            wb += 4;
            count -= 16U;
        }
        while ((count >= 4U) && (*wa == *wb))
        {
            ++wa;
            ++wb;
            count -= 4U;
        }
        a = (const unsigned char *)wa;
        b = (const unsigned char *)wb;
    }
    while (count != 0U)
    {
        if (*a != *b)
        {
            return (int)*a - (int)*b;
        }
        ++a;
        ++b;
        --count;
    }
    return 0;
}
