#!/usr/bin/env python3
"""Prepare the pinned ESP-IDF QuickJS source without editing managed_components.

0.14.0 misses immutable checks in reverse and species-created destinations.
Keep ordinary reads/subarray working; reject writes before touching flash.
The source identity deliberately fails closed when the dependency changes.
"""
import hashlib
import re
import sys
from pathlib import Path

SOURCE_URL = "https://raw.githubusercontent.com/espressif/esp-iot-solution/0d0b99456ce9112f4ac4838927ba837949359f9b/components/quickjs-ng/quickjs-ng/quickjs.c"
SOURCE_SHA256 = "36128da188cb236ffd029dd3c672ff8f85e5a196a9211e267a515c8efc1ab52c"


def prepare(source: bytes) -> str:
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("unsupported QuickJS source; review immutable-buffer patch before upgrading")
    text = source.decode()
    start = text.index("static JSValue js_typed_array_reverse(")
    end = text.index("\nstatic ", start + 1)
    method = text[start:end]
    if method.count("    if (len > 0) {") != 1:
        raise ValueError("unexpected reverse implementation")
    method = method.replace("    if (len > 0) {", "    if (typed_array_is_immutable(JS_VALUE_GET_OBJ(this_val))) {\n"
                            "        return JS_ThrowTypeErrorImmutableArrayBuffer(ctx);\n  }\n"
                            "    if (len > 0) {", 1)
    text = text[:start] + method + text[end:]
    # Both declaration and definition, plus all call sites. Only subarray
    # constructs a view without writing the returned destination.
    text, count = re.subn(r"(static JSValue js_typed_array___speciesCreate\([\s\S]*?JSValueConst \*argv)\)",
                         r"\1, bool writable)", text)
    if count != 2:
        raise ValueError("unexpected speciesCreate declarations")
    text = text.replace("js_typed_array___speciesCreate(ctx, JS_UNDEFINED, 2, args)",
                        "js_typed_array___speciesCreate(ctx, JS_UNDEFINED, 2, args, true)")
    text = text.replace("js_typed_array___speciesCreate(ctx, JS_UNDEFINED, 4, args)",
                        "js_typed_array___speciesCreate(ctx, JS_UNDEFINED, 4, args, false)")
    start = text.rindex("static JSValue js_typed_array___speciesCreate(")
    end = text.index("\nstatic ", start + 1)
    method = text[start:end].replace("    return ret;", "    if (writable && !JS_IsException(ret) &&\n"
        "        typed_array_is_immutable(JS_VALUE_GET_OBJ(ret))) {\n"
        "        JS_FreeValue(ctx, ret);\n"
        "        return JS_ThrowTypeErrorImmutableArrayBuffer(ctx);\n  }\n  return ret;")
    return text[:start] + method + text[end:]


if __name__ == "__main__":
    result = prepare(Path(sys.argv[1]).read_bytes())
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists() or output.read_text() != result:
        output.write_text(result)
