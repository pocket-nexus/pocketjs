import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from embed_package import validate

for path in Path(sys.argv[2]).glob("*.pocket"):
    try:
        validate(path.read_bytes())
        accepted = True
    except ValueError:
        accepted = False
    if accepted != path.name.startswith("ok-"):
        raise AssertionError(path.name)
