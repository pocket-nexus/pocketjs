"""Render the handhelds' front shells for a page, in two passes each.

Run: Blender --background --python tools/handheld-models/shells.py -- [psp|vita|3ds|ipod|android|gba|iphone-4s|ipod-touch-5|bb-classic|ipod-nano|all] [--samples 96]

A shell is the device seen straight from the front by an orthographic camera,
on a transparent film, at a whole number of pixels a millimetre:

  dist/handheld-shells/<id>/base.png     the case with its moving parts taken out: sockets, wells, the screens' glass
  dist/handheld-shells/<id>/parts.png    the moving parts, each rendered alone, on one sheet: keys, pads, stick caps
  dist/handheld-shells/<id>/profile.json where the screens, each control, each part and the keys the device keeps
                                         for itself (`system`) are, in the frame's pixels, and where each part is
                                         on the sheet

`bun tools/handheld-shells.ts` runs this and encodes the pictures for the
Pocket3D player (devices/web/pocket-web-wgpu/web/shells) and the MicroTS
playground (site/microts/shells). A page lays `parts` over `base`, so a key
that is held goes down into its socket and a stick's cap slides in its well.

No wordmark and no logo is rendered: the objects a device lists under `hide`
are left out. Legends a player needs stay (the face symbols, START, SELECT,
the d-pad's arrows).

The PS Vita, the 3DS and the iPod nano are this repository's own models. The
PSP is Dibad's (CC BY 4.0, assets/dibad-psp/ATTRIBUTION.md), split into its
parts here. The GBA, the iPhone 4S, the iPod touch of the fifth generation (a
white iPhone 5) and the BlackBerry Classic are other authors' models under
CC BY 4.0 that this repository does not carry (downloads.json): the tool
downloads them into dist/handheld-sources/. The fourth-generation iPod touch
and the Android phone are drawn in this file.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'engine/pocket3d/examples/handheld/assets'
# Models of other authors that this repository does not carry (downloads.json): tools/handheld-shells.ts fetches them here.
SOURCES = ROOT / 'dist/handheld-sources'
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

ANDROID = {
    'name': 'Android phone',
    'source': None,
    'pixels_per_mm': 16,
    'hide': [],
    'screens': {'upper': 'Screen'},
    # The three keys under the panel are drawn and take no pointer: a guest reads no button from a phone.
    'buttons': {},
}

NANO = {
    'name': 'iPod nano',
    'source': 'ipod-nano-2/source/ipod.blend',
    'pixels_per_mm': 18,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {'select': named('IPOD_CenterSelectButton')},
    # The wheel's ring is read by where a finger goes round it: a place for a pointer, not a key that moves.
    'zones': {'wheel': named('IPOD_ClickWheel')},
}

DPAD = named('D-pad')

# LightningGrey's model, downloads.json. Its L and R wrap the case's ends behind the face: rendered alone they would
# cover the face, so they stay in the case's picture and are places for a pointer (`zones`, from gba_parts).
GBA = {
    'name': 'Game Boy Advance',
    'download': True,
    'pixels_per_mm': 14,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {
        'up': DPAD, 'down': DPAD, 'left': DPAD, 'right': DPAD,
        'a': named('A button'), 'b': named('B button'),
        'start': named('START button'), 'select': named('SELECT button'),
    },
}

IPHONE_4S = {
    'name': 'iPhone 4S',
    'download': True,
    'pixels_per_mm': 16,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {},
    'system': {'home': named('Home button')},
}

IPOD_TOUCH_5 = {
    'name': 'iPod touch',
    'download': True,
    'pixels_per_mm': 16,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {},
    'system': {'home': named('Home button')},
}

# The keys of the row under the screen are printed on the face: their places come from bb_parts (`zones`, `system`).
BB_CLASSIC = {
    'name': 'BlackBerry Classic',
    'download': True,
    'pixels_per_mm': 14,
    'hide': [],
    'screens': {'upper': 'Screen'},
    'buttons': {'space': named('Space key'), 'enter': named('Enter key')},
}

DEVICES = {'psp': PSP, 'vita': VITA, '3ds': N3DS, 'ipod': IPOD, 'android': ANDROID, 'ipod-nano': NANO,
           'gba': GBA, 'iphone-4s': IPHONE_4S, 'ipod-touch-5': IPOD_TOUCH_5, 'bb-classic': BB_CLASSIC}


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
    """A rectangle of `w` by `h` about the origin with corners of radius `r`, as points."""
    points = []
    for cx, cy, start in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
        for i in range(steps + 1):
            a = math.radians(start + 90 * i / steps)
            points.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return points


def disc(r, steps=64):
    return [(r * math.cos(2 * math.pi * i / steps), r * math.sin(2 * math.pi * i / steps)) for i in range(steps)]


def slab(name, points, z0, z1, mat, at=(0, 0), bevel=0.0):
    """`points` from `z0` to `z1`, about `at`, in the scene."""
    n = len(points)
    vertices = [(x + at[0], y + at[1], z0) for x, y in points] + [(x + at[0], y + at[1], z1) for x, y in points]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Edge', 'BEVEL')
        mod.width, mod.segments, mod.limit_method = bevel, 4, 'ANGLE'
    return obj


def ring(name, outer, inner, z, mat, at=(0, 0)):
    """What lies between two outlines of as many points, flat at `z`."""
    n = len(outer)
    vertices = [(x + at[0], y + at[1], z) for x, y in outer] + [(x + at[0], y + at[1], z) for x, y in inner]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    data.materials.append(mat)
    return obj


def ipod_parts(_path):
    """An iPod touch of the fourth generation, drawn here: a slab of glass in a steel back, lying on its side
    with the home button at the right, as a game holds it. No file of anyone else's is read."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    LONG, SHORT, CORNER = 111.0, 58.9, 9.2

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


