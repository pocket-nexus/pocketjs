"""Render the handhelds' front shells for a page, in two passes each.

Run: Blender --background --python tools/handheld-models/shells.py -- [psp|vita|3ds|ipod|all] [--samples 96]

A shell is the device seen straight from the front by an orthographic camera,
on a transparent film, at a whole number of pixels a millimetre:

  dist/handheld-shells/<id>/base.png     the case with its moving parts taken out: sockets, wells, the screens' glass
  dist/handheld-shells/<id>/parts.png    the moving parts, each rendered alone, on one sheet: keys, pads, stick caps
  dist/handheld-shells/<id>/profile.json where the screens, each control and each part are, in the frame's pixels,
                                         and where each part is on the sheet

`bun tools/pocket3d-shells.ts` runs this and encodes the pictures for
devices/web/pocket-web-wgpu/web/shells. A page lays `parts` over `base`, so a
key that is held goes down into its socket and a stick's cap slides in its well.

No wordmark and no logo is rendered: the objects a device lists under `hide`
are left out. Legends a player needs stay (the face symbols, START, SELECT,
the d-pad's arrows).

The PS Vita and the 3DS are this repository's own models. The PSP is Dibad's
(CC BY 4.0, assets/dibad-psp/ATTRIBUTION.md), split into its parts here. The
iPod touch is drawn in this file.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'engine/pocket3d/examples/handheld/assets'
OUT = ROOT / 'dist/handheld-shells'
MARGIN = 1.0  # millimetres of film around the case


def named(*names, side=0):
    """Objects with one of `names`, or whose name starts with one that ends in `*`; `side` -1 or 1 keeps those left or right of the middle."""
    def pick(objects):
        out = [o for o in objects if any(o.name.startswith(n[:-1]) if n.endswith('*') else o.name == n for n in names)]
        if side:
            out = [o for o in out if centre(o)[0] * side > 0]
        return out
    return pick


VITA = {
    'name': 'PS Vita',
    'source': 'ps-vita-2000/ps-vita-2000.blend',
    'pixels_per_mm': 14,
    'hide': ['SONY wordmark', 'PS VITA wordmark', 'PS key logo', 'Card door mark', 'Rear PlayStation logo', 'Rear model identification'],
    'screens': {'upper': 'Screen_Primary'},
    'buttons': {
        'up': named('D-pad 0', 'D-pad arrow'),
        'left': named('D-pad 1', 'D-pad arrow.001'),
        'down': named('D-pad 2', 'D-pad arrow.002'),
        'right': named('D-pad 3', 'D-pad arrow.003'),
        'triangle': named('triangle button', 'triangle symbol'),
        'circle': named('circle button', 'circle symbol'),
        'cross': named('cross button', 'cross symbol*'),
        'square': named('square button', 'square symbol'),
        'select': named('SELECT key', 'SELECT legend'),
        'start': named('START key', 'START legend'),
        'l': named('L shoulder', 'L shoulder legend'),
        'r': named('R shoulder', 'R shoulder legend'),
    },
    # A cap and how far it slides from its rest, in millimetres.
    'sticks': {
        'left': {'cap': named('Analog thumb cap*', 'Stick grip serration*', side=-1), 'travel': 2.4},
        'right': {'cap': named('Analog thumb cap*', 'Stick grip serration*', side=1), 'travel': 2.4},
    },
}

N3DS = {
    'name': 'Nintendo 3DS',
    'source': 'new-nintendo-3ds/new-nintendo-3ds.blend',
    'pixels_per_mm': 14,
    # The lid lies flat, both screens toward the camera.
    'hinge': 'Lid_Hinge',
    'hide': [],
    'screens': {'upper': 'Screen_Primary', 'lower': 'Screen_Auxiliary'},
    'buttons': {
        # One moulded cross: its four arms are one part.
        'up': named('D-pad', 'D-pad inset mark*'),
        'down': named('D-pad', 'D-pad inset mark*'),
        'left': named('D-pad', 'D-pad inset mark*'),
        'right': named('D-pad', 'D-pad inset mark*'),
        'triangle': named('Button triangle', 'X legend'),
        'circle': named('Button circle', 'A legend'),
        'cross': named('Button cross', 'B legend'),
        'square': named('Button square', 'Y legend'),
        'select': named('SELECT button'),
        'start': named('START button'),
    },
    'sticks': {'left': {'cap': named('Circle pad'), 'travel': 3.2}},
    # The shoulder keys are on the rear edge, under the open lid: a finger reaches them behind the hinge's ends.
    'zones': {'l': named('Fixed hinge collar*', side=-1), 'r': named('Fixed hinge collar*', side=1)},
}

PSP = {
    'name': 'PSP',
    # Dibad's model (CC BY 4.0, see its ATTRIBUTION.md): one mesh, which `psp_parts` splits into named objects.
    'source': 'dibad-psp/psp_lod2_interactive.glb',
    'pixels_per_mm': 14,
    # The PSP wordmark, the PlayStation logo and the Memory Stick mark.
    'hide': ['decal psp', 'decal s', 'decal m'],
    'screens': {'upper': 'Screen'},
    'buttons': {
        'up': named('key up', 'decal s_1'),
        'right': named('key right', 'decal s_2'),
        'left': named('key left', 'decal s_3'),
        'down': named('key down', 'decal s_4'),
        'cross': named('key cross', 'decal st_3'),
        'circle': named('key circle', 'decal st_4'),
        'triangle': named('key triangle', 'decal st_5'),
        'square': named('key square', 'decal st_6'),
        'select': named('key select', 'decal se'),
        'start': named('key start', 'decal st'),
        'l': named('shoulder l'),
        'r': named('shoulder r'),
    },
    'sticks': {'left': {'cap': named('nub'), 'travel': 2.2}},
}

IPOD = {
    'name': 'iPod touch',
    'source': None,
    'pixels_per_mm': 20,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {},
}

DEVICES = {'psp': PSP, 'vita': VITA, '3ds': N3DS, 'ipod': IPOD}


def psp_parts(path):
    """Dibad's PSP as this script's other scenes are: millimetres, X right, Y up, Z toward the camera, the
    screen's centre at the origin, under the same lights; its controls and its decals as objects of their own."""
    import bmesh
    import numpy as np
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    scene = bpy.context.scene
    body = next(o for o in scene.objects if o.type == 'MESH')
    mesh = body.data
    names = [m.name for m in mesh.materials]
    source = [m.get('pocket3d_source_path', '').split('/') for m in mesh.materials]
    points = np.array([tuple(body.matrix_world @ v.co) for v in mesh.vertices])

    # The screen's plane says where the front is: the model stands a little turned in its file.
    screen = next(i for i, n in enumerate(names) if 'dynamic_screen' in n)
    on_screen = points[sorted({v for p in mesh.polygons if p.material_index == screen for v in p.vertices})]
    origin = on_screen.mean(axis=0)
    _, axes = np.linalg.eigh(np.cov((on_screen - origin).T))
    normal, up = axes[:, 0], axes[:, 1]
    normal = normal if normal[1] > 0 else -normal
    up = up if up[2] > 0 else -up
    right = np.cross(up, normal)
    scale = 170.0 / np.ptp((points - origin) @ right)  # the PSP-1000 is 170 mm wide
    turn = np.array([right, up, normal]) * scale
    world = np.array(body.matrix_world)
    matrix = np.eye(4)
    matrix[:3, :3] = turn @ world[:3, :3]
    matrix[:3, 3] = turn @ (world[:3, 3] - origin)
    from mathutils import Matrix
    mesh.transform(Matrix(matrix.tolist()))
    body.matrix_world = Matrix.Identity(4)
    mesh.update()

    centres = np.array([tuple(p.center) for p in mesh.polygons])
    material = np.array([p.material_index for p in mesh.polygons])
    # Every face is a triangle; a face is in a region when all its corners are.
    corners = np.array([tuple(v.co) for v in mesh.vertices])[np.array([tuple(p.vertices) for p in mesh.polygons])][:, :, :2]
    def in_disc(at, radius):
        return (np.hypot(corners[:, :, 0] - at[0], corners[:, :, 1] - at[1]) < radius).all(axis=1)
    def in_box(at, across, low, high, turn=0):
        # (`across` to each side of `at`, from `low` to `high` along the direction a quarter turn times `turn` from up)
        dx, dy = corners[:, :, 0] - at[0], corners[:, :, 1] - at[1]
        side, along = [(dx, dy), (dy, dx), (dx, -dy), (dy, -dx)][turn]
        return ((np.abs(side) < across) & (along > low) & (along < high)).all(axis=1)
    tag = np.zeros(len(mesh.polygons), dtype=int)
    tags = ['Body']
    def mark(name, chosen):
        tags.append(name)
        tag[chosen] = len(tags) - 1
    decals = {}
    for i, path in enumerate(source):
        if 'decals' in path:
            name = path[path.index('decals') + 1]
            decals[name] = centres[material == i][:, :2].mean(axis=0)
            mark('decal ' + name, material == i)
    mark('Screen', material == screen)
    for side, sign in [('l', -1), ('r', 1)]:
        mark('shoulder ' + side, np.array(['shoulder_triggers' in names[m] for m in material]) & (centres[:, 0] * sign > 0))
    # A key is its clear cap and what carries it, about its legend.
    keycap = np.isin(material, [names.index('tintado'), names.index('Botones')])
    pad = np.mean([decals[n] for n in ['s_1', 's_2', 's_3', 's_4']], axis=0)
    case = material == names.index('Carcasa')
    def forward(at, radius):
        # How far forward the case's face is about a place (the face is not flat).
        away = centres[:, :2] - at
        return float(np.percentile(centres[case & (np.hypot(away[:, 0], away[:, 1]) < radius) & (centres[:, 2] > -3)][:, 2], 90))
    # A key is what stands in front of the face: its skirt and the lugs that guide it are behind the face,
    # and nothing hides them when the key is rendered alone.
    def proud(at, radius):
        return centres[:, 2] > forward(at, radius) - 0.45
    # (an arm of the d-pad: a wedge that points at the middle. The clear ring around the four stays on the case.)
    for turn, key in enumerate(['up', 'right', 'down', 'left']):
        mark('key ' + key, keycap & in_box(pad, 5.4, 0.9, 13.3, turn) & proud(pad, 16.5))
    sockets = [('disc', pad, 14.0, -1.3)]
    for key, legend in [('cross', 'st_3'), ('circle', 'st_4'), ('triangle', 'st_5'), ('square', 'st_6')]:
        # (the cap's own middle: a legend is not centred on its key)
        about = decals[legend]
        for _ in range(3):
            about = centres[(material == names.index('tintado')) & in_disc(about, 6.2)][:, :2].mean(axis=0)
        mark('key ' + key, keycap & in_disc(about, 5.2) & proud(about, 8.7))
        sockets.append(('disc', about, 7.2, None))
    for key, legend in [('select', 'se'), ('start', 'st')]:
        mark('key ' + key, (material == names.index('Botones')) & in_box(decals[legend], 5.9, -1.9, 4.7))
        sockets.append(('box', decals[legend] + np.array([0, 1.2]), (6.4, 3.4), 0.2))
    # The analog nub: the ribbed cap that stands in front of the faceplate, below the d-pad.
    ribbed = (material == names.index('hard1')) & (centres[:, 2] > -0.6)
    about = np.array([pad[0] + 2.0, pad[1] - 22.8])
    for _ in range(3):
        nub = ribbed & in_disc(about, 8.0)
        about = centres[nub][:, :2].mean(axis=0)
    mark('nub', nub)
    # (what the cap rides on is bright in the file and would show beside a cap that has slid: it goes under the floor)
    sockets.append(('disc', about, 8.6, 0.25 - 0.9))
    # What a key rides on is bright metal in the file and shows beside a key that is held or a cap that has
    # slid: those faces are painted as the sockets' floors are.
    bright = np.isin(material, [names.index(n) for n in ['Aluminio', 'Metal_Blanco', 'material_0']]) & (tag == 0) & (centres[:, 2] > -9)
    seat = np.zeros(len(tag), dtype=bool)
    for shape, at, size, _ in sockets:
        if shape == 'disc':
            away = centres[:, :2] - at
            seat |= bright & (np.hypot(away[:, 0], away[:, 1]) < size + 2.5)
    mark('Seat', seat)
    print('shells: psp', {t: int((tag == i).sum()) for i, t in enumerate(tags) if not t.startswith('decal')}, 'nub at', about.round(1), 'pad at', pad.round(1))

    # One object a tag.
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bm = bmesh.from_edit_mesh(mesh)
    layer = bm.faces.layers.int.new('part')
    for face in bm.faces:
        face[layer] = int(tag[face.index])
    for index in range(1, len(tags)):
        chosen = False
        for face in bm.faces:
            face.select_set(face[layer] == index)
            chosen = chosen or face[layer] == index
        bmesh.update_edit_mesh(mesh)
        if chosen:
            bpy.ops.mesh.separate(type='SELECTED')
            bm = bmesh.from_edit_mesh(mesh)
            layer = bm.faces.layers.int['part']
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in scene.objects:
        if o.type == 'MESH':
            o.name = tags[o.data.attributes['part'].data[0].value]

    # Behind a key that is taken out the file has the inside of the case, in white: a dark floor for each socket.
    floor = bpy.data.materials.new('Socket floor')
    floor.use_nodes = True
    floor.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.004, .004, .004, 1)
    floor.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .9
    for shape, at, size, depth in sockets:
        if depth is None:
            # (just under the face around the socket)
            depth = forward(at, size + 2.5) - 0.7
        if shape == 'disc':
            bpy.ops.mesh.primitive_circle_add(vertices=64, radius=size, fill_type='NGON', location=(at[0], at[1], depth))
        else:
            bpy.ops.mesh.primitive_plane_add(size=2, location=(at[0], at[1], depth))
            bpy.context.object.scale = (size[0], size[1], 1)
        bpy.context.object.name = 'Socket floor'
        bpy.context.object.data.materials.append(floor)
    for slot in bpy.data.objects['Seat'].material_slots:
        slot.material = floor

    # The file's materials are one roughness and no metal. The finishes of a PSP-1000: a polished black face,
    # satin keys, a ribbed rubber nub, a bright band around the case.
    def finish(name, **values):
        for m in bpy.data.materials:
            if m.name == name or m.name.startswith(name + '.') or name in m.name.split('__'):
                shader = m.node_tree.nodes['Principled BSDF']
                for key, value in values.items():
                    shader.inputs[key].default_value = value
    finish('Carcasa', Roughness=.24)
    finish('Botones', Roughness=.42)
    finish('tintado', Roughness=.6)
    finish('hard1', Roughness=.78)
    finish('Aluminio', Metallic=1.0, Roughness=.32)
    finish('Metal_Blanco', Metallic=1.0, Roughness=.28)

    studio(scene)


