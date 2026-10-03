#include <quickjs.h>

#include <stdio.h>
#include <string.h>

#ifdef POCKETJS_WII_PROBE
#include <ogc/system.h>
#endif

#if __SIZEOF_POINTER__ != 4 && defined(POCKETJS_WII_PROBE)
#error "Wii QuickJS probe must use 32-bit pointers"
#endif
#if defined(POCKETJS_WII_PROBE) && __BYTE_ORDER__ != __ORDER_BIG_ENDIAN__
#error "Wii QuickJS probe must use big-endian byte order"
#endif

_Static_assert(sizeof(JSValue) == 16, "QuickJS JSValue layout mismatch");

static void report_exception(JSContext *ctx, const char *where)
{
    JSValue exception = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, exception);
    fprintf(stderr, "%s: %s\n", where, message ? message : "<unprintable exception>");
    if (message)
        JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, exception);
}

static int eval(JSContext *ctx, const char *source, JSValue *result)
{
    *result = JS_Eval(ctx, source, strlen(source), "w05-smoke.js", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(*result))
        return 1;
    report_exception(ctx, "JavaScript evaluation failed");
    return 0;
}

static int expect_int_property(JSContext *ctx, JSValueConst object,
                               const char *property, int expected)
{
    JSValue value = JS_GetPropertyStr(ctx, object, property);
    if (JS_IsException(value)) {
        report_exception(ctx, property);
        return 0;
    }

    int32_t actual;
    if (JS_ToInt32(ctx, &actual, value) < 0) {
        report_exception(ctx, property);
        JS_FreeValue(ctx, value);
        return 0;
    }
    JS_FreeValue(ctx, value);
    if (actual == expected)
        return 1;
    fprintf(stderr, "%s: expected %d, got %d\n", property, expected, actual);
    return 0;
}

static int expect_exception(JSContext *ctx)
{
    JSValue thrown = JS_Eval(ctx, "throw new Error('W05 smoke exception')",
                             sizeof("throw new Error('W05 smoke exception')") - 1,
                             "w05-exception.js", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(thrown)) {
        JS_FreeValue(ctx, thrown);
        fprintf(stderr, "expected JavaScript exception\n");
        return 0;
    }

    JSValue exception = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, exception);
    int matched = message && strstr(message, "W05 smoke exception");
    if (!matched)
        fprintf(stderr, "exception extraction failed: %s\n", message ? message : "<unprintable>");
    if (message)
        JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, exception);
    return matched;
}

static int copy_typed_array(JSContext *ctx, JSValueConst object,
                            const char *property, uint8_t *bytes,
                            size_t capacity, size_t *length,
                            size_t *bytes_per_element)
{
    JSValue view = JS_GetPropertyStr(ctx, object, property);
    if (JS_IsException(view)) {
        report_exception(ctx, property);
        return 0;
    }

    size_t offset, view_length, buffer_length;
    JSValue buffer = JS_GetTypedArrayBuffer(ctx, view, &offset, &view_length,
                                            bytes_per_element);
    JS_FreeValue(ctx, view);
    if (JS_IsException(buffer)) {
        report_exception(ctx, property);
        return 0;
    }

    uint8_t *data = JS_GetArrayBuffer(ctx, &buffer_length, buffer);
    if (!data) {
        report_exception(ctx, property);
        JS_FreeValue(ctx, buffer);
        return 0;
    }
    if (offset > buffer_length || view_length > buffer_length - offset ||
        view_length > capacity) {
        fprintf(stderr, "%s: invalid typed-array bounds\n", property);
        JS_FreeValue(ctx, buffer);
        return 0;
    }

    memcpy(bytes, data + offset, view_length);
    JS_FreeValue(ctx, buffer);
    *length = view_length;
    return 1;
}

