// A subpath mapped here belongs to the other execution domain: worker
// subpaths (`worker`, `io`, `io/i2c`) in a UI entry, UI subpaths in a worker
// entry. app-check.ts frameworkPaths maps them to this non-module file, so
// TypeScript reports the import as "not a module" instead of resolving the
// source through the package's own exports.
