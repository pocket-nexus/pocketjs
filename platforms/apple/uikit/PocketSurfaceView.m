#import "PocketSurfaceView.h"

#import <QuartzCore/QuartzCore.h>

#include "pocket_apple.h"

// The guest sees at most 8 contacts; slots map UITouch identity to the packed
// word's id bits for the touch's lifetime.
#define POCKET_MAX_TOUCHES 8

// Platform-contract identity published to plan-built guests
// (framework/src/host.ts assertNativeHostContract). Must match the ios-dev
// profile in tools/ios-profile.ts; external-guest hosts publish the same pair
// on the ui namespace they mount.
static const char *const kPocketSurfaceHostId = "ios-dev";
static const uint32_t kPocketSurfaceHostAbi = POCKET_BINDING_GENERATION;

// spec FIXED_DT — the rate a realm runs at when `tickRate` is left unset.
static const uint32_t kPocketSurfaceDefaultTickRate = 60;

typedef struct {
  __weak UITouch *touch;
  CGPoint point;
  BOOL live;
  BOOL reported;
  BOOL used;
  BOOL cancelled;
} PocketTouchSlot;

@interface PocketSurfaceView ()
- (instancetype)initWithFrame:(CGRect)frame
                 logicalWidth:(uint32_t)logicalWidth
                logicalHeight:(uint32_t)logicalHeight
                      density:(uint32_t)density
                       hostId:(NSString *)hostId
                      hostAbi:(uint32_t)hostAbi;
@end

static int32_t PocketGuestInitialize(void *context, pocket_runtime *runtime, const pocket_guest_environment *environment) {
  (void)runtime;
  __unsafe_unretained PocketSurfaceView *view = (__bridge PocketSurfaceView *)context;
  if (view.onGuestInitialize == nil) return POCKET_STATUS_FAILED;
  NSMutableArray *textures = [NSMutableArray array];
  NSMutableArray *sprites = [NSMutableArray array];
  for (size_t i = 0; i < environment->texture_count; i++) {
    const pocket_named_texture *item = &environment->textures[i];
    NSString *name = [[NSString alloc] initWithBytes:item->name length:item->name_length encoding:NSUTF8StringEncoding];
    if (name == nil) return POCKET_STATUS_INVALID;
    [textures addObject:@{ @"name": name, @"handle": @(item->handle) }];
  }
  for (size_t i = 0; i < environment->sprite_count; i++) {
    const pocket_named_sprite *item = &environment->sprites[i];
    NSString *name = [[NSString alloc] initWithBytes:item->name length:item->name_length encoding:NSUTF8StringEncoding];
    if (name == nil) return POCKET_STATUS_INVALID;
    [sprites addObject:@{ @"name": name, @"handle": @(item->handle), @"frames": @(item->frames), @"columns": @(item->columns), @"step": @(item->step) }];
  }
  NSString *host = [[NSString alloc] initWithBytes:environment->host length:environment->host_length encoding:NSUTF8StringEncoding];
  if (host == nil) return POCKET_STATUS_INVALID;
  NSDictionary *metadata = @{ @"host": host, @"hostAbi": @(environment->host_abi), @"tickHz": @(environment->tick_hz),
    @"viewport": @{ @"w": @(environment->viewport_width), @"h": @(environment->viewport_height) },
    @"rasterDensity": @(environment->raster_density), @"textures": textures, @"sprites": sprites,
    @"pak": [NSData dataWithBytes:environment->pak length:environment->pak_length] };
  @try { return view.onGuestInitialize(metadata) ? 0 : POCKET_STATUS_FAILED; }
  @catch (NSException *exception) { (void)exception; return POCKET_STATUS_FAILED; }
}
static int32_t PocketGuestEvaluate(void *context, pocket_runtime *runtime, const uint8_t *code, size_t length) {
  (void)runtime;
  __unsafe_unretained PocketSurfaceView *view = (__bridge PocketSurfaceView *)context;
  if (length > 0 && code[length - 1] == 0) length--;
  NSString *source = [[NSString alloc] initWithBytes:code length:length encoding:NSUTF8StringEncoding];
  if (source == nil || view.onGuestEvaluate == nil) return POCKET_STATUS_FAILED;
  @try { return view.onGuestEvaluate(source) ? 0 : POCKET_STATUS_FAILED; }
  @catch (NSException *exception) { (void)exception; return POCKET_STATUS_FAILED; }
}
static int32_t PocketGuestFrame(void *context, const pocket_guest_frame *frame) {
  __unsafe_unretained PocketSurfaceView *view = (__bridge PocketSurfaceView *)context;
  if (view.onGuestFrame == nil) return POCKET_STATUS_FAILED;
  NSMutableArray *touches = [NSMutableArray array], *hits = [NSMutableArray array], *surfaces = [NSMutableArray array];
  for (size_t i = 0; i < frame->touch_count; i++) {
    [touches addObject:@(frame->touches[i])]; [hits addObject:@(frame->hits[i])]; [surfaces addObject:@(frame->touch_surfaces[i])];
  }
  NSDictionary *input = @{ @"buttons": @(frame->buttons), @"analog": @(frame->analog), @"touches": touches,
    @"hits": hits, @"surfaces": surfaces, @"rightAnalog": @(frame->right_analog) };
  @try { return view.onGuestFrame(input) ? 0 : POCKET_STATUS_FAILED; }
  @catch (NSException *exception) { (void)exception; return POCKET_STATUS_FAILED; }
}
static void PocketGuestShutdown(void *context) {
  __unsafe_unretained PocketSurfaceView *view = (__bridge PocketSurfaceView *)context;
  @try { if (view.onGuestShutdown != nil) view.onGuestShutdown(); }
  @catch (NSException *exception) { (void)exception; }
}
static const pocket_guest_v1 PocketExternalGuest = {
  .struct_size = sizeof(pocket_guest_v1), .initialize = PocketGuestInitialize,
  .evaluate = PocketGuestEvaluate, .frame = PocketGuestFrame, .shutdown = PocketGuestShutdown,
};

