#include <QApplication>
#include <QDir>
#include <QElapsedTimer>
#ifdef Q_OS_SYMBIAN
#include <apgcli.h>
#include <apgtask.h>
#include <coemain.h>
#endif
#include <QBasicTimer>
#include <QByteArray>
#include <QEvent>
#include <QFile>
#include <QFocusEvent>
#include <QImage>
#include <QKeyEvent>
#include <QLabel>
#include <QList>
#include <QRect>
#include <QResizeEvent>
#include <QSize>
#include <QString>
#include <QStringList>
#include <QTimerEvent>
#include <QTouchEvent>
#ifdef POCKETJS_PERF_TRACE
#include <QElapsedTimer>
#ifdef Q_OS_SYMBIAN
#include <e32std.h>
#endif
#endif
#include <QVector>
#include <QWidget>
#include <QtGlobal>
#include <QtOpenGL/QGLWidget>
#include <EGL/egl.h>

#include <stdint.h>
#include <string.h>

extern "C" {
#include "quickjs.h"
}

#include "pocketjs_symbian_core.h"
#include "pocketjs_symbian_extension.h"
#include "pocketjs_symbian_keys.h"
#include "pocketjs_navigation_gesture.h"

typedef char PocketJsQuickJsValueMustBeEightBytes[
    sizeof(JSValue) == 8 ? 1 : -1
];

#ifndef POCKETJS_FRAME_RATE
#define POCKETJS_FRAME_RATE 30
#endif

#if POCKETJS_FRAME_RATE <= 0
#error POCKETJS_FRAME_RATE must be greater than zero
#elif (60 % POCKETJS_FRAME_RATE) != 0
#error POCKETJS_FRAME_RATE must divide the 60 Hz PocketJS core tick rate
#endif

#ifndef POCKETJS_INITIAL_LOGICAL_WIDTH
#define POCKETJS_INITIAL_LOGICAL_WIDTH 480
#endif

#ifndef POCKETJS_INITIAL_LOGICAL_HEIGHT
#define POCKETJS_INITIAL_LOGICAL_HEIGHT 272
#endif

namespace {

const int kMaximumViewportExtent = 640;
const int kAnalogCenter = 0x8080;
const int kMaximumTouches = 8;
const int kCoreTicksPerFrame = 60 / POCKETJS_FRAME_RATE;
const int kPocketPackageHeaderSize = 16;
const int kPocketPackageVariantSize = 40;
const int kPocketPackageSectionSize = 16;
const int kPocketPackageTargetBytes = 16;
const int kPocketPackageAlignment = 16;
const int kPocketSectionIdentity = 1;
const int kPocketSectionJavaScript = 3;
const int kPocketSectionPack = 4;
const uint32_t kPocketPackageMagic = 0x544b4350U;
const uint32_t kPocketPackageVersion = 1;
const int kPakHeaderSize = 32;
const int kPakEntrySize = 24;
const uint32_t kPakMagic = 0x4b504344U;
const uint16_t kPakVersion = 1;
const int kShotWidth = 256;
const int kShotHeight = 128;
const uint32_t kPixelStorage8888 = 3;

#ifdef POCKETJS_PERF_TRACE
QElapsedTimer perfGlClock;
int perfGlStages[6] = { 0, 0, 0, 0, 0, 0 };
uint32_t perfGlBatches = 0;
uint32_t perfGlVertices = 0;
void recordGlStage(uint32_t stage, uint32_t batches, uint32_t vertices)
{
    if (stage >= 6) return;
    if (stage == 0) perfGlClock.start();
    perfGlStages[stage] = perfGlClock.elapsed();
    perfGlBatches = batches;
    perfGlVertices = vertices;
}
#endif

const PocketJsSymbianExtensionV1 *pocketJsNativeExtension()
{
    const PocketJsSymbianExtensionV1 *extension =
        pocketjs_symbian_extension_v1();
    if (extension == 0 ||
        extension->abi_version != POCKETJS_SYMBIAN_EXTENSION_ABI_V1 ||
        extension->struct_size < sizeof(PocketJsSymbianExtensionV1)) {
        return 0;
    }
    return extension;
}

QGLFormat pocketJsGlFormat()
{
    QGLFormat format;
    format.setRgba(true);
    format.setDoubleBuffer(true);
    const PocketJsSymbianExtensionV1 *extension =
        pocketJsNativeExtension();
    format.setDepth(
        extension != 0 &&
        (extension->flags & POCKETJS_SYMBIAN_EXTENSION_DEPTH_BUFFER) != 0
    );
    format.setStencil(false);
    format.setAccum(false);
    format.setSampleBuffers(false);
    return format;
}

const int kButtonSelect = 0x0001;
const int kButtonStart = 0x0008;
const int kButtonUp = 0x0010;
const int kButtonRight = 0x0020;
const int kButtonDown = 0x0040;
const int kButtonLeft = 0x0080;
const int kButtonLeftTrigger = 0x0100;
const int kButtonRightTrigger = 0x0200;
const int kButtonTriangle = 0x1000;
const int kButtonCircle = 0x2000;
const int kButtonCross = 0x4000;
const int kButtonSquare = 0x8000;

enum HostOperation {
    HostCreateNode,
    HostDestroyNode,
    HostInsertBefore,
    HostRemoveChild,
    HostSetStyle,
    HostSetProp,
    HostSetPropBatch,
    HostSetText,
    HostReplaceText,
    HostUploadTexture,
    HostSetImage,
    HostSetSprite,
    HostAnimate,
    HostCancelAnim,
    HostSetFocus,
    HostSetActive,
    HostHitTest,
    HostSetCursor,
    HostSetCursorPos,
    HostLoadStyles,
    HostLoadFontAtlas,
    HostMeasureText,
    HostLoadTileTexture,
    HostFreeTexture,
    HostUploadImgEntry,
    HostDebugInspect,
    HostDebugRectXY,
    HostDebugRectWH,
    HostDebugPause,
    HostDebugStep
};

struct EmbeddedApp
{
    QString output;
    QString id;
    QString title;
    int packageOffset;
    int packageLength;
    QSize logicalViewport;
    bool liveViewport;
};

struct GuestPayload
{
    QByteArray javaScript;
    QByteArray pack;
};

class PocketJsRuntime;

bool lookupActivePackEntry(
    PocketJsRuntime *runtime,
    const char *key,
    size_t keyLength,
    const uint8_t **data,
    size_t *length
);

JSValue hostAppTable(
    JSContext *context,
    JSValueConst thisValue,
    int argc,
    JSValueConst *argv
);
JSValue hostAppLaunch(
    JSContext *context,
    JSValueConst thisValue,
    int argc,
    JSValueConst *argv
);
JSValue hostAppShot(
    JSContext *context,
    JSValueConst thisValue,
    int argc,
    JSValueConst *argv
);

int alignPocketOffset(int value)
{
    if (value < 0 || value > 0x7fffffff - (kPocketPackageAlignment - 1)) {
        return -1;
    }
    return (value + kPocketPackageAlignment - 1) &
        ~(kPocketPackageAlignment - 1);
}

bool readU16(
    const QByteArray &bytes,
    int offset,
    uint16_t *value
)
{
    if (offset < 0 || offset > bytes.size() - 2) return false;
    const unsigned char *data =
        reinterpret_cast<const unsigned char *>(bytes.constData() + offset);
    *value = static_cast<uint16_t>(
        static_cast<uint16_t>(data[0]) |
        (static_cast<uint16_t>(data[1]) << 8)
    );
    return true;
}

bool readU32(
    const QByteArray &bytes,
    int offset,
    uint32_t *value
)
{
    if (offset < 0 || offset > bytes.size() - 4) return false;
    const unsigned char *data =
        reinterpret_cast<const unsigned char *>(bytes.constData() + offset);
    *value =
        static_cast<uint32_t>(data[0]) |
        (static_cast<uint32_t>(data[1]) << 8) |
        (static_cast<uint32_t>(data[2]) << 16) |
        (static_cast<uint32_t>(data[3]) << 24);
    return true;
}

bool readU64(
    const QByteArray &bytes,
    int offset,
    quint64 *value
)
{
    uint32_t low = 0;
    uint32_t high = 0;
    if (!readU32(bytes, offset, &low) ||
        !readU32(bytes, offset + 4, &high)) {
        return false;
    }
    *value = static_cast<quint64>(low) |
        (static_cast<quint64>(high) << 32);
    return true;
}

bool findPakEntry(
    const QByteArray &pack,
    const char *key,
    size_t keyLength,
    const uint8_t **data,
    size_t *length
)
{
    *data = 0;
    *length = 0;
    if (key == 0 || keyLength > static_cast<size_t>(0x7fffffff) ||
        pack.size() < kPakHeaderSize) {
        return false;
    }

    uint32_t magic = 0;
    uint16_t version = 0;
    uint32_t count = 0;
    uint32_t rawDirectoryOffset = 0;
    uint32_t rawNamesOffset = 0;
    if (!readU32(pack, 0, &magic) ||
        !readU16(pack, 4, &version) ||
        !readU32(pack, 8, &count) ||
        !readU32(pack, 12, &rawDirectoryOffset) ||
        !readU32(pack, 16, &rawNamesOffset) ||
        magic != kPakMagic ||
        version != kPakVersion ||
        rawDirectoryOffset > static_cast<uint32_t>(pack.size()) ||
        rawNamesOffset > static_cast<uint32_t>(pack.size())) {
        return false;
    }

    const int directoryOffset = static_cast<int>(rawDirectoryOffset);
    const int namesOffset = static_cast<int>(rawNamesOffset);
    if (count > static_cast<uint32_t>(
            (pack.size() - directoryOffset) / kPakEntrySize)) {
        return false;
    }

    for (uint32_t index = 0; index < count; ++index) {
        const int entry = directoryOffset +
            static_cast<int>(index) * kPakEntrySize;
        uint32_t rawBlobOffset = 0;
        uint32_t rawBlobLength = 0;
        uint32_t rawNameOffset = 0;
        uint16_t nameLength = 0;
        if (!readU32(pack, entry + 4, &rawBlobOffset) ||
            !readU32(pack, entry + 8, &rawBlobLength) ||
            !readU32(pack, entry + 12, &rawNameOffset) ||
            !readU16(pack, entry + 16, &nameLength) ||
            rawNameOffset > static_cast<uint32_t>(pack.size() - namesOffset) ||
            nameLength > static_cast<uint32_t>(
                pack.size() - namesOffset - static_cast<int>(rawNameOffset)) ||
            rawBlobOffset > static_cast<uint32_t>(pack.size()) ||
            rawBlobLength > static_cast<uint32_t>(
                pack.size() - static_cast<int>(rawBlobOffset))) {
            return false;
        }

        const int nameOffset = namesOffset + static_cast<int>(rawNameOffset);
        if (keyLength != static_cast<size_t>(nameLength) ||
            memcmp(pack.constData() + nameOffset, key, keyLength) != 0) {
            continue;
        }
        *data = reinterpret_cast<const uint8_t *>(
            pack.constData() + static_cast<int>(rawBlobOffset)
        );
        *length = static_cast<size_t>(rawBlobLength);
        return true;
    }
    return false;
}

quint64 pocketHash(const QByteArray &bytes, int length)
{
    quint64 hash = Q_UINT64_C(0xcbf29ce484222325);
    const quint64 prime = Q_UINT64_C(0x100000001b3);
    const unsigned char *data =
        reinterpret_cast<const unsigned char *>(bytes.constData());
    for (int index = 0; index < length; ++index) {
        hash ^= static_cast<quint64>(data[index]);
        hash *= prime;
    }
    return hash;
}

bool sectionBounds(
    const QByteArray &package,
    int sectionEntry,
    uint32_t *kind,
    int *offset,
    int *length
)
{
    uint32_t rawOffset = 0;
    uint32_t rawLength = 0;
    if (!readU32(package, sectionEntry, kind) ||
        !readU32(package, sectionEntry + 8, &rawOffset) ||
        !readU32(package, sectionEntry + 12, &rawLength) ||
        rawOffset > static_cast<uint32_t>(package.size()) ||
        rawLength > static_cast<uint32_t>(package.size()) - rawOffset ||
        rawOffset + rawLength > static_cast<uint32_t>(package.size() - 8)) {
        return false;
    }
    *offset = static_cast<int>(rawOffset);
    *length = static_cast<int>(rawLength);
    return true;
}

bool decodeIdentity(
    const QByteArray &bytes,
    QString *output,
    QString *id,
    QString *title
)
{
    QString *fields[3] = { output, id, title };
    int offset = 0;
    for (int field = 0; field < 3; ++field) {
        uint16_t length = 0;
        if (!readU16(bytes, offset, &length)) return false;
        offset += 2;
        if (offset < 0 || offset > bytes.size() - static_cast<int>(length)) {
            return false;
        }
        *fields[field] = QString::fromUtf8(
            bytes.constData() + offset,
            static_cast<int>(length)
        );
        offset += static_cast<int>(length);
    }
    return offset == bytes.size();
}

bool parsePocketPackage(
    const QByteArray &package,
    const EmbeddedApp &app,
    GuestPayload *payload,
    QString *error
)
{
    if (package.size() < kPocketPackageHeaderSize + 8) {
        *error = "embedded .pocket is truncated";
        return false;
    }

    uint32_t magic = 0;
    uint32_t version = 0;
    uint32_t manifestLength = 0;
    uint32_t variantCount = 0;
    if (!readU32(package, 0, &magic) ||
        !readU32(package, 4, &version) ||
        !readU32(package, 8, &manifestLength) ||
        !readU32(package, 12, &variantCount) ||
        magic != kPocketPackageMagic ||
        version != kPocketPackageVersion) {
        *error = "embedded .pocket has an unsupported header";
        return false;
    }

    quint64 storedHash = 0;
    if (!readU64(package, package.size() - 8, &storedHash) ||
        pocketHash(package, package.size() - 8) != storedHash) {
        *error = "embedded .pocket footer hash does not match";
        return false;
    }

    if (manifestLength > static_cast<uint32_t>(package.size()) -
            kPocketPackageHeaderSize) {
        *error = "embedded .pocket manifest is out of bounds";
        return false;
    }
    const int tableOffset = alignPocketOffset(
        kPocketPackageHeaderSize + static_cast<int>(manifestLength)
    );
    const int packageBodyEnd = package.size() - 8;
    if (tableOffset < 0 ||
        tableOffset > packageBodyEnd ||
        variantCount > static_cast<uint32_t>(
            (packageBodyEnd - tableOffset) / kPocketPackageVariantSize)) {
        *error = "embedded .pocket variant table is out of bounds";
        return false;
    }

    int identityOffset = -1;
    int identityLength = 0;
    int javaScriptOffset = -1;
    int javaScriptLength = 0;
    int packOffset = -1;
    int packLength = 0;
    bool foundVariant = false;

    for (uint32_t variant = 0; variant < variantCount; ++variant) {
        const int entry = tableOffset +
            static_cast<int>(variant) * kPocketPackageVariantSize;
        int targetLength = 0;
        while (targetLength < kPocketPackageTargetBytes &&
               package.at(entry + targetLength) != '\0') {
            ++targetLength;
        }
        const QByteArray target = package.mid(entry, targetLength);

        uint32_t hostAbi = 0;
        uint32_t sectionCount = 0;
        uint32_t rawSectionsOffset = 0;
        if (!readU32(package, entry + 16, &hostAbi) ||
            !readU32(package, entry + 20, &sectionCount) ||
            !readU32(package, entry + 24, &rawSectionsOffset)) {
            *error = "embedded .pocket variant is truncated";
            return false;
        }
        if (target != "symbian-e7-dev") continue;
        if (hostAbi != static_cast<uint32_t>(POCKETJS_HOST_ABI)) {
            *error = "embedded .pocket host ABI does not match this runtime";
            return false;
        }
        if (rawSectionsOffset > static_cast<uint32_t>(packageBodyEnd) ||
            sectionCount > static_cast<uint32_t>(
                (packageBodyEnd - static_cast<int>(rawSectionsOffset)) /
                kPocketPackageSectionSize)) {
            *error = "embedded .pocket section table is out of bounds";
            return false;
        }

        foundVariant = true;
        for (uint32_t section = 0; section < sectionCount; ++section) {
            const int sectionEntry = static_cast<int>(rawSectionsOffset) +
                static_cast<int>(section) * kPocketPackageSectionSize;
            uint32_t kind = 0;
            int offset = 0;
            int length = 0;
            if (!sectionBounds(
                    package,
                    sectionEntry,
                    &kind,
                    &offset,
                    &length)) {
                *error = "embedded .pocket section is out of bounds";
                return false;
            }
            if (kind == kPocketSectionIdentity) {
                identityOffset = offset;
                identityLength = length;
            } else if (kind == kPocketSectionJavaScript) {
                javaScriptOffset = offset;
                javaScriptLength = length;
            } else if (kind == kPocketSectionPack) {
                packOffset = offset;
                packLength = length;
            }
        }
        break;
    }

    if (!foundVariant) {
        *error = "embedded .pocket has no symbian-e7-dev variant";
        return false;
    }
    if (identityOffset < 0 || javaScriptOffset < 0 ||
        javaScriptLength < 1 ||
        package.at(javaScriptOffset + javaScriptLength - 1) != '\0') {
        *error = "embedded .pocket is missing identity or NUL-terminated JS";
        return false;
    }

    QString output;
    QString id;
    QString title;
    if (!decodeIdentity(
            package.mid(identityOffset, identityLength),
            &output,
            &id,
            &title) ||
        output != app.output ||
        id != app.id ||
        title != app.title) {
        *error = "embedded .pocket identity does not match its catalog row";
        return false;
    }

    payload->javaScript = package.mid(
        javaScriptOffset,
        javaScriptLength - 1
    );
    payload->pack = packOffset < 0
        ? QByteArray()
        : package.mid(packOffset, packLength);
    return true;
}

bool intArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    int32_t *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToInt32(context, value, argv[index]) == 0;
}

