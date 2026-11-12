"""Link the no_std fixture; this does not create flashable board firmware."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("target", choices=["thumbv7em-none-eabihf", "riscv32imafc-unknown-none-elf"])
parser.add_argument("--cc", required=True)
args = parser.parse_args()
compiler = str(Path(shutil.which(args.cc) or args.cc).resolve())
flags = (["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16"]
         if args.target.startswith("thumb") else ["-march=rv32imafc", "-mabi=ilp32f"])
env = os.environ.copy()
suffix = args.target.replace("-", "_")
env["CC_" + suffix] = compiler
env["AR_" + suffix] = compiler.removesuffix("gcc") + "ar"
# Newlib hides declarations that QuickJS parses even when Atomics is disabled.
# No pthread implementation is linked; an accidental reference must fail to link.
headers = ["-D__STDC_NO_ATOMICS__=1", "-D_POSIX_THREADS=1", "-D_POSIX_TIMERS=1", "-D_POSIX_MONOTONIC_CLOCK=1"]
env["CFLAGS_" + suffix] = " ".join(flags + headers)
# GCC reports its newlib search path through preprocessing.
search = subprocess.run([compiler, *flags, "-E", "-Wp,-v", "-x", "c", "-"], input="", text=True, capture_output=True, check=True).stderr
includes = [line.strip() for line in search.splitlines() if line.startswith(" ") and Path(line.strip()).is_dir()]
newlib = next(Path(path) for path in includes if (Path(path) / "sys/reent.h").exists())
clang_target = "arm-none-eabi" if args.target.startswith("thumb") else "riscv32-unknown-elf"
env["BINDGEN_EXTRA_CLANG_ARGS_" + suffix] = " ".join(["--target=" + clang_target, *flags, "-isystem", str(newlib), *headers])
paths = set()
for name in ["c", "m", "nosys", "gcc"]:
    library = Path(subprocess.check_output([compiler, *flags, "-print-file-name=lib" + name + ".a"], text=True).strip())
    if not library.is_file():
        raise SystemExit("Missing target library: " + str(library))
    paths.add(str(library.parent))
link = []
for path in sorted(paths):
    link += ["-C", "link-arg=-L" + path]
for argument in ["--entry=_start", "--start-group", "-lc", "-lm", "-lnosys", "-lgcc", "--end-group"]:
    link += ["-C", "link-arg=" + argument]
subprocess.run(["cargo", "rustc", "--manifest-path", str(Path(__file__).with_name("Cargo.toml")),
                "--target", args.target, "--release", "--locked", "--", *link], env=env, check=True)

elf = Path(__file__).parent / "target" / args.target / "release/pocket-embassy-link-check"
symbols = subprocess.check_output([compiler.removesuffix("gcc") + "nm", str(elf)], text=True)
assert "pthread_" not in symbols, "The no-thread fixture must not link pthread calls"