@implementation PocketSurfaceView {
  PocketApple *_handle;
  CADisplayLink *_displayLink;
  NSTimer *_frameTimer;
  CGColorSpaceRef _colorSpace;
  PocketTouchSlot _touchSlots[POCKET_MAX_TOUCHES];
  uint32_t _density;
  uint64_t _frameNumber;
  BOOL _running;
  BOOL _runtimeCallActive;
  BOOL _disposeAfterCall;
}

+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density {
  return [[self alloc] initWithFrame:CGRectZero
                        logicalWidth:logicalWidth
                       logicalHeight:logicalHeight
                             density:density];
}

+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density
                                 hostId:(NSString *)hostId
                                hostAbi:(uint32_t)hostAbi {
  return [[self alloc] initWithFrame:CGRectZero
                        logicalWidth:logicalWidth
                       logicalHeight:logicalHeight
                             density:density
                              hostId:hostId
                             hostAbi:hostAbi];
}

+ (instancetype)externalSurfaceWithLogicalWidth:(uint32_t)logicalWidth
                                  logicalHeight:(uint32_t)logicalHeight
                                        density:(uint32_t)density {
  PocketSurfaceView *view = [[self alloc] initWithFrame:CGRectZero
                                           logicalWidth:logicalWidth
                                          logicalHeight:logicalHeight
                                                density:density];
  if (view != nil && view->_handle != NULL) {
    if (pocket_apple_set_guest(view->_handle, &PocketExternalGuest, (__bridge void *)view) != 0) [view captureError];
  }
  return view;
}

- (instancetype)initWithFrame:(CGRect)frame
                 logicalWidth:(uint32_t)logicalWidth
                logicalHeight:(uint32_t)logicalHeight
                      density:(uint32_t)density {
  return [self initWithFrame:frame
                logicalWidth:logicalWidth
               logicalHeight:logicalHeight
                     density:density
                      hostId:[NSString stringWithUTF8String:kPocketSurfaceHostId]
                     hostAbi:kPocketSurfaceHostAbi];
}

