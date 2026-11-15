use std::collections::VecDeque;
use std::ffi::{c_char, CStr, CString};
use std::sync::{Mutex, Once};

use pocket_net::{HttpTransport, NetFailure, TransportCompletion};

unsafe extern "C" {
    fn pocket_net_set_callbacks(
        done: Option<unsafe extern "C" fn(i32, u16, *const c_char, *const c_char, *const u8, usize)>,
        error: Option<unsafe extern "C" fn(i32, *const c_char, *const c_char)>,
    );
    fn pocket_net_request(
        url: *const c_char,
        method: *const c_char,
        headers_json: *const c_char,
        body: *const u8,
        body_len: usize,
        handle: i32,
    );
}

static COMPLETIONS: Mutex<VecDeque<TransportCompletion>> = Mutex::new(VecDeque::new());
static INIT: Once = Once::new();

unsafe extern "C" fn on_done(
    handle: i32,
    status: u16,
    url: *const c_char,
    headers_json: *const c_char,
    body: *const u8,
    body_len: usize,
) {
    let url_str = if url.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(url).to_string_lossy().into_owned() }
    };
    let headers_json_str = if headers_json.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(headers_json).to_string_lossy().into_owned() }
    };
    let body_bytes = if body.is_null() || body_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(body, body_len).to_vec() }
    };

    let headers: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&headers_json_str).unwrap_or_default();

    let completion = TransportCompletion::Done {
        handle,
        status,
        url: url_str,
        headers,
        body: body_bytes,
    };
    if let Ok(mut q) = COMPLETIONS.lock() {
        q.push_back(completion);
    }
}

unsafe extern "C" fn on_error(
    handle: i32,
    code: *const c_char,
    message: *const c_char,
) {
    let code_str = if code.is_null() {
        "network".to_string()
    } else {
        unsafe { CStr::from_ptr(code).to_string_lossy().into_owned() }
    };
    let msg_str = if message.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(message).to_string_lossy().into_owned() }
    };

    let completion = TransportCompletion::Error {
        handle,
        failure: NetFailure::new(code_str, msg_str),
    };
    if let Ok(mut q) = COMPLETIONS.lock() {
        q.push_back(completion);
    }
}

pub struct IosNetTransport;

impl IosNetTransport {
    pub fn new() -> Self {
        INIT.call_once(|| unsafe {
            pocket_net_set_callbacks(Some(on_done), Some(on_error));
        });
        Self
    }
}

impl Default for IosNetTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for IosNetTransport {
    fn start(&mut self, request: pocket_net::HttpRequest) -> Result<(), NetFailure> {
        let url_c = CString::new(request.url).map_err(|_| {
            NetFailure::new("invalid", "url contains null byte")
        })?;
        let method_c = CString::new(request.method).map_err(|_| {
            NetFailure::new("invalid", "method contains null byte")
        })?;
        let headers_json = serde_json::to_string(&request.headers).unwrap_or_else(|_| "{}".into());
        let headers_c = CString::new(headers_json).map_err(|_| {
            NetFailure::new("invalid", "headers contain null byte")
        })?;

        unsafe {
            pocket_net_request(
                url_c.as_ptr(),
                method_c.as_ptr(),
                headers_c.as_ptr(),
                request.body.as_ptr(),
                request.body.len(),
                request.handle,
            );
        }
        Ok(())
    }

    fn cancel(&mut self, _handle: i32) {}

    fn drain(&mut self, completions: &mut Vec<TransportCompletion>) {
        let mut queue = COMPLETIONS.lock().unwrap();
        while let Some(c) = queue.pop_front() {
            completions.push(c);
        }
    }
}