bool uintArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    uint32_t *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToUint32(context, value, argv[index]) == 0;
}

bool floatArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    double *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToFloat64(context, value, argv[index]) == 0;
}

bool nonNegativeUintArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    uint32_t *value
)
{
    double raw = 0.0;
    if (!floatArgument(context, argc, argv, index, &raw)) return false;
    if (raw <= 0.0) {
        *value = 0;
    } else if (raw >= 4294967295.0) {
        *value = 0xffffffffU;
    } else {
        *value = static_cast<uint32_t>(raw);
    }
    return true;
}

bool stringArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    const char **text,
    size_t *length
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    *text = JS_ToCStringLen2(context, length, argv[index], 0);
    return *text != 0;
}

bool bytesArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    const uint8_t **data,
    size_t *length
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }

    uint8_t *direct = JS_GetArrayBuffer(context, length, argv[index]);
    if (!JS_HasException(context)) {
        *data = direct;
        return true;
    }
    JSValue directError = JS_GetException(context);
    JS_FreeValue(context, directError);

    size_t offset = 0;
    size_t byteLength = 0;
    size_t bytesPerElement = 0;
    JSValue buffer = JS_GetTypedArrayBuffer(
        context,
        argv[index],
        &offset,
        &byteLength,
        &bytesPerElement
    );
    if (JS_IsException(buffer)) {
        return false;
    }

    size_t bufferLength = 0;
    uint8_t *base = JS_GetArrayBuffer(context, &bufferLength, buffer);
    if (JS_HasException(context)) {
        JS_FreeValue(context, buffer);
        return false;
    }

    (void)bytesPerElement;
    if (offset > bufferLength || byteLength > bufferLength - offset) {
        JS_FreeValue(context, buffer);
        JS_ThrowRangeError(context, "typed array is outside its backing buffer");
        return false;
    }

    *data = base == 0 ? 0 : base + offset;
    *length = byteLength;
    JS_FreeValue(context, buffer);
    return true;
}

