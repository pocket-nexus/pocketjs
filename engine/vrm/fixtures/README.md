# pocket-vrm test fixtures

Binary fixtures are git-ignored; download them here before running the
integration tests (tests skip themselves with a note when the files are
absent):

```
curl -L -o AvatarSample_A.vrm \
  https://dist.ayaka.moe/vrm-models/VRoid-Hub/AvatarSample-A/AvatarSample_A.vrm
curl -L -o idle_loop.vrma \
  https://raw.githubusercontent.com/moeru-ai/airi/main/packages/stage-ui-three/src/assets/vrm/animations/idle_loop.vrma
```

- `AvatarSample_A.vrm` (~26.8 MB) — VRM 0.x VRoid Hub sample model
  (VRoid Project, license "Other"; for local testing only).
- `idle_loop.vrma` (~157 KB) — VRMC_vrm_animation idle loop from the
  moeru-ai/airi project.
