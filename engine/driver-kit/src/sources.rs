//! Source checks use the actual implementation supplied by its CI.
use alloc::vec;
use pocket_drivers::*;
use pocket_package::{select_guest, source::LoadedPackage, HostFacts};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceViolation {
    Length,
    AllBytes,
    RangeError,
    RangeCount,
    RangeBytes,
    EndOfFile,
    OutOfBounds,
    Transfer,
    Admission,
    InputOverwrite,
    InputClasses,
    InputValue,
}

/// Compare borrowed and range reads with trusted fixture bytes. Short reads are
/// accepted; zero-progress before EOF and overreported lengths are failures.
/// No invalid caller pointer or buffer is ever supplied to a driver.
pub fn check_package_source(
    source: &mut dyn PackageSource,
    expected: &[u8],
) -> Result<(), SourceViolation> {
    if source.length() != Ok(expected.len()) {
        return Err(SourceViolation::Length);
    }
    match source.all() {
        Ok(bytes) if bytes == expected => (),
        Err(SourceError::Unsupported) => (),
        _ => return Err(SourceViolation::AllBytes),
    }
    for chunk in [1, 7, 31, 257] {
        let mut output = vec![0u8; chunk];
        let mut offset = 0;
        while offset < expected.len() {
            let count = source
                .range(offset, &mut output)
                .map_err(|_| SourceViolation::RangeError)?;
            if count == 0 || count > output.len() || count > expected.len() - offset {
                return Err(SourceViolation::RangeCount);
            }
            if output[..count] != expected[offset..offset + count] {
                return Err(SourceViolation::RangeBytes);
            }
            offset += count;
        }
        if source.range(expected.len(), &mut output) != Ok(0) {
            return Err(SourceViolation::EndOfFile);
        }
    }
    if source.range(0, &mut []) != Ok(0) {
        return Err(SourceViolation::RangeCount);
    }
    if let Some(past) = expected.len().checked_add(1) {
        if source.range(past, &mut [0u8; 1]) != Err(SourceError::OutOfBounds) {
            return Err(SourceViolation::OutOfBounds);
        }
    }
    if source.length() != Ok(expected.len()) {
        return Err(SourceViolation::Length);
    }
    Ok(())
}

/// A source that transfers storage hands over the bytes its reads returned.
/// This consumes a source whose transfer moves ownership, so it runs after
/// every other check on that source.
pub fn check_package_transfer(
    source: &mut dyn PackageSource,
    expected: &[u8],
) -> Result<(), SourceViolation> {
    match source.take_bytes() {
        Ok(bytes) if bytes.as_ref() == expected => Ok(()),
        Err(SourceError::Unsupported) => Ok(()),
        _ => Err(SourceViolation::Transfer),
    }
}

/// Run a corpus item through the driver's source and compare admission with
/// the canonical parser. `expected` is the trusted corpus item, never bytes
/// recovered through this source. Both accepted and rejected fixtures count.
pub fn check_package_admission<S: AsRef<str>>(
    source: &mut dyn PackageSource,
    expected: &[u8],
    host: &HostFacts<'_, S>,
) -> Result<(), SourceViolation> {
    check_package_source(source, expected)?;
    let canonical = select_guest(expected, host, false);
    let loaded = LoadedPackage::load(source, host, expected.len());
    match (canonical, loaded) {
        (Ok(guest), Ok(loaded))
            if guest.js == loaded.javascript()
                && guest.pak == loaded.pak()
                && guest.plan == loaded.plan()
                && loaded.bytes() == expected =>
        {
            Ok(())
        }
        (Err(wanted), Err(pocket_package::source::LoadError::Admission(actual)))
            if wanted == actual =>
        {
            Ok(())
        }
        _ => Err(SourceViolation::Admission),
    }
}

/// Feed a prepared replay source once per expected tick. The callback compares
/// its complete facts (including motion, text, contact IDs and units) against
/// the tape. Existing contributions are seeded to detect destructive polling.
/// Motion/pointer are singletons and may replace an earlier contribution.
pub fn check_input(
    source: &mut dyn InputSource,
    ticks: usize,
    mut expected: impl FnMut(usize, &InputFrame<'_>) -> bool,
) -> Result<(), SourceViolation> {
    let classes = source.classes();
    for tick in 0..ticks {
        let axis = AxisSample {
            id: u32::MAX,
            value: 17.0,
        };
        let relative = AxisDelta {
            id: u32::MAX,
            delta: 19,
        };
        let contact = Contact {
            surface: u32::MAX,
            id: u32::MAX,
            x: 23.0,
            y: 29.0,
            cancelled: false,
        };
        let cancelled = CancelledContact {
            surface: u32::MAX,
            id: u32::MAX,
        };
        let text = TextEvent::CompositionEnd;
        let mut builder = InputFrameBuilder::new();
        builder.buttons = 1 << 31;
        builder.axes.push(axis);
        builder.relative.push(relative);
        builder.contacts.push(contact);
        builder.cancelled.push(cancelled);
        builder.text.push(text);
        source.poll(&mut builder);
        if builder.buttons & (1 << 31) == 0
            || builder.axes.first() != Some(&axis)
            || builder.relative.first() != Some(&relative)
            || builder.contacts.first() != Some(&contact)
            || builder.cancelled.first() != Some(&cancelled)
            || builder.text.first() != Some(&TextEvent::CompositionEnd)
        {
            return Err(SourceViolation::InputOverwrite);
        }
        builder.buttons &= !(1 << 31);
        builder.axes.remove(0);
        builder.relative.remove(0);
        builder.contacts.remove(0);
        builder.cancelled.remove(0);
        builder.text.remove(0);
        for (present, class) in [
            (builder.buttons != 0, InputClasses::BUTTONS),
            (!builder.axes.is_empty(), InputClasses::AXIS_ABSOLUTE),
            (!builder.relative.is_empty(), InputClasses::AXIS_RELATIVE),
            (builder.pointer.is_some(), InputClasses::POINTER),
            (
                !builder.contacts.is_empty() || !builder.cancelled.is_empty(),
                InputClasses::CONTACT,
            ),
            (!builder.text.is_empty(), InputClasses::TEXT),
            (builder.motion.is_some(), InputClasses::MOTION),
        ] {
            if present && !classes.contains(class) {
                return Err(SourceViolation::InputClasses);
            }
        }
        if !expected(tick, &builder.frame()) {
            return Err(SourceViolation::InputValue);
        }
    }
    Ok(())
}
