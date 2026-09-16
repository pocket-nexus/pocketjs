package dev.pocketstack.android;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Android surface and lifecycle adapter for the shared PocketJS runtime. */
public class PocketActivity extends Activity {
    private static boolean nativeLoaded;
    private static String nativeLoadError = "";

    static {
        try {
            System.loadLibrary("pocketjs");
            nativeLoaded = true;
        } catch (Throwable error) {
            nativeLoaded = false;
            nativeLoadError = error.getClass().getSimpleName() + ": " + error.getMessage();
        }
    }

    private PocketSurfaceView surfaceView;
    private TextView errorView;

    private static native void nativeConfigure(String directory);
    private static native int nativeLogicalWidth();
    private static native int nativeLogicalHeight();
    private static native void nativeCancelTouches();
    private static native String nativeSurfaceCreated(byte[] guestJavaScript, byte[] guestPack);
    private static native void nativeSurfaceChanged(int width, int height);
    private static native boolean nativeFrame();
    private static native String nativeError();
    private static native void nativeKey(
        int action,
        int keyCode,
        int scanCode,
        int unicode,
        int repeat
    );
    private static native void nativeTouch(int action, int pointerId, float x, float y);
    private static native void nativeRelative(
        float deltaX,
        float deltaY,
        int action,
        int buttonState
    );

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        if (android.os.Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            try { attributes.getClass().getField("layoutInDisplayCutoutMode").setInt(attributes, 1); getWindow().setAttributes(attributes); }
            catch (Exception ignored) {}
        }
        if (android.os.Build.VERSION.SDK_INT >= 19) getWindow().getDecorView().setSystemUiVisibility(0x1000 | 0x200 | 0x400 | 0x100 | 0x4 | 0x2);
        if (nativeLoaded) nativeConfigure(getFilesDir().getAbsolutePath());
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        surfaceView = new PocketSurfaceView();
        root.addView(
            surfaceView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
            )
        );

        errorView = new TextView(this);
        errorView.setTextColor(Color.WHITE);
        errorView.setTextSize(15.0f);
        errorView.setTypeface(Typeface.MONOSPACE);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(28, 28, 28, 28);
        errorView.setBackgroundColor(0xff250d12);
        errorView.setText(nativeLoaded ? "BOOTING POCKETJS…" : "JNI FAILED\n" + nativeLoadError);
        root.addView(
            errorView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        surfaceView.onResume();
        surfaceView.requestFocus();
    }

    @Override
    protected void onPause() {
        if (nativeLoaded) nativeCancelTouches();
        surfaceView.onPause();
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) {
            surfaceView.requestFocus();
            if (android.os.Build.VERSION.SDK_INT >= 19) getWindow().getDecorView().setSystemUiVisibility(0x1000 | 0x200 | 0x400 | 0x100 | 0x4 | 0x2);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (nativeLoaded) {
            nativeKey(
                event.getAction(),
                event.getKeyCode(),
                event.getScanCode(),
                event.getUnicodeChar(event.getMetaState()),
                event.getRepeatCount()
            );
        }
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK ||
            event.getKeyCode() == KeyEvent.KEYCODE_HOME ||
            event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_UP ||
            event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.dispatchKeyEvent(event);
        }
        return true;
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (!nativeLoaded) return super.dispatchTouchEvent(event);
        int action = event.getActionMasked();
        int changed = event.getActionIndex();
        if (action == MotionEvent.ACTION_MOVE) {
            for (int index = 0; index < event.getPointerCount(); index++) {
                nativeTouch(
                    action,
                    event.getPointerId(index),
                    event.getX(index) - surfaceView.getLeft(),
                    event.getY(index) - surfaceView.getTop()
                );
            }
        } else if (action == MotionEvent.ACTION_CANCEL) {
            for (int index = 0; index < event.getPointerCount(); index++) {
                nativeTouch(
                    action,
                    event.getPointerId(index),
                    event.getX(index) - surfaceView.getLeft(),
                    event.getY(index) - surfaceView.getTop()
                );
            }
        } else {
            nativeTouch(
                action,
                event.getPointerId(changed),
                event.getX(changed) - surfaceView.getLeft(),
                event.getY(changed) - surfaceView.getTop()
            );
        }
        return true;
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (!nativeLoaded) return super.dispatchGenericMotionEvent(event);
        float horizontal = event.getAxisValue(MotionEvent.AXIS_HSCROLL);
        float vertical = event.getAxisValue(MotionEvent.AXIS_VSCROLL);
        nativeRelative(horizontal, vertical, event.getActionMasked(), event.getButtonState());
        return true;
    }

    @Override
    public boolean onTrackballEvent(MotionEvent event) {
        if (!nativeLoaded) return super.onTrackballEvent(event);
        nativeRelative(event.getX(), event.getY(), event.getActionMasked(), event.getButtonState());
        return true;
    }

    private void showBootResult(final String result) {
        runOnUiThread(new Runnable() {
            public void run() {
                if ("ok".equals(result)) {
                    errorView.setVisibility(View.GONE);
                } else {
                    errorView.setText("POCKETJS BOOT FAILED\n\n" + result);
                    errorView.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private void showRuntimeError(final String error) {
        runOnUiThread(new Runnable() {
            public void run() {
                errorView.setText("POCKETJS RUNTIME FAILED\n\n" + error);
                errorView.setVisibility(View.VISIBLE);
            }
        });
    }

    private byte[] readAsset(String name) throws IOException {
        InputStream input = getAssets().open(name);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        } finally {
            input.close();
        }
    }

    private final class PocketSurfaceView extends GLSurfaceView {
        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
            int logicalWidth = nativeLoaded ? nativeLogicalWidth() : 320;
            int logicalHeight = nativeLoaded ? nativeLogicalHeight() : 480;
            if ((long)width * logicalHeight > (long)height * logicalWidth) width = height * logicalWidth / logicalHeight;
            else height = width * logicalHeight / logicalWidth;
            setMeasuredDimension(width, height);
        }
        PocketSurfaceView() {
            super(PocketActivity.this);
            setEGLContextClientVersion(2);
            setPreserveEGLContextOnPause(true);
            setFocusable(true);
            setFocusableInTouchMode(true);
            setRenderer(new PocketRenderer());
            setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        }
    }

    private final class PocketRenderer implements GLSurfaceView.Renderer {
        private boolean failed;

        public void onSurfaceCreated(
            javax.microedition.khronos.opengles.GL10 ignored,
            javax.microedition.khronos.egl.EGLConfig config
        ) {
            if (!nativeLoaded) return;
            String result;
            try {
                result = nativeSurfaceCreated(readAsset("app.js"), readAsset("app.pak"));
            } catch (IOException error) {
                result = "APK asset read failed: " + error.getMessage();
            }
            failed = !"ok".equals(result);
            showBootResult(result);
        }

        public void onSurfaceChanged(
            javax.microedition.khronos.opengles.GL10 ignored,
            int width,
            int height
        ) {
            if (nativeLoaded) nativeSurfaceChanged(width, height);
        }

        public void onDrawFrame(javax.microedition.khronos.opengles.GL10 ignored) {
            if (!nativeLoaded || failed) return;
            if (!nativeFrame()) {
                failed = true;
                showRuntimeError(nativeError());
            }
        }
    }
}