JSValue hostOperation(
    JSContext *context,
    JSValueConst,
    int argc,
    JSValueConst *argv,
    int magic
)
{
    int32_t a = 0;
    int32_t b = 0;
    int32_t c = 0;
    uint32_t ua = 0;
    uint32_t ub = 0;
    uint32_t uc = 0;
    uint32_t ud = 0;
    double da = 0.0;
    double db = 0.0;
    double dc = 0.0;
    double dd = 0.0;
    const uint8_t *bytes = 0;
    size_t byteLength = 0;
    const char *text = 0;
    size_t textLength = 0;

    switch (magic) {
    case HostCreateNode:
        if (!uintArgument(context, argc, argv, 0, &ua)) return JS_EXCEPTION;
        return JS_NewInt32(context, ui_create_node(ua));

    case HostDestroyNode:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_destroy_node(a);
        return JS_UNDEFINED;

    case HostInsertBefore:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b) ||
            !intArgument(context, argc, argv, 2, &c)) {
            return JS_EXCEPTION;
        }
        ui_insert_before(a, b, c);
        return JS_UNDEFINED;

    case HostRemoveChild:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_remove_child(a, b);
        return JS_UNDEFINED;

    case HostSetStyle:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_style(a, b);
        return JS_UNDEFINED;

    case HostSetProp:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !floatArgument(context, argc, argv, 2, &da)) {
            return JS_EXCEPTION;
        }
        ui_set_prop(a, ua, da);
        return JS_UNDEFINED;

    case HostSetPropBatch:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        ui_set_prop_batch(bytes, byteLength);
        return JS_UNDEFINED;

    case HostSetText:
    case HostReplaceText:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !stringArgument(context, argc, argv, 1, &text, &textLength)) {
            return JS_EXCEPTION;
        }
        if (magic == HostSetText) {
            ui_set_text(a, reinterpret_cast<const uint8_t *>(text), textLength);
        } else {
            ui_replace_text(a, reinterpret_cast<const uint8_t *>(text), textLength);
        }
        JS_FreeCString(context, text);
        return JS_UNDEFINED;

    case HostUploadTexture:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !uintArgument(context, argc, argv, 2, &ub) ||
            !uintArgument(context, argc, argv, 3, &uc)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(
            context,
            ui_upload_texture(bytes, byteLength, ua, ub, uc)
        );

    case HostSetImage:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_image(a, b);
        return JS_UNDEFINED;

    case HostSetSprite:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b) ||
            !nonNegativeUintArgument(context, argc, argv, 2, &ua) ||
            !nonNegativeUintArgument(context, argc, argv, 3, &ub) ||
            !nonNegativeUintArgument(context, argc, argv, 4, &uc)) {
            return JS_EXCEPTION;
        }
        ui_set_sprite(a, b, ua, ub, uc);
        return JS_UNDEFINED;

    case HostAnimate:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !floatArgument(context, argc, argv, 2, &da) ||
            !nonNegativeUintArgument(context, argc, argv, 3, &ub) ||
            !uintArgument(context, argc, argv, 4, &uc) ||
            !nonNegativeUintArgument(context, argc, argv, 5, &ud)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(context, ui_animate(a, ua, da, ub, uc, ud));

    case HostCancelAnim:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_cancel_anim(a);
        return JS_UNDEFINED;

    case HostSetFocus:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_set_focus(a);
        return JS_UNDEFINED;

    case HostSetActive:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_active(a, b);
        return JS_UNDEFINED;

    case HostHitTest:
        if (!floatArgument(context, argc, argv, 0, &da) ||
            !floatArgument(context, argc, argv, 1, &db)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(
            context,
            ui_hit_test(static_cast<float>(da), static_cast<float>(db))
        );

    case HostSetCursor:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !floatArgument(context, argc, argv, 1, &da) ||
            !floatArgument(context, argc, argv, 2, &db) ||
            !floatArgument(context, argc, argv, 3, &dc) ||
            !floatArgument(context, argc, argv, 4, &dd)) {
            return JS_EXCEPTION;
        }
        ui_set_cursor(
            a,
            static_cast<float>(da),
            static_cast<float>(db),
            static_cast<float>(dc),
            static_cast<float>(dd)
        );
        return JS_UNDEFINED;

    case HostSetCursorPos:
        if (!floatArgument(context, argc, argv, 0, &da) ||
            !floatArgument(context, argc, argv, 1, &db)) {
            return JS_EXCEPTION;
        }
        ui_set_cursor_pos(static_cast<float>(da), static_cast<float>(db));
        return JS_UNDEFINED;

    case HostLoadStyles:
    case HostLoadFontAtlas:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        if (magic == HostLoadStyles) {
            return JS_NewBool(context, ui_load_styles(bytes, byteLength));
        }
        return JS_NewBool(context, ui_load_font_atlas(bytes, byteLength));

    case HostMeasureText:
        if (!stringArgument(context, argc, argv, 0, &text, &textLength)) {
            return JS_EXCEPTION;
        }
        if (!uintArgument(context, argc, argv, 1, &ua)) {
            JS_FreeCString(context, text);
            return JS_EXCEPTION;
        }
        da = ui_measure_text(
            reinterpret_cast<const uint8_t *>(text),
            textLength,
            ua
        );
        JS_FreeCString(context, text);
        return JS_NewFloat64(context, da);

    case HostLoadTileTexture: {
        if (!stringArgument(
                context, argc, argv, 0, &text, &textLength)) {
            return JS_EXCEPTION;
        }
        if (!intArgument(context, argc, argv, 1, &a)) {
            JS_FreeCString(context, text);
            return JS_EXCEPTION;
        }
        int32_t handle = -1;
        const uint8_t *entry = 0;
        size_t entryLength = 0;
        PocketJsRuntime *runtime = static_cast<PocketJsRuntime *>(
            JS_GetContextOpaque(context)
        );
        if (a >= 0 &&
            lookupActivePackEntry(
                runtime,
                text,
                textLength,
                &entry,
                &entryLength)) {
            handle = ui_upload_tileset_tile(
                entry,
                entryLength,
                static_cast<uint32_t>(a)
            );
        }
        JS_FreeCString(context, text);
        return JS_NewInt32(context, handle);
    }

    case HostFreeTexture:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_free_texture(a);
        return JS_UNDEFINED;

    case HostUploadImgEntry:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(context, ui_upload_img_entry(bytes, byteLength));

    case HostDebugInspect:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_debug_inspect(a);
        return JS_UNDEFINED;

    case HostDebugRectXY:
        return JS_NewInt32(context, ui_debug_rect_xy());

    case HostDebugRectWH:
        return JS_NewInt32(context, ui_debug_rect_wh());

    case HostDebugPause:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_debug_pause(a);
        return JS_UNDEFINED;

    case HostDebugStep:
        ui_debug_step();
        return JS_UNDEFINED;
    }

    return JS_ThrowInternalError(context, "unknown PocketJS HostOp");
}

void addHostOperation(
    JSContext *context,
    JSValueConst object,
    const char *name,
    int arity,
    HostOperation operation
)
{
    JSValue function = JS_NewCFunctionMagic(
        context,
        hostOperation,
        name,
        arity,
        JS_CFUNC_generic_magic,
        static_cast<int>(operation)
    );
    JS_SetPropertyStr(context, object, name, function);
}

JSValue hostAppClose(JSContext *, JSValueConst, int, JSValueConst *);

bool installHostOps(
    PocketJsRuntime *owner,
    JSContext *context,
    JSValueConst global,
    int viewportWidth,
    int viewportHeight,
    bool multiApp,
    bool nativeNavigation
)
{
    JS_SetContextOpaque(context, owner);
    JSValue ui = JS_NewObject(context);
    if (JS_IsException(ui)) return false;

    addHostOperation(context, ui, "createNode", 1, HostCreateNode);
    addHostOperation(context, ui, "destroyNode", 1, HostDestroyNode);
    addHostOperation(context, ui, "insertBefore", 3, HostInsertBefore);
    addHostOperation(context, ui, "removeChild", 2, HostRemoveChild);
    addHostOperation(context, ui, "setStyle", 2, HostSetStyle);
    addHostOperation(context, ui, "setProp", 3, HostSetProp);
    addHostOperation(context, ui, "setPropBatch", 1, HostSetPropBatch);
    addHostOperation(context, ui, "setText", 2, HostSetText);
    addHostOperation(context, ui, "replaceText", 2, HostReplaceText);
    addHostOperation(context, ui, "uploadTexture", 4, HostUploadTexture);
    addHostOperation(context, ui, "setImage", 2, HostSetImage);
    addHostOperation(context, ui, "setSprite", 5, HostSetSprite);
    addHostOperation(context, ui, "animate", 6, HostAnimate);
    addHostOperation(context, ui, "cancelAnim", 1, HostCancelAnim);
    addHostOperation(context, ui, "setFocus", 1, HostSetFocus);
    addHostOperation(context, ui, "setActive", 2, HostSetActive);
    addHostOperation(context, ui, "hitTest", 2, HostHitTest);
    addHostOperation(context, ui, "setCursor", 5, HostSetCursor);
    addHostOperation(context, ui, "setCursorPos", 2, HostSetCursorPos);
    addHostOperation(context, ui, "loadStyles", 1, HostLoadStyles);
    addHostOperation(context, ui, "loadFontAtlas", 1, HostLoadFontAtlas);
    addHostOperation(context, ui, "measureText", 2, HostMeasureText);
    addHostOperation(context, ui, "loadTileTexture", 2, HostLoadTileTexture);
    addHostOperation(context, ui, "freeTexture", 1, HostFreeTexture);
    addHostOperation(context, ui, "uploadImgEntry", 1, HostUploadImgEntry);
    addHostOperation(context, ui, "debugInspect", 1, HostDebugInspect);
    addHostOperation(context, ui, "debugRectXY", 0, HostDebugRectXY);
    addHostOperation(context, ui, "debugRectWH", 0, HostDebugRectWH);
    addHostOperation(context, ui, "debugPause", 1, HostDebugPause);
    addHostOperation(context, ui, "debugStep", 0, HostDebugStep);
    if (multiApp) {
        JS_SetPropertyStr(
            context,
            ui,
            "appTable",
            JS_NewCFunction(context, hostAppTable, "appTable", 0)
        );
        JS_SetPropertyStr(
            context,
            ui,
            "appLaunch",
            JS_NewCFunction(context, hostAppLaunch, "appLaunch", 1)
        );
        JS_SetPropertyStr(
            context,
            ui,
            "appShot",
            JS_NewCFunction(context, hostAppShot, "appShot", 0)
        );
    }

    if (nativeNavigation) JS_SetPropertyStr(context, ui, "appClose", JS_NewCFunction(context, hostAppClose, "appClose", 1));

    JSValue viewport = JS_NewObject(context);
    JS_SetPropertyStr(
        context,
        viewport,
        "w",
        JS_NewInt32(context, viewportWidth)
    );
    JS_SetPropertyStr(
        context,
        viewport,
        "h",
        JS_NewInt32(context, viewportHeight)
    );
    JS_SetPropertyStr(context, ui, "__viewport", viewport);

    JS_SetPropertyStr(
        context,
        ui,
        "__host",
        JS_NewString(context, "symbian-e7-dev")
    );
    JS_SetPropertyStr(
        context,
        ui,
        "__hostAbi",
        JS_NewInt32(context, POCKETJS_HOST_ABI)
    );

    // Deliberately publish neither __textures nor __sprites. The target-bound
    // native host still feeds styles, fonts, and images through global __pak.
    return JS_SetPropertyStr(context, global, "ui", ui) >= 0;
}

int buttonForKey(int key)
{
    switch (key) {
    case Qt::Key_Up:
        return kButtonUp;
    case Qt::Key_Right:
        return kButtonRight;
    case Qt::Key_Down:
        return kButtonDown;
    case Qt::Key_Left:
        return kButtonLeft;
    case Qt::Key_Backspace:
    case Qt::Key_Home:
        return kButtonSelect;
    case Qt::Key_Q:
        return kButtonLeftTrigger;
    case Qt::Key_E:
        return kButtonRightTrigger;
    case Qt::Key_T:
        return kButtonTriangle;
    case Qt::Key_S:
        return kButtonSquare;
    case Qt::Key_Select:
    case Qt::Key_Return:
    case Qt::Key_Enter:
        return kButtonCircle;
    case Qt::Key_Escape:
        return kButtonCross;
    case Qt::Key_Space:
        return kButtonStart;
    default:
        return 0;
    }
}

uint32_t nativeKeyForKey(int key)
{
    switch (key) {
    case Qt::Key_W:
        return POCKETJS_SYMBIAN_KEY_MOVE_FORWARD;
    case Qt::Key_S:
        return POCKETJS_SYMBIAN_KEY_MOVE_BACK;
    case Qt::Key_A:
        return POCKETJS_SYMBIAN_KEY_MOVE_LEFT;
    case Qt::Key_D:
        return POCKETJS_SYMBIAN_KEY_MOVE_RIGHT;
    case Qt::Key_Up:
        return POCKETJS_SYMBIAN_KEY_LOOK_UP;
    case Qt::Key_Down:
        return POCKETJS_SYMBIAN_KEY_LOOK_DOWN;
    case Qt::Key_Left:
        return POCKETJS_SYMBIAN_KEY_LOOK_LEFT;
    case Qt::Key_Right:
        return POCKETJS_SYMBIAN_KEY_LOOK_RIGHT;
    case Qt::Key_E:
        return POCKETJS_SYMBIAN_KEY_FIRE;
    case Qt::Key_Space:
        return POCKETJS_SYMBIAN_KEY_JUMP;
    case Qt::Key_R:
        return POCKETJS_SYMBIAN_KEY_RELOAD;
    case Qt::Key_Shift:
        return POCKETJS_SYMBIAN_KEY_WALK;
    default:
        return 0;
    }
}