def strokes(name, lines, width, z, mat, at):
    """Lines of one `width`, flat from `z` up, with round ends and joins. A line is its points as a key's own
    frame has them, millimetres right and up of `at` on a phone that stands: on the phone lying with its
    keys at the right, up is to the left and right is up."""
    vertices, faces = [], []
    def face(points):
        # (each piece a hair above the last: two faces in one plane shade each other where they overlap)
        height = z + len(faces) * 0.002
        faces.append(tuple(range(len(vertices), len(vertices) + len(points))))
        vertices.extend((at[0] - v, at[1] + u, height) for u, v in points)
    for line in lines:
        for (u0, v0), (u1, v1) in zip(line, line[1:]):
            along = math.hypot(u1 - u0, v1 - v0)
            nu, nv = -(v1 - v0) / along * width / 2, (u1 - u0) / along * width / 2
            face([(u0 + nu, v0 + nv), (u0 - nu, v0 - nv), (u1 - nu, v1 - nv), (u1 + nu, v1 + nv)])
        for u, v in line:
            face([(u + x, v + y) for x, y in disc(width / 2, 16)])
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    data.materials.append(mat)
    return obj


def android_parts(_path):
    """An Android phone of 2014, drawn here: a panel of 4.7 inches at 16:9 behind one sheet of black glass,
    in a satin shell, lying on its side with its three keys at the right, as a game holds it. No file of
    anyone else's is read, and the phone is no maker's: it carries no name and no mark."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    LONG, SHORT, CORNER, RIM = 137.0, 69.0, 9.0, 1.2

    shell = paint('Graphite shell', (.04, .042, .047), .42)
    glass = paint('Black glass face', (.004, .004, .005), .07, coat=.6)
    panel = paint('Screen_Primary', (.012, .014, .016), .12)
    recess = paint('Earpiece slot', (.016, .016, .018), .7)
    pale = paint('Key glyphs', (.3, .31, .33), .55)
    optic = paint('Camera glass', (.01, .012, .02), .05, coat=1.0)
    slab('Shell', outline(LONG, SHORT, CORNER), -9.9, -0.3, shell, bevel=.8)
    slab('Glass face', outline(LONG - 2 * RIM, SHORT - 2 * RIM, CORNER - RIM), -0.7, 0.0, glass, bevel=.12)
    # The panel: 104.0 by 58.5 mm, 14.5 mm from the earpiece's end of the case and 18.5 mm from the keys'.
    slab('Screen', [(52.0, 29.25), (-52.0, 29.25), (-52.0, -29.25), (52.0, -29.25)], 0.0, 0.02, panel, at=(-2.0, 0))
    # Above the panel (at the left as it lies): the earpiece, the camera to its left, two sensors to its right.
    top = -LONG / 2 + 6.5
    slab('Earpiece', outline(1.6, 10.0, .8, 8), 0.0, 0.02, recess, at=(top, 0))
    slab('Camera surround', disc(1.7), 0.0, 0.02, paint('Camera surround', (.006, .006, .007), .32), at=(top, -13.0))
    slab('Camera glass', disc(1.0), 0.0, 0.04, optic, at=(top, -13.0))
    for index, across in enumerate([10.5, 13.2]):
        slab(f'Sensor {index}', disc(.6, 24), 0.0, 0.02, recess, at=(top, across))
    # Below it: three keys that are drawn on the glass. Three bars, a house, an arrow that turns back.
    keys = LONG / 2 - 9.0
    strokes('Menu key', [[(-2.3, v), (2.3, v)] for v in (1.6, 0.0, -1.6)], .55, 0.03, pale, at=(keys, -19.0))
    strokes('Home key', [[(-2.2, -2.1), (-2.2, 0.2), (0.0, 2.3), (2.2, 0.2), (2.2, -2.1), (-2.2, -2.1)]], .55, 0.03, pale, at=(keys, 0.0))
    turn = [(0.9 + 1.55 * math.cos(math.radians(a)), -0.35 + 1.55 * math.sin(math.radians(a))) for a in range(-90, 91, 10)]
    strokes('Back key', [[(-0.6, -1.9), *turn, (-2.3, 1.2)], [(-1.1, 2.4), (-2.3, 1.2), (-1.1, 0.0)]], .55, 0.03, pale, at=(keys, 19.0))
    # On the right edge as it stands (the upper edge as it lies): the volume rocker over the power key.
    for name, along, length in [('Volume rocker', -22.0, 16.0), ('Power key', -3.0, 9.0)]:
        slab(name, outline(length, 1.4, .5, 6), -6.3, -3.7, shell, at=(along, SHORT / 2 - 0.2), bevel=.2)
    studio(scene)


def linear(rgb):
    """A colour as a picture stores it (sRGB, 0 to 1), in the linear values a material takes."""
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb)


def srgb(hex_value):
    """A colour as it is written for a page (`#rrggbb`), in the linear values a material takes."""
    return linear(int(hex_value.lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4))


def nano_parts(path):
    """The iPod nano of the second generation that this repository models (assets/ipod-nano-2), in pink:
    its case, its dark lens and its click wheel. The menu the file draws on its screen is left out, and so
    are its studio, lights and cameras."""
    bpy.ops.wm.open_mainfile(filepath=str(path))
    scene = bpy.context.scene
    for name in ['IPOD_SCREEN_UI', 'STUDIO', 'LIGHTS', 'CAMERA']:
        for o in list(bpy.data.collections[name].objects):
            bpy.data.objects.remove(o, do_unlink=True)
    for light in list(bpy.data.lights):
        bpy.data.lights.remove(light)
    # The file is in centimetres with its front toward -Y: millimetres, with the front toward the camera.
    from mathutils import Matrix
    turn = Matrix.Scale(10, 4) @ Matrix.Rotation(math.radians(-90), 4, 'X')
    for o in scene.objects:
        if o.parent is None:
            o.matrix_world = turn @ o.matrix_world
    scene.unit_settings.scale_length = 1.0
    shader = bpy.data.materials['MAT_AnodizedSilver'].node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (*srgb('#f27aa8'), 1)
    lcd = bpy.data.materials['MAT_ScreenGlow'].node_tree.nodes['Principled BSDF']
    lcd.inputs['Base Color'].default_value = (.012, .014, .016, 1)
    lcd.inputs['Emission Strength'].default_value = 0.0
    bpy.data.objects['IPOD_LCD'].name = 'Screen'
    # Behind the centre button, which is a part of its own: a dark floor in the wheel's middle.
    wheel = bpy.data.objects['IPOD_ClickWheel']
    lo, hi = bounds([wheel])
    centre = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    slab('Socket floor', disc(6.7), lo[2] - 0.05, lo[2], paint('Socket floor', (.004, .004, .005), .9), at=centre)
    studio(scene)


def glb(path, axes, length, along):
    """Another author's model (a GLB) in this script's axes, in millimetres. `axes` names the file's axis that
    becomes X, Y and Z ('-y': the file's y the other way round), and the model's extent along `along` (0: X,
    1: Y) becomes `length` millimetres. The middle of the case is on the Z axis and the front of its face at
    Z = 0. Each mesh carries its place in its vertices, so a split or a join keeps the pieces where they are."""
    from mathutils import Matrix
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    scene = bpy.context.scene
    rows = [[(-1 if a.startswith('-') else 1) if 'xyz'[i] == a[-1] else 0 for i in range(3)] + [0] for a in axes]
    turn = Matrix(rows + [[0, 0, 0, 1]])
    meshes = [o for o in scene.objects if o.type == 'MESH' and o.data.polygons]
    for o in meshes:
        world = turn @ o.matrix_world
        o.parent = None
        if o.data.users > 1:
            o.data = o.data.copy()
        o.data.transform(world)
        o.matrix_world = Matrix.Identity(4)
    for o in [o for o in scene.objects if o.type != 'MESH' or not o.data.polygons]:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    lo, hi = bounds(meshes)
    k = length / (hi[along] - lo[along])
    move = Matrix.Scale(k, 4) @ Matrix.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -hi[2]))
    for o in meshes:
        o.data.transform(move)
    bpy.context.view_layer.update()
    return meshes


def islands(obj):
    """`obj`'s loose pieces, each an object of its own."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    return list(bpy.context.selected_objects)


def joined(name, objects):
    """`objects` as one object called `name`."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def alive(objects):
    """The objects of a list that are still in the scene."""
    out = []
    for o in objects:
        try:
            o.name
        except ReferenceError:
            continue
        out.append(o)
    return out


def carve(obj, x0, y0, x1, y1):
    """Takes out the faces of `obj` that lie wholly inside a rectangle of the front, in millimetres."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    inside = [f for f in bm.faces if all(x0 <= v.co.x <= x1 and y0 <= v.co.y <= y1 for v in f.verts)]
    bmesh.ops.delete(bm, geom=inside, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()


def within(objects, x0, y0, x1, y1):
    """The objects that lie wholly inside a rectangle of the front, in millimetres."""
    out = []
    for o in objects:
        lo, hi = bounds([o])
        if x0 <= lo[0] and hi[0] <= x1 and y0 <= lo[1] and hi[1] <= y1:
            out.append(o)
    return out


def texture(material):
    """The picture a material takes its base colour from."""
    shader = next(n for n in bpy.data.materials[material].node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    return shader.inputs['Base Color'].links[0].from_node.image


def pixels(image):
    import numpy as np
    w, h = image.size
    # (rows from the top, as a picture's pixels are counted)
    return np.array(image.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]


def repaint(image, grid):
    image.pixels.foreach_set(grid[::-1].ravel())
    image.update()
    image.pack()


def on_front(objects, image, px, py):
    """Where a pixel of `image` (counted from its top left) is drawn on the front: on the front-most face whose
    texture coordinates hold it, as (x, y) in millimetres."""
    u, v = px / image.size[0], 1 - py / image.size[1]
    best = None
    for o in objects:
        mesh = o.data
        mesh.calc_loop_triangles()
        uv = mesh.uv_layers.active.data
        for t in mesh.loop_triangles:
            if t.normal.z < 0.9:
                continue
            a, b, c = (uv[i].uv for i in t.loops)
            d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
            if abs(d) < 1e-12:
                continue
            w0 = ((b.y - c.y) * (u - c.x) + (c.x - b.x) * (v - c.y)) / d
            w1 = ((c.y - a.y) * (u - c.x) + (a.x - c.x) * (v - c.y)) / d
            w2 = 1 - w0 - w1
            if min(w0, w1, w2) < -1e-6:
                continue
            p = sum((mesh.vertices[i].co * w for i, w in zip(t.vertices, (w0, w1, w2))), Vector())
            if best is None or p.z > best.z:
                best = p
    if best is None:
        raise SystemExit(f'shells: no face of the front shows pixel {px}, {py} of {image.name}')
    return best.x, best.y


def on_front_box(objects, image, rect):
    """A rectangle of `image` (x0, y0, x1, y1 in its pixels) where it is on the front: (x0, y0, x1, y1) in millimetres."""
    corners = [on_front(objects, image, x, y) for x in (rect[0], rect[2]) for y in (rect[1], rect[3])]
    return (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))


def panel(box, z):
    """A dark panel where the screen is, for the screen's rectangle in the profile and a quiet picture under the page's."""
    x0, y0, x1, y1 = box
    return slab('Screen', [(x1, y1), (x0, y1), (x0, y0), (x1, y0)], z, z + 0.02, paint('Screen_Primary', (.012, .014, .016), .12))


INDIGO = '#4a2cbc'


def gba_parts(path):
    """LightningGrey's Game Boy Advance (downloads.json), 144.5 mm across, its case in indigo. The maker's name in the badge over
    the screen is taken out of the case's mesh, and the console's name under the screen (paint on the lens's
    picture) is painted over in the lens's colour. The keys are pieces of one mesh: those that are a key's
    are joined into the key, and a dark floor stands under each. L and R wrap the case's ends behind the
    face, so they stay in the case's picture; their places are returned as zones."""
    import numpy as np
    meshes = glb(path, ('y', 'z', 'x'), 144.5, 0)
    by = {o.data.materials[0].name: o for o in meshes if o.data.materials}
    # The maker's name: everything inside the oval badge over the screen goes but the badge's rim (the strips
    # that run its length and the caps at its ends), and a floor in the case's colour closes the badge.
    pieces = islands(by['Controller'])
    badge = within(pieces, -8.8, 33.4, 9.3, 37.5)
    for o in badge:
        lo, hi = bounds([o])
        middle = (lo[0] + hi[0]) / 2
        rim = min(hi[0] - lo[0], hi[1] - lo[1]) < 0.7 and (hi[0] - lo[0] > 12.0 or middle < -7.7 or middle > 8.2)
        if not rim:
            bpy.data.objects.remove(o, do_unlink=True)
    # (the letters are faces of the case's own mesh too)
    for o in alive(pieces):
        if o not in alive(badge):
            carve(o, -8.4, 33.6, 9.1, 37.3)
    # The case in indigo, the colour the console was first sold in, a little lighter so it stands out on a dark
    # page: the model's own case colour (a pale silver) becomes indigo, shade for shade.
    picture = texture('Controller')
    case = pixels(picture)
    lightness = case[:, :, :3].mean(axis=2)
    silver = np.median(case[lightness > 0.3][:, :3], axis=0)
    near = np.abs(case[:, :, :3] - silver).max(axis=2) < 0.15
    indigo = np.array([int(INDIGO[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    case[near, :3] = np.clip(indigo * (lightness[near] / silver.mean())[:, None], 0, 1)
    repaint(picture, case)
    slab('Badge floor', outline(18.0, 4.1, 2.05, 10), -3.3, -3.15, paint('Case', srgb(INDIGO), .5), at=(0.25, 35.45))
    lens = texture('border')
    grid = pixels(lens)
    light = grid[:, :, :3].mean(axis=2)
    glass = np.median(grid[(light > 0.05) & (light < 0.3)][:, :3], axis=0)
    grid[light > glass.mean() + 0.02, :3] = glass
    repaint(lens, grid)
    # The screen: the larger piece of the screen-and-lamp paint, an octagon over a window in the lens. The window
    # is closed in the lens's colour and a 3:2 panel stands in its middle. The smaller piece is the power lamp, lit.
    lcd, lamp = sorted(islands(by['power']), key=lambda o: -sum(p.area for p in o.data.polygons))[:2]
    lo, hi = bounds([lcd])
    bpy.data.objects.remove(lcd, do_unlink=True)
    lens_z = bounds([by['border']])[1][2]
    slab('Lens window', [(hi[0], hi[1]), (lo[0], hi[1]), (lo[0], lo[1]), (hi[0], lo[1])], lens_z - 0.03, lens_z - 0.005, paint('Lens', linear(glass), .3))
    lit = paint('Power lamp', srgb('#3ddc2a'), .3)
    lit.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (*srgb('#3ddc2a'), 1)
    lit.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 2.5
    lamp.data.materials[0] = lit
    w, h = hi[0] - lo[0], hi[1] - lo[1]
    k = min(w / 3, h / 2)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    panel((cx - 1.5 * k, cy - k, cx + 1.5 * k, cy + k), hi[2] + 0.01)
    floor = paint('Socket floor', (.004, .004, .005), .9)
    rest = islands(by['Buttons'])
    for name, box in [('D-pad', (-64.0, -2.0, -41.0, 21.0)), ('A button', (53.5, 4.5, 64.8, 15.9)), ('B button', (41.0, 0.5, 51.5, 11.5)),
                      ('START button', (-46.2, -11.8, -42.2, -8.4)), ('SELECT button', (-46.6, -19.8, -42.6, -16.4))]:
        pieces = within(rest, *box)
        rest = [o for o in rest if o not in pieces]
        part = joined(name, pieces)
        lo, hi = bounds([part])
        slab(f'{name} socket floor', disc(min(hi[0] - lo[0], hi[1] - lo[1]) * 0.47), lo[2] - 0.2, lo[2] - 0.1, floor, at=((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2))
    joined('Shoulder keys', rest)
    studio(bpy.context.scene)
    return {'zones': {'l': (-70.0, 21.0, -42.0, 40.0), 'r': (42.0, 21.0, 70.0, 40.0)}}


def iphone_parts(path):
    """EwanLejkowski's iPhone 4S (downloads.json), 115.2 mm tall. The sheet of glass over its face is left out
    (seen straight on it greys the face) and the black under it is given the glass's polish. The screen's
    picture (a lock screen) gives way to a dark panel, and the home button's picture to a dark dish with its
    square, as the drawn iPod touch has."""
    meshes = glb(path, ('y', 'z', 'x'), 115.2, 1)
    for o in [o for o in meshes if o.data.materials and o.data.materials[0].name == 'Glass']:
        if bounds([o])[1][2] > -0.5:
            bpy.data.objects.remove(o, do_unlink=True)
    # (the camera's glass is white in the file: dark glass, as the drawn phones' cameras are)
    for name, colour, rough, coat in [('Black_Frit', (.004, .004, .005), .07, .6), ('black', (.004, .004, .005), .07, .6), ('Black_Plastic', (.004, .004, .005), .07, .6),
                                      ('Lens', (.01, .012, .02), .05, 1.0), ('Lens_Back', (.006, .008, .02), .2, 0.0), ('material_0', (.01, .012, .02), .05, 1.0)]:
        shader = next(n for n in bpy.data.materials[name].node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        shader.inputs['Base Color'].default_value = (*colour, 1)
        shader.inputs['Roughness'].default_value = rough
        shader.inputs['Coat Weight'].default_value = coat
        shader.inputs['Transmission Weight'].default_value = 0.0
    by = {o.data.materials[0].name: o for o in alive(meshes) if o.data.materials}
    screen = by['Screen']
    lo, hi = bounds([screen])
    bpy.data.objects.remove(screen, do_unlink=True)
    panel((lo[0], lo[1], hi[0], hi[1]), hi[2])
    home = by['Home_Button']
    home.name = 'Home button'
    home.data.materials[0] = paint('Home button dish', (.006, .006, .007), .32)
    lo, hi = bounds([home])
    r = (hi[0] - lo[0]) / 2
    at = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    ring('Home button square', outline(r * .8, r * .8, r * .19, 8), outline(r * .68, r * .68, r * .13, 8), hi[2] + 0.01, paint('Home button mark', (.075, .075, .08), .5), at=at)
    studio(bpy.context.scene)


def ipod_touch_parts(path):
    """thethieme's white iPhone 5 (downloads.json) as the iPod touch of the fifth generation, which has its
    face: 123.4 mm tall. The earpiece and the sensor beside it, which an iPod touch does not have, are taken
    out, and the opening is closed in the face's white. The screen's piece becomes a dark panel."""
    import numpy as np
    meshes = glb(path, ('x', 'z', '-y'), 123.4, 1)
    pieces = islands(meshes[0])
    face = texture(meshes[0].data.materials[0].name)
    # (the screen: the largest flat piece inside the face's border)
    screen = max((o for o in within(pieces, -27.0, -50.0, 27.0, 50.0) if bounds([o])[1][2] - bounds([o])[0][2] < 0.05), key=lambda o: sum(p.area for p in o.data.polygons))
    lo, hi = bounds([screen])
    bpy.data.objects.remove(screen, do_unlink=True)
    panel((lo[0], lo[1], hi[0], hi[1]), hi[2])
    pieces = alive(pieces)
    for o in within(pieces, -10.0, 48.0, -5.0, 53.0) + within(pieces, -6.0, 48.5, 6.5, 52.0):
        bpy.data.objects.remove(o, do_unlink=True)
    pieces = alive(pieces)
    joined('Home button', within(pieces, -7.0, -60.0, 7.0, -46.0))
    # (the face's white, from its picture about the screen's top)
    grid = pixels(face)
    white = np.median(grid[300:318, 60:340, :3].reshape(-1, 3), axis=0)
    cover = paint('Face', linear(white), .25, coat=.4)
    slab('Earpiece cover', outline(17.0, 4.6, 2.3, 8), -0.01, 0.012, cover, at=(-1.5, 50.2))
    studio(bpy.context.scene)


def bb_parts(path):
    """Jakub Proszowski's BlackBerry Classic (downloads.json), 131 mm tall. Its face is one picture: the maker's
    mark on the Menu key is painted over, with three bars in its place, and the screen's part of the picture
    gives way to a dark panel. Space and Enter are pieces of the mesh, joined into keys. The row under the
    screen is printed on the face: the places of Menu and the trackpad are returned as zones, those of Call,
    Back and End as keys the device keeps for itself."""
    import numpy as np
    meshes = glb(path, ('x', 'z', '-y'), 131.0, 1)
    body = meshes[0]
    face = texture(body.data.materials[0].name)
    grid = pixels(face)
    # (the picture lies upside down on the face; the rectangles are in the picture's pixels)
    grid[320:347, 645:676, :3] = grid[326:340, 630:640, :3].reshape(-1, 3).mean(axis=0)
    ink = grid[322:342, 810:832, :3].reshape(-1, 3).max(axis=0)
    for top in (325, 331, 337):
        grid[top:top + 3, 649:672, :3] = ink
    repaint(face, grid)
    front = [body]
    place = lambda rect: on_front_box(front, face, rect)
    screen = place((558, 371, 926, 741))
    zones = {'menu': place((628, 310, 692, 358)), 'trackpad': place((718, 312, 763, 355))}
    system = {'call': place((548, 310, 612, 358)), 'back': place((788, 310, 852, 358)), 'end': place((868, 310, 932, 358))}
    panel(screen, 0.0)
    # A key is its top and the four walls about it: a wall belongs to the top it is nearest.
    pieces = islands(body)
    def extent(o):
        lo, hi = bounds([o])
        return lo, hi
    tops = []
    for o in pieces:
        lo, hi = extent(o)
        if 3 < hi[0] - lo[0] < 25 and 3 < hi[1] - lo[1] < 8 and hi[2] - lo[2] < 0.15 and hi[1] < -27:
            tops.append((o, lo, hi))
    def gap(point, lo, hi):
        return math.hypot(max(lo[0] - point[0], 0, point[0] - hi[0]), max(lo[1] - point[1], 0, point[1] - hi[1]))
    keys = {id(t[0]): [t[0]] for t in tops}
    for o in pieces:
        lo, hi = extent(o)
        if any(o is t[0] for t in tops) or min(hi[0] - lo[0], hi[1] - lo[1]) > 1.0 or hi[1] > -26:
            continue
        mid = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
        top, d = min(((t, gap(mid, t[1], t[2])) for t in tops), key=lambda td: td[1])
        if d < 1.0:
            keys[id(top[0])].append(o)
    def key_at(x, y):
        return next(t[0] for t in tops if t[1][0] <= x <= t[2][0] and t[1][1] <= y <= t[2][1])
    joined('Space key', keys[id(key_at(0.0, -54.9))])
    joined('Enter key', keys[id(key_at(31.2, -47.5))])
    studio(bpy.context.scene)
    return {'zones': zones, 'system': system}


DRAWN = {'ipod': ipod_parts, 'android': android_parts}
# Devices read from a file that is not a scene of this script's: each brought to its axes, in millimetres.
READ = {'psp': psp_parts, 'ipod-nano': nano_parts, 'gba': gba_parts, 'iphone-4s': iphone_parts, 'ipod-touch-5': ipod_touch_parts, 'bb-classic': bb_parts}


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
    # (a reader may return places that are no object of the scene: rectangles of the front, in millimetres)
    places = {}
    if key in DRAWN:
        DRAWN[key](None)
    elif key in READ:
        places = READ[key](SOURCES / f'{key}.glb' if spec.get('download') else ASSETS / spec['source']) or {}
    else:
        bpy.ops.wm.open_mainfile(filepath=str(ASSETS / spec['source']))
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
        return rect((lo[0] - pad, lo[1] - pad, hi[0] + pad, hi[1] + pad))

    def rect(place):
        left, bottom, right, top = place
        return [round((left - x0) * ppm, 1), round((y1 - top) * ppm, 1), round((right - left) * ppm, 1), round((top - bottom) * ppm, 1)]

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
    for button, place in places.get('zones', {}).items():
        profile['controls'].append({'button': button, 'rect': rect(place), 'part': None})
    # (a key the device keeps for itself, such as a phone's home button: drawn, and read by no app)
    profile['system'] = {name: box(pick(shown)) for name, pick in spec.get('system', {}).items()}
    profile['system'].update({name: rect(place) for name, place in places.get('system', {}).items()})
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
