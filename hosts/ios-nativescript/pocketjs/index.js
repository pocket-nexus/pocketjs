import { View, File, knownFolders } from '@nativescript/core';
import { mountUi } from '@pocketjs/framework/guest-web';
import { attachGuest } from './guest.js';
import { foundationCodec } from './codec.js';

function codec() {
  return foundationCodec({
    bufferFromData: (data) => interop.bufferFromData(data),
    data: (buffer) => NSData.dataWithBytesLength(buffer, buffer.byteLength),
    number: (value) => NSNumber.numberWithDouble(value),
    array: (values) => { const result = NSMutableArray.new(); for (const value of values) result.addObject(value); return result; },
    dictionary: (values) => {
      const result = NSMutableDictionary.new();
      for (const key of Object.keys(values)) result.setObjectForKey(values[key], key);
      return result;
    },
  });
}

export class PocketView extends View {
  constructor() {
    super();
    this.viewportWidth = 480; this.viewportHeight = 272; this.density = 2; this.tickRate = 60;
    this._booted = false;
  }
  createNativeView() {
    if (typeof PocketSurfaceView === 'undefined') throw new Error('PocketApple.xcframework is missing; run pocket ios native');
    return this.externalGuest
      ? PocketSurfaceView.externalSurfaceWithLogicalWidthLogicalHeightDensity(this.viewportWidth, this.viewportHeight, this.density)
      : PocketSurfaceView.surfaceWithLogicalWidthLogicalHeightDensity(this.viewportWidth, this.viewportHeight, this.density);
  }
  initNativeView() {
    super.initNativeView();
    const view = this.nativeViewProtected;
    view.tickRate = this.tickRate;
    view.onError = (message) => this._error(message);
    view.onEffect = (line) => {
      let data; try { data = JSON.parse(line); } catch { data = line; }
      this.notify({ eventName: 'effect', object: this, data, line });
    };
    if (this.externalGuest) attachGuest(view, codec(), (error) => this._error(error), mountUi);
  }
  onLoaded() {
    super.onLoaded();
    this._boot();
    if (this._booted) this.nativeViewProtected.start();
  }
  onUnloaded() { this.nativeViewProtected?.stop(); super.onUnloaded(); }
  disposeNativeView() {
    const view = this.nativeViewProtected;
    if (view) {
      // Guest shutdown invalidates retained generated functions. A callback
      // may request disposal; UIKit defers destruction until the call returns.
      view.disposeRuntime();
      view.onEffect = null; view.onError = null;
    }
    this._booted = false;
    super.disposeNativeView();
  }
  set src(value) {
    if (this._booted && value !== this._src) throw new Error('create a new PocketView to replace its guest');
    this._src = value;
    if (this.isLoaded) this._boot();
  }
  get src() { return this._src; }
  _error(error) { this.notify({ eventName: 'error', object: this, message: String(error?.message ?? error) }); }
  _boot() {
    if (this._booted || !this._src || !this.nativeViewProtected) return;
    const base = this._src.startsWith('~/') ? knownFolders.currentApp().path + this._src.slice(1) : this._src;
    try {
      const pak = NSData.dataWithContentsOfFile(base + '.pak');
      const source = File.fromPath(base + '.pocketjs').readTextSync();
      const view = this.nativeViewProtected;
      if (!pak || !view.loadPak(pak) || !view.evalBundleLabel(source, base)) throw new Error(view.lastError ?? 'guest boot failed');
      this._booted = true;
      if (this.isLoaded) view.start();
    } catch (error) { this._error(error); }
  }
  post(value) { this.nativeViewProtected?.postEvent(typeof value === 'string' ? value : JSON.stringify(value)); }
}
export class PocketHostView extends PocketView {
  get externalGuest() { return true; }
}