class PocketJsRuntime : public QGLWidget
{
public:
    PocketJsRuntime();
    ~PocketJsRuntime();
    QByteArray appTableJson() const;
    int frozenShotHandle() const;
    bool lookupPackEntry(
        const char *key,
        size_t keyLength,
        const uint8_t **data,
        size_t *length
    ) const;
    bool requestAppLaunch(const QString &output);
    bool requestAppClose(const QString &output);

protected:
    bool event(QEvent *event);
    void keyPressEvent(QKeyEvent *event);
    void keyReleaseEvent(QKeyEvent *event);
    void focusOutEvent(QFocusEvent *event);
    void initializeGL();
    void paintGL();
    void resizeEvent(QResizeEvent *event);
    void timerEvent(QTimerEvent *event);

private:
    struct NativeApp { uint32_t uid; QString output, id, title; int shot; bool portrait; };
    QVector<NativeApp> nativeApps_;
    int nativeSelf_, pendingNativeApp_, lastNativeApp_, nativeReturnDestination_;
    bool nativeWasBackground_, nativeShotPending_, nativeIgnoreUntilRelease_, nativeGraphicsSuspended_;
    int nativeActivationDeadline_;
    double nativePoseX_, nativePoseY_, nativePoseScale_;
    QElapsedTimer navigationClock_;
    PocketJsNavigationGesture navigationGesture_;
    QImage nativeReturnShot_;
    bool initializeNativeNavigation();
    void suspendNativeGraphics();
    bool resumeNativeGraphics();
    QString navigationDirectory() const;
    bool nativeInstalled(int index) const;
    QByteArray nativeAppTable() const;
    int activateNativeApp(int index);
    void notifyNativeReturn(int index, int destination, int error);
    void receiveNativeReturn();
    void finishNativeLaunch();
    bool navigationTouch(QTouchEvent *event);
    void paintNavigationBar();
    bool initialize(const QSize &viewport);
    bool initializeCatalog();
    bool bootGuest(int appIndex, const QSize &windowViewport);
    bool applyPendingViewport();
    QImage readFrame();
    void captureFrozenShot();
    void destroyGuest();
    void finishPendingSwitch();
    bool loadResource(const QString &path, QByteArray *bytes);
    bool loadGuestPayload(int appIndex, GuestPayload *payload);
    bool parseCatalog(const QByteArray &index);
    bool drainJobs();
    bool recoverGuestFailure(int appIndex);
    bool validViewport(const QSize &viewport) const;
    QRect presentationRect() const;
    QString takeException(JSContext *context);
    void clearInput();
    void fail(const QString &message);
    void queueViewport(const QSize &viewport);
    void requestSummon();
    void runFrame();
    void updateTouches(QTouchEvent *event);

    JSRuntime *runtime_;
    JSContext *context_;
    JSValue global_;
    JSValue frame_;
    JSValue resizeViewport_;
    QByteArray appJavaScript_;
    QByteArray appPack_;
    QByteArray catalogBlob_;
    QByteArray frozenShot_;
#ifdef POCKETJS_PERF_TRACE
    QString perfPrefix_;
    uint32_t perfTouch_;
    void recordNativeEvent(const char *action, int index, int error);
    struct PerfSample {
        int elapsed, delta, js, tick, draw, present, touches;
        int replay;
        int scene, resources, geometry, upload, submit;
        uint32_t batches, vertices;
    };
    struct PerfInput { int ms; uint32_t touch; };
    QVector<PerfSample> perfSamples_;
    QVector<PerfInput> perfInputs_;
    QElapsedTimer perfClock_;
    int perfLastMs_;
    int perfInputIndex_;
    int perfDrawMs_;
    int perfWakeMs_;
    int perfInactiveFrames_;
    int perfWarmupFrames_;
    bool perfDone_;
    bool perfShotDone_;
    void finishPerfTrace();
#endif
    QVector<EmbeddedApp> apps_;
    QBasicTimer timer_;
    const PocketJsSymbianExtensionV1 *extension_;
    QLabel *errorLabel_;
    QVector<uint32_t> touches_;
    QSize viewportSize_;
    QSize pendingViewportSize_;
    QSize windowSize_;
    int buttons_;
    int pressedButtons_;
    uint32_t nativeKeys_;
    uint32_t pressedNativeKeys_;
    int currentApp_;
    int pendingApp_;
    int resumeApp_;
    int frozenShotHandle_;
    bool coreInitialized_;
    bool initialized_;
    bool guestLiveViewport_;
    bool hasPendingViewport_;
    bool pendingSummon_;
    bool selectLatched_;
    bool failed_;
    bool glInitialized_;
};

bool lookupActivePackEntry(
    PocketJsRuntime *runtime,
    const char *key,
    size_t keyLength,
    const uint8_t **data,
    size_t *length
)
{
    return runtime != 0 &&
        runtime->lookupPackEntry(key, keyLength, data, length);
}

bool PocketJsRuntime::lookupPackEntry(
    const char *key,
    size_t keyLength,
    const uint8_t **data,
    size_t *length
) const
{
    return findPakEntry(appPack_, key, keyLength, data, length);
}

PocketJsRuntime::PocketJsRuntime()
    : QGLWidget(pocketJsGlFormat()),
      nativeSelf_(-1), pendingNativeApp_(-1), lastNativeApp_(-1), nativeReturnDestination_(1), nativeWasBackground_(true), nativeShotPending_(false), nativeIgnoreUntilRelease_(false), nativeGraphicsSuspended_(false),
      nativeActivationDeadline_(0),
      nativePoseX_(0), nativePoseY_(0), nativePoseScale_(1),
      runtime_(0),
      context_(0),
      global_(JS_UNDEFINED),
      frame_(JS_UNDEFINED),
      resizeViewport_(JS_UNDEFINED),
      extension_(0),
      errorLabel_(new QLabel(this)),
      pendingViewportSize_(
          POCKETJS_INITIAL_LOGICAL_WIDTH,
          POCKETJS_INITIAL_LOGICAL_HEIGHT
      ),
      buttons_(0),
      pressedButtons_(0),
      nativeKeys_(0),
      pressedNativeKeys_(0),
      currentApp_(0),
      pendingApp_(-1),
      resumeApp_(-1),
      frozenShotHandle_(-1),
      coreInitialized_(false),
      initialized_(false),
      guestLiveViewport_(true),
      hasPendingViewport_(true),
      pendingSummon_(false),
      selectLatched_(true),
      failed_(false),
      glInitialized_(false)
{
#ifdef POCKETJS_PERF_TRACE
    perfPrefix_ = "E:/Installs/pocketjs-perf";
#ifdef POCKETJS_SYMBIAN_UID
    const QString appPrefix = QString("E:/Installs/pocketjs-perf-%1").arg(uint32_t(POCKETJS_SYMBIAN_UID), 8, 16, QChar('0'));
    QFile appInput(appPrefix + "-input.tsv");
    if (appInput.exists() && appInput.size() > 0) perfPrefix_ = appPrefix;
#endif
    perfTouch_ = 0;
    QFile::remove(perfPrefix_ + ".tsv");
    QFile::remove(perfPrefix_ + ".png");
    QFile::remove(perfPrefix_ + "-navigation.tsv");
    perfLastMs_ = -1;
    perfInputIndex_ = 0;
    perfDrawMs_ = 0;
    perfWakeMs_ = -1000;
    perfInactiveFrames_ = 0;
    perfWarmupFrames_ = 0;
    perfDone_ = false;
    perfShotDone_ = false;
    perfSamples_.reserve(2048);
    // Opt-in diagnostic builds can replay one packed contact (zero releases).
    // A bounded file is read once, outside the measured frame loop.
    QFile input(perfPrefix_ + "-input.tsv");
    if (input.open(QIODevice::ReadOnly) && input.size() <= 131072) {
        const QList<QByteArray> lines = input.readAll().split('\n');
        for (int i = 0; i < lines.size() && perfInputs_.size() < 4096; ++i) {
            const QList<QByteArray> fields = lines.at(i).trimmed().split('\t');
            if (fields.size() != 2) continue;
            bool timeOk = false, touchOk = false;
            PerfInput point;
            point.ms = fields.at(0).toInt(&timeOk);
            point.touch = fields.at(1).toUInt(&touchOk);
            if (!timeOk || !touchOk || point.ms < 0 || point.ms > 30000 ||
                (!perfInputs_.isEmpty() && point.ms < perfInputs_.last().ms) ||
                (point.touch != 0 && (point.touch & 0x80000000U) == 0)) {
                perfInputs_.clear();
                break;
            }
            perfInputs_.append(point);
        }
        // A test trace must release its final contact.
        if (!perfInputs_.isEmpty() && perfInputs_.last().touch != 0) perfInputs_.clear();
    }
#endif
    setAttribute(Qt::WA_OpaquePaintEvent, true);
    setAttribute(Qt::WA_AcceptTouchEvents, true);
#ifdef POCKETJS_PERF_TRACE
    // Replay coordinates belong to the manifest's initial viewport. Physical
    // rotation must not change icon hit targets during a comparison run.
    if (!perfInputs_.isEmpty()) {
        setAttribute(POCKETJS_INITIAL_LOGICAL_WIDTH < POCKETJS_INITIAL_LOGICAL_HEIGHT
            ? Qt::WA_LockPortraitOrientation : Qt::WA_LockLandscapeOrientation, true);
    } else
#endif
    setAttribute(Qt::WA_AutoOrientation, true);
    // This surface is a controller, not a Qt text editor. Do not advertise
    // input-method capabilities; controller identity comes from nativeScanCode.
    setAttribute(Qt::WA_InputMethodEnabled, false);
    setFocusPolicy(Qt::StrongFocus);

    errorLabel_->setAlignment(Qt::AlignCenter);
    errorLabel_->setWordWrap(true);
    errorLabel_->setTextFormat(Qt::PlainText);
    errorLabel_->setStyleSheet(
        "QLabel {"
        " background: #250d12;"
        " color: #fff4f4;"
        " font-size: 18px;"
        " padding: 24px;"
        "}"
    );
    errorLabel_->hide();

    // QApplication::exec() starts only after main() calls showFullScreen().
    // The first timer event therefore observes the native fullscreen extent
    // instead of QWidget's pre-show default geometry.
    if (!initializeNativeNavigation()) { fail("Invalid native navigation table"); return; }
    if (nativeSelf_ >= 0 && nativeApps_.at(nativeSelf_).portrait) { setAttribute(Qt::WA_AutoOrientation, false); setAttribute(Qt::WA_LockPortraitOrientation, true); }
    const int interval = qMax(1, 1000 / POCKETJS_FRAME_RATE);
    timer_.start(interval, this);
}

PocketJsRuntime::~PocketJsRuntime()
{
    timer_.stop();
    destroyGuest();
    if (glInitialized_ && isValid()) {
        makeCurrent();
        ui_gl_shutdown();
        doneCurrent();
    }
    glInitialized_ = false;
}

