use super::*;
use alloc::string::ToString;

pub struct CInputSource {
    table: PocketInputSourceV1,
    context: *mut c_void,
    classes: InputClasses,
    last_error: Option<AdapterError>,
}
impl CInputSource {
    /// # Safety
    /// Callback/context storage obeys the input contract; append contributions
    /// remain readable until append returns, including nested borrowed arrays.
    pub unsafe fn new(
        table: *const PocketInputSourceV1,
        context: *mut c_void,
    ) -> Result<Self, AdapterError> {
        let table =
            unsafe { PocketInputSourceV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        if table.poll.is_none() {
            return Err(AdapterError::Unsupported);
        }
        let bits = unsafe { table.classes.ok_or(AdapterError::Unsupported)?(context) };
        let mut classes = InputClasses::NONE;
        for class in [
            InputClasses::BUTTONS,
            InputClasses::AXIS_ABSOLUTE,
            InputClasses::AXIS_RELATIVE,
            InputClasses::POINTER,
            InputClasses::CONTACT,
            InputClasses::TEXT,
            InputClasses::MOTION,
        ] {
            if bits & class.bits() != 0 {
                classes |= class;
            }
        }
        Ok(Self {
            table,
            context,
            classes,
            last_error: None,
        })
    }
    pub fn last_error(&self) -> Option<AdapterError> {
        self.last_error
    }
}
fn merge(destination: &mut InputFrameBuilder, mut source: InputFrameBuilder) {
    destination.buttons |= source.buttons;
    destination.axes.append(&mut source.axes);
    destination.relative.append(&mut source.relative);
    destination.contacts.append(&mut source.contacts);
    destination.cancelled.append(&mut source.cancelled);
    destination.text.append(&mut source.text);
    if source.pointer.is_some() {
        destination.pointer = source.pointer;
    }
    if source.motion.is_some() {
        destination.motion = source.motion;
    }
}
struct Append {
    frame: InputFrameBuilder,
    error: Option<AdapterError>,
}
unsafe extern "C" fn append(context: *mut c_void, pointer: *const PocketInputFrame) -> i32 {
    let Some(append) = (unsafe { context.cast::<Append>().as_mut() }) else {
        return POCKET_STATUS_INVALID;
    };
    match unsafe { decode(pointer) } {
        Ok(frame) => {
            merge(&mut append.frame, frame);
            POCKET_STATUS_OK
        }
        Err(error) => {
            append.error = Some(error);
            error.status()
        }
    }
}
impl InputSource for CInputSource {
    fn classes(&self) -> InputClasses {
        self.classes
    }
    fn poll(&mut self, destination: &mut InputFrameBuilder) {
        let mut contribution = Append {
            frame: InputFrameBuilder::new(),
            error: None,
        };
        let mut builder = PocketInputFrameBuilder {
            context: (&mut contribution as *mut Append).cast(),
            append: Some(append),
            ..PocketInputFrameBuilder::empty()
        };
        let result = check(unsafe { self.table.poll.unwrap()(self.context, &mut builder) });
        self.last_error = contribution.error.or(result.err());
        if self.last_error.is_none() {
            merge(destination, contribution.frame);
        }
    }
}
unsafe fn decode(pointer: *const PocketInputFrame) -> Result<InputFrameBuilder, AdapterError> {
    let raw = unsafe { PocketInputFrame::read_prefix(pointer) }.ok_or(AdapterError::Invalid)?;
    let mut result = InputFrameBuilder::new();
    result.buttons = raw.buttons;
    unsafe {
        record_array(raw.axes, raw.axis_count, |pointer| {
            let item = PocketAxisSample::read_prefix(pointer).ok_or(AdapterError::Invalid)?;
            if !item.value.is_finite() {
                return Err(AdapterError::Invalid);
            }
            result.axes.push(AxisSample {
                id: item.axis,
                value: item.value,
            });
            Ok(())
        })
    }?;
    unsafe {
        record_array(raw.relative, raw.relative_count, |pointer| {
            let item = PocketAxisDelta::read_prefix(pointer).ok_or(AdapterError::Invalid)?;
            result.relative.push(AxisDelta {
                id: item.axis,
                delta: item.delta,
            });
            Ok(())
        })
    }?;
    if !raw.pointer.is_null() {
        let item =
            unsafe { PocketPointer::read_prefix(raw.pointer) }.ok_or(AdapterError::Invalid)?;
        if !item.x.is_finite() || !item.y.is_finite() {
            return Err(AdapterError::Invalid);
        }
        result.pointer = Some(Pointer {
            surface: item.surface,
            x: item.x,
            y: item.y,
            buttons: item.buttons,
        });
    }
    unsafe {
        record_array(raw.contacts, raw.contact_count, |pointer| {
            let item = PocketContact::read_prefix(pointer).ok_or(AdapterError::Invalid)?;
            if !item.x.is_finite() || !item.y.is_finite() || item.cancelled > 1 {
                return Err(AdapterError::Invalid);
            }
            result.contacts.push(Contact {
                surface: item.surface,
                id: item.id,
                x: item.x,
                y: item.y,
                cancelled: item.cancelled != 0,
            });
            Ok(())
        })
    }?;
    unsafe {
        record_array(raw.cancelled, raw.cancelled_count, |pointer| {
            let item = PocketCancelledContact::read_prefix(pointer).ok_or(AdapterError::Invalid)?;
            result.cancelled.push(CancelledContact {
                surface: item.surface,
                id: item.id,
            });
            Ok(())
        })
    }?;
    unsafe {
        record_array(raw.text, raw.text_count, |pointer| {
            let item = PocketTextEvent::read_prefix(pointer).ok_or(AdapterError::Invalid)?;
            let text = core::str::from_utf8(borrowed(item.text, item.byte_length)?)
                .map_err(|_| AdapterError::Invalid)?;
            if item.repeat > 1 {
                return Err(AdapterError::Invalid);
            }
            let event = match item.kind {
                POCKET_TEXT_KEY_DOWN | POCKET_TEXT_KEY_UP => TextEvent::Key {
                    key: text.to_string(),
                    pressed: item.kind == POCKET_TEXT_KEY_DOWN,
                    repeat: item.repeat != 0,
                },
                POCKET_TEXT_COMMIT => TextEvent::Commit(text.to_string()),
                POCKET_TEXT_COMPOSITION => {
                    if item.selection_start > item.selection_end
                        || !text.is_char_boundary(item.selection_start as usize)
                        || !text.is_char_boundary(item.selection_end as usize)
                    {
                        return Err(AdapterError::Invalid);
                    }
                    TextEvent::Composition {
                        text: text.to_string(),
                        selection_start: item.selection_start,
                        selection_end: item.selection_end,
                    }
                }
                POCKET_TEXT_COMPOSITION_END => TextEvent::CompositionEnd,
                _ => return Err(AdapterError::Unsupported),
            };
            result.text.push(event);
            Ok(())
        })
    }?;
    if !raw.motion.is_null() {
        let raw =
            unsafe { PocketMotionState::read_prefix(raw.motion) }.ok_or(AdapterError::Invalid)?;
        let mut motion = MotionState::default();
        motion.timestamp = raw.timestamp;
        macro_rules! copy_motion {
            ($field:ident,$record:ident) => {
                if !raw.$field.is_null() {
                    let mut item =
                        unsafe { $record::read_prefix(raw.$field) }.ok_or(AdapterError::Invalid)?;
                    if item.value.iter().any(|value| !value.is_finite()) {
                        return Err(AdapterError::Invalid);
                    }
                    item.struct_size = mem::size_of::<$record>();
                    motion.$field = Some(item);
                }
            };
        }
        copy_motion!(gravity_direction, PocketMotionGravityDirection);
        copy_motion!(inclination, PocketMotionInclination);
        copy_motion!(linear_acceleration, PocketMotionLinearAcceleration);
        copy_motion!(rotation_rate, PocketMotionRotationRate);
        copy_motion!(orientation, PocketMotionOrientation);
        copy_motion!(heading, PocketMotionHeading);
        copy_motion!(screen_rotation, PocketMotionScreenRotation);
        copy_motion!(tilt, PocketMotionTilt);
        copy_motion!(angles, PocketMotionAngles);
        result.motion = Some(motion);
    }
    Ok(result)
}