- (instancetype)initWithFrame:(CGRect)frame
                 logicalWidth:(uint32_t)logicalWidth
                logicalHeight:(uint32_t)logicalHeight
                      density:(uint32_t)density
                       hostId:(NSString *)hostId
                      hostAbi:(uint32_t)hostAbi {
  self = [super initWithFrame:frame];
  if (self) {
    _logicalWidth = logicalWidth;
    _logicalHeight = logicalHeight;
    _density = density;
    _handle = pocket_apple_create(density, logicalWidth, logicalHeight);
    if (_handle == NULL) {
      [self captureError];
    } else if (hostId.length == 0 || hostAbi == 0 ||
               pocket_apple_set_identity(_handle, hostId.UTF8String, hostAbi) != 0) {
      [self captureError];
    }
    _colorSpace = CGColorSpaceCreateDeviceRGB();
    self.multipleTouchEnabled = YES;
    self.layer.contentsGravity = kCAGravityResizeAspect;
    self.backgroundColor = [UIColor blackColor];

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appDidEnterBackground)
                                                 name:UIApplicationDidEnterBackgroundNotification
                                               object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appWillEnterForeground)
                                                 name:UIApplicationWillEnterForegroundNotification
                                               object:nil];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [_displayLink invalidate];
  [_frameTimer invalidate];
  if (_handle != NULL) {
    PocketApple *handle = _handle;
    _handle = NULL;
    pocket_apple_destroy(handle);
  }
  if (_colorSpace != NULL) {
    CGColorSpaceRelease(_colorSpace);
  }
}

- (void)captureError {
  const char *message = pocket_apple_last_error();
  _lastError = message != NULL ? @(message) : @"unknown pocket-apple error";
  if (self.onError != nil) {
    self.onError(_lastError);
  }
}

static void PocketSurfaceEffectTrampoline(const char *line, void *context) {
  __unsafe_unretained PocketSurfaceView *view = (__bridge PocketSurfaceView *)context;
  @try {
    if (view.onEffect != nil && line != NULL) view.onEffect(@(line));
  } @catch (NSException *exception) {
    // Objective-C exceptions must never unwind across the Rust C callback.
    [view stop];
    @try { if (view.onError != nil) view.onError(exception.reason ?: @"host effect failed"); }
    @catch (NSException *nested) { (void)nested; }
  }
}

- (void)setOnEffect:(void (^)(NSString *))onEffect {
  _onEffect = [onEffect copy];
  if (_handle != NULL) {
    // The handle is destroyed in dealloc, so the unretained self reference
    // can never outlive the registration.
    pocket_apple_set_effect_callback(
        _handle, onEffect != nil ? PocketSurfaceEffectTrampoline : NULL,
        (__bridge void *)self);
  }
}

- (void)postEvent:(NSString *)line {
  if (line.length == 0) {
    return;
  }
  if (_handle != NULL) pocket_apple_post_event(_handle, line.UTF8String);
}

- (BOOL)loadPak:(NSData *)pak {
  if (pak.length == 0) {
    return NO;
  }
  if (_handle == NULL) {
    return NO;
  }
  if (pocket_apple_load_pak(_handle, pak.bytes, pak.length) != 0) {
    [self captureError];
    return NO;
  }
  return YES;
}

- (BOOL)evalBundle:(NSString *)source label:(NSString *)label {
  if (_handle == NULL || source.length == 0) {
    return NO;
  }
  NSData *utf8 = [source dataUsingEncoding:NSUTF8StringEncoding];
  _runtimeCallActive = YES;
  int32_t status = pocket_apple_eval_bundle(_handle, utf8.bytes, utf8.length,
                               label != nil ? label.UTF8String : NULL);
  _runtimeCallActive = NO;
  if (_disposeAfterCall) { [self disposeRuntime]; return NO; }
  if (status != 0) {
    [self captureError];
    return NO;
  }
  return YES;
}