void PocketJsRuntime::clearInput()
{
    buttons_ = 0;
    pressedButtons_ = 0;
    nativeKeys_ = 0;
    pressedNativeKeys_ = 0;
    touches_.clear();
}

void PocketJsRuntime::destroyGuest()
{
    initialized_ = false;
    if (extension_ != 0) {
        const bool hasContext = glInitialized_ && isValid();
        if (hasContext) makeCurrent();
        if (extension_->shutdown != 0) {
            extension_->shutdown(hasContext ? 1 : 0);
        }
        if (hasContext) doneCurrent();
        extension_ = 0;
    }
    if (context_ != 0) {
        JS_FreeValue(context_, resizeViewport_);
        JS_FreeValue(context_, frame_);
        JS_FreeValue(context_, global_);
        JS_FreeContext(context_);
        context_ = 0;
    }
    if (runtime_ != 0) {
        JS_FreeRuntime(runtime_);
        runtime_ = 0;
    }
    if (coreInitialized_) {
        if (glInitialized_ && isValid()) {
            makeCurrent();
            ui_gl_reset_resources();
            doneCurrent();
        }
        ui_shutdown();
        coreInitialized_ = false;
    }
    global_ = JS_UNDEFINED;
    frame_ = JS_UNDEFINED;
    resizeViewport_ = JS_UNDEFINED;
    appJavaScript_.clear();
    appPack_.clear();
    clearInput();
    frozenShotHandle_ = -1;
}

bool PocketJsRuntime::loadResource(
    const QString &path,
    QByteArray *bytes
)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        fail(QString("PocketJS resource is missing:\n%1").arg(path));
        return false;
    }
    *bytes = file.readAll();
    return true;
}

bool PocketJsRuntime::validViewport(const QSize &viewport) const
{
    return viewport.width() > 0 &&
        viewport.height() > 0 &&
        viewport.width() <= kMaximumViewportExtent &&
        viewport.height() <= kMaximumViewportExtent;
}

bool PocketJsRuntime::parseCatalog(const QByteArray &index)
{
    const QList<QByteArray> lines = index.split('\n');
    int previousEnd = 0;
    for (int lineNumber = 0; lineNumber < lines.size(); ++lineNumber) {
        QByteArray line = lines.at(lineNumber);
        if (line.endsWith('\r')) line.chop(1);
        if (line.isEmpty() || line.startsWith("#")) continue;

        const QList<QByteArray> fields = line.split('\t');
        if (fields.size() != 8) {
            fail(
                QString("PocketJS catalog row %1 must have 8 tab fields")
                    .arg(lineNumber + 1)
            );
            return false;
        }

        bool offsetOk = false;
        bool lengthOk = false;
        bool widthOk = false;
        bool heightOk = false;
        const int offset = fields.at(3).toInt(&offsetOk);
        const int length = fields.at(4).toInt(&lengthOk);
        const int width = fields.at(5).toInt(&widthOk);
        const int height = fields.at(6).toInt(&heightOk);
        const QByteArray viewportMode = fields.at(7);
        if (!offsetOk || !lengthOk || !widthOk || !heightOk ||
            offset < 0 || length <= 0 ||
            offset % kPocketPackageAlignment != 0 ||
            offset < previousEnd ||
            offset > catalogBlob_.size() - length ||
            width <= 0 || height <= 0 ||
            width > kMaximumViewportExtent ||
            height > kMaximumViewportExtent ||
            (viewportMode != "live" && viewportMode != "fixed")) {
            fail(
                QString("PocketJS catalog row %1 has invalid bounds or viewport")
                    .arg(lineNumber + 1)
            );
            return false;
        }

        EmbeddedApp app;
        app.output = QString::fromUtf8(
            fields.at(0).constData(),
            fields.at(0).size()
        );
        app.id = QString::fromUtf8(
            fields.at(1).constData(),
            fields.at(1).size()
        );
        app.title = QString::fromUtf8(
            fields.at(2).constData(),
            fields.at(2).size()
        );
        app.packageOffset = offset;
        app.packageLength = length;
        app.logicalViewport = QSize(width, height);
        app.liveViewport = viewportMode == "live";
        if (app.output.isEmpty() || app.id.isEmpty() || app.title.isEmpty()) {
            fail(
                QString("PocketJS catalog row %1 has an empty identity field")
                    .arg(lineNumber + 1)
            );
            return false;
        }
        for (int index = 0; index < apps_.size(); ++index) {
            if (apps_.at(index).output == app.output) {
                fail(
                    QString("PocketJS catalog repeats output %1")
                        .arg(app.output)
                );
                return false;
            }
        }
        apps_.append(app);
        previousEnd = offset + length;
    }

    if (!apps_.isEmpty() &&
        apps_.first().id != "dev.pocket-stack.launcher") {
        fail("PocketJS catalog entry zero is not the launcher");
        return false;
    }
    return true;
}

bool PocketJsRuntime::initializeCatalog()
{
    QByteArray index;
    if (!loadResource(":/pocketjs/catalog.tsv", &index) ||
        !loadResource(":/pocketjs/catalog.bin", &catalogBlob_)) {
        return false;
    }
    apps_.clear();
    if (!parseCatalog(index)) return false;

    if (apps_.isEmpty()) {
        EmbeddedApp app;
        app.output = "app";
        app.id = "dev.pocket-stack.app";
        app.title = "PocketJS App";
        app.packageOffset = -1;
        app.packageLength = 0;
        app.logicalViewport = QSize(
            POCKETJS_INITIAL_LOGICAL_WIDTH,
            POCKETJS_INITIAL_LOGICAL_HEIGHT
        );
        // This preserves the original standalone runtime: the OS window is
        // the logical viewport and every orientation change relayouts it.
        app.liveViewport = true;
        apps_.append(app);
        catalogBlob_.clear();
    }
    return true;
}

bool PocketJsRuntime::loadGuestPayload(
    int appIndex,
    GuestPayload *payload
)
{
    if (appIndex < 0 || appIndex >= apps_.size()) {
        fail("PocketJS tried to boot an unknown catalog entry");
        return false;
    }
    const EmbeddedApp &app = apps_.at(appIndex);
    if (app.packageOffset < 0) {
        if (!loadResource(":/pocketjs/app.js", &payload->javaScript) ||
            !loadResource(":/pocketjs/app.pak", &payload->pack)) {
            return false;
        }
        if (payload->javaScript.isEmpty()) {
            fail(":/pocketjs/app.js is empty");
            return false;
        }
        return true;
    }

    QString error;
    const QByteArray package = catalogBlob_.mid(
        app.packageOffset,
        app.packageLength
    );
    if (!parsePocketPackage(package, app, payload, &error)) {
        fail(
            QString("PocketJS cannot boot %1\n\n%2")
                .arg(app.output)
                .arg(error)
        );
        return false;
    }
    return true;
}

bool PocketJsRuntime::initialize(const QSize &viewport)
{
    if (!validViewport(viewport)) {
        fail(
            QString("PocketJS received an invalid initial viewport: %1x%2")
                .arg(viewport.width())
                .arg(viewport.height())
        );
        return false;
    }
    windowSize_ = viewport;
    if (!initializeCatalog()) return false;
    return bootGuest(0, viewport);
}

bool PocketJsRuntime::bootGuest(
    int appIndex,
    const QSize &windowViewport
)
{
    GuestPayload payload;
    if (!loadGuestPayload(appIndex, &payload)) return false;

    const EmbeddedApp &app = apps_.at(appIndex);
    const QSize viewport = app.liveViewport
        ? QSize(windowViewport.width(), windowViewport.height() - (nativeSelf_ > 0 ? 28 : 0))
        : app.logicalViewport;
    if (!validViewport(viewport)) {
        fail(
            QString("PocketJS received an invalid guest viewport: %1x%2")
                .arg(viewport.width())
                .arg(viewport.height())
        );
        return false;
    }

    currentApp_ = appIndex;
    guestLiveViewport_ = app.liveViewport;
    viewportSize_ = viewport;
    pendingViewportSize_ = windowViewport;
    windowSize_ = windowViewport;
    hasPendingViewport_ = false;
    selectLatched_ = true;
    appJavaScript_ = payload.javaScript;
    appPack_ = payload.pack;

    ui_init(1);
    coreInitialized_ = true;
    ui_set_viewport(viewport.width(), viewport.height());
    if (!frozenShot_.isEmpty()) {
        frozenShotHandle_ = ui_upload_texture(
            reinterpret_cast<const uint8_t *>(frozenShot_.constData()),
            static_cast<size_t>(frozenShot_.size()),
            kShotWidth,
            kShotHeight,
            kPixelStorage8888
        );
    } else {
        frozenShotHandle_ = -1;
    }

    runtime_ = JS_NewRuntime();
    if (runtime_ == 0) {
        fail("QuickJS runtime allocation failed");
        return false;
    }
    JS_SetMaxStackSize(runtime_, 512 * 1024);

    context_ = JS_NewContext(runtime_);
    if (context_ == 0) {
        fail("QuickJS context allocation failed");
        return false;
    }
    global_ = JS_GetGlobalObject(context_);

    if (!installHostOps(
            this,
            context_,
            global_,
            viewport.width(),
            viewport.height(),
            apps_.size() > 1 || nativeSelf_ >= 0,
            nativeSelf_ >= 0)) {
        fail(takeException(context_));
        return false;
    }

    extension_ = pocketJsNativeExtension();
    // A native extension may borrow appPack_ as immutable storage until
    // shutdown. QuickJS ArrayBuffers are always writable, so an extension
    // guest must receive an independent JS-owned copy rather than an alias
    // that a Uint8Array could mutate behind Rust's borrowed CookedMap.
    JSValue pack = extension_ != 0
        ? JS_NewArrayBufferCopy(
            context_,
            reinterpret_cast<const uint8_t *>(appPack_.constData()),
            static_cast<size_t>(appPack_.size())
        )
        : JS_NewArrayBuffer(
            context_,
            reinterpret_cast<uint8_t *>(appPack_.data()),
            static_cast<size_t>(appPack_.size()),
            0,
            0,
            0
        );
    if (JS_IsException(pack) ||
        JS_SetPropertyStr(context_, global_, "__pak", pack) < 0 ||
        JS_SetPropertyStr(
            context_,
            global_,
            "__simHz",
            JS_NewInt32(context_, POCKETJS_FRAME_RATE)
        ) < 0) {
        fail(takeException(context_));
        return false;
    }

    if (extension_ != 0 &&
        (extension_->boot == 0 ||
         extension_->boot(
             context_,
             reinterpret_cast<const uint8_t *>(appPack_.constData()),
             static_cast<size_t>(appPack_.size()),
             viewport.width(),
             viewport.height()
         ) == 0)) {
        fail("PocketJS native extension could not initialize.");
        return false;
    }

    JSValue result = JS_Eval(
        context_,
        appJavaScript_.constData(),
        static_cast<size_t>(appJavaScript_.size()),
        "app.js",
        JS_EVAL_TYPE_GLOBAL
    );
    if (JS_IsException(result)) {
        fail(takeException(context_));
        return false;
    }
    JS_FreeValue(context_, result);

    frame_ = JS_GetPropertyStr(context_, global_, "frame");
    if (JS_IsException(frame_)) {
        fail(takeException(context_));
        return false;
    }
    if (!JS_IsFunction(context_, frame_)) {
        fail("app.js did not install globalThis.frame");
        return false;
    }

    resizeViewport_ = JS_GetPropertyStr(
        context_,
        global_,
        "__pocketResizeViewport"
    );
    if (JS_IsException(resizeViewport_)) {
        fail(takeException(context_));
        return false;
    }
    if (!JS_IsFunction(context_, resizeViewport_)) {
        fail("app.js did not install globalThis.__pocketResizeViewport");
        return false;
    }

    initialized_ = true;
    return true;
}

