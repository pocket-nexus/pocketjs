// The codec only bridges Foundation containers and owned byte copies. The
// operation table, argument coercion and result decoding have one generator.
export function attachGuest(view, codec, reportError, mountUi, global = globalThis) {
  let mount, frame;
  const guarded = (callback) => (...args) => {
    try { callback(...args); return true; }
    catch (error) { reportError(error); return false; }
  };
  view.onGuestInitialize = guarded((metadata) => {
    mount = mountUi({
      supportsOp: (op) => view.supportsOperation(op),
      dispatch(op, args) {
        const result = codec.result(view.dispatchOperationArguments(op, codec.arguments(args)));
        if (result.error) throw new Error(result.error);
        return result;
      },
    }, codec.environment(metadata), global);
  });
  view.onGuestEvaluate = guarded((source) => {
    if (global.frame !== undefined) throw new Error('a guest frame is already installed');
    // Bundles are generated scripts that install globalThis.frame.
    try { new Function(source)(); } finally { frame = global.frame; }
    if (typeof frame !== 'function') throw new Error('guest did not install frame()');
  });
  view.onGuestFrame = guarded((value) => {
    const input = codec.frame(value);
    frame(input.buttons, input.analog, input.touches, input.hits,
      input.surfaces, input.rightAnalog, [], undefined);
  });
  view.onGuestShutdown = () => {
    mount?.dispose();
    mount = undefined;
    if (frame && global.frame === frame) delete global.frame;
    frame = undefined;
  };
}