def studio(scene):
    """The lights and the camera the Vita's and the 3DS's files carry (build.py, `setup_studio`), for a scene made here."""
    scene.world = bpy.data.worlds.new('Neutral studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.75, .78, .82, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .18
    scene.view_settings.view_transform = 'AgX'
    for name, at, power, size in [('Large softbox', (-110, 120, 240), 650000, 170), ('Side strip', (170, -20, 110), 240000, 130), ('Back softbox', (0, 50, -220), 500000, 150)]:
        data = bpy.data.lights.new(name, 'AREA')
        data.energy, data.shape, data.size = power, 'DISK', size
        light = bpy.data.objects.new(name, data)
        scene.collection.objects.link(light)
        light.location = at
        light.rotation_euler = (Vector((0, 0, 0)) - light.location).to_track_quat('-Z', 'Y').to_euler()
    camera = bpy.data.objects.new('Shell camera', bpy.data.cameras.new('Shell camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera


def ipod_parts(_path):
    """An iPod touch of the fourth generation, drawn here: a slab of glass in a steel back, lying on its side
    with the home button at the right, as a game holds it. No file of anyone else's is read."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    LONG, SHORT, CORNER = 111.0, 58.9, 9.2

    def paint(name, colour, roughness, metallic=0.0, coat=0.0):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        shader = m.node_tree.nodes['Principled BSDF']
        shader.inputs['Base Color'].default_value = (*colour, 1)
        shader.inputs['Roughness'].default_value = roughness
        shader.inputs['Metallic'].default_value = metallic
        shader.inputs['Coat Weight'].default_value = coat
        return m

    def outline(w, h, r, steps=20):
        points = []
        for cx, cy, start in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
            for i in range(steps + 1):
                a = math.radians(start + 90 * i / steps)
                points.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        return points

    def slab(name, points, z0, z1, mat, at=(0, 0), bevel=0.0):
        n = len(points)
        vertices = [(x + at[0], y + at[1], z0) for x, y in points] + [(x + at[0], y + at[1], z1) for x, y in points]
        faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        data = bpy.data.meshes.new(name)
        data.from_pydata(vertices, [], faces)
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        data.materials.append(mat)
        if bevel:
            mod = obj.modifiers.new('Edge', 'BEVEL')
            mod.width, mod.segments, mod.limit_method = bevel, 4, 'ANGLE'
        return obj

    def ring(name, outer, inner, z, mat, at=(0, 0)):
        n = len(outer)
        vertices = [(x + at[0], y + at[1], z) for x, y in outer] + [(x + at[0], y + at[1], z) for x, y in inner]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        data = bpy.data.meshes.new(name)
        data.from_pydata(vertices, [], faces)
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        data.materials.append(mat)
        return obj

    def disc(r, steps=64):
        return [(r * math.cos(2 * math.pi * i / steps), r * math.sin(2 * math.pi * i / steps)) for i in range(steps)]

    steel = paint('Polished steel back', (.72, .73, .74), .22, metallic=1.0)
    glass = paint('Black glass face', (.004, .004, .005), .07, coat=.6)
    panel = paint('Screen_Primary', (.012, .014, .016), .12)
    recess = paint('Home button dish', (.006, .006, .007), .32)
    mark = paint('Home button mark', (.075, .075, .08), .5)
    optic = paint('Camera glass', (.01, .012, .02), .05, coat=1.0)
    slab('Steel back', outline(LONG, SHORT, CORNER), -7.2, -0.25, steel, bevel=.5)
    slab('Glass face', outline(LONG - 1.3, SHORT - 1.3, CORNER - .65), -0.6, 0.0, glass, bevel=.12)
    # The panel: 3.5 inches at 3:2, in the middle of the glass.
    slab('Screen', [(37.0, 24.65), (-37.0, 24.65), (-37.0, -24.65), (37.0, -24.65)], 0.0, 0.02, panel)
    home = (LONG / 2 - 9.4, 0)
    slab('Home button', disc(5.3), 0.0, 0.03, recess, at=home)
    ring('Home button edge', disc(5.3), disc(5.05), 0.04, paint('Home button edge', (.03, .03, .032), .25), at=home)
    ring('Home button square', outline(4.3, 4.3, 1.0, 8), outline(3.7, 3.7, .7, 8), 0.05, mark, at=home)
    eye = (-LONG / 2 + 9.3, 0)
    slab('Camera surround', disc(1.9), 0.0, 0.02, recess, at=eye)
    slab('Camera glass', disc(1.15), 0.0, 0.04, optic, at=eye)
    studio(scene)


def centre(o):
    lo, hi = bounds([o])
    return [(a + b) / 2 for a, b in zip(lo, hi)]


def bounds(objects):
    deps = bpy.context.evaluated_depsgraph_get()
    lo, hi = [1e9] * 3, [-1e9] * 3
    for o in objects:
        e = o.evaluated_get(deps)
        for corner in e.bound_box:
            w = e.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def use_gpu():
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        bpy.context.scene.cycles.device = 'GPU'
    except Exception as error:  # a machine without Metal renders on its processor
        print('shells: no GPU for Cycles:', error)


def shell(key, spec, samples):
    if key == 'ipod':
        ipod_parts(None)
    elif spec['source'].endswith('.blend'):
        bpy.ops.wm.open_mainfile(filepath=str(ASSETS / spec['source']))
    else:
        psp_parts(ASSETS / spec['source'])
    scene = bpy.context.scene
    if spec.get('hinge'):
        hinge = bpy.data.objects[spec['hinge']]
        hinge.animation_data_clear()
        hinge.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    solid = [o for o in scene.objects if o.type in {'MESH', 'CURVE', 'FONT'}]
    for o in solid:
        if o.name in spec['hide']:
            o.hide_render = True
    shown = [o for o in solid if not o.hide_render]

    # The frame: the case's own extent and a margin, a whole number of pixels.
    ppm = spec['pixels_per_mm']
    lo, hi = bounds(shown)
    x0, y1 = lo[0] - MARGIN, hi[1] + MARGIN
    width, height = math.ceil((hi[0] + MARGIN - x0) * ppm), math.ceil((y1 - (lo[1] - MARGIN)) * ppm)
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = width, height, 100
    camera = scene.camera
    camera.data.type = 'ORTHO'
    camera.data.sensor_fit = 'HORIZONTAL'
    camera.data.ortho_scale = width / ppm
    camera.data.clip_start, camera.data.clip_end = 1, 2000
    camera.location = (x0 + width / ppm / 2, y1 - height / ppm / 2, 500)
    camera.rotation_euler = (0, 0, 0)
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    use_gpu()

    def box(objects, pad=0.0):
        lo, hi = bounds(objects)
        return [round((lo[0] - pad - x0) * ppm, 1), round((y1 - hi[1] - pad) * ppm, 1), round((hi[0] - lo[0] + 2 * pad) * ppm, 1), round((hi[1] - lo[1] + 2 * pad) * ppm, 1)]

    parts, seen = [], {}
    def part(objects):
        names = tuple(sorted(o.name for o in objects))
        if names not in seen:
            seen[names] = len(parts)
            parts.append({'rect': box(objects, 0.6), 'objects': list(objects)})
        return seen[names]

    profile = {'id': key, 'name': spec['name'], 'width': width, 'height': height, 'pixelsPerMm': ppm, 'screens': {}, 'controls': [], 'sticks': []}
    for name, obj in spec['screens'].items():
        profile['screens'][name] = box([bpy.data.objects[obj]])
    for button, pick in spec['buttons'].items():
        objects = pick(shown)
        if not objects:
            raise SystemExit(f'shells: {key} has no part for {button}')
        profile['controls'].append({'button': button, 'rect': box(objects), 'part': part(objects)})
    for stick, picks in spec.get('sticks', {}).items():
        cap = picks['cap'](shown)
        if not cap:
            raise SystemExit(f'shells: {key} has no {stick} stick')
        rest = box(cap)
        profile['sticks'].append({'id': stick, 'centre': [round(rest[0] + rest[2] / 2, 1), round(rest[1] + rest[3] / 2, 1)], 'radius': round(rest[2] / 2, 1), 'travel': round(picks['travel'] * ppm, 1), 'part': part(cap)})
    for button, pick in spec.get('zones', {}).items():
        profile['controls'].append({'button': button, 'rect': box(pick(shown)), 'part': None})
    moving = {o.name for p in parts for o in p['objects']}

    out = OUT / key
    out.mkdir(parents=True, exist_ok=True)
    for o in shown:
        o.hide_render = o.name in moving
    scene.render.filepath = str(out / 'base.png')
    bpy.ops.render.render(write_still=True)

    # Each part alone, in its own rectangle of the frame, and all of them on one sheet: a part's picture has
    # nothing of its neighbour's in it, though their rectangles overlap.
    import numpy as np
    cut = []
    scene.render.use_border = scene.render.use_crop_to_border = True
    for index, p in enumerate(parts):
        x, y, w, h = p['rect']
        x0, y0, x1, y1 = max(0, math.floor(x)), max(0, math.floor(y)), min(width, math.ceil(x + w)), min(height, math.ceil(y + h))
        own = {o.name for o in p['objects']}
        for o in shown:
            o.hide_render = o.name not in own
        scene.render.border_min_x, scene.render.border_max_x = x0 / width, x1 / width
        scene.render.border_min_y, scene.render.border_max_y = 1 - y1 / height, 1 - y0 / height
        scene.render.filepath = str(out / f'part-{index}.png')
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(scene.render.filepath)
        image.colorspace_settings.name = 'Non-Color'
        pixels = np.array(image.pixels[:], dtype=np.float32).reshape(image.size[1], image.size[0], 4)[::-1]
        p['rect'] = [x0, y0, pixels.shape[1], pixels.shape[0]]
        cut.append(pixels)
    scene.render.use_border = scene.render.use_crop_to_border = False
    if cut:
        # (rows of parts, two pixels apart, in a sheet about as wide as it is tall)
        across = max(max(c.shape[1] for c in cut) + 2, int(math.sqrt(sum((c.shape[0] + 2) * (c.shape[1] + 2) for c in cut)) * 1.15))
        x = y = row = 0
        for p, c in zip(parts, cut):
            if x + c.shape[1] + 2 > across:
                x, y, row = 0, y + row, 0
            p['at'] = [x + 1, y + 1]
            x, row = x + c.shape[1] + 2, max(row, c.shape[0] + 2)
        down = y + row
        sheet = np.zeros((down, across, 4), dtype=np.float32)
        for p, c in zip(parts, cut):
            sheet[p['at'][1]:p['at'][1] + c.shape[0], p['at'][0]:p['at'][0] + c.shape[1]] = c
        image = bpy.data.images.new('Parts', across, down, alpha=True)
        image.colorspace_settings.name = 'Non-Color'
        image.alpha_mode = 'STRAIGHT'
        image.pixels.foreach_set(sheet[::-1].ravel())
        image.filepath_raw = str(out / 'parts.png')
        image.file_format = 'PNG'
        image.save()
        profile['partsWidth'], profile['partsHeight'] = across, down
    profile['parts'] = [[*p['rect'], *p['at']] for p in parts]
    (out / 'profile.json').write_text(json.dumps(profile, indent=1) + '\n')
    print('shells:', key, width, 'x', height, len(parts), 'parts')


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    which = args[0] if args and not args[0].startswith('--') else 'all'
    samples = int(args[args.index('--samples') + 1]) if '--samples' in args else 96
    for key, spec in DEVICES.items():
        if which in {'all', key}:
            shell(key, spec, samples)