QString PocketJsRuntime::takeException(JSContext *context)
{
    if (context == 0) return "Unknown QuickJS failure";

    JSValue exception = JS_GetException(context);
    size_t messageLength = 0;
    const char *message = JS_ToCStringLen2(
        context,
        &messageLength,
        exception,
        0
    );
    QString text = message == 0
        ? QString("QuickJS exception")
        : QString::fromUtf8(message, static_cast<int>(messageLength));
    if (message != 0) JS_FreeCString(context, message);

    if (JS_IsError(context, exception)) {
        JSValue stack = JS_GetPropertyStr(context, exception, "stack");
        if (!JS_IsException(stack) && !JS_IsUndefined(stack)) {
            size_t stackLength = 0;
            const char *stackText = JS_ToCStringLen2(
                context,
                &stackLength,
                stack,
                0
            );
            if (stackText != 0) {
                const QString formatted = QString::fromUtf8(
                    stackText,
                    static_cast<int>(stackLength)
                );
                if (!formatted.isEmpty() && formatted != text) {
                    text += "\n\n" + formatted;
                }
                JS_FreeCString(context, stackText);
            }
        }
        JS_FreeValue(context, stack);
    }
    JS_FreeValue(context, exception);
    return text;
}

void appendJsonString(QByteArray *json, const QString &value)
{
    static const char hex[] = "0123456789abcdef";
    const QByteArray utf8 = value.toUtf8();
    json->append('"');
    for (int index = 0; index < utf8.size(); ++index) {
        const unsigned char byte =
            static_cast<unsigned char>(utf8.at(index));
        if (byte == '"') {
            json->append("\\\"");
        } else if (byte == '\\') {
            json->append("\\\\");
        } else if (byte < 0x20) {
            json->append("\\u00");
            json->append(hex[(byte >> 4) & 0x0f]);
            json->append(hex[byte & 0x0f]);
        } else {
            json->append(static_cast<char>(byte));
        }
    }
    json->append('"');
}

#include "pocketjs_native_navigation.h"

QByteArray PocketJsRuntime::appTableJson() const
{
    if (nativeSelf_ >= 0) return nativeAppTable();
    QByteArray json("{\"apps\":[");
    for (int index = 0; index < apps_.size(); ++index) {
        if (index > 0) json.append(',');
        const EmbeddedApp &app = apps_.at(index);
        json.append("{\"output\":");
        appendJsonString(&json, app.output);
        json.append(",\"id\":");
        appendJsonString(&json, app.id);
        json.append(",\"title\":");
        appendJsonString(&json, app.title);
        json.append('}');
    }
    json.append("],\"current\":");
    appendJsonString(&json, apps_.at(currentApp_).output);
    json.append(",\"resume\":");
    if (resumeApp_ >= 0 && resumeApp_ < apps_.size()) {
        appendJsonString(&json, apps_.at(resumeApp_).output);
    } else {
        json.append("null");
    }
    json.append('}');
    return json;
}

int PocketJsRuntime::frozenShotHandle() const
{
    return frozenShotHandle_;
}

bool PocketJsRuntime::requestAppLaunch(const QString &output)
{
    if (nativeSelf_ >= 0) {
        for (int i = 0; i < nativeApps_.size(); ++i) {
            if (nativeApps_.at(i).output != output || i == nativeSelf_ || !nativeInstalled(i)) continue;
            pendingNativeApp_ = i;
            return true;
        }
        return false;
    }
    for (int index = 0; index < apps_.size(); ++index) {
        if (apps_.at(index).output == output) {
            pendingApp_ = index;
            pendingSummon_ = false;
            return true;
        }
    }
    return false;
}

void PocketJsRuntime::requestSummon()
{
    if (apps_.size() <= 1 || currentApp_ == 0) return;
    pendingApp_ = 0;
    pendingSummon_ = true;
}

JSValue hostAppTable(
    JSContext *context,
    JSValueConst,
    int,
    JSValueConst *
)
{
    PocketJsRuntime *runtime = static_cast<PocketJsRuntime *>(
        JS_GetContextOpaque(context)
    );
    if (runtime == 0) return JS_ThrowInternalError(
        context,
        "PocketJS runtime context is missing"
    );
    const QByteArray json = runtime->appTableJson();
    return JS_NewStringLen(
        context,
        json.constData(),
        static_cast<size_t>(json.size())
    );
}

JSValue hostAppLaunch(
    JSContext *context,
    JSValueConst,
    int argc,
    JSValueConst *argv
)
{
    PocketJsRuntime *runtime = static_cast<PocketJsRuntime *>(
        JS_GetContextOpaque(context)
    );
    if (runtime == 0) return JS_ThrowInternalError(
        context,
        "PocketJS runtime context is missing"
    );
    const char *output = 0;
    size_t outputLength = 0;
    if (!stringArgument(
            context,
            argc,
            argv,
            0,
            &output,
            &outputLength)) {
        return JS_EXCEPTION;
    }
    const bool scheduled = runtime->requestAppLaunch(
        QString::fromUtf8(output, static_cast<int>(outputLength))
    );
    JS_FreeCString(context, output);
    return JS_NewInt32(context, scheduled ? 1 : 0);
}

JSValue hostAppClose(JSContext *context, JSValueConst, int argc, JSValueConst *argv)
{
    PocketJsRuntime *runtime = static_cast<PocketJsRuntime *>(JS_GetContextOpaque(context));
    const char *output = 0; size_t length = 0;
    if (!runtime || !stringArgument(context, argc, argv, 0, &output, &length)) return JS_EXCEPTION;
    const bool result = runtime->requestAppClose(QString::fromUtf8(output, length));
    JS_FreeCString(context, output);
    return JS_NewInt32(context, result ? 1 : 0);
}

JSValue hostAppShot(
    JSContext *context,
    JSValueConst,
    int,
    JSValueConst *
)
{
    PocketJsRuntime *runtime = static_cast<PocketJsRuntime *>(
        JS_GetContextOpaque(context)
    );
    if (runtime == 0) return JS_ThrowInternalError(
        context,
        "PocketJS runtime context is missing"
    );
    return JS_NewInt32(context, runtime->frozenShotHandle());
}

void PocketJsRuntime::fail(const QString &message)
{
    if (failed_) return;
    failed_ = true;
    if (nativeSelf_ <= 0) timer_.stop();
    // Keep the host-owned return gesture available after a child guest fails.
    errorLabel_->setAttribute(Qt::WA_TransparentForMouseEvents);
    errorLabel_->setText(
        QString("PocketJS E7 runtime stopped\n\n%1").arg(message)
    );
    errorLabel_->setGeometry(rect());
    errorLabel_->show();
    errorLabel_->raise();
}

bool PocketJsRuntime::recoverGuestFailure(int appIndex)
{
    if (!failed_ || apps_.size() <= 1 || appIndex == 0) return false;

    // Match the console broken-guest rule: a malformed or throwing embedded
    // app cannot strand the whole multi-app SIS. Log the diagnostic, retire
    // every partially-created guest resource, and cold-boot app 0. A broken
    // launcher (or the classic single-app SIS) keeps fail()'s visible stop.
    const QByteArray diagnostic = errorLabel_->text().toUtf8();
    qWarning("%s", diagnostic.constData());
    pendingApp_ = -1;
    pendingSummon_ = false;
    resumeApp_ = -1;
    frozenShot_.clear();
    destroyGuest();

    failed_ = false;
    errorLabel_->hide();
    if (!bootGuest(0, size())) return false;

    timer_.start(qMax(1, 1000 / POCKETJS_FRAME_RATE), this);
    update();
    return true;
}

bool PocketJsRuntime::drainJobs()
{
    JSContext *jobContext = 0;
    int result = 0;
    while ((result = JS_ExecutePendingJob(runtime_, &jobContext)) > 0) {
    }
    if (result < 0) {
        fail(takeException(jobContext == 0 ? context_ : jobContext));
        return false;
    }
    return true;
}

void PocketJsRuntime::queueViewport(const QSize &windowViewport)
{
    const QSize viewport(windowViewport.width(), windowViewport.height() - (nativeSelf_ > 0 ? 28 : 0));
    // Symbian can report a transient empty extent while changing layout.
    // Wait for the final non-empty QWidget size rather than resizing the core
    // to a geometry it cannot render.
    if (viewport.width() <= 0 || viewport.height() <= 0) return;

    if (initialized_ && !guestLiveViewport_) {
        if (viewport == windowSize_) return;
        windowSize_ = viewport;
        pendingViewportSize_ = viewport;
        hasPendingViewport_ = false;
        clearInput();
        update();
        return;
    }

    if (initialized_ && viewport == viewportSize_) {
        windowSize_ = viewport;
        pendingViewportSize_ = viewport;
        hasPendingViewport_ = false;
        return;
    }
    if (hasPendingViewport_ && viewport == pendingViewportSize_) return;

    pendingViewportSize_ = viewport;
    hasPendingViewport_ = true;
    windowSize_ = viewport;

    // Coordinates and held keyboard directions belong to the old screen
    // orientation. Never deliver them against the replacement layout.
    if (nativeSelf_ > 0 && (navigationGesture_.owned || !touches_.isEmpty())) nativeIgnoreUntilRelease_ = true;
    navigationGesture_.reset();
    clearInput();
}

bool PocketJsRuntime::applyPendingViewport()
{
    if (!hasPendingViewport_) return true;

    const QSize viewport = pendingViewportSize_;
    hasPendingViewport_ = false;
    if (viewport == viewportSize_) return true;
    if (!validViewport(viewport)) {
        fail(
            QString("PocketJS received an invalid viewport: %1x%2")
                .arg(viewport.width())
                .arg(viewport.height())
        );
        return false;
    }

    ui_set_viewport(viewport.width(), viewport.height());
    viewportSize_ = viewport;
    clearInput();
    if (extension_ != 0 && extension_->resize != 0) {
        extension_->resize(viewport.width(), viewport.height());
    }

    JSValue arguments[2];
    arguments[0] = JS_NewInt32(context_, viewport.width());
    arguments[1] = JS_NewInt32(context_, viewport.height());
    JSValue result = JS_Call(
        context_,
        resizeViewport_,
        global_,
        2,
        arguments
    );
    JS_FreeValue(context_, arguments[0]);
    JS_FreeValue(context_, arguments[1]);
    if (JS_IsException(result)) {
        fail(takeException(context_));
        return false;
    }
    JS_FreeValue(context_, result);
    if (!drainJobs()) return false;

    update();
    return true;
}