- (BOOL)loadAppNamed:(NSString *)name fromDirectory:(NSString *)directory {
  NSString *jsPath = [directory stringByAppendingPathComponent:
                                    [name stringByAppendingPathExtension:@"js"]];
  NSString *pakPath = [directory stringByAppendingPathComponent:
                                     [name stringByAppendingPathExtension:@"pak"]];
  NSData *pak = [NSData dataWithContentsOfFile:pakPath];
  NSString *bundle = [NSString stringWithContentsOfFile:jsPath
                                               encoding:NSUTF8StringEncoding
                                                  error:nil];
  if (pak == nil || bundle == nil) {
    _lastError = [NSString stringWithFormat:@"missing app assets: %@ / %@", jsPath, pakPath];
    if (self.onError != nil) {
      self.onError(_lastError);
    }
    return NO;
  }
  return [self loadPak:pak] && [self evalBundle:bundle label:name];
}

- (void)setTickRate:(uint32_t)tickRate {
  // Applied to the realm immediately: the rate has to be declared before the
  // bundle evaluates (the mount publishes it as ui.__tickHz, and mount-time
  // animate() calls convert ms to frames at the rate in force). A rejected
  // set surfaces through lastError/onError and leaves the old rate pinned.
  uint32_t rate = tickRate > 0 ? tickRate : kPocketSurfaceDefaultTickRate;
  int32_t status = 0;
  if (_handle != NULL) {
    status = pocket_apple_set_tick_rate(_handle, rate);
  }
  if (status != 0) {
    [self captureError];
    return;
  }
  _tickRate = tickRate;
}

- (void)start {
  if (_running || _handle == NULL) {
    return;
  }
  _running = YES;
  // The realm's rate was declared through setTickRate before the bundle
  // evaluated; the display link is pinned to the same cadence here.
  uint32_t rate = _tickRate > 0 ? _tickRate : kPocketSurfaceDefaultTickRate;
  _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(handleDisplayTick:)];
  if (@available(iOS 15.0, *)) {
    // The core advances in exact 1/rate s steps; pin the link to match.
    _displayLink.preferredFrameRateRange = CAFrameRateRangeMake(rate, rate, rate);
  }
  [_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)startWithFixedFrameTimer {
  if (_running || _handle == NULL) {
    return;
  }
  _running = YES;
  _frameTimer = [NSTimer timerWithTimeInterval:(1.0 / (_tickRate > 0 ? _tickRate : kPocketSurfaceDefaultTickRate))
                                        target:self
                                      selector:@selector(handleFixedTimerTick:)
                                      userInfo:nil
                                       repeats:YES];
  [[NSRunLoop mainRunLoop] addTimer:_frameTimer forMode:NSRunLoopCommonModes];
}

- (void)stop {
  _running = NO;
  [_displayLink invalidate];
  _displayLink = nil;
  [_frameTimer invalidate];
  _frameTimer = nil;
}

- (void)disposeRuntime {
  [self stop];
  if (_runtimeCallActive) { _disposeAfterCall = YES; return; }
  _disposeAfterCall = NO;
  if (_handle != NULL) {
    PocketApple *handle = _handle;
    _handle = NULL;
    pocket_apple_destroy(handle);
  }
  self.onGuestInitialize = nil; self.onGuestEvaluate = nil;
  self.onGuestFrame = nil; self.onGuestShutdown = nil;
}

- (void)appDidEnterBackground {
  _displayLink.paused = YES;
  _frameTimer.fireDate = [NSDate distantFuture];
}

- (void)appWillEnterForeground {
  if (_running) {
    _displayLink.paused = NO;
    _frameTimer.fireDate = [NSDate date];
  }
}

- (void)handleFixedTimerTick:(NSTimer *)timer {
  (void)timer;
  [self handleDisplayTick:nil];
}

// The layer letterboxes with resizeAspect; touches must invert the same fit.
- (CGRect)fittedContentRect {
  CGSize bounds = self.bounds.size;
  if (bounds.width <= 0 || bounds.height <= 0 || _logicalWidth == 0 || _logicalHeight == 0) {
    return CGRectZero;
  }
  CGFloat scale = MIN(bounds.width / _logicalWidth, bounds.height / _logicalHeight);
  CGFloat width = _logicalWidth * scale;
  CGFloat height = _logicalHeight * scale;
  return CGRectMake((bounds.width - width) / 2, (bounds.height - height) / 2, width, height);
}

