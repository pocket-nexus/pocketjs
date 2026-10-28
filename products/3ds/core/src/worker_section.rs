/// The worker declaration and executable payload must agree before either realm
/// is created. Section 8 is a NUL-terminated script with at least one byte.
pub fn select(declared: bool, section: Option<&[u8]>) -> Result<&[u8], i32> {
    match (declared, section) {
        (false, None) => Ok(&[]),
        (true, Some(source)) if source.len() > 1 && source.last() == Some(&0) => Ok(source),
        (true, Some(_)) => Err(11),
        _ => Err(18),
    }
}
