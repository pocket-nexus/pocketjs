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

#[cfg(test)]
mod tests {
    use super::select;
    #[test]
    fn declaration_requires_worker_payload() {
        assert_eq!(select(true, None), Err(18));
        assert_eq!(select(false, Some(b"turn();\0")), Err(18));
        assert_eq!(select(false, None), Ok(&[][..]));
    }
    #[test]
    fn empty_and_unterminated_worker_are_refused() {
        assert_eq!(select(true, Some(b"")), Err(11));
        assert_eq!(select(true, Some(b"\0")), Err(11));
        assert_eq!(select(true, Some(b"turn();")), Err(11));
        assert_eq!(select(true, Some(b"turn();\0")), Ok(&b"turn();\0"[..]));
    }
}