static int expect_array_buffer_property(JSContext *ctx, JSValueConst object,
                                        const char *property,
                                        const uint8_t *expected,
                                        size_t expected_length)
{
    JSValue buffer = JS_GetPropertyStr(ctx, object, property);
    if (JS_IsException(buffer)) {
        report_exception(ctx, property);
        return 0;
    }

    size_t actual_length;
    uint8_t *actual = JS_GetArrayBuffer(ctx, &actual_length, buffer);
    JS_FreeValue(ctx, buffer);
    if (!actual) {
        report_exception(ctx, property);
        return 0;
    }
    if (actual_length != expected_length ||
        memcmp(actual, expected, expected_length) != 0) {
        fprintf(stderr, "%s: ArrayBuffer bytes did not match\n", property);
        return 0;
    }
    return 1;
}

static void print_bytes(FILE *stream, const uint8_t *bytes, size_t length)
{
    for (size_t i = 0; i < length; i++)
        fprintf(stream, "%02x", bytes[i]);
}

static int expect_buffer_byte_order(JSContext *ctx)
{
    static const uint8_t little_endian_bytes[] = {
        0x00, 0x00, 0x34, 0x12, 0x00, 0x00, 0x80, 0x3f,
    };
    JSValue result = JS_UNDEFINED;
    if (!eval(ctx,
              "(() => {"
              " const buffer = new ArrayBuffer(8);"
              " const dataView = new DataView(buffer, 2, 6);"
              " dataView.setUint16(0, 0x1234, true);"
              " dataView.setFloat32(2, 1, true);"
              " return { bytes: new Uint8Array(buffer), dataView,"
              "          word: new Uint16Array([0x1234]),"
              "          hostOps: new Float64Array([42.5]) };"
              "})()",
              &result))
        return 0;

    uint8_t bytes[sizeof(little_endian_bytes)];
    size_t length, bytes_per_element;
    if (!copy_typed_array(ctx, result, "bytes", bytes, sizeof(bytes), &length,
                          &bytes_per_element) ||
        length != sizeof(little_endian_bytes) || bytes_per_element != 1 ||
        memcmp(bytes, little_endian_bytes, sizeof(little_endian_bytes)) != 0) {
        fprintf(stderr, "Uint8Array: expected DataView bytes ");
        print_bytes(stderr, little_endian_bytes, sizeof(little_endian_bytes));
        fputc('\n', stderr);
        JS_FreeValue(ctx, result);
        return 0;
    }

    JSValue data_view = JS_GetPropertyStr(ctx, result, "dataView");
    if (JS_IsException(data_view)) {
        report_exception(ctx, "dataView");
        JS_FreeValue(ctx, result);
        return 0;
    }
    int data_view_ok = expect_int_property(ctx, data_view, "byteOffset", 2) &&
                       expect_int_property(ctx, data_view, "byteLength", 6) &&
                       expect_array_buffer_property(ctx, data_view, "buffer",
                                                    little_endian_bytes,
                                                    sizeof(little_endian_bytes));
    JS_FreeValue(ctx, data_view);
    if (!data_view_ok) {
        JS_FreeValue(ctx, result);
        return 0;
    }

    uint16_t expected_word = 0x1234;
    if (!copy_typed_array(ctx, result, "word", bytes, sizeof(bytes), &length,
                          &bytes_per_element) ||
        length != sizeof(expected_word) || bytes_per_element != sizeof(expected_word) ||
        memcmp(bytes, &expected_word, sizeof(expected_word)) != 0) {
        fprintf(stderr, "Uint16Array: bytes do not match native-endian 0x1234\n");
        JS_FreeValue(ctx, result);
        return 0;
    }
    uint8_t word_bytes[sizeof(expected_word)];
    memcpy(word_bytes, bytes, sizeof(word_bytes));

    double expected_host_ops = 42.5;
    if (!copy_typed_array(ctx, result, "hostOps", bytes, sizeof(bytes), &length,
                          &bytes_per_element) ||
        length != sizeof(expected_host_ops) || bytes_per_element != sizeof(expected_host_ops) ||
        memcmp(bytes, &expected_host_ops, sizeof(expected_host_ops)) != 0) {
        fprintf(stderr, "Float64Array: bytes do not match native-endian 42.5\n");
        JS_FreeValue(ctx, result);
        return 0;
    }
    uint8_t host_ops_bytes[sizeof(expected_host_ops)];
    memcpy(host_ops_bytes, bytes, sizeof(host_ops_bytes));

    JS_FreeValue(ctx, result);
    printf("W06d QuickJS buffers passed: DataView LE=");
    print_bytes(stdout, little_endian_bytes, sizeof(little_endian_bytes));
    printf(" Uint16Array native=");
    print_bytes(stdout, word_bytes, sizeof(word_bytes));
    printf(" Float64Array native=");
    print_bytes(stdout, host_ops_bytes, sizeof(host_ops_bytes));
    puts(" (42.5)");
    return 1;
}