- (BOOL)logicalPointForPoint:(CGPoint)point outX:(uint32_t *)outX outY:(uint32_t *)outY {
  CGRect content = [self fittedContentRect];
  if (CGRectIsEmpty(content)) {
    return NO;
  }
  CGFloat x = (point.x - content.origin.x) / content.size.width * _logicalWidth;
  CGFloat y = (point.y - content.origin.y) / content.size.height * _logicalHeight;
  if (x < 0 || y < 0 || x >= _logicalWidth || y >= _logicalHeight) {
    return NO;
  }
  // Preserve legacy words for compact surfaces. A viewport whose axis exceeds
  // 512 logical pixels uses the append-only 10-bit wire form.
  BOOL wide = _logicalWidth > 512 || _logicalHeight > 512;
  CGFloat maxCoordinate = wide ? 1023.0 : 511.0;
  *outX = (uint32_t)MIN(x, maxCoordinate);
  *outY = (uint32_t)MIN(y, maxCoordinate);
  return YES;
}

// Contacts latch until the display tick has reported them at least once:
// a down+up that lands between two ticks still reaches the guest as one
// present frame followed by an absent one (the contract's release edge).
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  for (UITouch *touch in touches) {
    for (int slot = 0; slot < POCKET_MAX_TOUCHES; slot++) {
      if (!_touchSlots[slot].used) {
        _touchSlots[slot].touch = touch;
        _touchSlots[slot].point = [touch locationInView:self];
        _touchSlots[slot].live = YES;
        _touchSlots[slot].reported = NO;
        _touchSlots[slot].cancelled = NO;
        _touchSlots[slot].used = YES;
        break;
      }
    }
  }
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  for (UITouch *touch in touches) {
    for (int slot = 0; slot < POCKET_MAX_TOUCHES; slot++) {
      if (_touchSlots[slot].used && _touchSlots[slot].touch == touch) {
        _touchSlots[slot].point = [touch locationInView:self];
      }
    }
  }
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [self releaseTouches:touches cancelled:NO];
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [self releaseTouches:touches cancelled:YES];
}

- (void)releaseTouches:(NSSet<UITouch *> *)touches cancelled:(BOOL)cancelled {
  for (UITouch *touch in touches) {
    for (int slot = 0; slot < POCKET_MAX_TOUCHES; slot++) {
      if (_touchSlots[slot].used && _touchSlots[slot].touch == touch) {
        _touchSlots[slot].live = NO;
        _touchSlots[slot].cancelled = cancelled;
        if (_touchSlots[slot].reported && !cancelled) {
          _touchSlots[slot].used = NO;
        }
      }
    }
  }
}

- (size_t)collectTouchWords:(uint32_t[POCKET_MAX_TOUCHES])words {
  size_t count = 0;
  for (int slot = 0; slot < POCKET_MAX_TOUCHES; slot++) {
    if (!_touchSlots[slot].used) {
      continue;
    }
    if (_touchSlots[slot].live && _touchSlots[slot].touch != nil) {
      _touchSlots[slot].point = [_touchSlots[slot].touch locationInView:self];
    }
    uint32_t x = 0;
    uint32_t y = 0;
    if ([self logicalPointForPoint:_touchSlots[slot].point outX:&x outY:&y] || _touchSlots[slot].cancelled) {
      uint32_t cancel = _touchSlots[slot].cancelled ? 0x40000000u : 0;
      if (_logicalWidth > 512 || _logicalHeight > 512) {
        words[count++] = cancel | 0x80000000u | ((uint32_t)(slot & 0xff) << 20) |
                         ((y & 0x3ff) << 10) | (x & 0x3ff);
      } else {
        words[count++] = cancel | ((uint32_t)(slot & 0xff) << 18) |
                         ((y & 0x1ff) << 9) | (x & 0x1ff);
      }
    }
    _touchSlots[slot].reported = YES;
    if (!_touchSlots[slot].live) {
      _touchSlots[slot].used = NO;
    }
  }
  return count;
}

