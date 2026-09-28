// SPDX-License-Identifier: MIT
//! Independent module used by the desktop host's real dynamic-loading test.
use anyhow::Result;
use pocket_desktop_native::{
    Application, Context, Event, KEY, RESET, Render, export_application, wgpu,
};
use std::{fs::OpenOptions, io::Write, path::PathBuf};
struct Fixture {
    journal: PathBuf,
    red: bool,
    ticks: u64,
}
impl Fixture {
    fn record(&self, text: &str) -> Result<()> {
        writeln!(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.journal)?,
            "{text}"
        )?;
        Ok(())
    }
}
impl Application for Fixture {
    fn create(c: Context<'_>) -> Result<Self> {
        let app = Self {
            journal: c.root.join("events.log"),
            red: false,
            ticks: 0,
        };
        app.record("create")?;
        Ok(app)
    }
    fn event(&mut self, e: &Event) -> Result<()> {
        if e.kind == KEY && e.key_name() == "w" {
            self.red = e.down != 0;
        }
        if e.kind == RESET {
            self.red = false;
            self.record("reset")?;
        }
        Ok(())
    }
    fn tick(&mut self, _: f64) -> Result<()> {
        self.ticks += 1;
        self.record(&format!("tick:{}", self.ticks))
    }
    fn render(&mut self, c: Render<'_>) -> Result<()> {
        let _pass = c.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("independent native fixture"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: c.target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(if self.red {
                        wgpu::Color::RED
                    } else {
                        wgpu::Color::BLUE
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.record("destroy");
    }
}
export_application!(Fixture, "dev.pocket-stack.native-fixture", 0);
