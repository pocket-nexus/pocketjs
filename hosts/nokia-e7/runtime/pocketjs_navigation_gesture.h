#ifndef POCKETJS_NAVIGATION_GESTURE_H
#define POCKETJS_NAVIGATION_GESTURE_H

/* A contact belongs to the reserved bar for its entire lifetime. Neither a
 * cancelled gesture nor its release may leak into the app below it. */
struct PocketJsNavigationGesture {
    int id, startX, startY, x, y, quietSince;
    bool owned, cancelled;
    PocketJsNavigationGesture() { reset(); }
    void reset() { id = -1; owned = false; cancelled = false; x = y = startX = startY = quietSince = 0; }
    bool begin(int contact, int px, int py, int height, int now) {
        reset();
        if (py < height - 28) return false;
        id = contact; x = startX = px; y = startY = py;
        quietSince = now; owned = true;
        return true;
    }
    void move(int px, int py, int now) {
        if (px - x > 3 || x - px > 3 || py - y > 3 || y - py > 3) quietSince = now;
        x = px; y = py;
    }
    int lift() const { return owned && !cancelled && y < startY ? startY - y : 0; }
    // 0 cancels, 1 returns Home, 2 opens the Shell switcher. Tap also returns.
    int release(int now) const {
        if (!owned || cancelled) return 0;
        int dx = x - startX; if (dx < 0) dx = -dx;
        int dy = y - startY; if (dy < 0) dy = -dy;
        if (dx < 8 && dy < 8) return 1;
        if (lift() < 24 || dx > lift()) return 0;
        return now - quietSince >= 220 ? 2 : 1;
    }
};
#endif
