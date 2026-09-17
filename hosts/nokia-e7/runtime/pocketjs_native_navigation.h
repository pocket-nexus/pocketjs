/* Included after PocketJsRuntime and appendJsonString; one Qt UI thread owns
 * these operations. No guest can launch an app outside the packaged table. */
bool PocketJsRuntime::initializeNativeNavigation()
{
    QFile file(":/pocketjs/navigation.tsv");
    if (!file.open(QIODevice::ReadOnly) || file.size() == 0) return true;
    if (file.size() > 16384) return false;
    const QList<QByteArray> lines = file.readAll().split('\n');
    for (int i = 0; i < lines.size(); ++i) {
        if (lines.at(i).isEmpty()) continue;
        const QList<QByteArray> fields = lines.at(i).split('\t');
        if (fields.size() != 5 || nativeApps_.size() >= 32) return false;
        bool ok = false;
        NativeApp app;
        app.uid = fields.at(0).toUInt(&ok, 16);
        if (!ok || (app.uid & 0xf0000000U) != 0xe0000000U) return false;
        app.output = QString::fromUtf8(fields.at(1));
        app.id = QString::fromUtf8(fields.at(2));
        app.title = QString::fromUtf8(fields.at(3));
        if (fields.at(4) != "auto" && fields.at(4) != "portrait") return false;
        app.portrait = fields.at(4) == "portrait";
        app.shot = -1;
        if (app.output.isEmpty() || app.id.isEmpty() || app.title.isEmpty()) return false;
        for (int j = 0; j < nativeApps_.size(); ++j) {
            const NativeApp &other = nativeApps_.at(j);
            if (app.uid == other.uid || app.id == other.id || app.output == other.output) return false;
        }
#ifdef POCKETJS_SYMBIAN_UID
        if (app.uid == POCKETJS_SYMBIAN_UID) nativeSelf_ = nativeApps_.size();
#endif
        nativeApps_.append(app);
    }
    if (nativeApps_.size() < 2 || nativeSelf_ < 0) return false;
    navigationClock_.start();
    // A cold shell accepts a child return after its guest has booted.
    return true;
}

QString PocketJsRuntime::navigationDirectory() const
{
    return QString("E:/Data/PocketJS/navigation/%1").arg(nativeApps_.first().uid, 8, 16, QChar('0'));
}

bool PocketJsRuntime::nativeInstalled(int index) const
{
#ifdef Q_OS_SYMBIAN
    RApaLsSession session;
    if (session.Connect() != KErrNone) return false;
    TApaAppInfo info;
    const TInt error = session.GetAppInfo(info, TUid::Uid(nativeApps_.at(index).uid));
    session.Close();
    return error == KErrNone;
#else
    return false;
#endif
}

QByteArray PocketJsRuntime::nativeAppTable() const
{
    QByteArray json("{\"kind\":\"native\",\"apps\":[");
    for (int i = 0; i < nativeApps_.size(); ++i) {
        if (i) json.append(',');
        const NativeApp &app = nativeApps_.at(i);
        json.append("{\"output\":"); appendJsonString(&json, app.output);
        json.append(",\"id\":"); appendJsonString(&json, app.id);
        json.append(",\"title\":"); appendJsonString(&json, app.title);
        json.append(nativeInstalled(i) ? ",\"installed\":true}" : ",\"installed\":false}");
    }
    json.append("],\"current\":"); appendJsonString(&json, nativeApps_.at(nativeSelf_).output);
    json.append(",\"resume\":null}");
    return json;
}

int PocketJsRuntime::activateNativeApp(int index)
{
#ifdef Q_OS_SYMBIAN
    const TUid uid = TUid::Uid(nativeApps_.at(index).uid);
    TApaTaskList tasks(CCoeEnv::Static()->WsSession());
    TApaTask task = tasks.FindApp(uid);
    if (task.Exists()) { task.BringToForeground(); return KErrNone; }
    RApaLsSession session;
    TInt error = session.Connect();
    if (error != KErrNone) return error;
    TThreadId thread;
    error = session.StartDocument(KNullDesC, uid, thread);
    session.Close();
    return error;
#else
    return -1;
#endif
}

