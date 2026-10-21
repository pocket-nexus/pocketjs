//! Program-owned package location. Runtime owns loading and admission.
pub const PATH: &str = "app0:app.pocket";
pub fn source() -> Result<pocket_vita_io::FileSource, String> {
    pocket_vita_io::FileSource::open(PATH).map_err(|_| format!("Cannot open {PATH}"))
}