- (void)presentFrame:(const PocketAppleFrame *)frame {
  if (frame->region_count == 0 && self.layer.contents != nil) {
    return;
  }
  size_t length = (size_t)frame->stride_bytes * frame->height_px;
  CFDataRef data = CFDataCreate(NULL, frame->pixels, (CFIndex)length);
  if (data == NULL) {
    return;
  }
  CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
  CGImageRef image = CGImageCreate(
      frame->width_px, frame->height_px, 8, 32, frame->stride_bytes, _colorSpace,
      (CGBitmapInfo)kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little, provider, NULL,
      false, kCGRenderingIntentDefault);
  if (image != NULL) {
    self.layer.contents = (__bridge id)image;
    CGImageRelease(image);
  }
  CGDataProviderRelease(provider);
  CFRelease(data);
}

- (void)handleDisplayTick:(CADisplayLink *)link {
  uint32_t words[POCKET_MAX_TOUCHES];
  size_t count = [self collectTouchWords:words];

  if (_handle == NULL) {
    return;
  }
  _runtimeCallActive = YES;
  int32_t status = pocket_apple_frame(_handle, 0, 0, count > 0 ? words : NULL, count);
  _runtimeCallActive = NO;
  if (_disposeAfterCall) { [self disposeRuntime]; return; }
  if (status != 0) {
    [self captureError];
    [self stop];
    return;
  }
  PocketAppleFrame frame;
  if (pocket_apple_render(_handle, &frame) != 0) {
    [self captureError];
    [self stop];
    return;
  }
  [self presentFrame:&frame];
  _frameNumber += 1;
  if (self.onFrame != nil) {
    self.onFrame(_frameNumber, count);
  }
}

- (BOOL)supportsOperation:(uint16_t)operation {
  return _handle != NULL && pocket_apple_supports_op(_handle, operation) != 0;
}
- (NSDictionary *)dispatchOperation:(uint16_t)operation arguments:(NSArray<NSDictionary *> *)arguments {
  if (_handle == NULL || arguments.count > 64) return @{ @"error": @"invalid runtime arguments" };
  pocket_op_arg values[64] = {0};
  for (NSUInteger i = 0; i < arguments.count; i++) {
    NSDictionary *argument = arguments[i];
    NSString *kind = argument[@"kind"];
    id value = argument[@"value"];
    values[i].struct_size = sizeof(values[i]);
    if ([kind isEqualToString:@"integer"] && [value isKindOfClass:[NSNumber class]]) {
      values[i].tag = POCKET_ARG_INTEGER; values[i].integer = [value longLongValue];
    } else if ([kind isEqualToString:@"real"] && [value isKindOfClass:[NSNumber class]]) {
      values[i].tag = POCKET_ARG_REAL; values[i].real = [value doubleValue];
    } else if ([kind isEqualToString:@"bytes"] && [value isKindOfClass:[NSData class]]) {
      values[i].tag = POCKET_ARG_BYTES; values[i].bytes = [value bytes]; values[i].byte_length = [value length];
    } else return @{ @"error": @"invalid operation argument" };
  }
  pocket_result result = { .struct_size = sizeof(result) };
  int32_t status = pocket_apple_op(_handle, operation, values, arguments.count * sizeof(values[0]), &result);
  if (status != 0) return @{ @"error": [NSString stringWithFormat:@"runtime operation failed (%d)", status] };
  switch (result.tag) {
    case POCKET_RESULT_NONE: return @{ @"kind": @"none" };
    case POCKET_RESULT_I64: return @{ @"kind": @"integer", @"value": @(result.integer) };
    case POCKET_RESULT_F64: return @{ @"kind": @"real", @"value": @(result.real) };
    case POCKET_RESULT_BYTES: return @{ @"kind": @"bytes", @"value": [NSData dataWithBytes:result.bytes length:result.byte_length] };
    default: return @{ @"error": @"invalid runtime result" };
  }
}
- (int32_t)uiHitTestBounds:(float)x y:(float)y {
  return _handle != NULL ? pocket_apple_hit_test_bounds(_handle, x, y) : 0;
}
@end
