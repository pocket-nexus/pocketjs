"""Render the committed, editable 3DS source's hinge action for visual review."""
from pathlib import Path
import bpy
from mathutils import Vector

root = Path(__file__).resolve().parents[2]
source = root / 'engine/pocket3d/examples/handheld/assets/new-nintendo-3ds/new-nintendo-3ds.blend'
output = root / 'dist/handheld-models/hinge-frames'
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(source))
scene = bpy.context.scene
scene.render.resolution_x = 720
scene.render.resolution_y = 550
scene.cycles.samples = 16
scene.camera.location = (125, -220, 300)
scene.camera.rotation_euler = (Vector((0, -3, 12)) - scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera.data.ortho_scale = 260
for index, frame in enumerate(range(1, 105, 4)):
    scene.frame_set(min(frame, 100))
    scene.render.filepath = str(output / f'{index:03}.png')
    bpy.ops.render.render(write_still=True)
