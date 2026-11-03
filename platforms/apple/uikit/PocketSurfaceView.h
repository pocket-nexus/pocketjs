// PocketSurfaceView — a UIKit view that hosts one PocketJS guest: display-link
// driven ticks, packed touch input, and damage-gated compositing of the
// software-rasterized ARGB framebuffer. Main thread only.

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface PocketSurfaceView : UIView

// density is the raster scale (1..4; use 2 or 3 to match screen scale).
- (instancetype)initWithFrame:(CGRect)frame
                 logicalWidth:(uint32_t)logicalWidth
                logicalHeight:(uint32_t)logicalHeight
                      density:(uint32_t)density;

// Struct-free convenience for bridged callers; frame starts at zero and is
// laid out by the parent view system.
+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density;

// Standalone hosts that share PocketSurfaceView's ABI but publish a distinct
// platform target use this initializer. The default initializer above keeps
// publishing ios-dev/7 for the NativeScript shell.
+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density
                                 hostId:(NSString *)hostId
                                hostAbi:(uint32_t)hostAbi;

// The embedding engine receives canonical guest initialization, evaluation,
// frame and shutdown callbacks. The runtime still owns admission/input/present.
+ (instancetype)externalSurfaceWithLogicalWidth:(uint32_t)logicalWidth
                                  logicalHeight:(uint32_t)logicalHeight
                                        density:(uint32_t)density;
@property(nonatomic, copy, nullable) BOOL (^onGuestInitialize)(NSDictionary *environment);
@property(nonatomic, copy, nullable) BOOL (^onGuestEvaluate)(NSString *source);
@property(nonatomic, copy, nullable) BOOL (^onGuestFrame)(NSDictionary *frame);
@property(nonatomic, copy, nullable) void (^onGuestShutdown)(void);
- (BOOL)supportsOperation:(uint16_t)operation;
// Records have kind integer/real/bytes and a NSNumber/NSData value. The result
// is copied before another runtime operation can invalidate borrowed bytes.
- (NSDictionary *)dispatchOperation:(uint16_t)operation arguments:(NSArray<NSDictionary *> *)arguments;
- (int32_t)uiHitTestBounds:(float)x y:(float)y;

// Feed assets before start. Returns NO with `lastError` set on failure.
- (BOOL)loadPak:(NSData *)pak;
- (BOOL)evalBundle:(NSString *)source label:(nullable NSString *)label;

// Convenience: reads <name>.js and <name>.pak from a directory.
- (BOOL)loadAppNamed:(NSString *)name fromDirectory:(NSString *)directory;

// Ticks per second of guest virtual time, and the rate the display link is
// pinned to. 0 means the 60 Hz default. Set before the bundle evaluates
// (evalBundle here, or the embedding runtime's guest eval in external mode):
// the mount publishes the rate to the guest as ui.__tickHz, and a later set
// is rejected through lastError/onError, keeping the declared rate. The
// bundle must have been built for the same rate (`pocket ios build --hz=<n>`).
@property(nonatomic) uint32_t tickRate;

// Starts/stops the CADisplayLink. start after evalBundle succeeds.
- (void)start;

// Starts a main-run-loop timer at tickRate instead of CADisplayLink. Connected
// device hosts use this only when their runtime does not deliver display-link
// callbacks; it is mutually exclusive with start.
- (void)startWithFixedFrameTimer;
- (void)stop;
// Stops and destroys the runtime. A call from a guest/effect callback defers
// destruction until that callback returns. The view cannot restart afterward.
- (void)disposeRuntime;

// Guest -> host effect lines (JSON by convention), delivered on the main
// thread during the display tick.
@property(nonatomic, copy, nullable) void (^onEffect)(NSString *line);

// Called after a guest frame has advanced and rendered successfully. Native
// device hosts use this for liveness and touch receipts without observing or
// changing application state.
@property(nonatomic, copy, nullable) void (^onFrame)
    (uint64_t frameNumber, NSUInteger touchCount);

// Host -> guest: queued for the guest's next poll (frame-boundary delivery).
- (void)postEvent:(NSString *)line;

@property(nonatomic, readonly) uint32_t logicalWidth;
@property(nonatomic, readonly) uint32_t logicalHeight;
@property(nonatomic, readonly, nullable) NSString *lastError;
@property(nonatomic, copy, nullable) void (^onError)(NSString *message);

@end

NS_ASSUME_NONNULL_END