int main(void)
{
#ifdef POCKETJS_WII_PROBE
    SYS_STDIO_Report(true);
#endif
    JSRuntime *runtime = JS_NewRuntime();
    if (!runtime) {
        fprintf(stderr, "JS_NewRuntime failed\n");
        return 1;
    }
    JSContext *ctx = JS_NewContext(runtime);
    if (!ctx) {
        JS_FreeRuntime(runtime);
        fprintf(stderr, "JS_NewContext failed\n");
        return 1;
    }

    int status = 1;
    JSValue result = JS_UNDEFINED;
    if (!eval(ctx,
              "({ number: 6 * 7, object: { answer: 40 + 2 }, "
              "bytes: new Uint8Array([0x12, 0x34]) })",
              &result))
        goto done;
    if (!JS_IsObject(result)) {
        fprintf(stderr, "result is not an object\n");
        goto done;
    }
    if (!expect_int_property(ctx, result, "number", 42))
        goto done;

    JSValue object = JS_GetPropertyStr(ctx, result, "object");
    if (JS_IsException(object)) {
        report_exception(ctx, "object");
        goto done;
    }
    if (!expect_int_property(ctx, object, "answer", 42)) {
        JS_FreeValue(ctx, object);
        goto done;
    }
    JS_FreeValue(ctx, object);

    JSValue bytes = JS_GetPropertyStr(ctx, result, "bytes");
    if (JS_IsException(bytes)) {
        report_exception(ctx, "bytes");
        goto done;
    }
    if (!JS_IsObject(bytes) ||
        !expect_int_property(ctx, bytes, "byteLength", 2) ||
        !expect_int_property(ctx, bytes, "0", 0x12) ||
        !expect_int_property(ctx, bytes, "1", 0x34)) {
        JS_FreeValue(ctx, bytes);
        goto done;
    }
    JS_FreeValue(ctx, bytes);
    JS_FreeValue(ctx, result);
    result = JS_UNDEFINED;

    if (!eval(ctx,
              "globalThis.promiseResult = 'pending'; "
              "Promise.resolve(40).then(value => { promiseResult = value + 2; });",
              &result))
        goto done;
    JS_FreeValue(ctx, result);
    result = JS_UNDEFINED;

    int job_count = 0;
    JSContext *job_ctx = NULL;
    int job_status;
    while ((job_status = JS_ExecutePendingJob(runtime, &job_ctx)) > 0)
        job_count++;
    if (job_status < 0) {
        report_exception(job_ctx ? job_ctx : ctx, "pending job failed");
        goto done;
    }
    if (job_count == 0) {
        fprintf(stderr, "promise did not enqueue a pending job\n");
        goto done;
    }
    JSValue global = JS_GetGlobalObject(ctx);
    if (!expect_int_property(ctx, global, "promiseResult", 42)) {
        JS_FreeValue(ctx, global);
        goto done;
    }
    JS_FreeValue(ctx, global);

    if (!expect_exception(ctx))
        goto done;

    if (!expect_buffer_byte_order(ctx))
        goto done;

    puts("W05 QuickJS smoke passed: number=42 object=42 typed-array=[18,52] promises=drained exception=extracted");
    status = 0;

done:
    JS_FreeValue(ctx, result);
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return status;
}
