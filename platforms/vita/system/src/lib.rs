use std::{fmt, string::String};
extern "C" {
    fn sceClibPrintf(fmt: *const i8, ...) -> i32;
}
pub fn vita_log(args: fmt::Arguments<'_>) {
    use std::fmt::Write;
    let mut line = String::new();
    let _ = line.write_fmt(args);
    line.push('\0');
    unsafe {
        sceClibPrintf(c"%s\n".as_ptr(), line.as_ptr());
    }
}