void PocketJsRuntime::notifyNativeReturn(int index, int destination, int error)
{
    if (context_ == 0 || index < 0 || index >= nativeApps_.size()) return;
    JSValue callback = JS_GetPropertyStr(context_, global_, "__pocketjsNativeReturn");
    if (JS_IsFunction(context_, callback)) {
        const QByteArray output = nativeApps_.at(index).output.toUtf8();
        JSValue args[7];
        args[0] = JS_NewStringLen(context_, output.constData(), output.size());
        args[1] = JS_NewString(context_, destination == 2 ? "switcher" : "home");
        args[2] = JS_NewInt32(context_, nativeApps_.at(index).shot);
        args[3] = JS_NewInt32(context_, error);
        args[4] = JS_NewFloat64(context_, nativePoseX_);
        args[5] = JS_NewFloat64(context_, nativePoseY_);
        args[6] = JS_NewFloat64(context_, nativePoseScale_);
        JSValue result = JS_Call(context_, callback, global_, 7, args);
        for (int i = 0; i < 7; ++i) JS_FreeValue(context_, args[i]);
        if (JS_IsException(result)) fail(takeException(context_));
        JS_FreeValue(context_, result);
    }
    JS_FreeValue(context_, callback);
}

void PocketJsRuntime::receiveNativeReturn()
{
    if (nativeSelf_ != 0) return;
    int index = lastNativeApp_, destination = 1;
    nativePoseX_ = nativePoseY_ = 0; nativePoseScale_ = 1;
    QFile mailbox(navigationDirectory() + "/return.tsv");
    if (mailbox.open(QIODevice::ReadOnly)) {
        const QList<QByteArray> fields = mailbox.read(256).trimmed().split('\t');
        if (fields.size() == 5) {
            for (int i = 1; i < nativeApps_.size(); ++i) {
                if (fields.at(0) == nativeApps_.at(i).output.toUtf8()) {
                    index = i; destination = fields.at(1) == "2" ? 2 : 1;
                    bool xok=false, yok=false, sok=false;
                    const double x=fields.at(2).toDouble(&xok), y=fields.at(3).toDouble(&yok), scale=fields.at(4).toDouble(&sok);
                    if (xok && yok && sok && x>=0 && x<=0.1 && y>=-0.2 && y<=0 && scale>=0.8 && scale<=1) {
                        nativePoseX_=x; nativePoseY_=y; nativePoseScale_=scale;
                    }
                    break;
                }
            }
        }
        mailbox.close(); mailbox.remove();
    }
    lastNativeApp_ = -1;
    if (index < 0) return;
    NativeApp &app = nativeApps_[index];
    QImage shot(navigationDirectory() + QString("/%1.png").arg(app.uid, 8, 16, QChar('0')));
    if (!shot.isNull() && shot.width() <= 640 && shot.height() <= 640) {
        // Texture uploads require power-of-two edges no larger than 512.
        // The shell stretches this thumbnail back to the card's aspect ratio.
        shot = shot.scaled(shot.width() > shot.height() ? 512 : 256,
            shot.width() > shot.height() ? 256 : 512, Qt::IgnoreAspectRatio, Qt::SmoothTransformation)
            .convertToFormat(QImage::Format_ARGB32);
        QByteArray rgba(shot.width() * shot.height() * 4, 0);
        for (int y = 0; y < shot.height(); ++y) for (int x = 0; x < shot.width(); ++x) {
            const QRgb p = shot.pixel(x, y); const int offset = (y * shot.width() + x) * 4;
            rgba[offset] = qRed(p); rgba[offset + 1] = qGreen(p); rgba[offset + 2] = qBlue(p); rgba[offset + 3] = 255;
        }
        if (app.shot >= 0) ui_free_texture(app.shot);
        app.shot = ui_upload_texture(reinterpret_cast<const uint8_t *>(rgba.constData()), rgba.size(), shot.width(), shot.height(), kPixelStorage8888);
    }
    notifyNativeReturn(index, destination, 0);
}

