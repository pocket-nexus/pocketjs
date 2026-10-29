//! QR codes read with zxing-cpp through its C API (`ZXingC.h` of 2.3), from
//! the `libZXing.so.3` that Debian's libzxing3 installs on the CardputerZero
//! image. The library is opened at run time, so the program runs on a system
//! without it and camera.rs falls back to rqrr. With rqrr (a port of quirc)
//! the Camera tool's scan read no code on the device (reported 2026-10-29):
//! in the 640x360 viewfinder frame a 5 cm code held 25 cm away spans about
//! 110 pixels, under 4 pixels a module, with soft edges from the fixed-focus
//! lens, and zxing-cpp reads codes at fewer pixels a module than quirc.

use std::{
    ffi::{c_char, c_int, c_uint, c_void, CStr},
    sync::OnceLock,
};

/// `ZXing_ImageFormat_Lum`: one byte of luminance a pixel.
const FORMAT_LUM: c_int = 0x0100_0000;
/// `ZXing_BarcodeFormat_QRCode | ZXing_BarcodeFormat_MicroQRCode`.
const FORMATS_QR: c_uint = (1 << 13) | (1 << 16);

type ImageViewNew = unsafe extern "C" fn(*const u8, c_int, c_int, c_int, c_int, c_int) -> *mut c_void;
type Delete = unsafe extern "C" fn(*mut c_void);
type OptionsNew = unsafe extern "C" fn() -> *mut c_void;
type SetFormats = unsafe extern "C" fn(*mut c_void, c_uint);
type SetBool = unsafe extern "C" fn(*mut c_void, bool);
type ReadBarcodes = unsafe extern "C" fn(*const c_void, *const c_void) -> *mut c_void;
type BarcodesSize = unsafe extern "C" fn(*const c_void) -> c_int;
type BarcodesAt = unsafe extern "C" fn(*const c_void, c_int) -> *const c_void;
type BarcodeText = unsafe extern "C" fn(*const c_void) -> *mut c_char;

pub struct Zxing {
    image_view_new: ImageViewNew,
    image_view_delete: Delete,
    read_barcodes: ReadBarcodes,
    barcodes_size: BarcodesSize,
    barcodes_at: BarcodesAt,
    barcodes_delete: Delete,
    barcode_text: BarcodeText,
    free: Delete,
    options: *mut c_void,
}

// The options are written once in `open` and only read after; the library's
// reads share nothing else between calls.
unsafe impl Send for Zxing {}
unsafe impl Sync for Zxing {}

/// The library, opened on first use; `None` when it is not installed.
pub fn get() -> Option<&'static Zxing> {
    static ZXING: OnceLock<Option<Zxing>> = OnceLock::new();
    ZXING.get_or_init(|| unsafe { Zxing::open() }).as_ref()
}

unsafe fn symbol<T: Copy>(library: *mut c_void, name: &CStr) -> Option<T> {
    let address = libc::dlsym(library, name.as_ptr());
    (!address.is_null()).then(|| std::mem::transmute_copy(&address))
}

impl Zxing {
    unsafe fn open() -> Option<Zxing> {
        let library = [c"libZXing.so.3", c"libZXing.so"].into_iter().map(|name| libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL)).find(|handle| !handle.is_null())?;
        let opened = (|| {
            let options_new: OptionsNew = symbol(library, c"ZXing_ReaderOptions_new")?;
            let set_formats: SetFormats = symbol(library, c"ZXing_ReaderOptions_setFormats")?;
            let set_try_harder: SetBool = symbol(library, c"ZXing_ReaderOptions_setTryHarder")?;
            let zxing = Zxing {
                image_view_new: symbol(library, c"ZXing_ImageView_new")?,
                image_view_delete: symbol(library, c"ZXing_ImageView_delete")?,
                read_barcodes: symbol(library, c"ZXing_ReadBarcodes")?,
                barcodes_size: symbol(library, c"ZXing_Barcodes_size")?,
                barcodes_at: symbol(library, c"ZXing_Barcodes_at")?,
                barcodes_delete: symbol(library, c"ZXing_Barcodes_delete")?,
                barcode_text: symbol(library, c"ZXing_Barcode_text")?,
                free: symbol(library, c"ZXing_free")?,
                options: options_new(),
            };
            if zxing.options.is_null() {
                return None;
            }
            set_formats(zxing.options, FORMATS_QR);
            set_try_harder(zxing.options, true);
            Some(zxing)
        })();
        if opened.is_none() {
            libc::dlclose(library);
        }
        opened
    }

    /// The text of the first QR code in a greyscale picture.
    pub fn read(&self, luma: &[u8], w: usize, h: usize) -> Option<String> {
        if w == 0 || h == 0 || luma.len() < w * h || w > c_int::MAX as usize || h > c_int::MAX as usize {
            return None;
        }
        unsafe {
            let view = (self.image_view_new)(luma.as_ptr(), w as c_int, h as c_int, FORMAT_LUM, w as c_int, 1);
            if view.is_null() {
                return None;
            }
            let barcodes = (self.read_barcodes)(view, self.options);
            (self.image_view_delete)(view);
            if barcodes.is_null() {
                return None;
            }
            let mut found = None;
            for at in 0..(self.barcodes_size)(barcodes) {
                let barcode = (self.barcodes_at)(barcodes, at);
                if barcode.is_null() {
                    continue;
                }
                let text = (self.barcode_text)(barcode);
                if text.is_null() {
                    continue;
                }
                let value = CStr::from_ptr(text).to_string_lossy().into_owned();
                (self.free)(text.cast());
                if !value.is_empty() {
                    found = Some(value);
                    break;
                }
            }
            (self.barcodes_delete)(barcodes);
            found
        }
    }
}
