"""Export the hero camera's screen triangles for a fixed-camera web composite."""
import argparse
import json
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view


def export_web(scene, manifest, destination):
    bpy.context.view_layer.update()
    screens = []
    for binding in manifest['screens']:
        obj = scene.objects[binding['node']]
        mesh = obj.data
        mesh.calc_loop_triangles()
        uv = mesh.uv_layers.active.data
        vertices = []
        for tri in mesh.loop_triangles:
            for loop in tri.loops:
                vertex = mesh.vertices[mesh.loops[loop].vertex_index]
                p = world_to_camera_view(scene, scene.camera, obj.matrix_world @ vertex.co)
                t = uv[loop].uv
                vertices.append([round(v, 9) for v in (p.x, p.y, p.z, t.x, t.y)])
        screens.append({**binding, 'vertices': vertices})
    payload = {'version': 1, 'projection': 'fixed-camera',
               'image_size': [manifest['render']['width'], manifest['render']['height']],
               'generator_sha256': manifest['generator_sha256'], 'screens': screens}
    destination.write_text(json.dumps(payload, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    directory = args.directory.resolve()
    manifest = json.loads((directory/'scene.json').read_text())
    bpy.ops.wm.open_mainfile(filepath=str(directory/'desk-scene.blend'))
    export_web(bpy.context.scene, manifest, directory/'web.json')


if __name__ == '__main__':
    main()
