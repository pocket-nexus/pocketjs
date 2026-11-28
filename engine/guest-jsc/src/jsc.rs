//! The JavaScriptCore C API and a thin handle layer over it.
//!
//! Values are `Copy` handles that stay valid while they are reachable from the native stack
//! (JavaScriptCore scans the stack conservatively); a value kept across calls is wrapped in
//! [`Persistent`]. Hosts use this module to mount their own namespaces next to `ui`.
#![allow(non_camel_case_types, clippy::missing_safety_doc)]

use std::ffi::{c_char, c_void};
use std::ptr::{null, null_mut};

#[repr(C)]
pub struct OpaqueJSContext(c_void);
#[repr(C)]
pub struct OpaqueJSValue(c_void);
#[repr(C)]
pub struct OpaqueJSString(c_void);
#[repr(C)]
pub struct OpaqueJSClass(c_void);

pub type JSContextRef = *const OpaqueJSContext;
pub type JSGlobalContextRef = *mut OpaqueJSContext;
pub type JSValueRef = *const OpaqueJSValue;
pub type JSObjectRef = *mut OpaqueJSValue;
pub type JSStringRef = *mut OpaqueJSString;
pub type JSClassRef = *mut OpaqueJSClass;

pub type JSObjectCallAsFunctionCallback = Option<
    unsafe extern "C" fn(
        JSContextRef,
        JSObjectRef,
        JSObjectRef,
        usize,
        *const JSValueRef,
        *mut JSValueRef,
    ) -> JSValueRef,
>;
pub type JSObjectFinalizeCallback = Option<unsafe extern "C" fn(JSObjectRef)>;
pub type JSTypedArrayBytesDeallocator = Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>;

