//! Runtime Cg → GXP compilation through Sony's SceShaccCg (`libshacccg.suprx`).
//!
//! The compiler is not part of the firmware. Users extract it from the PSM
//! runtime on their own device (ShaRKBR33D writes `ur0:data/libshacccg.suprx`).
//! Development builds use it to compile shader sources served over USB; the
//! resulting GXP binaries are stored in the repository so release builds need
//! no compiler on the device.

use core::ffi::{c_char, c_int, c_void, CStr};
use std::ffi::CString;
use std::sync::Mutex;

#[repr(C)]
struct SourceFile {
    file_name: *const c_char,
    text: *const c_char,
    size: u32,
}

#[repr(C)]
struct SourceLocation {
    file: *const SourceFile,
    line: u32,
    column: u32,
}

type OpenFile = unsafe extern "C" fn(
    *const c_char,
    *const SourceLocation,
    *const CompileOptions,
    *mut *const c_char,
) -> *mut SourceFile;

#[repr(C)]
struct CallbackList {
    open_file: Option<OpenFile>,
    release_file: *const c_void,
    locate_file: *const c_void,
    absolute_path: *const c_void,
    release_file_name: *const c_void,
    file_date: *const c_void,
}

#[repr(C)]
struct CompileOptions {
    main_source_file: *const c_char,
    target_profile: u32,
    entry_function_name: *const c_char,
    search_path_count: u32,
    search_paths: *const *const c_char,
    macro_definition_count: u32,
    macro_definitions: *const *const c_char,
    include_file_count: u32,
    include_files: *const *const c_char,
    suppressed_warnings_count: u32,
    suppressed_warnings: *const u32,
    locale: u32,
    use_fx: i32,
    no_stdlib: i32,
    optimization_level: i32,
    use_fastmath: i32,
    use_fastprecision: i32,
    use_fastint: i32,
    field_48: i32,
    warnings_as_errors: i32,
    performance_warnings: i32,
    warning_level: i32,
    pedantic: i32,
    pedantic_error: i32,
    field_60: i32,
    field_64: i32,
}

const _: () = assert!(core::mem::size_of::<CompileOptions>() == 0x68);

#[repr(C)]
struct DiagnosticMessage {
    level: u32,
    code: u32,
    location: *const SourceLocation,
    message: *const c_char,
}

#[repr(C)]
struct CompileOutput {
    program_data: *const u8,
    program_size: u32,
    diagnostic_count: i32,
    diagnostics: *const DiagnosticMessage,
}

