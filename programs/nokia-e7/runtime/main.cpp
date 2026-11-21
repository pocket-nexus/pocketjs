#include "pocket_spec.h"
#if POCKETJS_HOST_ABI != POCKET_BINDING_GENERATION
#error "POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION"
#endif
#include <QApplication>
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

#include "pocket_native_program.h"
#include "pocket_guest_quickjs.h"
#include "pocket_native_extension.h"
#include "pocketjs_symbian_keys.h"

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

#ifdef POCKETJS_PERF_TRACE
QElapsedTimer perfGlClock;
int perfGlStages[7] = { 0, 0, 0, 0, 0, 0, 0 };
uint32_t perfGlBatches = 0;
uint32_t perfGlVertices = 0;
void recordGlStage(uint32_t stage, uint32_t batches, uint32_t vertices)
{
    if (stage >= 7) return;
    if (stage == 0) perfGlClock.start();
    perfGlStages[stage] = perfGlClock.elapsed();
    perfGlBatches = batches;
    perfGlVertices = vertices;
}
#endif

const PocketNativeExtensionV1 *pocketJsNativeExtension()
{
    const PocketNativeExtensionV1 *extension =
        pocket_native_extension_v1();
    if (extension == 0 ||
        extension->abi_version != POCKET_NATIVE_EXTENSION_ABI_V1 ||
        extension->struct_size < sizeof(PocketNativeExtensionV1)) {
        return 0;
    }
    return extension;
}

QGLFormat pocketJsGlFormat()
{
    QGLFormat format;
    format.setRgba(true);
    // Qt's E7 default chooses RGB565 even on a 32-bit desktop. Request
    // eight-bit channels so gradients do not acquire a dither grid.
    format.setRedBufferSize(8);
    format.setGreenBufferSize(8);
    format.setBlueBufferSize(8);
    format.setAlphaBufferSize(0);
    format.setDoubleBuffer(true);
    const PocketNativeExtensionV1 *extension =
        pocketJsNativeExtension();
    format.setDepth(
        extension != 0 &&
        (extension->flags & POCKET_NATIVE_EXTENSION_DEPTH_BUFFER) != 0
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
        return POCKET_NATIVE_KEY_MOVE_FORWARD;
    case Qt::Key_S:
        return POCKET_NATIVE_KEY_MOVE_BACK;
    case Qt::Key_A:
        return POCKET_NATIVE_KEY_MOVE_LEFT;
    case Qt::Key_D:
        return POCKET_NATIVE_KEY_MOVE_RIGHT;
    case Qt::Key_Up:
        return POCKET_NATIVE_KEY_LOOK_UP;
    case Qt::Key_Down:
        return POCKET_NATIVE_KEY_LOOK_DOWN;
    case Qt::Key_Left:
        return POCKET_NATIVE_KEY_LOOK_LEFT;
    case Qt::Key_Right:
        return POCKET_NATIVE_KEY_LOOK_RIGHT;
    case Qt::Key_E:
        return POCKET_NATIVE_KEY_FIRE;
    case Qt::Key_Space:
        return POCKET_NATIVE_KEY_JUMP;
    case Qt::Key_R:
        return POCKET_NATIVE_KEY_RELOAD;
    case Qt::Key_Shift:
        return POCKET_NATIVE_KEY_WALK;
    default:
        return 0;
    }
}

class PocketJsRuntime : public QGLWidget
{
public:
    PocketJsRuntime();
    ~PocketJsRuntime();

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
    bool initialize(const QSize &viewport);
    bool applyPendingViewport();
#ifdef POCKETJS_PERF_TRACE
    QImage readFrame();
#endif
    void destroyGuest();
    bool loadResource(const QString &path, QByteArray *bytes);
    bool validViewport(const QSize &viewport) const;
    QString takeException(JSContext *context);
    void clearInput();
    void fail(const QString &message);
    void queueViewport(const QSize &viewport);
    void runFrame();
    void updateTouches(QTouchEvent *event);