#[repr(C)]
pub struct JSClassDefinition {
    pub version: i32,
    pub attributes: u32,
    pub class_name: *const c_char,
    pub parent_class: JSClassRef,
    pub static_values: *const c_void,
    pub static_functions: *const c_void,
    pub initialize: *const c_void,
    pub finalize: JSObjectFinalizeCallback,
    pub has_property: *const c_void,
    pub get_property: *const c_void,
    pub set_property: *const c_void,
    pub delete_property: *const c_void,
    pub get_property_names: *const c_void,
    pub call_as_function: JSObjectCallAsFunctionCallback,
    pub call_as_constructor: *const c_void,
    pub has_instance: *const c_void,
    pub convert_to_type: *const c_void,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JSType {
    Undefined = 0,
    Null,
    Boolean,
    Number,
    String,
    Object,
    Symbol,
    BigInt,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypedArrayType {
    Int8 = 0,
    Int16,
    Int32,
    Uint8,
    Uint8Clamped,
    Uint16,
    Uint32,
    Float32,
    Float64,
    ArrayBuffer,
    None,
    BigInt64,
    BigUint64,
}

#[cfg_attr(
    target_vendor = "apple",
    link(name = "JavaScriptCore", kind = "framework")
)]
unsafe extern "C" {
    pub fn JSGlobalContextCreate(global_class: JSClassRef) -> JSGlobalContextRef;
    pub fn JSGlobalContextRelease(ctx: JSGlobalContextRef);
    pub fn JSContextGetGlobalObject(ctx: JSContextRef) -> JSObjectRef;
    pub fn JSGlobalContextSetName(ctx: JSGlobalContextRef, name: JSStringRef);
    pub fn JSEvaluateScript(
        ctx: JSContextRef,
        script: JSStringRef,
        this: JSObjectRef,
        url: JSStringRef,
        line: i32,
        exc: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSGarbageCollect(ctx: JSContextRef);

    pub fn JSStringCreateWithCharacters(chars: *const u16, len: usize) -> JSStringRef;
    pub fn JSStringCreateWithUTF8CString(s: *const c_char) -> JSStringRef;
    pub fn JSStringRelease(s: JSStringRef);
    pub fn JSStringGetLength(s: JSStringRef) -> usize;
    pub fn JSStringGetCharactersPtr(s: JSStringRef) -> *const u16;

    pub fn JSValueGetType(ctx: JSContextRef, v: JSValueRef) -> JSType;
    pub fn JSValueIsObject(ctx: JSContextRef, v: JSValueRef) -> bool;
    pub fn JSValueIsArray(ctx: JSContextRef, v: JSValueRef) -> bool;
    pub fn JSValueIsUndefined(ctx: JSContextRef, v: JSValueRef) -> bool;
    pub fn JSValueIsNull(ctx: JSContextRef, v: JSValueRef) -> bool;
    pub fn JSValueMakeUndefined(ctx: JSContextRef) -> JSValueRef;
    pub fn JSValueMakeNull(ctx: JSContextRef) -> JSValueRef;
    pub fn JSValueMakeBoolean(ctx: JSContextRef, b: bool) -> JSValueRef;
    pub fn JSValueMakeNumber(ctx: JSContextRef, n: f64) -> JSValueRef;
    pub fn JSValueMakeString(ctx: JSContextRef, s: JSStringRef) -> JSValueRef;
    pub fn JSValueMakeFromJSONString(ctx: JSContextRef, s: JSStringRef) -> JSValueRef;
    pub fn JSValueCreateJSONString(
        ctx: JSContextRef,
        v: JSValueRef,
        indent: u32,
        exc: *mut JSValueRef,
    ) -> JSStringRef;
    pub fn JSValueToBoolean(ctx: JSContextRef, v: JSValueRef) -> bool;
    pub fn JSValueToNumber(ctx: JSContextRef, v: JSValueRef, exc: *mut JSValueRef) -> f64;
    pub fn JSValueToStringCopy(
        ctx: JSContextRef,
        v: JSValueRef,
        exc: *mut JSValueRef,
    ) -> JSStringRef;
    pub fn JSValueToObject(ctx: JSContextRef, v: JSValueRef, exc: *mut JSValueRef) -> JSObjectRef;
    pub fn JSValueProtect(ctx: JSContextRef, v: JSValueRef);
    pub fn JSValueUnprotect(ctx: JSContextRef, v: JSValueRef);
    pub fn JSValueGetTypedArrayType(
        ctx: JSContextRef,
        v: JSValueRef,
        exc: *mut JSValueRef,
    ) -> TypedArrayType;

    pub fn JSClassCreate(def: *const JSClassDefinition) -> JSClassRef;
    pub fn JSObjectMake(ctx: JSContextRef, cls: JSClassRef, data: *mut c_void) -> JSObjectRef;
    pub fn JSObjectGetPrivate(obj: JSObjectRef) -> *mut c_void;
    pub fn JSObjectSetPrototype(ctx: JSContextRef, obj: JSObjectRef, proto: JSValueRef);
    pub fn JSObjectSetPrivate(obj: JSObjectRef, data: *mut c_void) -> bool;
    pub fn JSObjectMakeArray(
        ctx: JSContextRef,
        argc: usize,
        argv: *const JSValueRef,
        exc: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectMakeError(
        ctx: JSContextRef,
        argc: usize,
        argv: *const JSValueRef,
        exc: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectGetProperty(
        ctx: JSContextRef,
        obj: JSObjectRef,
        name: JSStringRef,
        exc: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSObjectSetProperty(
        ctx: JSContextRef,
        obj: JSObjectRef,
        name: JSStringRef,
        v: JSValueRef,
        attrs: u32,
        exc: *mut JSValueRef,
    );
    pub fn JSObjectGetPropertyAtIndex(
        ctx: JSContextRef,
        obj: JSObjectRef,
        i: u32,
        exc: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSObjectSetPropertyAtIndex(
        ctx: JSContextRef,
        obj: JSObjectRef,
        i: u32,
        v: JSValueRef,
        exc: *mut JSValueRef,
    );
    pub fn JSObjectIsFunction(ctx: JSContextRef, obj: JSObjectRef) -> bool;
    pub fn JSObjectCallAsConstructor(
        ctx: JSContextRef,
        f: JSObjectRef,
        argc: usize,
        argv: *const JSValueRef,
        exc: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectCallAsFunction(
        ctx: JSContextRef,
        f: JSObjectRef,
        this: JSObjectRef,
        argc: usize,
        argv: *const JSValueRef,
        exc: *mut JSValueRef,
    ) -> JSValueRef;

    pub fn JSObjectGetTypedArrayBytesPtr(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> *mut c_void;
    pub fn JSObjectGetTypedArrayLength(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> usize;
    pub fn JSObjectGetTypedArrayByteLength(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> usize;
    pub fn JSObjectGetTypedArrayByteOffset(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> usize;
    pub fn JSObjectGetArrayBufferBytesPtr(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> *mut c_void;
    pub fn JSObjectGetArrayBufferByteLength(
        ctx: JSContextRef,
        obj: JSObjectRef,
        exc: *mut JSValueRef,
    ) -> usize;
    pub fn JSObjectMakeTypedArray(
        ctx: JSContextRef,
        t: TypedArrayType,
        len: usize,
        exc: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx: JSContextRef,
        bytes: *mut c_void,
        len: usize,
        dealloc: JSTypedArrayBytesDeallocator,
        ctx_: *mut c_void,
        exc: *mut JSValueRef,
    ) -> JSObjectRef;
}

/// ECMAScript ToInt32: NaN and infinities are 0, other numbers truncate and wrap modulo 2^32.
pub fn to_int32(n: f64) -> i32 {
    if !n.is_finite() {
        return 0;
    }
    let t = n.trunc();
    if t >= i32::MIN as f64 && t <= i32::MAX as f64 {
        return t as i32;
    }
    t.rem_euclid(4294967296.0) as u64 as u32 as i32
}

/// A JS string owned by native code.
pub struct JsString(pub JSStringRef);
impl JsString {
    pub fn new(s: &str) -> Self {
        let u: Vec<u16> = s.encode_utf16().collect();
        JsString(unsafe { JSStringCreateWithCharacters(u.as_ptr(), u.len()) })
    }
    pub fn from_utf16(u: &[u16]) -> Self {
        JsString(unsafe { JSStringCreateWithCharacters(u.as_ptr(), u.len()) })
    }
    pub fn utf16(&self) -> &[u16] {
        unsafe {
            let len = JSStringGetLength(self.0);
            if len == 0 {
                return &[];
            }
            std::slice::from_raw_parts(JSStringGetCharactersPtr(self.0), len)
        }
    }
    #[allow(clippy::inherent_to_string)]
    pub fn to_string(&self) -> String {
        String::from_utf16_lossy(self.utf16())
    }
    /// UTF-8 with each unpaired surrogate as three U+FFFD: the bytes a WTF-8 engine (QuickJS)
    /// produces, decoded lossily, so every guest hands the core the same text.
    pub fn to_string_wtf8_lossy(&self) -> String {
        let mut out = String::with_capacity(self.utf16().len());
        for unit in char::decode_utf16(self.utf16().iter().copied()) {
            match unit {
                Ok(ch) => out.push(ch),
                Err(_) => out.push_str("\u{fffd}\u{fffd}\u{fffd}"),
            }
        }
        out
    }
}
impl Drop for JsString {
    fn drop(&mut self) {
        unsafe { JSStringRelease(self.0) }
    }
}

/// A borrowed context handle (the one passed into callbacks, or a global context).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ctx(pub JSContextRef);

/// A value handle; valid while reachable from the native stack or protected.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Value(pub JSValueRef);

pub type NativeResult = Result<Value, String>;
type NativeFn = Box<dyn Fn(Ctx, Value, &[Value]) -> NativeResult>;

static mut FN_CLASS: JSClassRef = null_mut();

unsafe extern "C" fn fn_call(
    ctx: JSContextRef,
    function: JSObjectRef,
    this: JSObjectRef,
    argc: usize,
    argv: *const JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    unsafe {
        let f = &*(JSObjectGetPrivate(function) as *const NativeFn);
        let args = if argc == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(argv as *const Value, argc)
        };
        let c = Ctx(ctx);
        let this = if this.is_null() {
            c.undefined()
        } else {
            Value(this)
        };
        match f(c, this, args) {
            Ok(v) => v.0,
            Err(msg) => {
                *exc = c.error(&msg).0;
                JSValueMakeUndefined(ctx)
            }
        }
    }
}

unsafe extern "C" fn fn_finalize(obj: JSObjectRef) {
    unsafe {
        let p = JSObjectGetPrivate(obj) as *mut NativeFn;
        if !p.is_null() {
            drop(Box::from_raw(p));
        }
    }
}

fn fn_class() -> JSClassRef {
    unsafe {
        if FN_CLASS.is_null() {
            let def = JSClassDefinition {
                version: 0,
                attributes: 0,
                class_name: c"NativeFunction".as_ptr(),
                parent_class: null_mut(),
                static_values: null(),
                static_functions: null(),
                initialize: null(),
                finalize: Some(fn_finalize),
                has_property: null(),
                get_property: null(),
                set_property: null(),
                delete_property: null(),
                get_property_names: null(),
                call_as_function: Some(fn_call),
                call_as_constructor: null(),
                has_instance: null(),
                convert_to_type: null(),
            };
            FN_CLASS = JSClassCreate(&def);
        }
        FN_CLASS
    }
}

impl Ctx {
    pub fn global(self) -> Value {
        Value(unsafe { JSContextGetGlobalObject(self.0) })
    }
    pub fn undefined(self) -> Value {
        Value(unsafe { JSValueMakeUndefined(self.0) })
    }
    pub fn null(self) -> Value {
        Value(unsafe { JSValueMakeNull(self.0) })
    }
    pub fn bool(self, b: bool) -> Value {
        Value(unsafe { JSValueMakeBoolean(self.0, b) })
    }
    pub fn num(self, n: f64) -> Value {
        Value(unsafe { JSValueMakeNumber(self.0, n) })
    }
    pub fn str(self, s: &str) -> Value {
        let js = JsString::new(s);
        Value(unsafe { JSValueMakeString(self.0, js.0) })
    }
    pub fn str_utf16(self, s: &[u16]) -> Value {
        let js = JsString::from_utf16(s);
        Value(unsafe { JSValueMakeString(self.0, js.0) })
    }
    /// Parse JSON into a JS value (fast path for structured data crossing the boundary).
    pub fn json(self, s: &str) -> Value {
        let js = JsString::new(s);
        let v = unsafe { JSValueMakeFromJSONString(self.0, js.0) };
        if v.is_null() {
            self.undefined()
        } else {
            Value(v)
        }
    }
    pub fn error(self, msg: &str) -> Value {
        let m = self.str(msg);
        Value(unsafe { JSObjectMakeError(self.0, 1, &m.0, null_mut()) })
    }
    pub fn object(self) -> Value {
        Value(unsafe { JSObjectMake(self.0, null_mut(), null_mut()) })
    }
    pub fn array(self, items: &[Value]) -> Value {
        Value(unsafe {
            JSObjectMakeArray(
                self.0,
                items.len(),
                items.as_ptr() as *const JSValueRef,
                null_mut(),
            )
        })
    }
    pub fn function(self, f: impl Fn(Ctx, Value, &[Value]) -> NativeResult + 'static) -> Value {
        let boxed: Box<NativeFn> = Box::new(Box::new(f));
        let obj = unsafe { JSObjectMake(self.0, fn_class(), Box::into_raw(boxed) as *mut c_void) };
        // Inherit Function.prototype so call/apply/bind work like on any function.
        let proto = self.global().get(self, "Function").get(self, "prototype");
        if proto.is_object(self) {
            unsafe { JSObjectSetPrototype(self.0, obj, proto.0) };
        }
        Value(obj)
    }
    /// A fresh typed array of `len` elements, filled from `bytes` (which must be exactly the byte size).
    pub fn typed_array(self, t: TypedArrayType, len: usize, bytes: &[u8]) -> Value {
        unsafe {
            let o = JSObjectMakeTypedArray(self.0, t, len, null_mut());
            let p = JSObjectGetTypedArrayBytesPtr(self.0, o, null_mut()) as *mut u8;
            let off = JSObjectGetTypedArrayByteOffset(self.0, o, null_mut());
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), p.add(off), bytes.len());
            }
            Value(o)
        }
    }

    /// A new ArrayBuffer that takes ownership of `bytes` without copying them.
    pub fn array_buffer(self, bytes: Vec<u8>) -> Value {
        unsafe extern "C" fn free_bytes(bytes: *mut c_void, context: *mut c_void) {
            // SAFETY: `context` is the length `array_buffer` boxed with the slice below.
            unsafe {
                let len = *Box::from_raw(context as *mut usize);
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    bytes as *mut u8,
                    len,
                )));
            }
        }
        let boxed = bytes.into_boxed_slice();
        let len = boxed.len();
        let ptr = Box::into_raw(boxed) as *mut u8 as *mut c_void;
        let context = Box::into_raw(Box::new(len)) as *mut c_void;
        Value(unsafe {
            JSObjectMakeArrayBufferWithBytesNoCopy(
                self.0,
                ptr,
                len,
                Some(free_bytes),
                context,
                null_mut(),
            )
        } as JSValueRef)
    }

    pub fn eval(self, src: &str, url: &str) -> NativeResult {
        let s = JsString::new(src);
        let u = JsString::new(url);
        let mut exc: JSValueRef = null();
        let v = unsafe { JSEvaluateScript(self.0, s.0, null_mut(), u.0, 1, &mut exc) };
        if !exc.is_null() {
            Err(self.describe(Value(exc)))
        } else {
            Ok(Value(v))
        }
    }

    /// `message\nstack` for an exception value.
    pub fn describe(self, e: Value) -> String {
        let msg = e.to_string(self);
        if e.is_object(self) {
            let stack = e.get(self, "stack");
            if !stack.is_undefined(self) {
                let st = stack.to_string(self);
                if !st.is_empty() {
                    return format!("{msg}\n{st}");
                }
            }
        }
        msg
    }

    pub fn call(self, f: Value, this: Option<Value>, args: &[Value]) -> NativeResult {
        let mut exc: JSValueRef = null();
        let this = this.map(|t| t.0 as JSObjectRef).unwrap_or(null_mut());
        let r = unsafe {
            JSObjectCallAsFunction(
                self.0,
                f.0 as JSObjectRef,
                this,
                args.len(),
                args.as_ptr() as *const JSValueRef,
                &mut exc,
            )
        };
        if !exc.is_null() {
            Err(self.describe(Value(exc)))
        } else {
            Ok(Value(r))
        }
    }

    pub fn gc(self) {
        unsafe { JSGarbageCollect(self.0) }
    }
}

impl Value {
    pub fn is_undefined(self, c: Ctx) -> bool {
        unsafe { JSValueIsUndefined(c.0, self.0) }
    }
    pub fn is_null(self, c: Ctx) -> bool {
        unsafe { JSValueIsNull(c.0, self.0) }
    }
    pub fn is_nullish(self, c: Ctx) -> bool {
        self.is_null(c) || self.is_undefined(c)
    }
    pub fn is_object(self, c: Ctx) -> bool {
        unsafe { JSValueIsObject(c.0, self.0) }
    }
    pub fn is_array(self, c: Ctx) -> bool {
        unsafe { JSValueIsArray(c.0, self.0) }
    }
    pub fn kind(self, c: Ctx) -> JSType {
        unsafe { JSValueGetType(c.0, self.0) }
    }
    pub fn is_function(self, c: Ctx) -> bool {
        self.is_object(c) && unsafe { JSObjectIsFunction(c.0, self.0 as JSObjectRef) }
    }
    pub fn to_bool(self, c: Ctx) -> bool {
        unsafe { JSValueToBoolean(c.0, self.0) }
    }
    pub fn to_num(self, c: Ctx) -> f64 {
        unsafe { JSValueToNumber(c.0, self.0, null_mut()) }
    }
    /// ECMAScript ToInt32 (wraps modulo 2^32).
    pub fn to_i32(self, c: Ctx) -> i32 {
        to_int32(self.to_num(c))
    }
    /// ECMAScript ToUint32 (wraps modulo 2^32).
    pub fn to_u32(self, c: Ctx) -> u32 {
        to_int32(self.to_num(c)) as u32
    }
    pub fn to_js_string(self, c: Ctx) -> JsString {
        JsString(unsafe { JSValueToStringCopy(c.0, self.0, null_mut()) })
    }
    pub fn to_string(self, c: Ctx) -> String {
        let s = unsafe { JSValueToStringCopy(c.0, self.0, null_mut()) };
        if s.is_null() {
            return String::new();
        }
        JsString(s).to_string()
    }
    /// JSON text of the value (`None` for undefined / functions).
    pub fn to_json(self, c: Ctx) -> Option<String> {
        let s = unsafe { JSValueCreateJSONString(c.0, self.0, 0, null_mut()) };
        if s.is_null() {
            None
        } else {
            Some(JsString(s).to_string())
        }
    }
    pub fn get(self, c: Ctx, name: &str) -> Value {
        let n = JsString::new(name);
        Value(unsafe { JSObjectGetProperty(c.0, self.0 as JSObjectRef, n.0, null_mut()) })
    }
    pub fn set(self, c: Ctx, name: &str, v: Value) {
        let n = JsString::new(name);
        unsafe { JSObjectSetProperty(c.0, self.0 as JSObjectRef, n.0, v.0, 0, null_mut()) }
    }
    pub fn at(self, c: Ctx, i: u32) -> Value {
        Value(unsafe { JSObjectGetPropertyAtIndex(c.0, self.0 as JSObjectRef, i, null_mut()) })
    }
    pub fn set_at(self, c: Ctx, i: u32, v: Value) {
        unsafe { JSObjectSetPropertyAtIndex(c.0, self.0 as JSObjectRef, i, v.0, null_mut()) }
    }
    pub fn len(self, c: Ctx) -> u32 {
        self.get(c, "length").to_u32(c)
    }
    pub fn typed_kind(self, c: Ctx) -> TypedArrayType {
        if !self.is_object(c) {
            return TypedArrayType::None;
        }
        unsafe { JSValueGetTypedArrayType(c.0, self.0, null_mut()) }
    }
    /// The bytes viewed by a typed array or an ArrayBuffer; `None` for other values and for
    /// detached buffers.
    /// The slice is only valid until the next call into JavaScriptCore.
    pub fn bytes<'a>(self, c: Ctx) -> Option<&'a mut [u8]> {
        unsafe {
            match self.typed_kind(c) {
                TypedArrayType::None => None,
                TypedArrayType::ArrayBuffer => {
                    let o = self.0 as JSObjectRef;
                    let p = JSObjectGetArrayBufferBytesPtr(c.0, o, null_mut()) as *mut u8;
                    let n = JSObjectGetArrayBufferByteLength(c.0, o, null_mut());
                    if p.is_null() {
                        if self.get(c, "detached").to_bool(c) {
                            None
                        } else {
                            Some(&mut [])
                        }
                    } else {
                        Some(std::slice::from_raw_parts_mut(p, n))
                    }
                }
                _ => {
                    let o = self.0 as JSObjectRef;
                    let p = JSObjectGetTypedArrayBytesPtr(c.0, o, null_mut()) as *mut u8;
                    let off = JSObjectGetTypedArrayByteOffset(c.0, o, null_mut());
                    let n = JSObjectGetTypedArrayByteLength(c.0, o, null_mut());
                    if p.is_null() || n == 0 {
                        // a view of a detached buffer reads as empty; tell it from an empty view
                        if self.get(c, "buffer").get(c, "detached").to_bool(c) {
                            None
                        } else {
                            Some(&mut [])
                        }
                    } else {
                        Some(std::slice::from_raw_parts_mut(p.add(off), n))
                    }
                }
            }
        }
    }
}

/// A value kept alive across calls (GC root).
pub struct Persistent {
    ctx: JSContextRef,
    pub value: Value,
}
impl Persistent {
    pub fn new(c: Ctx, v: Value) -> Self {
        unsafe { JSValueProtect(c.0, v.0) };
        Persistent { ctx: c.0, value: v }
    }
    pub fn get(&self) -> Value {
        self.value
    }
}
impl Drop for Persistent {
    fn drop(&mut self) {
        unsafe { JSValueUnprotect(self.ctx, self.value.0) }
    }
}

/// An owned global context ("a page"): created on navigation, released on teardown.
pub struct Context {
    raw: JSGlobalContextRef,
}
impl Context {
    pub fn new(name: &str) -> Self {
        let raw = unsafe { JSGlobalContextCreate(null_mut()) };
        let n = JsString::new(name);
        unsafe { JSGlobalContextSetName(raw, n.0) };
        Context { raw }
    }
    pub fn ctx(&self) -> Ctx {
        Ctx(self.raw)
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        unsafe { JSGlobalContextRelease(self.raw) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let cx = Context::new("t");
        let c = cx.ctx();
        let g = c.global();
        g.set(
            c,
            "add",
            c.function(|c, _this, a| Ok(c.num(a[0].to_num(c) + a[1].to_num(c)))),
        );
        let v = c.eval("add(2, 3) + [1,2,3].length", "t.js").unwrap();
        assert_eq!(v.to_num(c), 8.0);
        let ta = c
            .eval("new Float32Array([1, 2, 3]).subarray(1)", "t.js")
            .unwrap();
        let b = ta.bytes(c).unwrap();
        assert_eq!(b.len(), 8);
        assert_eq!(f32::from_le_bytes(b[0..4].try_into().unwrap()), 2.0);
        assert!(c
            .eval("throw new Error('boom')", "t.js")
            .unwrap_err()
            .contains("boom"));
        assert_eq!(
            c.eval(
                "add.apply(null, [1, 2]) + add.call(null, 3, 4) + add.bind(null, 5)(6)",
                "t.js"
            )
            .unwrap()
            .to_num(c),
            21.0
        );
        // microtasks drain when the outermost API call returns
        c.eval(
            "globalThis.flag = 0; Promise.resolve().then(() => flag = 1)",
            "t.js",
        )
        .unwrap();
        assert_eq!(g.get(c, "flag").to_num(c), 1.0);
    }
}
