/* KeyOS libc shim: double-precision math. Rust's compiler_builtins exports
 * most of these on armv7a-unknown-xous-elf; libc.c supplies the rest. */
#ifndef POCKET_KEYOS_MATH_H
#define POCKET_KEYOS_MATH_H

#ifdef __cplusplus
extern "C" {
#endif

#define NAN __builtin_nan("")
#define INFINITY __builtin_inf()
#define HUGE_VAL __builtin_huge_val()
#define HUGE_VALF __builtin_huge_valf()

#define FP_NAN 0
#define FP_INFINITE 1
#define FP_ZERO 2
#define FP_SUBNORMAL 3
#define FP_NORMAL 4
#define fpclassify(x) __builtin_fpclassify(FP_NAN, FP_INFINITE, FP_NORMAL, FP_SUBNORMAL, FP_ZERO, x)
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define isnormal(x) __builtin_isnormal(x)
#define signbit(x) __builtin_signbit(x)

#define M_E 2.7182818284590452354
#define M_LN2 0.69314718055994530942
#define M_LN10 2.30258509299404568402
#define M_LOG2E 1.4426950408889634074
#define M_LOG10E 0.43429448190325182765
#define M_PI 3.14159265358979323846
#define M_SQRT1_2 0.70710678118654752440
#define M_SQRT2 1.41421356237309504880

double acos(double x);
double acosh(double x);
double asin(double x);
double asinh(double x);
double atan(double x);
double atan2(double y, double x);
double atanh(double x);
double cbrt(double x);
double ceil(double x);
double copysign(double x, double y);
double cos(double x);
double cosh(double x);
double exp(double x);
double exp2(double x);
double expm1(double x);
double fabs(double x);
double floor(double x);
double fma(double x, double y, double z);
double fmax(double x, double y);
double fmin(double x, double y);
double fmod(double x, double y);
double frexp(double x, int *exp);
double hypot(double x, double y);
double ldexp(double x, int exp);
double log(double x);
double log10(double x);
double log1p(double x);
double log2(double x);
long lrint(double x);
double modf(double x, double *ipart);
double nearbyint(double x);
double pow(double x, double y);
double rint(double x);
double round(double x);
double scalbn(double x, int exp);
double sin(double x);
double sinh(double x);
double sqrt(double x);
double tan(double x);
double tanh(double x);
double trunc(double x);
float ceilf(float x);
float fabsf(float x);
float floorf(float x);
float roundf(float x);
float sqrtf(float x);
float truncf(float x);

#ifdef __cplusplus
}
#endif
#endif