    static int32_t initializeGuest(void *, pocket_runtime *, const pocket_guest_environment *);
    static int32_t evaluateGuest(void *, pocket_runtime *, const uint8_t *, size_t);
    static int32_t frameGuest(void *, const pocket_guest_frame *);
    static int32_t collectGuest(void *);
    static void shutdownGuest(void *);
    PocketNativeProgram *program_;
    pocket_guest_quickjs *guest_;
    uint32_t frameNativeKeys_;
    bool resizingGuest_;
    bool destroyingGuest_;
    JSRuntime *runtime_;
    JSContext *context_;
    JSValue global_;
    JSValue resizeViewport_;
    QByteArray appJavaScript_;
    QByteArray appPack_;
#ifdef POCKETJS_PERF_TRACE
    QElapsedTimer *framePerfTimer_;
    int guestMs_;
    QString perfPrefix_;
    struct PerfSample {
        int elapsed, delta, js, tick, draw, present, touches;
        int replay;
        int scene, resources, geometry, upload, submit, error;
        uint32_t batches, vertices;
        int hit;
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
    QBasicTimer timer_;
    const PocketNativeExtensionV1 *extension_;
    QLabel *errorLabel_;
    QVector<uint32_t> touches_;
    QSize viewportSize_;
    QSize pendingViewportSize_;
    int buttons_;
    int pressedButtons_;
    uint32_t nativeKeys_;
    uint32_t pressedNativeKeys_;
    bool coreInitialized_;
    bool initialized_;
    bool hasPendingViewport_;
    bool failed_;
    bool glInitialized_;
};

PocketJsRuntime::PocketJsRuntime()
    : QGLWidget(pocketJsGlFormat()),
      program_(0), guest_(0), frameNativeKeys_(0), resizingGuest_(false), destroyingGuest_(false),
      runtime_(0),
      context_(0),
      global_(JS_UNDEFINED),
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
      coreInitialized_(false),
      initialized_(false),
      hasPendingViewport_(true),
      failed_(false),
      glInitialized_(false)
{
#ifdef POCKETJS_PERF_TRACE
    framePerfTimer_ = 0; guestMs_ = 0;
    perfPrefix_ = "E:/Installs/pocketjs-perf";
#ifdef POCKETJS_SYMBIAN_UID
    const QString appPrefix = QString("E:/Installs/pocketjs-perf-%1").arg(uint32_t(POCKETJS_SYMBIAN_UID), 8, 16, QChar('0'));
    QFile appInput(appPrefix + "-input.tsv");
    if (appInput.exists() && appInput.size() > 0) perfPrefix_ = appPrefix;
#endif
    QFile::remove(perfPrefix_ + ".tsv");
    QFile::remove(perfPrefix_ + ".png");
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
    // Replay coordinates belong to the application's initial viewport. Physical
    // rotation must not change icon hit targets during a comparison run.
    if (!perfInputs_.isEmpty()) {
        setAttribute(POCKETJS_INITIAL_LOGICAL_WIDTH < POCKETJS_INITIAL_LOGICAL_HEIGHT
            ? Qt::WA_LockPortraitOrientation : Qt::WA_LockLandscapeOrientation, true);
    } else
#endif
    // The build's one orientation decision (tools/symbian-profile.ts): the
    // application's viewport range, or the --orientation build option. Every
    // other app follows the phone.
    if (POCKETJS_ORIENTATION_LOCK == 1) setAttribute(Qt::WA_LockPortraitOrientation, true);
    else if (POCKETJS_ORIENTATION_LOCK == 2) setAttribute(Qt::WA_LockLandscapeOrientation, true);
    else setAttribute(Qt::WA_AutoOrientation, true);
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
    const int interval = qMax(1, 1000 / POCKETJS_FRAME_RATE);
    timer_.start(interval, this);
}

PocketJsRuntime::~PocketJsRuntime()
{
    timer_.stop();
    destroyGuest();
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
    if (destroyingGuest_) return;
    destroyingGuest_ = true;
    initialized_ = false;
    const bool hasContext = glInitialized_ && isValid();
    if (hasContext) makeCurrent();
    PocketNativeProgram *program = program_;
    program_ = 0;
    if (program != 0) pocket_native_program_destroy(program);
    // Also covers failures before the guest vtable was registered.
    shutdownGuest(this);
    if (guest_ != 0) { pocket_guest_quickjs_destroy(guest_); guest_ = 0; }
    if (context_ != 0) {
        JS_FreeValue(context_, resizeViewport_);
        JS_FreeValue(context_, global_);
        JS_FreeContext(context_);
        context_ = 0;
    }
    if (runtime_ != 0) { JS_FreeRuntime(runtime_); runtime_ = 0; }
    if (hasContext) doneCurrent();
    coreInitialized_ = false;
    global_ = JS_UNDEFINED;
    resizeViewport_ = JS_UNDEFINED;
    appJavaScript_.clear();
    appPack_.clear();
    clearInput();
    destroyingGuest_ = false;
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
    if (!loadResource(":/pocketjs/app.js", &appJavaScript_) ||
        !loadResource(":/pocketjs/app.pak", &appPack_)) {
        return false;
    }
    if (appJavaScript_.isEmpty()) {
        fail(":/pocketjs/app.js is empty");
        return false;
    }

    // The OS window is the logical viewport and every orientation change
    // relayouts it.
    viewportSize_ = viewport;
    pendingViewportSize_ = viewport;
    hasPendingViewport_ = false;

    program_ = pocket_native_program_create_profile("symbian-e7-dev", POCKETJS_HOST_ABI,
        reinterpret_cast<const uint8_t *>(appJavaScript_.constData()), appJavaScript_.size(),
        reinterpret_cast<const uint8_t *>(appPack_.constData()), appPack_.size(),
        viewport.width(), viewport.height(), 1, POCKETJS_PHYSICS,
        pocket_profile.facts, pocket_profile.profile_hash);
    if (program_ == 0) {
        fail("PocketJS package admission or program allocation failed"); return false;
    }
    coreInitialized_ = true;
    runtime_ = JS_NewRuntime();
    if (runtime_ == 0) { fail("QuickJS runtime allocation failed"); return false; }
    JS_SetMaxStackSize(runtime_, 512 * 1024);
    context_ = JS_NewContext(runtime_);
    if (context_ == 0) { fail("QuickJS context allocation failed"); return false; }
    global_ = JS_GetGlobalObject(context_);
    JS_SetContextOpaque(context_, this);
    guest_ = pocket_guest_quickjs_attach(context_, POCKET_QJS_CANONICAL);
    if (guest_ == 0) { fail("QuickJS guest allocation failed"); return false; }
    const pocket_guest_v1 guest = { sizeof(pocket_guest_v1), evaluateGuest,
        frameGuest, collectGuest, shutdownGuest, initializeGuest };
    pocket_runtime *handle = pocket_native_program_runtime(program_);
    if (pocket_runtime_set_guest(handle, &guest, this) != POCKET_STATUS_OK ||
        pocket_native_program_boot(program_) != POCKET_STATUS_OK) {
        if (!failed_) fail(QString::fromUtf8(pocket_guest_quickjs_error(guest_)));
        return false;
    }
#if defined(POCKETJS_GL_STAGES) && defined(POCKETJS_PERF_TRACE)
    pocket_native_program_set_gl_trace(program_, recordGlStage);
#endif
    if (glInitialized_ && isValid()) {
        makeCurrent();
        const int status = pocket_native_program_gl_initialize(program_);
        doneCurrent();
        if (status != POCKET_STATUS_OK) { fail("PocketJS GLES initialization failed"); return false; }
    }
    initialized_ = true;
    return true;
}

int32_t PocketJsRuntime::initializeGuest(void *opaque, pocket_runtime *handle, const pocket_guest_environment *environment)
{
    PocketJsRuntime *self = static_cast<PocketJsRuntime *>(opaque);
    if (pocket_guest_quickjs_vtable()->initialize(self->guest_, handle, environment) != POCKET_STATUS_OK) return POCKET_STATUS_FAILED;
    if (JS_SetPropertyStr(self->context_, self->global_, "__simHz",
            JS_NewInt32(self->context_, POCKETJS_FRAME_RATE)) < 0) return POCKET_STATUS_FAILED;
    self->extension_ = pocketJsNativeExtension();
    if (self->extension_ != 0 && (self->extension_->boot == 0 ||
        self->extension_->boot(self->context_, environment->pak, environment->pak_length,
            environment->viewport_width, environment->viewport_height) == 0)) {
        self->fail("PocketJS native extension could not initialize.");
        return POCKET_STATUS_FAILED;
    }
    return POCKET_STATUS_OK;
}

int32_t PocketJsRuntime::evaluateGuest(void *opaque, pocket_runtime *handle, const uint8_t *code, size_t length)
{
    PocketJsRuntime *self = static_cast<PocketJsRuntime *>(opaque);
    if (pocket_guest_quickjs_vtable()->evaluate(self->guest_, handle, code, length) != POCKET_STATUS_OK) return POCKET_STATUS_FAILED;
    JSValue frame = JS_GetPropertyStr(self->context_, self->global_, "frame");
    const bool validFrame = JS_IsFunction(self->context_, frame);
    JS_FreeValue(self->context_, frame);
    if (!validFrame) { self->fail("app.js did not install globalThis.frame"); return POCKET_STATUS_FAILED; }
    self->resizeViewport_ = JS_GetPropertyStr(self->context_, self->global_, "__pocketResizeViewport");
    if (!JS_IsFunction(self->context_, self->resizeViewport_)) {
        self->fail("app.js did not install globalThis.__pocketResizeViewport"); return POCKET_STATUS_FAILED;
    }
    return POCKET_STATUS_OK;
}

int32_t PocketJsRuntime::frameGuest(void *opaque, const pocket_guest_frame *frame)
{
    PocketJsRuntime *self = static_cast<PocketJsRuntime *>(opaque);
#ifdef POCKETJS_PERF_TRACE
    const int startMs = self->framePerfTimer_ != 0 ? self->framePerfTimer_->elapsed() : 0;
#endif
    if (self->extension_ != 0 && self->extension_->before_guest != 0 &&
        self->extension_->before_guest(self->context_, frame->buttons, frame->analog, self->frameNativeKeys_) == 0) {
        self->fail("PocketJS native extension frame failed."); return POCKET_STATUS_FAILED;
    }
    const int status = pocket_guest_quickjs_vtable()->frame(self->guest_, frame);
    if (status != POCKET_STATUS_OK) return status;
    if (self->extension_ != 0 && self->extension_->after_guest != 0 &&
        self->extension_->after_guest(self->context_) == 0) {
        self->fail("PocketJS native extension guest handoff failed."); return POCKET_STATUS_FAILED;
    }
#ifdef POCKETJS_PERF_TRACE
    if (self->framePerfTimer_ != 0) self->guestMs_ = self->framePerfTimer_->elapsed() - startMs;
#endif
    return POCKET_STATUS_OK;
}

int32_t PocketJsRuntime::collectGuest(void *opaque)
{
    PocketJsRuntime *self = static_cast<PocketJsRuntime *>(opaque);
    if (self->resizingGuest_) {
        if (self->extension_ != 0 && self->extension_->resize != 0)
            self->extension_->resize(self->viewportSize_.width(), self->viewportSize_.height());
        JSValue arguments[2] = { JS_NewInt32(self->context_, self->viewportSize_.width()),
            JS_NewInt32(self->context_, self->viewportSize_.height()) };
        JSValue result = JS_Call(self->context_, self->resizeViewport_, self->global_, 2, arguments);
        JS_FreeValue(self->context_, arguments[0]); JS_FreeValue(self->context_, arguments[1]);
        if (JS_IsException(result)) {
            self->fail(self->takeException(self->context_)); return POCKET_STATUS_FAILED;
        }
        JS_FreeValue(self->context_, result);
    }
    return pocket_guest_quickjs_vtable()->collect(self->guest_);
}

void PocketJsRuntime::shutdownGuest(void *opaque)
{
    PocketJsRuntime *self = static_cast<PocketJsRuntime *>(opaque);
    const PocketNativeExtensionV1 *extension = self->extension_;
    self->extension_ = 0;
    if (extension != 0 && extension->shutdown != 0)
        extension->shutdown(self->glInitialized_ && self->isValid() ? 1 : 0);
    if (self->guest_ != 0) pocket_guest_quickjs_vtable()->shutdown(self->guest_);
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

void PocketJsRuntime::fail(const QString &message)
{
    if (failed_) return;
    failed_ = true;
    timer_.stop();
    errorLabel_->setText(
        QString("PocketJS E7 runtime stopped\n\n%1").arg(message)
    );
    errorLabel_->setGeometry(rect());
    errorLabel_->show();
    errorLabel_->raise();
}

void PocketJsRuntime::queueViewport(const QSize &viewport)
{
    // Symbian can report a transient empty extent while changing layout.
    // Wait for the final non-empty QWidget size rather than resizing the core
    // to a geometry it cannot render.
    if (viewport.width() <= 0 || viewport.height() <= 0) return;

    if (initialized_ && viewport == viewportSize_) {
        pendingViewportSize_ = viewport;
        hasPendingViewport_ = false;
        return;
    }
    if (hasPendingViewport_ && viewport == pendingViewportSize_) return;

    pendingViewportSize_ = viewport;
    hasPendingViewport_ = true;

    // Coordinates and held keyboard directions belong to the old screen
    // orientation. Never deliver them against the replacement layout.
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

    if (pocket_native_program_resize_viewport(program_, viewport.width(), viewport.height()) != POCKET_STATUS_OK) {
        fail("PocketJS could not resize the program viewport"); return false;
    }
    viewportSize_ = viewport;
    clearInput();
    resizingGuest_ = true;
    const int status = pocket_native_program_collect(program_);
    resizingGuest_ = false;
    if (status != POCKET_STATUS_OK) {
        if (!failed_) fail(QString::fromUtf8(pocket_guest_quickjs_error(guest_)));
        return false;
    }

    update();
    return true;
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
        touches_.clear();
        if (touch != 0) touches_.append(touch);
    }
    QElapsedTimer perfTimer;
    perfTimer.start();
#endif
    // Preserve a quick press+release for one host frame. S60 can deliver both
    // events between two 30 Hz samples even though the core advances at 60 Hz.
    const int frameButtons = buttons_ | pressedButtons_;
    const uint32_t frameNativeKeys = nativeKeys_ | pressedNativeKeys_;
    pressedButtons_ = 0;
    pressedNativeKeys_ = 0;

    frameNativeKeys_ = frameNativeKeys;
    pocket_contact contacts[kMaximumTouches];
    memset(contacts, 0, sizeof(contacts));
    const int contactCount = qMin(touches_.size(), kMaximumTouches);
    for (int index = 0; index < contactCount; ++index) {
        const uint32_t packed = touches_.at(index);
        const bool extended = (packed & 0x80000000U) != 0;
        contacts[index].struct_size = sizeof(pocket_contact);
        contacts[index].id = (packed >> (extended ? 20 : 18)) & 255;
        contacts[index].x = packed & (extended ? 1023 : 511);
        contacts[index].y = (packed >> (extended ? 10 : 9)) & (extended ? 1023 : 511);
    }
    pocket_input_frame input;
    memset(&input, 0, sizeof(input));
    input.struct_size = sizeof(input);
    input.buttons = frameButtons;
    input.contacts = contacts;
    input.contact_count = contactCount;
#ifdef POCKETJS_PERF_TRACE
    framePerfTimer_ = &perfTimer;
#endif
    const int status = pocket_native_program_advance(program_, &input, kCoreTicksPerFrame);
#ifdef POCKETJS_PERF_TRACE
    framePerfTimer_ = 0;
    const int jsMs = guestMs_;
    const int tickEndMs = perfTimer.elapsed();
#endif
    if (status != POCKET_STATUS_OK) {
        if (!failed_) fail(QString::fromUtf8(pocket_guest_quickjs_error(guest_)));
        return;
    }
    // QGLWidget::updateGL() is synchronous: paintGL() submits this frame and
    // auto-swaps before runFrame returns.
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
            perfGlStages[6] - perfGlStages[5],
            perfGlBatches, perfGlVertices, -1 };
        perfSamples_.append(sample);
        // No per-frame formatting, filesystem I/O or readback.
        // Runtime rendering waits for terminal GPU completion before returning.
        // Write only after the bounded measurement window has ended.
        if (replayMs >= 30000 || elapsedMs >= 60000 || perfSamples_.size() >= 2048) finishPerfTrace();
    }
