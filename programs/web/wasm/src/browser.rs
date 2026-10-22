use super::*;
use pocket_package::embedded::{self, EmbeddedPackage};
use pocket_package::source::MemorySource;
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, RuntimeConfig};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "pocket_web")]
unsafe extern "C" {
    fn guest_call(
        kind: u32,
        host: *const std::ffi::c_void,
        p: *const u8,
        n: usize,
        pak: *const u8,
        pak_len: usize,
    ) -> i32;
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn guest_call(
    _: u32,
    _: *const std::ffi::c_void,
    _: *const u8,
    _: usize,
    _: *const u8,
    _: usize,
) -> i32 {
    -1
}

pub struct BrowserGuest(pub *const WasmHost);
impl BrowserGuest {
    fn call(&self, kind: u32, payload: &[u8], pak: &[u8]) -> Result<(), RuntimeError> {
        if unsafe {
            guest_call(
                kind,
                self.0.cast(),
                payload.as_ptr(),
                payload.len(),
                pak.as_ptr(),
                pak.len(),
            )
        } == 0
        {
            Ok(())
        } else {
            Err(RuntimeError::Guest)
        }
    }
}
impl Guest for BrowserGuest {
    fn initialize(&mut self, _: OpContext, e: &GuestEnvironment<'_>) -> Result<(), RuntimeError> {
        let mut value = json!({"host":e.host,"hostAbi":e.host_abi,"tickHz":e.tick_hz,"viewport":{"w":e.viewport[0],"h":e.viewport[1]}});
        if let Some([w, h]) = e.auxiliary_viewport {
            value["auxiliary"] = json!({"root":e.auxiliary_root,"w":w,"h":h});
        }
        self.call(0, &serde_json::to_vec(&value).unwrap(), e.pak)
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        self.call(1, code.strip_suffix(&[0]).unwrap_or(code), &[])
    }
    fn frame(&mut self, f: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        let deltas = f
            .axis_deltas
            .iter()
            .map(|a| json!({"axis":a.id,"delta":a.delta}))
            .collect::<Vec<_>>();
        self.call(
            2,
            &serde_json::to_vec(&json!([
                f.buttons,
                f.analog,
                f.touches,
                f.hits,
                f.touch_surfaces,
                f.right_analog,
                deltas,
                null
            ]))
            .unwrap(),
            &[],
        )
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        self.call(3, &[], &[])
    }
    fn shutdown(&mut self) {
        let _ = self.call(4, &[], &[]);
    }
}
pub struct BrowserInput(pub Rc<RefCell<InputFrameBuilder>>);
impl InputSource for BrowserInput {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS
            | InputClasses::AXIS_ABSOLUTE
            | InputClasses::CONTACT
            | InputClasses::AXIS_RELATIVE
    }
    fn poll(&mut self, f: &mut InputFrameBuilder) {
        let src = self.0.borrow();
        f.buttons |= src.buttons;
        f.axes.extend_from_slice(&src.axes);
        f.contacts.extend_from_slice(&src.contacts);
        f.relative.extend_from_slice(&src.relative);
    }
}
#[derive(Clone, Copy, Default)]
pub struct Snapshot {
    pub ptr: *const u8,
    pub len: usize,
}
pub struct Display {
    size: Rc<Cell<[u32; 2]>>,
    role: DisplayRole,
    pixels: Vec<u8>,
    snapshot: Rc<Cell<Snapshot>>,
    generation: u64,
    allocated: [u32; 2],
    serial: u64,
    pending: Option<u64>,
}
impl Display {
    pub fn new(size: Rc<Cell<[u32; 2]>>, role: DisplayRole, snapshot: Rc<Cell<Snapshot>>) -> Self {
        Self {
            size,
            role,
            pixels: Vec::new(),
            snapshot,
            generation: 1,
            allocated: [0, 0],
            serial: 0,
            pending: None,
        }
    }
    fn allocate(&mut self) -> Result<(), DisplayError> {
        let size = self.size.get();
        if self.allocated != size {
            let len = checked_size(size, 1).ok_or(DisplayError::InvalidTarget)?;
            resize(&mut self.pixels, len).map_err(|_| DisplayError::Failed)?;
            self.allocated = size;
            self.generation = self.generation.wrapping_add(1);
            self.snapshot.set(Snapshot::default());
        }
        Ok(())
    }
}
impl DisplayOutput for Display {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let [w, h] = self.size.get();
        let mut d = DisplayDescriptor::new(
            self.role,
            w,
            h,
            PixelFormat::Rgba8888,
            w as usize * 4,
            TargetOwnership::CpuVisible,
        );
        d.partial_refresh = true;
        d
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        self.allocate()?;
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: self.generation,
        }))
    }
    fn acquire(&mut self, r: Rect) -> Result<Target<'_>, DisplayError> {
        if self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        self.allocate()?;
        let [w, h] = self.size.get();
        if r.x.checked_add(r.width).is_none_or(|n| n > w)
            || r.y.checked_add(r.height).is_none_or(|n| n > h)
        {
            return Err(DisplayError::InvalidTarget);
        }
        let stride = w as usize * 4;
        let offset = r.y as usize * stride + r.x as usize * 4;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.pixels[offset..],
            r,
            stride,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<u64, DisplayError> {
        if self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        self.serial += 1;
        self.pending = Some(self.serial);
        Ok(self.serial)
    }
    fn wait(&mut self, t: u64) -> Result<(), DisplayError> {
        if self.pending != Some(t) {
            return Err(DisplayError::InvalidTarget);
        }
        self.pending = None;
        self.snapshot.set(Snapshot {
            ptr: self.pixels.as_ptr(),
            len: self.pixels.len(),
        });
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

#[no_mangle]
pub unsafe extern "C" fn web_boot(
    h: &WasmHost,
    code: *const u8,
    code_len: usize,
    pak: *const u8,
    pak_len: usize,
    hz: u32,
    scale: u32,
) -> i32 {
    status(
        h,
        (|| {
            let mut slot = h.runtime.try_borrow_mut().map_err(|_| RuntimeError::Busy)?;
            if slot.is_some() {
                return Err(RuntimeError::InvalidState);
            }
            let [w, height] = h.logical.get();
            checked_size([w, height], scale).ok_or(RuntimeError::InvalidArgument)?;
            let density = h.density.get();
            let (host, abi) = h.identity.borrow().clone();
            h.physical.set([w * scale, height * scale]);
            let mut display = json!({"physicalViewport":[w*scale,height*scale],"logicalViewports":[[w,height]],"rasterDensity":density});
            let mut plan = json!({"viewport":{"logical":[w,height],"rasterDensity":density},"features":{"input.buttons":true,"input.analog.left":true,"input.analog.right":true,"input.touch":true,"input.axis.relative":true,"text.glyphs.baked":true,"ui.physics":true}});
            if let Some([aw, ah]) = h.auxiliary.get() {
                checked_size([aw, ah], scale).ok_or(RuntimeError::InvalidArgument)?;
                display["auxiliary"] = json!({"physicalViewport":[aw*scale,ah*scale],"logicalViewports":[[aw,ah]],"rasterDensity":density});
                plan["surfaces"] = json!({"auxiliary":{"logical":[aw,ah],"rasterDensity":density}});
                plan["features"]["display.auxiliary"] = json!(true);
                plan["features"]["input.touch.auxiliary"] = json!(true);
            }
            let profile=serde_json::to_vec(&json!({"id":host,"platform":"web","form":"embedded","tickHz":hz,"display":display,"capabilities":["input.buttons","input.analog.left","input.analog.right","input.touch","input.axis.relative","text.glyphs.baked","ui.physics"],"roleCapabilities":{}})).unwrap();
            let identity =
                embedded::identity("web", "dev.pocketjs.web.embedded", "Web embedded guest")
                    .map_err(|_| RuntimeError::InvalidArgument)?;
            let plan = serde_json::to_vec(&plan).unwrap();
            let package = embedded::encode(EmbeddedPackage {
                target: &host,
                host_abi: abi,
                profile_hash: pocket_package::sha256::sha256(&profile),
                identity: &identity,
                plan: &plan,
                code: bytes(code, code_len),
                pak: bytes(pak, pak_len),
            })
            .map_err(|_| RuntimeError::InvalidArgument)?;
            let mut runtime = Runtime::new(RuntimeConfig {
                profile_hash: pocket_package::sha256::sha256(&profile),
                host_abi: abi,
                tick_hz: hz,
                heap_limit: MAX_BYTES,
                frame_buffer_budget: MAX_BYTES,
                profile_json: profile,
            })?;
            runtime.allow_embedded_viewport_changes()?;
            runtime.set_native_asset_loading(false)?;
            runtime.set_package_source(Box::new(MemorySource(package)))?;
            runtime.set_guest(Box::new(BrowserGuest(h)))?;
            if !h.provider_ops.borrow().is_empty() {
                runtime.add_provider(Box::new(BrowserProvider {
                    host: h,
                    operations: h.provider_ops.borrow().clone(),
                }))?;
            }
            runtime.add_input_source(Box::new(BrowserInput(h.input.clone())))?;
            runtime.add_display(
                Display::new(h.physical.clone(), DisplayRole::Primary, h.snapshot.clone()),
                pocket_present::RendererId::SOFTWARE,
            )?;
            if let Some([aw, ah]) = h.auxiliary.get() {
                runtime.add_display(
                    Display::new(
                        Rc::new(Cell::new([aw * scale, ah * scale])),
                        DisplayRole::Auxiliary,
                        Rc::new(Cell::new(Snapshot::default())),
                    ),
                    pocket_present::RendererId::SOFTWARE,
                )?;
            }
            let ops = runtime.op_context();
            ops.set_compositor_enabled(true)?;
            *h.ops.borrow_mut() = ops;
            // Store before any imported guest callback. Callbacks use only the
            // separate OpContext; trying to boot/reset/destroy again returns Busy.
            *slot = Some(runtime);
            let runtime = slot.as_mut().unwrap();
            runtime.boot_deferred()?;
            runtime.skip_presentation()?;
            Ok(())
        })(),
    )
}
#[no_mangle]
pub unsafe extern "C" fn web_advance(h: &WasmHost, p: *const u8, n: usize, ticks: u32) -> i32 {
    status(
        h,
        (|| {
            let value: Value =
                serde_json::from_slice(bytes(p, n)).map_err(|_| RuntimeError::InvalidInput)?;
            let mut facts = InputFrameBuilder::new();
            facts.buttons = value["buttons"].as_u64().unwrap_or(0) as u32;
            let left = value["analog"].as_u64().unwrap_or(0x8080) as u32;
            let right = value["rightAnalog"].as_u64().unwrap_or(0x8080) as u32;
            for (id, v) in [
                (POCKET_AXIS_LEFT_X, (left >> 8) & 255),
                (POCKET_AXIS_LEFT_Y, left & 255),
                (POCKET_AXIS_RIGHT_X, (right >> 8) & 255),
                (POCKET_AXIS_RIGHT_Y, right & 255),
            ] {
                facts.axes.push(AxisSample {
                    id,
                    value: v as f32,
                });
            }
            if let Some(contacts) = value["contacts"].as_array() {
                for c in contacts {
                    facts.contacts.push(Contact {
                        surface: c["surface"].as_u64().ok_or(RuntimeError::InvalidInput)? as u32,
                        id: c["id"].as_u64().ok_or(RuntimeError::InvalidInput)? as u32,
                        x: c["x"].as_f64().ok_or(RuntimeError::InvalidInput)? as f32,
                        y: c["y"].as_f64().ok_or(RuntimeError::InvalidInput)? as f32,
                        cancelled: c["cancelled"].as_bool().unwrap_or(false),
                    });
                }
            }
            if let Some(deltas) = value["axisDeltas"].as_array() {
                for d in deltas {
                    facts.relative.push(AxisDelta {
                        id: d["axis"].as_u64().ok_or(RuntimeError::InvalidInput)? as u32,
                        delta: d["delta"]
                            .as_i64()
                            .and_then(|v| i32::try_from(v).ok())
                            .ok_or(RuntimeError::InvalidInput)?,
                    });
                }
            }
            let mut runtime = h.runtime.try_borrow_mut().map_err(|_| RuntimeError::Busy)?;
            let runtime = runtime.as_mut().ok_or(RuntimeError::InvalidState)?;
            *h.input.borrow_mut() = facts;
            runtime.skip_presentation()?;
            runtime.advance_with_core_ticks(ticks)
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_present(h: &WasmHost) -> i32 {
    status(
        h,
        (|| {
            h.runtime
                .try_borrow_mut()
                .map_err(|_| RuntimeError::Busy)?
                .as_mut()
                .ok_or(RuntimeError::InvalidState)?
                .present()
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_pixels(h: &WasmHost) -> *const u8 {
    h.snapshot.get().ptr
}
#[no_mangle]
pub extern "C" fn web_pixels_len(h: &WasmHost) -> usize {
    h.snapshot.get().len
}

struct BrowserProvider {
    host: *const WasmHost,
    operations: Vec<u16>,
}
impl pocket_runtime::OpProvider for BrowserProvider {
    fn supports_op(&self, op: u16) -> bool {
        self.operations.contains(&op)
    }
    fn dispatch(
        &mut self,
        _: &mut Ui,
        op: u16,
        args: &[pocket_runtime::OpArg<'_>],
    ) -> Result<OpResult, RuntimeError> {
        use pocket_runtime::generated_ops::{ArgKind, OP_DESCRIPTORS};
        let descriptor = OP_DESCRIPTORS
            .iter()
            .find(|d| d.id == op)
            .ok_or(RuntimeError::UnsupportedOperation)?;
        let arguments = args
            .iter()
            .zip(descriptor.args)
            .map(|(value, kind)| match value {
                pocket_runtime::OpArg::Integer(v) => json!(v),
                pocket_runtime::OpArg::Real(v) => json!(v),
                pocket_runtime::OpArg::Bytes(b) => {
                    if kind.kind == ArgKind::String {
                        json!(String::from_utf8_lossy(b))
                    } else {
                        json!(b)
                    }
                }
            })
            .collect::<Vec<_>>();
        let payload=serde_json::to_vec(&json!({"name":descriptor.name,"args":arguments,"result":format!("{:?}",descriptor.result)})).unwrap();
        // Only the provider-result mailbox is mutably borrowed across this
        // callback. Reentrant core operations fail through OpContext::Busy.
        let host = unsafe { &*self.host };
        host.provider_result.borrow_mut().take();
        BrowserGuest(self.host).call(5, &payload, &[])?;
        host.provider_result
            .borrow_mut()
            .take()
            .ok_or(RuntimeError::InvalidArgument)
    }
}
#[no_mangle]
pub unsafe extern "C" fn web_register_provider(h: &WasmHost, p: *const u8, n: usize) -> i32 {
    status(
        h,
        (|| {
            if h.runtime
                .try_borrow()
                .map_err(|_| RuntimeError::Busy)?
                .is_some()
            {
                return Err(RuntimeError::InvalidState);
            }
            let name =
                std::str::from_utf8(bytes(p, n)).map_err(|_| RuntimeError::InvalidArgument)?;
            let descriptor = pocket_runtime::generated_ops::OP_DESCRIPTORS
                .iter()
                .find(|d| d.name == name)
                .ok_or(RuntimeError::UnsupportedOperation)?;
            if matches!(descriptor.provider, "core" | "package") {
                return Err(RuntimeError::InvalidArgument);
            }
            let mut operations = h.provider_ops.borrow_mut();
            if operations.contains(&descriptor.id) {
                return Err(RuntimeError::InvalidArgument);
            }
            operations.push(descriptor.id);
            Ok(())
        })(),
    )
}
#[no_mangle]
pub unsafe extern "C" fn web_provider_result(h: &WasmHost, p: *const u8, n: usize) -> i32 {
    status(
        h,
        (|| {
            let value: Value =
                serde_json::from_slice(bytes(p, n)).map_err(|_| RuntimeError::InvalidArgument)?;
            let result = match value["kind"].as_str() {
                Some("none") => OpResult::None,
                Some("integer") => OpResult::Integer(
                    value["value"]
                        .as_i64()
                        .ok_or(RuntimeError::InvalidArgument)?,
                ),
                Some("real") => OpResult::Real(
                    value["value"]
                        .as_f64()
                        .ok_or(RuntimeError::InvalidArgument)?,
                ),
                Some("bytes") => OpResult::Bytes(
                    value["value"]
                        .as_array()
                        .ok_or(RuntimeError::InvalidArgument)?
                        .iter()
                        .map(|v| {
                            v.as_u64()
                                .and_then(|n| u8::try_from(n).ok())
                                .ok_or(RuntimeError::InvalidArgument)
                        })
                        .collect::<Result<_, _>>()?,
                ),
                _ => return Err(RuntimeError::InvalidArgument),
            };
            *h.provider_result.borrow_mut() = Some(result);
            Ok(())
        })(),
    )
}

#[no_mangle]
pub unsafe extern "C" fn web_set_identity(h: &WasmHost, p: *const u8, n: usize, abi: u32) -> i32 {
    status(
        h,
        (|| {
            if abi != BINDING_GENERATION {
                return Err(RuntimeError::BindingGenerationMismatch);
            }
            if h.runtime
                .try_borrow()
                .map_err(|_| RuntimeError::Busy)?
                .is_some()
            {
                return Err(RuntimeError::InvalidState);
            }
            let name =
                std::str::from_utf8(bytes(p, n)).map_err(|_| RuntimeError::InvalidArgument)?;
            if name.is_empty() || name.len() >= 32 || name.contains('\0') {
                return Err(RuntimeError::InvalidArgument);
            }
            *h.identity.borrow_mut() = (name.into(), abi);
            Ok(())
        })(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_requires_current_generation_before_changing_the_host() {
        let pointer = web_create(4, 4, 1, 0, 0);
        assert!(!pointer.is_null());
        let host = unsafe { &*pointer };
        assert_eq!(*host.identity.borrow(), ("web".into(), BINDING_GENERATION));
        let name = b"browser-test";
        for generation in (0..12).chain([BINDING_GENERATION + 1, u32::MAX]) {
            assert_ne!(
                unsafe { web_set_identity(host, name.as_ptr(), name.len(), generation) },
                0
            );
            assert_eq!(*host.identity.borrow(), ("web".into(), BINDING_GENERATION));
            assert_eq!(&*host.result.borrow(), b"BindingGenerationMismatch");
            assert!(host.runtime.borrow().is_none());
        }
        assert_eq!(
            unsafe { web_set_identity(host, name.as_ptr(), name.len(), BINDING_GENERATION) },
            0
        );
        assert_eq!(
            *host.identity.borrow(),
            ("browser-test".into(), BINDING_GENERATION)
        );
        assert_eq!(unsafe { web_destroy(pointer) }, 0);
    }
}
