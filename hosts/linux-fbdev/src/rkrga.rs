use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::slice;

use anyhow::{bail, Context, Result};

unsafe extern "C" {
    fn pocket_rkrga_open(path: *const c_char) -> *mut c_void;
    fn pocket_rkrga_last_open_error() -> *const c_char;
    fn pocket_rkrga_prepare(
        rga: *mut c_void,
        src_width: c_int,
        src_height: c_int,
        dst_width: c_int,
        dst_height: c_int,
        dst_stride_pixels: c_int,
        dst_virtual_height: c_int,
    ) -> c_int;
    fn pocket_rkrga_source_address(rga: *mut c_void) -> *mut c_void;
    fn pocket_rkrga_source_size(rga: *mut c_void) -> usize;
    fn pocket_rkrga_present(rga: *mut c_void, dst: *mut c_void) -> c_int;
    fn pocket_rkrga_last_error(rga: *mut c_void) -> *const c_char;
    fn pocket_rkrga_close(rga: *mut c_void);
}

pub struct RkrgaPresenter(*mut c_void);

impl RkrgaPresenter {
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        path: &str,
        source_width: usize,
        source_height: usize,
        destination_width: usize,
        destination_height: usize,
        destination_stride_pixels: usize,
        destination_virtual_height: usize,
    ) -> Result<Self> {
        let path = CString::new(path).context("RGA library path contains NUL")?;
        let handle = unsafe { pocket_rkrga_open(path.as_ptr()) };
        if handle.is_null() {
            bail!("{}", unsafe { message(pocket_rkrga_last_open_error()) });
        }
        let presenter = Self(handle);
        let status = unsafe {
            pocket_rkrga_prepare(
                handle,
                to_c_int(source_width, "source width")?,
                to_c_int(source_height, "source height")?,
                to_c_int(destination_width, "destination width")?,
                to_c_int(destination_height, "destination height")?,
                to_c_int(destination_stride_pixels, "destination stride")?,
                to_c_int(destination_virtual_height, "destination virtual height")?,
            )
        };
        if status != 0 {
            bail!("RK RGA dma-buf preparation failed ({status})");
        }
        Ok(presenter)
    }

    pub fn source_buffer(&mut self) -> &mut [u8] {
        unsafe {
            slice::from_raw_parts_mut(
                pocket_rkrga_source_address(self.0).cast(),
                pocket_rkrga_source_size(self.0),
            )
        }
    }

    pub fn present(&mut self, destination: *mut u8) -> Result<()> {
        let status = unsafe { pocket_rkrga_present(self.0, destination.cast()) };
        if status != 0 {
            bail!("{}", unsafe { message(pocket_rkrga_last_error(self.0)) });
        }
        Ok(())
    }
}

impl Drop for RkrgaPresenter {
    fn drop(&mut self) {
        unsafe { pocket_rkrga_close(self.0) };
    }
}

fn to_c_int(value: usize, name: &str) -> Result<c_int> {
    c_int::try_from(value).with_context(|| format!("{name} exceeds the RGA API range"))
}

unsafe fn message(value: *const c_char) -> String {
    if value.is_null() {
        return "unknown RK RGA error".into();
    }
    unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned()
}