#endif
}

#ifdef POCKETJS_PERF_TRACE
void PocketJsRuntime::finishPerfTrace()
{
    perfDone_ = true;
    QByteArray buffer;
    buffer.append("# runtime_composition\tcanonical-v1\n# hit_ms_available\t0\n");
    buffer.append("# frame_rate\t" + QByteArray::number(POCKETJS_FRAME_RATE) + "\n");
    buffer.append("# viewport\t" + QByteArray::number(width()) + "\t" + QByteArray::number(height()) + "\n");
    buffer.append("# replay_points\t" + QByteArray::number(perfInputs_.size()) + "\n");
    buffer.append("# inactive_frames\t" + QByteArray::number(perfInactiveFrames_) + "\n");
    buffer.append("# warmup_frames\t" + QByteArray::number(perfWarmupFrames_) + "\n");
    buffer.append("frame\telapsed_ms\tdelta_ms\tjs_ms\ttick_ms\tdraw_ms\tpresent_ms\ttouches\treplay_ms\tscene_ms\tresources_ms\tgeometry_ms\tupload_ms\tsubmit_ms\terror_ms\tbatches\tvertices\thit_ms\n");
    for (int i = 0; i < perfSamples_.size(); ++i) {
        const PerfSample &s = perfSamples_.at(i);
        buffer.append(QByteArray::number(i) + "\t" + QByteArray::number(s.elapsed) + "\t" +
            QByteArray::number(s.delta) + "\t" + QByteArray::number(s.js) + "\t" +
            QByteArray::number(s.tick) + "\t" + QByteArray::number(s.draw) + "\t" +
            QByteArray::number(s.present) + "\t" + QByteArray::number(s.touches) + "\t" + QByteArray::number(s.replay) + "\t" +
            QByteArray::number(s.scene) + "\t" + QByteArray::number(s.resources) + "\t" +
            QByteArray::number(s.geometry) + "\t" + QByteArray::number(s.upload) + "\t" +
            QByteArray::number(s.submit) + "\t" + QByteArray::number(s.error) + "\t" + QByteArray::number(s.batches) + "\t" +
            QByteArray::number(s.vertices) + "\t" + QByteArray::number(s.hit) + "\n");
    }
    QFile trace(perfPrefix_ + ".tsv");
    if (trace.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text)) trace.write(buffer);
    perfSamples_.clear();
}