extern "C" {
    fn sceShaccCgInitializeCompileOptions(options: *mut CompileOptions) -> c_int;
    fn sceShaccCgCompileProgram(
        options: *const CompileOptions,
        callbacks: *const CallbackList,
        unk: c_int,
    ) -> *const CompileOutput;
    fn sceShaccCgSetDefaultAllocator(
        malloc: unsafe extern "C" fn(u32) -> *mut c_void,
        free: unsafe extern "C" fn(*mut c_void),
    ) -> c_int;
    fn sceShaccCgInitializeCallbackList(callbacks: *mut CallbackList, defaults: u32);
    fn sceShaccCgDestroyCompileOutput(output: *const CompileOutput);
    fn sceShaccCgGetVersionString() -> *const c_char;
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

unsafe extern "C" fn compiler_malloc(size: u32) -> *mut c_void {
    malloc(size as usize)
}

unsafe extern "C" fn compiler_free(ptr: *mut c_void) {
    free(ptr)
}

/// Where extraction tools place the compiler.
pub const SEARCH_PATHS: [&str; 2] = [
    "ur0:data/libshacccg.suprx",
    "ur0:data/external/libshacccg.suprx",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Vertex,
    Fragment,
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub level: &'static str,
    pub line: u32,
    pub column: u32,
    pub message: String,
}

pub struct Compiled {
    /// GXP program bytes, as written to disk.
    pub program: Vec<u8>,
    pub diagnostics: Vec<Diagnostic>,
}

pub struct Compiler {
    pub path: &'static str,
    pub version: String,
    source: Mutex<()>,
    module: vitasdk_sys::SceUID,
}

/// Holds the text handed to the open-file callback during one compile.
struct Current {
    name: CString,
    text: CString,
    file: SourceFile,
}

static mut CURRENT: Option<Current> = None;

unsafe extern "C" fn open_file(
    _name: *const c_char,
    _from: *const SourceLocation,
    _options: *const CompileOptions,
    error: *mut *const c_char,
) -> *mut SourceFile {
    // SAFETY: CURRENT is set for the duration of compile(), serialized by
    // Compiler::source.
    match (*core::ptr::addr_of_mut!(CURRENT)).as_mut() {
        Some(current) => &mut current.file,
        None => {
            if !error.is_null() {
                *error = c"no source".as_ptr();
            }
            core::ptr::null_mut()
        }
    }
}

impl Compiler {
    /// Loads `libshacccg.suprx` from the first path that exists. Returns the
    /// kernel error for the last attempted path when none can be started.
    pub fn load() -> Result<Self, String> {
        let mut last = String::from("not found");
        for path in SEARCH_PATHS {
            if std::fs::metadata(path).is_err() {
                last = format!("{path}: missing");
                continue;
            }
            let c = CString::new(path).unwrap();
            let uid = unsafe {
                vitasdk_sys::sceKernelLoadStartModule(
                    c.as_ptr(),
                    0,
                    core::ptr::null_mut(),
                    0,
                    core::ptr::null_mut(),
                    core::ptr::null_mut(),
                )
            };
            if uid < 0 {
                last = format!("{path}: sceKernelLoadStartModule 0x{:08x}", uid as u32);
                continue;
            }
            unsafe {
                sceShaccCgSetDefaultAllocator(compiler_malloc, compiler_free);
            }
            let version = unsafe {
                let v = sceShaccCgGetVersionString();
                if v.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(v).to_string_lossy().into_owned()
                }
            };
            return Ok(Self {
                path,
                version,
                source: Mutex::new(()),
                module: uid,
            });
        }
        Err(last)
    }

    /// Stops and unloads the module. After a "fatal internal error" the
    /// compiler fails every later program until it is loaded again.
    pub fn unload(self) {
        unsafe {
            vitasdk_sys::sceKernelStopUnloadModule(
                self.module,
                0,
                core::ptr::null_mut(),
                0,
                core::ptr::null_mut(),
                core::ptr::null_mut(),
            );
        }
    }

    /// Compiles one Cg program with entry point `main`.
    pub fn compile(
        &self,
        name: &str,
        source: &str,
        stage: Stage,
        defines: &[&str],
    ) -> Result<Compiled, Vec<Diagnostic>> {
        let _guard = self.source.lock().unwrap();
        let name_c = CString::new(name).unwrap_or_else(|_| CString::new("shader.cg").unwrap());
        let text_c = CString::new(source).unwrap_or_else(|_| CString::new("").unwrap());
        let defines_c: Vec<CString> = defines
            .iter()
            .filter_map(|d| CString::new(*d).ok())
            .collect();
        let define_ptrs: Vec<*const c_char> = defines_c.iter().map(|d| d.as_ptr()).collect();
        unsafe {
            let size = text_c.as_bytes().len() as u32;
            let current = Current {
                file: SourceFile {
                    file_name: name_c.as_ptr(),
                    text: text_c.as_ptr(),
                    size,
                },
                name: name_c,
                text: text_c,
            };
            *core::ptr::addr_of_mut!(CURRENT) = Some(current);
            let current = (*core::ptr::addr_of!(CURRENT)).as_ref().unwrap();

            let mut callbacks: CallbackList = core::mem::zeroed();
            sceShaccCgInitializeCallbackList(&mut callbacks, 1);
            callbacks.open_file = Some(open_file);

            let mut options: CompileOptions = core::mem::zeroed();
            sceShaccCgInitializeCompileOptions(&mut options);
            options.main_source_file = current.name.as_ptr();
            options.target_profile = match stage {
                Stage::Vertex => 0,
                Stage::Fragment => 1,
            };
            options.entry_function_name = c"main".as_ptr();
            options.macro_definition_count = define_ptrs.len() as u32;
            options.macro_definitions = if define_ptrs.is_empty() {
                core::ptr::null()
            } else {
                define_ptrs.as_ptr()
            };
            options.locale = 0;
            options.use_fx = 1;
            options.optimization_level = 3;
            options.use_fastmath = 1;
            options.use_fastprecision = 0;
            options.use_fastint = 1;
            options.warning_level = 2;
            options.performance_warnings = 0;

            let output = sceShaccCgCompileProgram(&options, &callbacks, 0);
            let _ = &current.text;
            let mut diagnostics = Vec::new();
            let mut program = Vec::new();
            if !output.is_null() {
                let out = &*output;
                for i in 0..out.diagnostic_count.max(0) as usize {
                    let d = &*out.diagnostics.add(i);
                    let (line, column) = if d.location.is_null() {
                        (0, 0)
                    } else {
                        ((*d.location).line, (*d.location).column)
                    };
                    diagnostics.push(Diagnostic {
                        level: match d.level {
                            0 => "info",
                            1 => "warning",
                            _ => "error",
                        },
                        line,
                        column,
                        message: if d.message.is_null() {
                            String::new()
                        } else {
                            CStr::from_ptr(d.message).to_string_lossy().into_owned()
                        },
                    });
                }
                if !out.program_data.is_null() && out.program_size > 0 {
                    program =
                        core::slice::from_raw_parts(out.program_data, out.program_size as usize)
                            .to_vec();
                }
                sceShaccCgDestroyCompileOutput(output);
            }
            *core::ptr::addr_of_mut!(CURRENT) = None;
            if program.is_empty() {
                if diagnostics.is_empty() {
                    diagnostics.push(Diagnostic {
                        level: "error",
                        line: 0,
                        column: 0,
                        message: "compiler produced no program".into(),
                    });
                }
                Err(diagnostics)
            } else {
                Ok(Compiled {
                    program,
                    diagnostics,
                })
            }
        }
    }
}
