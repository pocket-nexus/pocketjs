"""Check the saved scene or its reimported GLB, including camera-to-screen rays."""
import argparse
import json
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--glb', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    manifest = json.loads((args.directory/'scene.json').read_text())
    if args.glb:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(args.directory/'desk-scene.glb'))
    else:
        bpy.ops.wm.open_mainfile(filepath=str(args.directory/'desk-scene.blend'))
    scene = bpy.context.scene
    scene.camera = bpy.data.objects[manifest['camera']]
    # glTF perspective carries aspectRatio, but import does not restore render size.
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    origin = scene.camera.matrix_world.translation
    assert len(manifest['devices']) == 6
    assert len(manifest['screens']) == 7
    assert len({s['material'] for s in manifest['screens']}) == 7
    reports = []
    for screen in manifest['screens']:
        obj = bpy.data.objects[screen['node']]
        assert obj.type == 'MESH' and obj.data.uv_layers.active
        assert obj.get('bake_exclude') is True
        assert obj.data.materials[0].name == screen['material']
        uv = obj.data.uv_layers.active.data
        assert min(v.uv.x for v in uv) >= -.001
        assert min(v.uv.y for v in uv) >= -.001
        assert max(v.uv.x for v in uv) <= 1.001
        assert max(v.uv.y for v in uv) <= 1.001
        assert max(v.uv.x for v in uv)-min(v.uv.x for v in uv) > .99
        assert max(v.uv.y for v in uv)-min(v.uv.y for v in uv) > .99
        coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        center = sum(coords, Vector()) / len(coords)
        projected = [world_to_camera_view(scene, scene.camera, co) for co in coords]
        assert all(0 < p.x < 1 and 0 < p.y < 1 and p.z > 0 for p in projected), screen['node']+' out of frame'
        uv_projection = [(uv[loop.index].uv, projected[loop.vertex_index]) for loop in obj.data.loops]
        u_right = sum((a.x-.5)*(b.x-world_to_camera_view(scene, scene.camera, center).x) for a, b in uv_projection)
        v_up = sum((a.y-.5)*(b.y-world_to_camera_view(scene, scene.camera, center).y) for a, b in uv_projection)
        assert u_right > 0 and v_up > 0, (screen['node'], 'mirrored or inverted screen UVs', u_right, v_up)
        # Probe centre and inset perimeter vertices; edge probes avoid bevel noise.
        samples = [center] + [center.lerp(co, .8) for co in coords]
        occluders = set()
        for point in samples:
            direction = (point-origin).normalized()
            hit, _, _, _, actual, _ = scene.ray_cast(depsgraph, origin, direction)
            if not hit or actual.original.name != obj.name:
                occluders.add(actual.name if hit else 'miss')
        assert not occluders, (screen['node'], sorted(occluders))
        reports.append({'screen': obj.name, 'visible_ray_samples': len(samples),
                        'frame_rect': [min(p.x for p in projected), min(p.y for p in projected),
                                       max(p.x for p in projected), max(p.y for p in projected)]})
    # The hierarchy survives export; future hinge movement must not move lower LCD.
    hinge = bpy.data.objects['3ds__Lid_Hinge']
    assert bpy.data.objects['Screen__3ds__primary'].parent == hinge
    assert bpy.data.objects['Screen__3ds__auxiliary'].parent != hinge
    for device in manifest['devices']:
        root = bpy.data.objects[device['node']]
        points = [o.matrix_world @ Vector(c) for o in root.children_recursive
                  if o.type == 'MESH' for c in o.bound_box]
        width = max(p.x for p in points)-min(p.x for p in points)
        low, high = (.53, .57) if device['id'] == 'desktop-monitor' else (.04, .23)
        assert low < width < high, (device['id'], width, 'expected metres')
        framing = [world_to_camera_view(scene, scene.camera, p) for p in points]
        assert all(0 < p.x < 1 and 0 < p.y < 1 and p.z > 0 for p in framing), (device['id'], 'body cropped')
    print(json.dumps({'verified': 'glb' if args.glb else 'blend', 'screens': reports}, indent=2))


if __name__ == '__main__':
    main()