QImage PocketJsRuntime::readFrame()
{
    if (!glInitialized_ || !isValid()) return QImage();
    const QRect sourceRect = rect();
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

    // GLES readback is RGBA and bottom-left-origin. Only the post-measurement
    // capture reads the framebuffer back; measured frames never allocate it.
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
#endif

void PocketJsRuntime::updateTouches(QTouchEvent *touchEvent)
{
    touches_.clear();

    if (!initialized_ ||
        hasPendingViewport_) {
        return;
    }

    const QRect target = rect();
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
        updateTouches(static_cast<QTouchEvent *>(event));
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
    GLint redBits = 0, greenBits = 0, blueBits = 0, alphaBits = 0;
    glGetIntegerv(GL_RED_BITS, &redBits);
    glGetIntegerv(GL_GREEN_BITS, &greenBits);
    glGetIntegerv(GL_BLUE_BITS, &blueBits);
    glGetIntegerv(GL_ALPHA_BITS, &alphaBits);
    qWarning(
        "PocketJS GLES2: version=%s vendor=%s renderer=%s maxTexture=%d rgbaBits=%d/%d/%d/%d",
        version == 0 ? "unknown" : version,
        vendor == 0 ? "unknown" : vendor,
        renderer == 0 ? "unknown" : renderer,
        maximumTextureSize, redBits, greenBits, blueBits, alphaBits
    );
#ifdef POCKETJS_PERF_TRACE
#if defined(POCKETJS_GL_STAGES) && defined(POCKETJS_PERF_TRACE)
    pocket_native_program_set_gl_trace(program_, recordGlStage);
#endif
    QFile trace(perfPrefix_ + ".tsv");
    if (trace.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text)) {
        const EGLDisplay display = eglGetCurrentDisplay();
        const EGLSurface surface = eglGetCurrentSurface(EGL_DRAW);
        EGLint swapBehavior = EGL_UNKNOWN;
        eglQuerySurface(display, surface, EGL_SWAP_BEHAVIOR, &swapBehavior);
        trace.write("# egl_swap_behavior\t");
        trace.write(QByteArray::number(swapBehavior));
        trace.write("\n# egl_version\t");
        const char *eglVersion = eglQueryString(display, EGL_VERSION);
        trace.write(eglVersion ? eglVersion : "unknown");
        trace.write("\n# gl_extensions\t");
        const char *glExtensions = reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS));
        trace.write(glExtensions ? glExtensions : "unknown");
        trace.write("\n");
        trace.write("# gles_version\t");
        trace.write(version == 0 ? "unknown" : version);
        trace.write("\n# gles_vendor\t");
        trace.write(vendor == 0 ? "unknown" : vendor);
        trace.write("\n# gles_renderer\t");
        trace.write(renderer == 0 ? "unknown" : renderer);
        trace.write("\n# max_texture_size\t");
        trace.write(QByteArray::number(maximumTextureSize));
        trace.write("\n# framebuffer_rgba_bits\t");
        trace.write(QByteArray::number(redBits) + " " +
            QByteArray::number(greenBits) + " " +
            QByteArray::number(blueBits) + " " +
            QByteArray::number(alphaBits));
        trace.write("\n");
    }
#endif
    if (maximumTextureSize < 512) {
        fail("PocketJS requires an OpenGL ES 2 texture size of at least 512.");
        return;
    }
    glInitialized_ = program_ == 0 || pocket_native_program_gl_initialize(program_) == POCKET_STATUS_OK;
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
    const QRect target = rect();
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
    const int uiRendered = pocket_native_program_gl_render_rect(program_,
        target.x(), target.y(), target.width(), target.height(), width(), height(),
        nativeRendered ? 1 : 0);
    if (uiRendered != POCKET_STATUS_OK) {
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
        if (failed_) return;

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

        if (!applyPendingViewport()) return;
        runFrame();
        return;
    }
    QGLWidget::timerEvent(event);
}

} // namespace

int main(int argc, char *argv[])
{
    // The host paints app content through GLES itself. Raster Qt chrome keeps
    // a second OpenVG graphics system out of the process.
    QApplication::setGraphicsSystem("raster");
    QApplication application(argc, argv);
    PocketJsRuntime runtime;
    runtime.showFullScreen();
    runtime.setFocus();
    return application.exec();
}