QRect PocketJsRuntime::presentationRect() const
{
    if (nativeSelf_ > 0) {
        const int lift = nativeShotPending_ ? 0 : qMin(navigationGesture_.lift(), height() / 2);
        const double scale = 1.0 - 0.18 * lift / qMax(1, height() / 2);
        const int w = qMax(1, static_cast<int>(width() * scale));
        const int h = qMax(1, static_cast<int>((height() - 28) * scale));
        return QRect((width() - w) / 2, -lift / 5, w, h);
    }
    if (guestLiveViewport_ || viewportSize_.isEmpty()) return rect();

    const int availableWidth = qMax(1, width());
    const int availableHeight = qMax(1, height());
    int targetWidth = viewportSize_.width();
    int targetHeight = viewportSize_.height();

    const double fit = qMin(
        static_cast<double>(availableWidth) / targetWidth,
        static_cast<double>(availableHeight) / targetHeight
    );
    double scale = fit;
    if (fit >= 1.0) {
        scale = static_cast<int>(fit);
    }
    targetWidth = qMax(1, static_cast<int>(targetWidth * scale));
    targetHeight = qMax(1, static_cast<int>(targetHeight * scale));
    return QRect(
        (availableWidth - targetWidth) / 2,
        (availableHeight - targetHeight) / 2,
        targetWidth,
        targetHeight
    );
}

void PocketJsRuntime::runFrame()
{
#ifdef POCKETJS_PERF_TRACE
    // Do not depend on the installed Qt DLL's default timer sentinel. E7
    // firmware can pair these 4.7 headers with a different QtCore build.
    const bool perfWarmup = perfWarmupFrames_ < 120;
    if (perfWarmup || perfLastMs_ < 0) perfClock_.start();
    const int elapsedMs = perfClock_.elapsed();
    // Match the framework's virtual frame clock. Wall-clock replay skips
    // entire contacts when a slow frame spans a gesture's press and release.
    const int replayMs = perfInputs_.isEmpty() ? elapsedMs
        : perfSamples_.size() * 1000 / POCKETJS_FRAME_RATE;
    const int frameDeltaMs = perfLastMs_ < 0 ? 0 : elapsedMs - perfLastMs_;
    perfLastMs_ = elapsedMs;
    if (!perfDone_ && elapsedMs >= 1000 && !isActiveWindow()) ++perfInactiveFrames_;
#ifdef Q_OS_SYMBIAN
    // Packed replay bypasses the window server's real-input activity reset.
    // Allow a bounded inspection window after collection, too. Release builds
    // retain normal sleep behavior.
    if (elapsedMs < 5 * 60 * 1000 && elapsedMs - perfWakeMs_ >= 1000) {
        User::ResetInactivityTime();
        perfWakeMs_ = elapsedMs;
    }
#endif
    while (!perfWarmup && perfInputIndex_ < perfInputs_.size() &&
           perfInputs_.at(perfInputIndex_).ms <= replayMs) {
        const uint32_t touch = perfInputs_.at(perfInputIndex_++).touch;
        if (nativeSelf_ >= 0) {
            if (touch || perfTouch_) {
                const uint32_t packed = touch ? touch : perfTouch_;
                QTouchEvent::TouchPoint point((packed >> 20) & 255);
                const Qt::TouchPointState state = !touch ? Qt::TouchPointReleased : !perfTouch_ ? Qt::TouchPointPressed : Qt::TouchPointMoved;
                point.setState(state); point.setPos(QPointF(packed & 1023, (packed >> 10) & 1023));
                QList<QTouchEvent::TouchPoint> points; points.append(point);
                QTouchEvent input(!touch ? QEvent::TouchEnd : !perfTouch_ ? QEvent::TouchBegin : QEvent::TouchUpdate,
                    QTouchEvent::TouchScreen, Qt::NoModifier, state, points);
                event(&input);
            }
            perfTouch_ = touch;
        } else {
            touches_.clear();
            if (touch != 0) touches_.append(touch);
        }
    }
    QElapsedTimer perfTimer;
    perfTimer.start();
#endif
    // Preserve a quick press+release for one host frame. S60 can deliver both
    // events between two 30 Hz samples even though the core advances at 60 Hz.
    int frameButtons = buttons_ | pressedButtons_;
    const uint32_t frameNativeKeys = nativeKeys_ | pressedNativeKeys_;
    pressedButtons_ = 0;
    pressedNativeKeys_ = 0;
    if (apps_.size() > 1 && currentApp_ != 0) {
        const bool selectPressed =
            (frameButtons & kButtonSelect) != 0;
        if (selectPressed && !selectLatched_) requestSummon();
        selectLatched_ = selectPressed;
        frameButtons &= ~kButtonSelect;
    }

    if (extension_ != 0 &&
        extension_->before_guest != 0 &&
        extension_->before_guest(
            context_,
            static_cast<uint32_t>(frameButtons),
            static_cast<uint32_t>(kAnalogCenter),
            frameNativeKeys
        ) == 0) {
        fail("PocketJS native extension frame failed.");
        return;
    }

    JSValue touchArray = JS_NewArray(context_);
    for (int index = 0; index < touches_.size(); ++index) {
        JS_SetPropertyUint32(
            context_,
            touchArray,
            static_cast<uint32_t>(index),
            JS_NewUint32(context_, touches_.at(index))
        );
    }

    JSValue arguments[3];
    arguments[0] = JS_NewInt32(context_, frameButtons);
    arguments[1] = JS_NewInt32(context_, kAnalogCenter);
    arguments[2] = touchArray;
    JSValue result = JS_Call(
        context_,
        frame_,
        global_,
        3,
        arguments
    );
    JS_FreeValue(context_, arguments[0]);
    JS_FreeValue(context_, arguments[1]);
    JS_FreeValue(context_, touchArray);

    if (JS_IsException(result)) {
        fail(takeException(context_));
        return;
    }
    JS_FreeValue(context_, result);
    if (!drainJobs()) return;
    if (extension_ != 0 &&
        extension_->after_guest != 0 &&
        extension_->after_guest(context_) == 0) {
        fail("PocketJS native extension guest handoff failed.");
        return;
    }
#ifdef POCKETJS_PERF_TRACE
    const int jsMs = perfTimer.elapsed();
#endif

    for (int tick = 0; tick < kCoreTicksPerFrame; ++tick) {
        ui_tick();
    }
#ifdef POCKETJS_PERF_TRACE
    const int tickEndMs = perfTimer.elapsed();
#endif
    // QGLWidget::updateGL() is synchronous: paintGL() submits this frame and
    // auto-swaps before a pending guest switch can release its DrawList and
    // texture storage.
    updateGL();
#ifdef POCKETJS_PERF_TRACE
    const int presentEndMs = perfTimer.elapsed();
    if (perfWarmup) {
        // First presentation can upload textures for seconds. Start replay
        // after 120 completed frames so deferred uploads/context cleanup
        // settle before the first contact is injected.
        ++perfWarmupFrames_;
        perfLastMs_ = -1;
    } else if (!perfDone_) {
        PerfSample sample = { elapsedMs, frameDeltaMs, jsMs,
            tickEndMs - jsMs, perfDrawMs_, presentEndMs - tickEndMs,
            touches_.size(), replayMs, perfGlStages[1] - perfGlStages[0],
            perfGlStages[2] - perfGlStages[1], perfGlStages[3] - perfGlStages[2],
            perfGlStages[4] - perfGlStages[3], perfGlStages[5] - perfGlStages[4],
            perfGlBatches, perfGlVertices };
        perfSamples_.append(sample);
        // No per-frame formatting, filesystem I/O, readback or glFinish.
        // Write only after the bounded measurement window has ended.
        if (replayMs >= 30000 || elapsedMs >= 60000 || perfSamples_.size() >= 2048) finishPerfTrace();
    }
#endif
    finishPendingSwitch();
    finishNativeLaunch();
}

#ifdef POCKETJS_PERF_TRACE
void PocketJsRuntime::finishPerfTrace()
{
    perfDone_ = true;
    QByteArray buffer;
    buffer.append("# frame_rate\t" + QByteArray::number(POCKETJS_FRAME_RATE) + "\n");
    buffer.append("# viewport\t" + QByteArray::number(width()) + "\t" + QByteArray::number(height()) + "\n");
    buffer.append("# replay_points\t" + QByteArray::number(perfInputs_.size()) + "\n");
    buffer.append("# inactive_frames\t" + QByteArray::number(perfInactiveFrames_) + "\n");
    buffer.append("# warmup_frames\t" + QByteArray::number(perfWarmupFrames_) + "\n");
    buffer.append("frame\telapsed_ms\tdelta_ms\tjs_ms\ttick_ms\tdraw_ms\tpresent_ms\ttouches\treplay_ms\tscene_ms\tresources_ms\tgeometry_ms\tupload_ms\tsubmit_ms\tbatches\tvertices\n");
    for (int i = 0; i < perfSamples_.size(); ++i) {
        const PerfSample &s = perfSamples_.at(i);
        buffer.append(QByteArray::number(i) + "\t" + QByteArray::number(s.elapsed) + "\t" +
            QByteArray::number(s.delta) + "\t" + QByteArray::number(s.js) + "\t" +
            QByteArray::number(s.tick) + "\t" + QByteArray::number(s.draw) + "\t" +
            QByteArray::number(s.present) + "\t" + QByteArray::number(s.touches) + "\t" + QByteArray::number(s.replay) + "\t" +
            QByteArray::number(s.scene) + "\t" + QByteArray::number(s.resources) + "\t" +
            QByteArray::number(s.geometry) + "\t" + QByteArray::number(s.upload) + "\t" +
            QByteArray::number(s.submit) + "\t" + QByteArray::number(s.batches) + "\t" +
            QByteArray::number(s.vertices) + "\n");
    }
    QFile trace(perfPrefix_ + ".tsv");
    if (trace.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text)) trace.write(buffer);
    perfSamples_.clear();
}
#endif

QImage PocketJsRuntime::readFrame()
{
    if (!glInitialized_ || !isValid()) return QImage();
    const QRect sourceRect = nativeSelf_ > 0 ? rect() : presentationRect().intersected(rect());
    if (sourceRect.isEmpty()) return QImage();

    QByteArray pixels;
    pixels.resize(sourceRect.width() * sourceRect.height() * 4);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(
        sourceRect.x(),
        height() - sourceRect.y() - sourceRect.height(),
        sourceRect.width(),
        sourceRect.height(),
        GL_RGBA,
        GL_UNSIGNED_BYTE,
        pixels.data()
    );
    if (glGetError() != GL_NO_ERROR) return QImage();

    // GLES readback is RGBA and bottom-left-origin. Convert once on the
    // summon path; steady frames never allocate or read back the framebuffer.
    QImage frame(sourceRect.size(), QImage::Format_ARGB32);
    for (int y = 0; y < sourceRect.height(); ++y) {
        QRgb *target = reinterpret_cast<QRgb *>(frame.scanLine(y));
        const unsigned char *source =
            reinterpret_cast<const unsigned char *>(pixels.constData()) +
            (sourceRect.height() - 1 - y) * sourceRect.width() * 4;
        for (int x = 0; x < sourceRect.width(); ++x) {
            target[x] = qRgba(
                source[x * 4],
                source[x * 4 + 1],
                source[x * 4 + 2],
                0xff
            );
        }
    }
    return frame;
}

