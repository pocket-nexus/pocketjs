use super::*;
use std::{
    fs::{File, OpenOptions},
    os::fd::AsRawFd,
    path::Path,
};
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Bitfield {
    offset: u32,
    length: u32,
    msb_right: u32,
}
#[repr(C)]
#[derive(Default)]
struct Variable {
    xres: u32,
    yres: u32,
    xres_virtual: u32,
    yres_virtual: u32,
    xoffset: u32,
    yoffset: u32,
    bits_per_pixel: u32,
    grayscale: u32,
    red: Bitfield,
    green: Bitfield,
    blue: Bitfield,
    transp: Bitfield,
    nonstd: u32,
    activate: u32,
    height: u32,
    width: u32,
    accel_flags: u32,
    pixclock: u32,
    left_margin: u32,
    right_margin: u32,
    upper_margin: u32,
    lower_margin: u32,
    hsync_len: u32,
    vsync_len: u32,
    sync: u32,
    vmode: u32,
    rotate: u32,
    colorspace: u32,
    reserved: [u32; 4],
}
#[repr(C)]
#[derive(Default)]
struct Fixed {
    id: [u8; 16],
    smem_start: libc::c_ulong,
    smem_len: u32,
    type_: u32,
    type_aux: u32,
    visual: u32,
    xpanstep: u16,
    ypanstep: u16,
    ywrapstep: u16,
    line_length: u32,
    mmio_start: libc::c_ulong,
    mmio_len: u32,
    accel: u32,
    capabilities: u16,
    reserved: [u16; 2],
}
pub struct Mapping {
    pointer: *mut libc::c_void,
    length: usize,
    _file: File,
}
impl FrameStore for Mapping {
    fn bytes_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.pointer.cast(), self.length) }
    }
    /// A framebuffer that DRM emulates for a panel without scanout memory (an
    /// SPI panel such as panel-mipi-dbi) uses deferred I/O: the kernel collects
    /// the pages written through the mapping and sends them to the panel 50 ms
    /// after the first write, about 18 updates a second on the CardputerZero,
    /// so the frames of a 30 Hz animation merge. fsync on the device runs that
    /// flush now (fb_deferred_io_fsync). On a framebuffer without deferred I/O
    /// the call fails or does nothing, and the error is ignored.
    fn sync(&mut self) {
        unsafe {
            libc::fsync(self._file.as_raw_fd());
        }
    }
}
impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.pointer, self.length);
        }
    }
}
pub fn open(path: impl AsRef<Path>) -> io::Result<Framebuffer<Mapping>> {
    if cfg!(target_endian = "big") {
        return Err(invalid("framebuffer staging requires little-endian output"));
    }
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let mut fixed = Fixed::default();
    let mut variable = Variable::default();
    if unsafe { libc::ioctl(file.as_raw_fd(), 0x4602, &mut fixed) } < 0
        || unsafe { libc::ioctl(file.as_raw_fd(), 0x4600, &mut variable) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    if fixed.type_ != 0
        || fixed.visual != 2
        || variable.nonstd != 0
        || variable.grayscale != 0
        || variable.rotate != 0
        || variable
            .xoffset
            .checked_add(variable.xres)
            .is_none_or(|x| x > variable.xres_virtual)
        || variable
            .yoffset
            .checked_add(variable.yres)
            .is_none_or(|y| y > variable.yres_virtual)
    {
        return Err(invalid("framebuffer requires packed true-color pixels"));
    }
    if [variable.red, variable.green, variable.blue, variable.transp]
        .iter()
        .any(|channel| channel.msb_right != 0)
    {
        return Err(invalid("reversed bitfields are unsupported"));
    }
    let channel = |value: Bitfield| Channel {
        offset: value.offset,
        bits: value.length,
    };
    let geometry = Geometry {
        width: variable.xres,
        height: variable.yres,
        x_offset: variable.xoffset,
        y_offset: variable.yoffset,
        stride: fixed.line_length as usize,
        mapping_bytes: fixed.smem_len as usize,
        bits_per_pixel: variable.bits_per_pixel,
        red: channel(variable.red),
        green: channel(variable.green),
        blue: channel(variable.blue),
        alpha: channel(variable.transp),
    };
    geometry.validate()?;
    let pointer = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            geometry.mapping_bytes,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    if pointer == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    Framebuffer::new(
        Mapping {
            pointer,
            length: geometry.mapping_bytes,
            _file: file,
        },
        geometry,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kernel_layout_matches_native_header_contract() {
        assert_eq!(size_of::<Variable>(), 160);
        assert_eq!(
            size_of::<Fixed>(),
            if size_of::<libc::c_ulong>() == 8 {
                80
            } else {
                68
            }
        );
        assert_eq!(
            std::mem::offset_of!(Fixed, line_length),
            if size_of::<libc::c_ulong>() == 8 {
                48
            } else {
                44
            }
        );
    }
}
