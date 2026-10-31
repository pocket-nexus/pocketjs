//! TypeScript to JavaScript on the device: types are stripped module by module
//! with oxc, without bundling. QuickJS resolves the imports at load time.
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

pub struct Stripped {
    pub code: String,
}

/// One 1-based line and column in the original source.
fn location(source: &str, offset: usize) -> (usize, usize) {
    let head = &source[..offset.min(source.len())];
    let line = head.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = head
        .rsplit('\n')
        .next()
        .map_or(0, |tail| tail.chars().count())
        + 1;
    (line, column)
}

/// Strip types from one module. Errors name file:line:col for each diagnostic.
pub fn strip(name: &str, source: &str) -> Result<Stripped, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(name))
        .unwrap_or_else(|_| SourceType::ts())
        .with_module(true);
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.diagnostics.has_errors() {
        let mut message = String::new();
        for error in parsed.diagnostics.errors().take(8) {
            let at = error
                .labels
                .first()
                .map(|label| location(source, label.offset() as usize));
            match at {
                Some((line, column)) => {
                    message.push_str(&format!("{name}:{line}:{column}: {}\n", error.message))
                }
                None => message.push_str(&format!("{name}: {}\n", error.message)),
            }
        }
        return Err(message);
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let options = TransformOptions::default();
    let transformed = Transformer::new(&allocator, Path::new(name), &options)
        .build_with_scoping(scoping, &mut program);
    if transformed.diagnostics.has_errors() {
        return Err(transformed
            .diagnostics
            .errors()
            .take(8)
            .map(|error| format!("{name}: {}\n", error.message))
            .collect());
    }
    let code = Codegen::new()
        .with_options(CodegenOptions::default())
        .build(&program)
        .code;
    Ok(Stripped { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_types_and_keeps_modules() {
        let out = strip("main.ts", "import { game } from './x.ts';\ninterface P { x: number }\nconst a: number = 1 as number;\nexport default game({ a } satisfies object);\n").unwrap();
        assert!(out.code.contains("import { game }"), "{}", out.code);
        assert!(!out.code.contains("interface"), "{}", out.code);
        assert!(!out.code.contains("number"), "{}", out.code);
    }

    #[test]
    fn reports_syntax_errors_with_location() {
        let error = strip("main.ts", "const a = 1;\nconst = 2;\n")
            .err()
            .unwrap();
        assert!(error.starts_with("main.ts:2:"), "{error}");
    }
}