void PocketJsRuntime::captureFrozenShot()
{
    frozenShot_.clear();
    const QImage frame = readFrame();
    if (frame.isNull()) return;
    const QImage shot = frame.scaled(
        kShotWidth,
        kShotHeight,
        Qt::IgnoreAspectRatio,
        Qt::SmoothTransformation
    );
    frozenShot_.resize(kShotWidth * kShotHeight * 4);
    unsigned char *target = reinterpret_cast<unsigned char *>(
        frozenShot_.data()
    );
    for (int y = 0; y < kShotHeight; ++y) {
        for (int x = 0; x < kShotWidth; ++x) {
            const QRgb pixel = shot.pixel(x, y);
            const int offset = (y * kShotWidth + x) * 4;
            target[offset] = static_cast<unsigned char>(qRed(pixel));
            target[offset + 1] = static_cast<unsigned char>(qGreen(pixel));
            target[offset + 2] = static_cast<unsigned char>(qBlue(pixel));
            target[offset + 3] = 0xff;
        }
    }
}

void PocketJsRuntime::finishPendingSwitch()
{
    if (pendingApp_ < 0) return;

    const int nextApp = pendingApp_;
    const bool summon = pendingSummon_;
    pendingApp_ = -1;
    pendingSummon_ = false;
    if (summon) {
        resumeApp_ = currentApp_;
    } else {
        frozenShot_.clear();
        resumeApp_ = -1;
    }

    // updateGL() above is synchronous: the outgoing frame is already visible.
    // Nothing from the next guest is evaluated until the entire QuickJS realm
    // and native Ui have been released.
    destroyGuest();
    if (!bootGuest(nextApp, size())) {
        recoverGuestFailure(nextApp);
    }
}

void PocketJsRuntime::updateTouches(QTouchEvent *touchEvent)
{
    touches_.clear();

    if (!initialized_ ||
        hasPendingViewport_) {
        return;
    }

    const QRect target = presentationRect();
    if (target.isEmpty()) return;

    const QList<QTouchEvent::TouchPoint> points = touchEvent->touchPoints();
    for (int index = 0;
         index < points.size() && touches_.size() < kMaximumTouches;
         ++index) {
        const QTouchEvent::TouchPoint &point = points.at(index);
        if (point.state() == Qt::TouchPointReleased) continue;

        const QPointF position = point.pos();
        if (position.x() < target.left() ||
            position.x() >= target.left() + target.width() ||
            position.y() < target.top() ||
            position.y() >= target.top() + target.height()) {
            continue;
        }
        int x = static_cast<int>(
            (position.x() - target.left()) *
            viewportSize_.width() /
            target.width()
        );
        int y = static_cast<int>(
            (position.y() - target.top()) *
            viewportSize_.height() /
            target.height()
        );
        x = qBound(0, x, viewportSize_.width() - 1);
        y = qBound(0, y, viewportSize_.height() - 1);
        // Compatibility extension wire. Legacy contacts keep bit 31 clear
        // with 9-bit x/y. E7 contacts set it and carry 10-bit x/y so the
        // native 640px viewport never truncates coordinates:
        //   bit31=1, x[0..9], y[10..19], id[20..27].
        const uint32_t packed =
            0x80000000U |
            ((static_cast<uint32_t>(point.id()) & 0xff) << 20) |
            ((static_cast<uint32_t>(y) & 0x3ff) << 10) |
            (static_cast<uint32_t>(x) & 0x3ff);
        touches_.append(packed);
    }
}

bool PocketJsRuntime::event(QEvent *event)
{
    if (event->type() == QEvent::TouchBegin ||
        event->type() == QEvent::TouchUpdate ||
        event->type() == QEvent::TouchEnd) {
        if (!navigationTouch(static_cast<QTouchEvent *>(event))) updateTouches(static_cast<QTouchEvent *>(event));
        event->accept();
        return true;
    }
    return QGLWidget::event(event);
}

void PocketJsRuntime::keyPressEvent(QKeyEvent *event)
{
    const int key = pocketjsSymbianControlKey(
        event->key(),
        event->nativeScanCode()
    );
    const int button = buttonForKey(key);
    const uint32_t nativeKey = nativeKeyForKey(key);
    if (button != 0 || nativeKey != 0) {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        if (button != 0) {
            buttons_ |= button;
            pressedButtons_ |= button;
        }
        nativeKeys_ |= nativeKey;
        pressedNativeKeys_ |= nativeKey;
        event->accept();
        return;
    }
    QGLWidget::keyPressEvent(event);
}

void PocketJsRuntime::keyReleaseEvent(QKeyEvent *event)
{
    const int key = pocketjsSymbianControlKey(
        event->key(),
        event->nativeScanCode()
    );
    const int button = buttonForKey(key);
    const uint32_t nativeKey = nativeKeyForKey(key);
    if (button != 0 || nativeKey != 0) {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        if (button != 0) buttons_ &= ~button;
        nativeKeys_ &= ~nativeKey;
        event->accept();
        return;
    }
    QGLWidget::keyReleaseEvent(event);
}

void PocketJsRuntime::focusOutEvent(QFocusEvent *event)
{
    nativeIgnoreUntilRelease_ = navigationGesture_.owned || !touches_.isEmpty();
    navigationGesture_.reset();
    clearInput();
    QGLWidget::focusOutEvent(event);
}

void PocketJsRuntime::initializeGL()
{
    const char *version = reinterpret_cast<const char *>(glGetString(GL_VERSION));
    const char *vendor = reinterpret_cast<const char *>(glGetString(GL_VENDOR));
    const char *renderer = reinterpret_cast<const char *>(glGetString(GL_RENDERER));
    GLint maximumTextureSize = 0;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maximumTextureSize);
    qWarning(
        "PocketJS GLES2: version=%s vendor=%s renderer=%s maxTexture=%d",
        version == 0 ? "unknown" : version,
        vendor == 0 ? "unknown" : vendor,
        renderer == 0 ? "unknown" : renderer,
        maximumTextureSize
    );
#ifdef POCKETJS_PERF_TRACE
#ifdef POCKETJS_GL_STAGES
    ui_gl_set_trace(recordGlStage);
#endif
    QFile trace(perfPrefix_ + ".tsv");
    if (trace.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text)) {
        trace.write("# gles_version\t");
        trace.write(version == 0 ? "unknown" : version);
        trace.write("\n# gles_vendor\t");
        trace.write(vendor == 0 ? "unknown" : vendor);
        trace.write("\n# gles_renderer\t");
        trace.write(renderer == 0 ? "unknown" : renderer);
        trace.write("\n# max_texture_size\t");
        trace.write(QByteArray::number(maximumTextureSize));
        trace.write("\n");
    }
#endif
    if (maximumTextureSize < 512) {
        fail("PocketJS requires an OpenGL ES 2 texture size of at least 512.");
        return;
    }
    glInitialized_ = ui_gl_initialize() != 0;
    if (!glInitialized_) {
        fail("PocketJS could not initialize the OpenGL ES 2 renderer.");
    }
}

void PocketJsRuntime::paintGL()
{
#ifdef POCKETJS_PERF_TRACE
    QElapsedTimer drawTimer;
    drawTimer.start();
#endif
    if (!glInitialized_ || !coreInitialized_ || failed_) {
        glDisable(GL_SCISSOR_TEST);
        glViewport(0, 0, width(), height());
        glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        return;
    }
    const QRect target = presentationRect();
    bool nativeRendered = false;
    if (extension_ != 0 && extension_->render != 0) {
        if (extension_->render(
                target.x(),
                target.y(),
                target.width(),
                target.height(),
                width(),
                height()
            ) == 0) {
            fail("PocketJS native extension rendering failed.");
            return;
        }
        nativeRendered = true;
    }
    const int uiRendered = nativeRendered
        ? ui_gl_render_over(
            target.x(),
            target.y(),
            target.width(),
            target.height(),
            width(),
            height()
        )
        : ui_gl_render(
            target.x(),
            target.y(),
            target.width(),
            target.height(),
            width(),
            height()
        );
    if (uiRendered == 0) {
        fail("PocketJS OpenGL ES 2 rendering failed.");
        return;
    }
#ifdef POCKETJS_PERF_TRACE
    perfDrawMs_ = drawTimer.elapsed();
    if (perfDone_ && !perfShotDone_) {
        // Capture the next completed back buffer, outside the measurement
        // window and before QGLWidget swaps it to the display.
        perfShotDone_ = true;
        readFrame().save(perfPrefix_ + ".png");
    }
#endif
    if (nativeSelf_ > 0 && nativeShotPending_) { nativeReturnShot_ = readFrame(); nativeShotPending_ = false; }
    paintNavigationBar();
    if (pendingApp_ >= 0 && pendingSummon_) {
        // QGLWidget auto-swaps only after paintGL returns, so this captures
        // the outgoing guest's just-rendered back buffer, never an undefined
        // post-swap buffer.
        captureFrozenShot();
    }
}

void PocketJsRuntime::resizeEvent(QResizeEvent *event)
{
    queueViewport(event->size());
    errorLabel_->setGeometry(rect());
    QGLWidget::resizeEvent(event);
}

void PocketJsRuntime::timerEvent(QTimerEvent *event)
{
    if (event->timerId() == timer_.timerId()) {
        if (failed_) {
            if (nativeSelf_ > 0 && pendingNativeApp_ >= 0) finishNativeLaunch();
            return;
        }
        if (nativeSelf_ >= 0 && initialized_) {
            if (!isActiveWindow()) { nativeActivationDeadline_ = 0; nativeWasBackground_ = true; suspendNativeGraphics(); clearInput(); return; }
            // StartDocument can return before the next app owns a window. Keep
            // our GPU resources released through that startup interval.
            if (nativeActivationDeadline_ > navigationClock_.elapsed()) return;
            if (nativeActivationDeadline_ != 0) {
                nativeActivationDeadline_ = 0;
                nativeWasBackground_ = true;
            }
            if (nativeWasBackground_) {
                if (!resumeNativeGraphics()) return;
                nativeWasBackground_ = false;
                navigationGesture_.reset();
                receiveNativeReturn();
#ifdef POCKETJS_PERF_TRACE
                recordNativeEvent("foreground", nativeSelf_, 0);
#endif
            }
        }

        // QResizeEvent is authoritative; polling size() is a cheap fallback
        // for Belle variants that coalesce a native layout notification.
        queueViewport(size());

        if (!initialized_) {
            if (!isVisible() || !isFullScreen() || !validViewport(size())) {
                return;
            }
            if (!isValid()) {
                fail("PocketJS could not obtain a valid OpenGL ES 2 context.");
                return;
            }
            if (!initialize(size())) return;
        } else if (!isValid()) {
            fail("PocketJS lost its OpenGL ES 2 context.");
            return;
        }

        if (!applyPendingViewport()) {
            recoverGuestFailure(currentApp_);
            return;
        }
        runFrame();
        if (failed_) recoverGuestFailure(currentApp_);
        return;
    }
    QGLWidget::timerEvent(event);
}

} // namespace

int main(int argc, char *argv[])
{
    // The host paints app content through GLES itself. Raster Qt chrome avoids
    // keeping a second OpenVG graphics system alive behind a suspended context.
    QApplication::setGraphicsSystem("raster");
    QApplication application(argc, argv);
    PocketJsRuntime runtime;
    runtime.showFullScreen();
    runtime.setFocus();
    return application.exec();
}