void PocketJsRuntime::finishNativeLaunch()
{
    if (pendingNativeApp_ < 0) return;
    const int next = pendingNativeApp_; pendingNativeApp_ = -1;
    if (nativeSelf_ > 0 && next == 0) {
        QDir().mkpath(navigationDirectory());
        if (!nativeReturnShot_.isNull()) {
            nativeReturnShot_.save(navigationDirectory() + QString("/%1.png").arg(nativeApps_.at(nativeSelf_).uid, 8, 16, QChar('0')));
        }
        const QRect pose = presentationRect();
        QFile mailbox(navigationDirectory() + "/return.tsv");
        if (mailbox.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            mailbox.write(nativeApps_.at(nativeSelf_).output.toUtf8() + "\t" + QByteArray::number(nativeReturnDestination_) + "\t" + QByteArray::number(double(pose.x()) / width()) + "\t" + QByteArray::number(double(pose.y()) / height()) + "\t" + QByteArray::number(double(pose.width()) / width()) + "\n");
        }
    }
    // Retire our surface before the destination allocates one. Waiting for a
    // background notification permits a transient two-context GPU peak.
    suspendNativeGraphics();
    nativeActivationDeadline_ = navigationClock_.elapsed() + 5000;
    const int error = activateNativeApp(next);
#ifdef POCKETJS_PERF_TRACE
    recordNativeEvent("launch", next, error);
#endif
    if (error == 0 && nativeSelf_ == 0) lastNativeApp_ = next;
    if (error != 0) {
        nativeActivationDeadline_ = 0;
        resumeNativeGraphics();
        notifyNativeReturn(next, 1, error);
        // A missing shell leaves the child usable, with its return handle.
        qWarning("PocketJS native app launch failed: %d", error);
    }
    navigationGesture_.reset();
    clearInput();
}

bool PocketJsRuntime::navigationTouch(QTouchEvent *event)
{
    if (nativeSelf_ <= 0) return false;
    if (event->type() == QEvent::TouchBegin) nativeIgnoreUntilRelease_ = false;
    if (nativeIgnoreUntilRelease_) {
        if (event->type() == QEvent::TouchEnd) nativeIgnoreUntilRelease_ = false;
        return true;
    }
    const QList<QTouchEvent::TouchPoint> points = event->touchPoints();
    const int now = navigationClock_.elapsed();
    if (event->type() == QEvent::TouchBegin && points.size() == 1) {
        const QTouchEvent::TouchPoint &p = points.first();
        if (navigationGesture_.begin(p.id(), p.pos().x(), p.pos().y(), height(), now)) { clearInput(); nativeShotPending_ = true; }
    }
    if (!navigationGesture_.owned) return false;
    if (points.size() > 1) navigationGesture_.cancelled = true;
    for (int i = 0; i < points.size(); ++i) {
        const QTouchEvent::TouchPoint &p = points.at(i);
        if (p.id() == navigationGesture_.id) navigationGesture_.move(p.pos().x(), p.pos().y(), now);
    }
    if (event->type() == QEvent::TouchEnd) {
        nativeReturnDestination_ = navigationGesture_.release(now);
        if (nativeReturnDestination_ > 0) pendingNativeApp_ = 0;
        else navigationGesture_.reset();
    }
    touches_.clear();
    return true;
}

