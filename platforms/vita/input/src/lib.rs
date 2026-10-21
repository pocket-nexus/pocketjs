#[cfg(target_os = "vita")]
use vitasdk_sys::{
    sceCtrlPeekBufferPositive, sceCtrlSetSamplingMode, sceTouchGetPanelInfo, sceTouchPeek,
    sceTouchSetSamplingState, SceCtrlData, SceTouchData, SceTouchPanelInfo, SCE_CTRL_MODE_ANALOG,
    SCE_TOUCH_PORT_FRONT, SCE_TOUCH_SAMPLING_STATE_START,
};

mod pad;
mod touch;

pub use pad::Pad;
pub use touch::{TouchPanel, TouchReport, TouchSnapshot};

#[cfg(target_os = "vita")]
static mut FRONT_PANEL: TouchPanelState = TouchPanelState::Uninitialized;

#[cfg(target_os = "vita")]
#[derive(Clone, Copy)]
enum TouchPanelState {
    Uninitialized,
    Ready(touch::TouchPanel),
}

#[cfg(target_os = "vita")]
pub fn init() {
    unsafe {
        sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
        let _ = sceTouchSetSamplingState(SCE_TOUCH_PORT_FRONT, SCE_TOUCH_SAMPLING_STATE_START);
        let mut info: SceTouchPanelInfo = core::mem::zeroed();
        let panel = if sceTouchGetPanelInfo(SCE_TOUCH_PORT_FRONT, &mut info) >= 0 {
            touch::TouchPanel::new([
                info.minDispX as i32,
                info.minDispY as i32,
                info.maxDispX as i32,
                info.maxDispY as i32,
            ])
        } else {
            touch::TouchPanel::default()
        };
        FRONT_PANEL = TouchPanelState::Ready(panel);
    }
}

#[cfg(target_os = "vita")]
pub fn read_touches(logical: [i32; 2]) -> TouchSnapshot {
    unsafe {
        let TouchPanelState::Ready(panel) = FRONT_PANEL else {
            return TouchSnapshot::EMPTY;
        };
        let mut data: SceTouchData = core::mem::zeroed();
        if sceTouchPeek(SCE_TOUCH_PORT_FRONT, &mut data, 1) < 0 {
            return TouchSnapshot::EMPTY;
        }
        let count = (data.reportNum as usize)
            .min(data.report.len())
            .min(touch::MAX_TOUCHES);
        let mut reports = [TouchReport::default(); touch::MAX_TOUCHES];
        for (out, raw) in reports.iter_mut().zip(&data.report[..count]) {
            *out = TouchReport {
                id: raw.id,
                x: raw.x,
                y: raw.y,
            };
        }
        TouchSnapshot::from_reports(panel, &reports[..count], logical)
    }
}

#[cfg(target_os = "vita")]
pub fn read() -> Pad {
    unsafe {
        let mut raw: SceCtrlData = core::mem::zeroed();
        sceCtrlPeekBufferPositive(0, &mut raw, 1);
        Pad {
            buttons: raw.buttons,
            lx: raw.lx,
            ly: raw.ly,
            rx: raw.rx,
            ry: raw.ry,
        }
    }
}
