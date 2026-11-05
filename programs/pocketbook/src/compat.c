/* C23 math symbols that LLVM 19+ lowers f32/f64::max/min (and maximum/minimum)
 * to, but that PocketBook's glibc 2.23 predates — linking the host otherwise
 * fails with `undefined symbol: fmaximum_numf` & friends.
 *
 * The `_num` variants are NaN-suppressing (return the non-NaN operand), exactly
 * matching Rust's f32::max/min, so fmax/fmin are a precise shim. The plain
 * variants are NaN-propagating (Rust's f32::maximum/minimum); the rasterizer
 * never feeds them NaN, but we implement the propagation anyway for correctness.
 *
 * Only compiled for the armv7-unknown-linux-gnueabi cross-build (see build.rs);
 * glibc 2.23 defines none of these, so there is no duplicate-symbol clash.
 */
#include <math.h>

float fmaximum_numf(float a, float b) { return fmaxf(a, b); }
float fminimum_numf(float a, float b) { return fminf(a, b); }
double fmaximum_num(double a, double b) { return fmax(a, b); }
double fminimum_num(double a, double b) { return fmin(a, b); }

float fmaximumf(float a, float b) {
    if (isnan(a) || isnan(b)) return NAN;
    return a > b ? a : b;
}
float fminimumf(float a, float b) {
    if (isnan(a) || isnan(b)) return NAN;
    return a < b ? a : b;
}
double fmaximum(double a, double b) {
    if (isnan(a) || isnan(b)) return NAN;
    return a > b ? a : b;
}
double fminimum(double a, double b) {
    if (isnan(a) || isnan(b)) return NAN;
    return a < b ? a : b;
}
