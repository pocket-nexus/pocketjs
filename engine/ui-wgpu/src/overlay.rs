//! A PocketJS guest over a Pocket3D frame. Applications provide JSON state
//! and consume JSON commands; the adapter owns viewport and pointer transport.

use crate::{
    Blit, ProgramConfig, ProgramOutput, ProgramTarget, UiProgram, UiSurface, embedded_profile,
};
use anyhow::{Context, Result, anyhow};
use pocket_mod::{Guest, qjs::Function};
use pocket3d::{
    gpu::Gpu,
    input::{Input, PointerEvent},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc, sync::Arc};
use winit::event::MouseButton;

pub struct UiOverlay {
    controls: BTreeMap<String, i32>,
    guest: Rc<Guest>,
    program: UiProgram,
    output: ProgramOutput,
    surface: UiSurface,
    size: (u32, u32),
    scale: f32,
    format: wgpu::TextureFormat,
    blit: Option<(wgpu::TextureFormat, Blit)>,
}

impl UiOverlay {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        gpu: &Gpu,
        format: wgpu::TextureFormat,
        bundle: &str,
        pak: &[u8],
        size: (u32, u32),
        scale: f32,
        density: u32,
    ) -> Result<Self> {
        let scale = valid_scale(scale);
        let logical = [
            (size.0 as f32 / scale).ceil().max(1.) as u32,
            (size.1 as f32 / scale).ceil().max(1.) as u32,
        ];
        // A HUD inside the host game: its package comes from the game's own
        // bundle and pak, not from a `pocket build` export.
        let (profile, profile_hash) = embedded_profile("desktop", logical, density, 60);
        let mut program = UiProgram::new(ProgramConfig {
            profile,
            profile_hash,
            tick_hz: 60,
            host_abi: pocket_spec::BINDING_GENERATION,
            logical,
            heap_limit: 64 * 1024 * 1024,
            frame_buffer_budget: 128 * 1024 * 1024,
        })?;
        let surface = program.surface();
        surface.set_svc_allowlist(["pocket.overlay"]);
        let guest = Rc::new(Guest::new()?);
        let output = ProgramOutput::with_options(
            gpu,
            (logical[0], logical[1]),
            1.,
            format,
            wgpu::Color::TRANSPARENT,
            false,
        )?;
        output.register(&mut program)?;
        program.boot(guest.clone(), "overlay", bundle, pak)?;
        output.configure(size, scale)?;
        program
            .runtime_mut()
            .resize_embedded_gpu(
                [size.0 as f32 / scale, size.1 as f32 / scale],
                [size.0, size.1],
            )
            .map_err(|error| anyhow!("overlay viewport: {error:?}"))?;
        let overlay = Self {
            controls: BTreeMap::new(),
            guest,
            surface,
            program,
            output,
            size,
            scale,
            format,
            blit: None,
        };
        overlay.resize_guest(size.0 as f32 / scale, size.1 as f32 / scale)?;
        Ok(overlay)
    }

    /// Resize layout and input together. Pak raster density is independent of
    /// the OS scale, so a density-2 bundle also works at 1x and fractional DPI.
    pub fn resize(&mut self, size: (u32, u32), scale: f32) -> Result<()> {
        let size = (size.0.max(1), size.1.max(1));
        let scale = valid_scale(scale);
        if self.size == size && self.scale == scale {
            return Ok(());
        }
        self.cancel_pointer();
        let (width, height) = (size.0 as f32 / scale, size.1 as f32 / scale);
        self.output.configure(size, scale)?;
        if let Err(error) = self
            .program
            .runtime_mut()
            .resize_embedded_gpu([width, height], [size.0, size.1])
        {
            self.output.configure(self.size, self.scale)?;
            return Err(anyhow!("overlay resize: {error:?}"));
        }
        self.size = size;
        self.scale = scale;
        self.resize_guest(width, height)
    }
    fn resize_guest(&self, width: f32, height: f32) -> Result<()> {
        self.guest.with(|ctx| -> Result<()> {
            let hook: Option<Function> = ctx.globals().get("__pocketResizeViewport")?;
            if let Some(hook) = hook {
                hook.call::<_, ()>((width, height))
                    .map_err(|e| anyhow!("overlay resize: {e}"))?;
            }
            Ok(())
        })
    }

    pub fn logical_size(&self) -> (f32, f32) {
        (
            self.size.0 as f32 / self.scale,
            self.size.1 as f32 / self.scale,
        )
    }

    pub fn cancel_pointer(&self) {
        self.surface
            .svc_push(json!({"type":"pointer", "event":{"kind":"cancel"}}).to_string());
    }

    /// Consume each rendered frame once. Ordered edges retain a press and
    /// release that both arrived between two frames. A closed overlay should
    /// be cancelled and receive no further game input.
    pub fn frame(&mut self, input: &Input, state: &Value) -> Result<Vec<Value>> {
        self.surface
            .svc_push(json!({"type":"state", "value":state}).to_string());
        for event in input.pointer_events() {
            if let Some(event) = pointer_packet(*event, self.scale) {
                self.surface
                    .svc_push(json!({"type":"pointer", "event":event}).to_string());
            }
        }
        self.program.advance()?;
        let mut commands = Vec::new();
        for line in self.surface.svc_drain() {
            let value: Value =
                serde_json::from_str(&line).context("invalid PocketJS overlay command")?;
            if value["type"] == "pocket.overlay.control" {
                if let (Some(name), Some(node)) = (value["name"].as_str(), value["node"].as_i64()) {
                    if value["remove"] == true {
                        if self.controls.get(name) == Some(&(node as i32)) {
                            self.controls.remove(name);
                        }
                    } else {
                        self.controls.insert(name.to_owned(), node as i32);
                    }
                }
            } else {
                commands.push(value);
            }
        }
        Ok(commands)
    }

    /// Screen-space bounds from the core's painted geometry. This cold
    /// diagnostic query supports coordinate-driven acceptance and inspectors.
    /// It returns None for controls that are no longer painted.
    pub fn control_bounds(&self, name: &str) -> Option<(f32, f32, f32, f32)> {
        let &node = self.controls.get(name)?;
        self.surface.with_ui(|ui| {
            ui.debug_inspect(node);
            ui.draw();
            let xy = ui.debug_rect_xy();
            let wh = ui.debug_rect_wh();
            ui.debug_inspect(0);
            if wh == -1 {
                return None;
            }
            Some((
                (xy as i16) as f32 * self.scale,
                ((xy >> 16) as i16) as f32 * self.scale,
                (wh & 0xffff) as f32 * self.scale,
                ((wh >> 16) & 0xffff) as f32 * self.scale,
            ))
        })
    }

    /// Render through the registered driver, then record scene composition.
    /// Keep the returned lease until the scene encoder has been submitted.
    pub fn render(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        format: wgpu::TextureFormat,
    ) -> Result<Arc<ProgramTarget>> {
        anyhow::ensure!(
            format.is_srgb() == self.format.is_srgb(),
            "overlay output color space changed"
        );
        anyhow::ensure!(
            self.output.prepare()?,
            "all overlay target leases are outstanding"
        );
        self.program.present()?;
        let target = self
            .output
            .last()
            .ok_or_else(|| anyhow!("overlay produced no target"))?;
        if let Some((_, blit)) = self
            .blit
            .as_mut()
            .filter(|(previous_format, _)| *previous_format == format)
        {
            blit.set_source(gpu, &target.view);
        } else {
            self.blit = Some((
                format,
                Blit::new_premultiplied(gpu, &target.view, format, wgpu::FilterMode::Nearest),
            ));
        }
        let blit = &self.blit.as_ref().expect("blit initialized").1;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Pocket UI overlay composition"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            blit.draw(&mut pass);
        }
        Ok(target)
    }
}