void PocketJsRuntime::paintNavigationBar()
{
    if (nativeSelf_ <= 0) return;
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, width(), 28);
    glClearColor(0.06f, 0.07f, 0.10f, 1.0f); glClear(GL_COLOR_BUFFER_BIT);
    glScissor((width() - 96) / 2, 10, 96, 4);
    glClearColor(0.9f, 0.91f, 0.94f, 1.0f); glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
}

bool PocketJsRuntime::requestAppClose(const QString &output)
{
#ifdef Q_OS_SYMBIAN
    if (nativeSelf_ != 0) return false;
    for (int i = 1; i < nativeApps_.size(); ++i) {
        if (nativeApps_.at(i).output != output) continue;
        TApaTaskList tasks(CCoeEnv::Static()->WsSession());
        TApaTask task = tasks.FindApp(TUid::Uid(nativeApps_.at(i).uid));
        if (task.Exists()) task.EndTask();
#ifdef POCKETJS_PERF_TRACE
        recordNativeEvent("close", i, 0);
#endif
        QFile::remove(navigationDirectory() + QString("/%1.png").arg(nativeApps_.at(i).uid, 8, 16, QChar('0')));
        return true;
    }
#endif
    return false;
}

#ifdef POCKETJS_PERF_TRACE
void PocketJsRuntime::recordNativeEvent(const char *action, int index, int error)
{
    if (index < 0 || index >= nativeApps_.size()) return;
    QFile file(perfPrefix_ + "-navigation.tsv");
    if (file.open(QIODevice::WriteOnly | QIODevice::Append)) {
        file.write(QByteArray(action) + "\t" + nativeApps_.at(index).output.toUtf8() + "\t" +
            QByteArray::number(error) + "\t" + QByteArray::number(perfSamples_.size()) + "\t" +
            QByteArray::number(isActiveWindow() ? 1 : 0) + "\n");
    }
}
#endif

// VideoCore's graphics OOM monitor can terminate background QGLWidget apps
// even while ordinary RAM is available. Retire the EGL surface/context too.
void PocketJsRuntime::suspendNativeGraphics()
{
    if (nativeGraphicsSuspended_ || !glInitialized_) return;
    if (extension_ && extension_->struct_size < sizeof(PocketJsSymbianGraphicsExtensionV1)) return;
    setUpdatesEnabled(false);
    makeCurrent();
    if (extension_) {
        const PocketJsSymbianGraphicsExtensionV1 *graphics =
            reinterpret_cast<const PocketJsSymbianGraphicsExtensionV1 *>(extension_);
        if (graphics->release_graphics) graphics->release_graphics(1);
    }
    ui_gl_shutdown();
    doneCurrent();
    const_cast<QGLContext *>(context())->reset();
    // VideoCore retains per-client pools after the last context is destroyed.
    // This host uses raster Qt chrome and owns the process's only EGL client.
    eglTerminate(eglGetDisplay(EGL_DEFAULT_DISPLAY));
    eglReleaseThread();
    glInitialized_ = false;
    nativeGraphicsSuspended_ = true;
#ifdef POCKETJS_PERF_TRACE
    recordNativeEvent("suspend-graphics", nativeSelf_, 0);
#endif
}

bool PocketJsRuntime::resumeNativeGraphics()
{
    if (!nativeGraphicsSuspended_) return true;
    if (!eglInitialize(eglGetDisplay(EGL_DEFAULT_DISPLAY), 0, 0)) {
        fail("PocketJS could not restore its EGL connection.");
        return false;
    }
    if (!const_cast<QGLContext *>(context())->create()) {
        fail("PocketJS could not restore its OpenGL ES 2 context.");
        return false;
    }
    nativeGraphicsSuspended_ = false;
    setUpdatesEnabled(true);
#ifdef POCKETJS_PERF_TRACE
    recordNativeEvent("resume-graphics", nativeSelf_, 0);
#endif
    // QGLWidget invokes initializeGL again after QGLContext::reset/create.
    // CPU textures and the native scene remain retained for the first paint.
    updateGL();
    return !failed_ && glInitialized_;
}