fn valid_scale(scale: f32) -> f32 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn pointer_packet(event: PointerEvent, scale: f32) -> Option<Value> {
    let (position, kind, down) = match event {
        PointerEvent::Move(pos) => (pos, "move", None),
        PointerEvent::Button {
            position,
            button: MouseButton::Left,
            down,
        } => (position, "button", Some(down)),
        PointerEvent::Button { .. } => return None,
        PointerEvent::Cancel => return Some(json!({"kind":"cancel"})),
    };
    let mut packet =
        json!({"kind":kind, "x":position.map(|p| p.x / scale), "y":position.map(|p| p.y / scale)});
    if let Some(down) = down {
        packet["down"] = json!(down);
    }
    Some(packet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket3d::input::Input;

    #[test]
    fn ordered_clicks_and_cancellation_reach_the_guest_at_both_scales() {
        let bundle = r#"
            ui.svcOpen("pocket.overlay");
            globalThis.frame = function() {
                const batch = ui.svcPoll();
                if (batch) for (const line of batch.split("\n")) if (line) ui.svcSend(line);
            };
        "#;
        let gpu = Gpu::new_headless().unwrap();
        for scale in [1.0, 1.25, 2.0] {
            let mut overlay = UiOverlay::new(
                &gpu,
                pocket3d::gpu::OFFSCREEN_FORMAT,
                bundle,
                &[],
                (960, 600),
                scale,
                2,
            )
            .unwrap();
            let mut input = Input::default();
            input.inject_cursor(200.0, 100.0);
            input.inject_mouse_button(MouseButton::Left, true);
            input.inject_mouse_button(MouseButton::Left, false);
            let received = overlay.frame(&input, &json!({"count":1})).unwrap();
            assert_eq!(received.len(), 4);
            assert_eq!(received[1]["event"]["x"], json!(200.0 / scale));
            assert_eq!(received[2]["event"]["down"], true);
            assert_eq!(received[3]["event"]["down"], false);
            input.end_frame();
            input.clear();
            let received = overlay.frame(&input, &Value::Null).unwrap();
            assert_eq!(received[1]["event"]["kind"], "cancel");
            overlay.resize((1200, 800), scale).unwrap();
            assert_eq!(overlay.logical_size(), (1200.0 / scale, 800.0 / scale));
        }
    }
    #[test]
    fn runtime_overlay_matches_direct_pixels_at_fractional_scale() {
        let gpu = Gpu::new_headless().unwrap();
        let format = pocket3d::gpu::OFFSCREEN_FORMAT;
        let source = format!(
            "globalThis.size=[];globalThis.__pocketResizeViewport=(w,h)=>size=[w,h];const n=ui.createNode(0);ui.insertBefore(1,n,0);ui.setProp(n,{},19);ui.setProp(n,{},11);ui.setProp(n,{},{});globalThis.frame=()=>{{}};",
            pocketjs_core::spec::prop::WIDTH,
            pocketjs_core::spec::prop::HEIGHT,
            pocketjs_core::spec::prop::BG_COLOR,
            0x806040e0u32
        );
        for scale in [1., 1.25, 2.] {
            let mut overlay =
                UiOverlay::new(&gpu, format, &source, &[], (37, 23), scale, 1).unwrap();
            let width: f32 = overlay.guest.with(|ctx| ctx.eval("size[0]")).unwrap();
            assert_eq!(width, 37. / scale);
            assert_eq!(
                overlay.surface.with_ui(|ui| ui.viewport()),
                (37. / scale, 23. / scale)
            );
            overlay.frame(&Input::default(), &Value::Null).unwrap();
            let direct = pocket3d::gpu::OffscreenTarget::new(&gpu, 37, 23);
            let composed = pocket3d::gpu::OffscreenTarget::new(&gpu, 37, 23);
            let background = wgpu::Color {
                r: 0.15,
                g: 0.25,
                b: 0.4,
                a: 1.,
            };
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            let mut reference = crate::UiRenderer::new(&gpu, format);
            overlay.surface.with_ui(|ui| {
                let words = ui.draw().words.clone();
                reference
                    .render_words_scaled(
                        &gpu,
                        ui,
                        &words,
                        &mut encoder,
                        &direct.view,
                        direct.size,
                        scale,
                        wgpu::LoadOp::Clear(background),
                    )
                    .unwrap();
            });
            {
                let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("overlay background"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &composed.view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(background),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
            }
            let lease = overlay
                .render(&gpu, &mut encoder, &composed.view, format)
                .unwrap();
            assert_eq!(overlay.output.pending_submissions(), 0);
            gpu.queue.submit([encoder.finish()]);
            let actual = composed.read_rgba(&gpu).unwrap();
            let expected = direct.read_rgba(&gpu).unwrap();
            for (i, (a, b)) in actual.iter().zip(expected).enumerate() {
                assert!(
                    a.abs_diff(b) <= 1,
                    "scale {scale}, byte {i}: composite {a}, direct {b}"
                );
            }
            // The completed frame stays valid across output reconfiguration.
            let retained = lease.read_rgba(&gpu).unwrap();
            overlay.resize((41, 31), scale).unwrap();
            overlay.frame(&Input::default(), &Value::Null).unwrap();
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            let next = pocket3d::gpu::OffscreenTarget::new(&gpu, 41, 31);
            let next_lease = overlay
                .render(&gpu, &mut encoder, &next.view, format)
                .unwrap();
            gpu.queue.submit([encoder.finish()]);
            assert_eq!(lease.read_rgba(&gpu).unwrap(), retained);
            assert_eq!(next_lease.size, (41, 31));
        }
    }
    #[test]
    fn tiny_physical_window_keeps_the_existing_core_minimum_viewport() {
        let gpu = Gpu::new_headless().unwrap();
        let format = pocket3d::gpu::OFFSCREEN_FORMAT;
        let mut overlay =
            UiOverlay::new(&gpu, format, "globalThis.frame=()=>{}", &[], (1, 1), 2., 1).unwrap();
        assert_eq!(overlay.logical_size(), (0.5, 0.5));
        assert_eq!(overlay.surface.with_ui(|ui| ui.viewport()), (1., 1.));
        overlay.resize((1, 2), 2.).unwrap();
        let target = pocket3d::gpu::OffscreenTarget::new(&gpu, 1, 2);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        let lease = overlay
            .render(&gpu, &mut encoder, &target.view, format)
            .unwrap();
        gpu.queue.submit([encoder.finish()]);
        assert_eq!(lease.size, (1, 2));
        assert_eq!(lease.read_rgba(&gpu).unwrap().len(), 8);
    }
}
