"""Editable monitor and handheld desk scene. Run with Blender --background --python.

Geometry is authored in mm, then placed under one 0.001 world root for glTF.
Device displays retain independent UVs, materials, and stable semantic names.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import random
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'engine/pocket3d/examples/handheld/assets'
spec = importlib.util.spec_from_file_location('parts', ROOT / 'tools/handheld-models/build.py')
parts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parts)
SOURCES = []
SCREENS = []
DEVICES = []


def empty(name):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    return obj


def bounds(objects):
    bpy.context.view_layer.update()
    points = [o.matrix_world @ Vector(v) for o in objects
              if o.type in {'MESH', 'CURVE', 'FONT'} for v in o.bound_box]
    return [min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]


def source(path):
    SOURCES.append({'path': str(path.relative_to(ROOT)),
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})


def register_screen(obj, device, role, resolution):
    name = f'Screen__{device}__{role}'
    obj.name = name
    # Blank powered-off glass; replace this material with a framebuffer later.
    mat = parts.material(name, (.006, .010, .016), .14, 0, .25)
    mat['pocket3d_role'] = 'dynamic_screen' if role == 'primary' else 'dynamic_screen_auxiliary'
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj['device_id'] = device
    obj['touch_surface'] = role
    obj['framebuffer_size'] = resolution
    obj['bake_exclude'] = True
    SCREENS.append({'node': name, 'material': name, 'device': device,
                    'surface': role, 'framebuffer_size': resolution,
                    'uv_origin': 'bottom-left', 'bake_exclude': True})


def place(device, objects, position, rotation, floor):
    root = empty('Device__' + device)
    for obj in objects:
        if obj.parent is None:
            obj.parent = root
    root.rotation_euler = [math.radians(v) for v in rotation]
    root.location = (*position, 0)
    lo, _ = bounds(objects)
    root.location.z += floor - lo[2]
    root['device_id'] = device
    DEVICES.append({'id': device, 'node': root.name})
    return root


def append_device(device, path, position, rotation, floor):
    source(path)
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = src.objects
    objects = []
    for obj in dst.objects:
        if obj.type in {'MESH', 'CURVE', 'FONT', 'EMPTY'}:
            bpy.context.collection.objects.link(obj)
            objects.append(obj)
    for obj in objects:
        old = obj.name
        obj.name = device + '__' + old
        if old.startswith('Screen_Primary'):
            register_screen(obj, device, 'primary', [400, 240] if device == '3ds' else [960, 544])
        elif old.startswith('Screen_Auxiliary'):
            register_screen(obj, device, 'auxiliary', [320, 240])
        if old == 'Lid_Hinge':
            # Retain the source animation as an action, but pose this composition.
            if obj.animation_data:
                obj.animation_data.action.use_fake_user = True
                obj.animation_data_clear()
            obj.rotation_euler.x = math.radians(35)
            obj['opening_degrees'] = 145
    return place(device, objects, position, rotation, floor)


def psp():
    path = ASSETS / 'dibad-psp/psp_lod2_interactive.glb'
    source(path)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    lo, hi = bounds(objects)
    center = Vector([(a+b)/2 for a, b in zip(lo, hi)])
    scale = 170 / (hi[0]-lo[0])
    # Source GLB front is +Y after Blender import, profile has a 180deg Y turn.
    axes = Matrix(((-1, 0, 0), (0, 0, 1), (0, 1, 0)))
    for obj in objects:
        transform = obj.matrix_world.copy()
        obj.parent = None
        for vertex in obj.data.vertices:
            vertex.co = axes @ (transform @ vertex.co - center) * scale
        obj.matrix_world = Matrix.Identity(4)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
    objects = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for obj in list(objects):
        mat = obj.data.materials[0]
        obj.name = 'psp__' + mat.name
        if mat.name.startswith('P3D_screen_and_glass__tintado'):
            objects.remove(obj)
            bpy.data.objects.remove(obj, do_unlink=True)
        elif mat.get('pocket3d_role') == 'dynamic_screen':
            register_screen(obj, 'psp', 'primary', [480, 272])
        elif mat.get('pocket3d_base_color_mode') == 'monochrome':
            # Match the existing runtime's hardware-marking semantic.
            tree = mat.node_tree
            bs = tree.nodes.get('Principled BSDF')
            socket = bs.inputs['Base Color']
            for link in list(socket.links):
                tree.links.remove(link)
            socket.default_value = (.64, .67, .69, 1)
    return place('psp', objects, (-120, -225), (24, 0, -12), 3)


def monitor():
    """Generic 24-inch desktop monitor, authored upright in device-local XY."""
    before = set(bpy.data.objects)
    panel_drop = 105
    shell = parts.material('Monitor textured black ABS', (.014, .019, .024), .48, 0, .08)
    bezel = parts.material('Monitor satin bezel', (.008, .012, .017), .35, .15)
    metal = parts.material('Monitor anodized stand', (.047, .056, .065), .32, .8)
    recess = parts.material('Monitor recesses', (.002, .003, .004), .8)
    trim = parts.material('Monitor rim highlight', (.075, .090, .105), .28, .75)
    parts.slab('Rear cabinet', (0, 350-panel_drop, -9), (548, 326, 24), 8, shell, 1.6)
    parts.slab('Perimeter assembly seam', (0, 350-panel_drop, 3), (548.2, 326.2, .8), 8, recess, .2)
    parts.slab('Front bezel', (0, 350-panel_drop, 5), (548, 326, 3), 7.5, bezel, .65)
    parts.slab('LCD gasket', (0, 353-panel_drop, 6.6), (534.2, 301.7, .7), 1.5, recess, .15)
    lcd = parts.surface('Monitor LCD', (0, 353-panel_drop, 7.05), 531.4, 298.9, 'dynamic_screen')
    register_screen(lcd, 'desktop-monitor', 'primary', [1920, 1080])
    bs = lcd.data.materials[0].node_tree.nodes['Principled BSDF']
    bs.inputs['Roughness'].default_value = .28
    bs.inputs['Specular IOR Level'].default_value = .25
    bs.inputs['Coat Weight'].default_value = .05
    # The adjustable column sits behind the panel and connects to its VESA plate.
    parts.slab('VESA mounting plate', (0, 330-panel_drop, -24), (112, 112, 8), 7, metal, 1)
    parts.disc('Tilt joint', (0, 330-panel_drop, -38), 21, 22, metal, 1.5)
    parts.block('Stand column', (0, 167-panel_drop/2, -42), (38, 320-panel_drop, 28), metal, 5)
    parts.block('Stand telescopic seam', (0, 232-panel_drop, -42), (39, 3, 29), recess, .4)
    parts.block('Stand foot', (0, 8, -12), (220, 16, 155), metal, 7)
    for x in [-87, 87]:
        for z in [-67, 40]:
            parts.block('Stand rubber foot', (x, -1, z), (24, 2, 20), recess, 3)
    for x in [-50, 50]:
        for y in [280, 380]:
            parts.disc('VESA screw', (x, y-panel_drop, -28.3), 3, .5, recess, .2)
    for x in range(-210, 211, 12):
        parts.slab('Rear ventilation slot', (x, 466-panel_drop, -21.2), (3, 19, .4), 1.4, recess, .1)
    parts.slab('Rear connector inset', (110, 243-panel_drop, -21.3), (126, 33, .5), 3, recess, .3)
    for x, w in [(64, 14), (94, 17), (126, 14)]:
        parts.block('Rear socket trim', (x, 243-panel_drop, -21.8), (w, 7, .8), trim, .8)
        parts.block('Rear socket opening', (x, 243-panel_drop, -22.3), (w-2, 5, .5), recess, .6)
    parts.line('Monitor power cable', [(160, 240-panel_drop, -23), (163, 216-panel_drop, -45),
               (124, 120-panel_drop/2, -67), (84, 12, -100), (100, 4, -182)], 2.5, recess)
    parts.disc('Power indicator', (249, 194-panel_drop, 7), .85, .15, trim, .08)
    objects = [o for o in bpy.data.objects if o not in before]
    for obj in objects:
        if not obj.name.startswith('Screen__'):
            obj.name = 'desktop-monitor__' + obj.name
    return place('desktop-monitor', objects, (0, 155), (90, 0, 0), 3)


def phone(device, position, rotation, floor):
    before = set(bpy.data.objects)
    ipod = device == 'ipod-touch-4'
    w, h, d = (58.9, 111, 7.2) if ipod else (66, 126, 10.5)
    shell = parts.material(device + ' shell', (.027, .031, .035), .39, .05, .16)
    chrome = parts.material(device + ' stainless rim', (.48, .51, .54), .2, .92)
    black = parts.material(device + ' glass bezel', (.003, .005, .009), .19, .06, .4)
    seam = parts.material(device + ' gasket', (.003, .004, .005), .7)
    ink = parts.material(device + ' engraved symbols', (.32, .36, .39), .4, .3)
    lens = parts.material(device + ' lens', (.007, .025, .044), .1, .4, .5)
    parts.slab('Curved rear enclosure', (0, 0, -.6), (w, h, d-1.2), 9, chrome if ipod else shell, .8)
    parts.slab('Front perimeter seam', (0, 0, d/2-1), (w-.65, h-.65, .65), 8.7, seam, .12)
    parts.slab('Polished edge', (0, 0, d/2-.55), (w-.8, h-.8, .45), 8.5, chrome if ipod else shell, .1)
    parts.slab('Black front glass', (0, 0, d/2-.25), (w-1.6, h-1.6, .55), 8.2, black, .1)
    sw, sh = (49.3, 73.95) if ipod else (55.8, 93)
    obj = parts.surface('Display', (0, .8 if ipod else -1, d/2+.06), sw, sh, 'dynamic_screen')
    register_screen(obj, device, 'primary', [640, 960] if ipod else [480, 800])
    if ipod:
        parts.disc('Home button metal lip', (0, -46, d/2+.07), 5.3, .12, chrome, .04)
        parts.disc('Recessed home button', (0, -46, d/2+.15), 5.05, .12, black, .04)
        points = [(x, y-46, d/2+.23) for x, y in parts.outline(3.25, 3.25, .7, 5)]
        parts.line('Home square', points, .10, ink, True)
        parts.disc('FaceTime camera ring', (0, 46.6, d/2+.03), 1.55, .10, seam, .03)
        parts.disc('FaceTime camera glass', (0, 46.6, d/2+.10), 1.0, .10, lens, .03)
        parts.disc('Rear camera', (-21.7, 46.5, -d/2), 2.5, .3, seam, .08)
        parts.disc('Rear camera optic', (-21.7, 46.5, -d/2-.17), 1.5, .1, lens, .05)
        parts.block('30 pin dock opening', (0, -h/2+.15, -.4), (22, .8, 2.2), seam, .6)
        for i in range(15):
            parts.block('Dock contact', (-8.4+i*1.2, -h/2-.04, -.4), (.25, .12, .45), chrome, .03)
        parts.disc('Headphone jack', (21.5, -h/2+.3, -.5), 1.75, .5, seam, .05, (math.pi/2, 0, 0))
        for x in range(8):
            parts.block('Speaker aperture', (-20+x, -h/2+.15, -.6), (.45, .7, 1.1), seam, .1)
    else:
        parts.slab('Earpiece recess', (0, 53, d/2+.08), (16, 2.6, .16), 1.2, seam, .03)
        for x in range(-7, 8):
            parts.block('Earpiece mesh', (x, 53, d/2+.19), (.3, 1.9, .08), ink, .03)
        parts.disc('Front camera', (-17, 52.5, d/2+.1), 1.65, .15, lens, .05)
        parts.disc('Proximity sensor', (16, 52.5, d/2+.1), 1.1, .12, seam, .03)
        z = d/2+.15
        nav_ink = parts.material('Android capacitive key print', (.16, .19, .22), .65)
        parts.line('Capacitive back', [(-15.6, -53.5, z), (-17.3, -54.8, z), (-15.6, -56.1, z)], .10, nav_ink)
        parts.line('Capacitive home', [(-1.65, -54.6, z), (0, -53.2, z), (1.65, -54.6, z),
                                     (1.65, -56.3, z), (-1.65, -56.3, z)], .10, nav_ink, True)
        for y in [-53.9, -54.8, -55.7]:
            parts.line('Capacitive menu', [(14.9, y, z), (18.1, y, z)], .10, nav_ink)
        parts.slab('Rear camera housing', (0, 45, -d/2+.3), (13, 15, 1), 3, shell, .3)
        parts.disc('Rear camera ring', (0, 46, -d/2-.4), 4.1, .6, chrome, .12)
        parts.disc('Rear camera optic', (0, 46, -d/2-.8), 3.2, .3, lens, .1)
        parts.block('Micro USB opening', (0, -h/2+.1, 0), (7.5, .6, 2.6), seam, .6)
    for y in [28, 39]:
        parts.block('Volume key', (-w/2-.2, y, -.2), (.7, 7, 2.1), chrome if ipod else shell, .25)
    parts.block('Sleep key', (17, h/2-.1, -.2), (9, .8, 2), chrome if ipod else shell, .25)
    objects = [o for o in bpy.data.objects if o not in before]
    for obj in objects:
        if not obj.name.startswith('Screen__'):
            obj.name = device + '__' + obj.name
    return place(device, objects, position, rotation, floor)


def textured(name, color, roughness, scale, strength, distance):
    mat = parts.material(name, color, roughness)
    tree = mat.node_tree
    noise = tree.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = 3
    bump = tree.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = distance*.001
    tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
    tree.links.new(bump.outputs['Normal'], tree.nodes['Principled BSDF'].inputs['Normal'])
    return mat


def plant(name, at, size):
    rng = random.Random(name)
    pot = textured(name+' ceramic', (.045, .052, .052), .62, 45, .22, .16)
    soil = textured(name+' soil', (.015, .009, .005), 1, 30, .8, .6)
    leaf = parts.material(name+' foliage', (.027, .065, .023), .42, 0, .17)
    x, y, z = at
    parts.lathe(name+' planter', (x, y, z), [(size*.28, 0), (size*.38, size*.60),
                (size*.36, size*.63), (size*.33, size*.61), (size*.28, size*.1)], pot)
    parts.disc(name+' soil', (x, y, z+size*.58), size*.33, 2, soil)
    for i in range(18):
        angle = rng.uniform(0, 2*math.pi)
        radius = rng.uniform(.35, .95)*size
        height = rng.uniform(.7, 1.8)*size
        origin = Vector((x, y, z+size*.59))
        tip = Vector((x+math.cos(angle)*radius, y+math.sin(angle)*radius, z+height))
        sideways = Vector((-math.sin(angle), math.cos(angle), 0))*size*rng.uniform(.10, .17)
        verts = []
        for j in range(9):
            t = j/8
            mid = origin.lerp(tip, t) + Vector((0, 0, math.sin(t*math.pi)*size*.27))
            width = math.sin(t*math.pi)**.8
            verts.extend([mid-sideways*width, mid+Vector((0, 0, size*.035*width)), mid+sideways*width])
        faces = [(j*3+k, (j+1)*3+k, (j+1)*3+k+1, j*3+k+1) for j in range(8) for k in range(2)]
        obj = parts.mesh(name+f' leaf {i:02}', verts, faces, leaf)
        solid = obj.modifiers.new('Leaf thickness', 'SOLIDIFY')
        solid.thickness = .25


def environment():
    desk = textured('Charcoal oak', (.047, .035, .029), .48, 5, .35, .18)
    noise = next(n for n in desk.node_tree.nodes if n.type == 'TEX_NOISE')
    tex = desk.node_tree.nodes.new('ShaderNodeTexCoord')
    mapping = desk.node_tree.nodes.new('ShaderNodeVectorMath')
    mapping.operation = 'MULTIPLY'
    mapping.inputs[1].default_value = (.003, .2, .1)
    desk.node_tree.links.new(tex.outputs['Object'], mapping.inputs[0])
    desk.node_tree.links.new(mapping.outputs[0], noise.inputs['Vector'])
    parts.block('Desk oak top', (0, 0, -19), (1100, 760, 38), desk, 6)
    felt = textured('Graphite woven desk mat', (.026, .034, .040), .94, 200, .3, .13)
    parts.slab('Desk mat', (0, -78, 1.35), (790, 345, 2.7), 22, felt, .35)
    stitch = parts.material('Mat stitching', (.068, .076, .077), .95)
    # A restrained seam gives the near edge scale without drawing a UI border.
    points = [(x, y-78, 2.8) for x, y in parts.outline(780, 335, 18, 22)]
    parts.line('Mat perimeter seam', points, .23, stitch, True)
    wall = textured('Midnight plaster', (.005, .008, .013), .96, 180, .18, .12)
    parts.block('Background wall', (0, 350, 310), (1400, 30, 720), wall, 2)
    metal = parts.material('Dark anodized aluminum', (.017, .023, .029), .36, .75)
    pages = textured('Uncoated paper edges', (.24, .24, .22), .92, 90, .25, .1)
    cover = parts.material('Book cloth blue black', (.015, .026, .036), .86)
    for name, at, size in [('Left riser', (-205, -60, 3), (160, 102, 6)),
                           ('Vita riser', (145, -54, 16.5), (196, 95, 33))]:
        x, y, z = at; w, h, d = size
        parts.slab(name+' pages', at, (w-3, h-2, d-3), 2, pages, .4)
        for dz in [-d/2, d/2]:
            parts.slab(name+' cloth cover', (x, y, z+dz), (w, h, 1.5), 3, cover, .2)
        parts.block(name+' spine', (x, y+h/2-2, z), (w, 4, d), cover, 1.2)
    # Small physical cradles support the near-vertical handhelds.
    for label, x, y, w, top in [('Vita', 145, -47, 58, 34),
                                ('iPod', -44, -94, 32, 3), ('Android', 28, -182, 37, 3)]:
        parts.slab(label+' stand foot', (x, y+9, top+2), (w, 38, 4), 5, metal, .5)
        stand = parts.block(label+' stand back', (x, y+20, top+24), (w*.65, 4, 44), metal, 2)
        stand.rotation_euler.x = math.radians(-12)
    parts.block('3DS stand back', (-205, -37, 34), (66, 5, 54), metal, 2)
    parts.block('PSP low cradle', (-120, -207, 12), (64, 18, 18), metal, 3)
    plant('Left fern', (-445, 165, 0), 153)
    plant('Right plant', (435, 142, 0), 104)
    # Out-of-focus room shelf, no lettering or promotional content.
    parts.block('Background shelf', (410, 270, 132), (275, 120, 12), metal, 3)
    for x in [300, 520]:
        parts.block('Shelf support', (x, 289, 61), (10, 12, 140), metal, 2)
    for i in range(4):
        parts.block('Background book', (320+i*22, 286, 179+i*3), (18, 45, 79+i*6), cover, 1)
    parts.lathe('Ceramic cup', (468, 280, 140), [(21, 0), (27, 62), (25, 64), (23, 61), (18, 5)], metal)
    # Cropped keyboard and pen in the foreground establish the desktop scale.
    parts.slab('Keyboard frame', (-69, -349, 7), (343, 116, 14), 9, metal, 1.5)
    key = parts.material('Keyboard keycaps', (.022, .028, .033), .56)
    for row in range(5):
        for col in range(16):
            if row == 0 and 5 <= col <= 10:
                continue
            parts.slab('Unlabelled key', (-225+col*20.6, -390+row*20.5, 17), (18.2, 18.2, 6), 2.2, key, .8)
    parts.slab('Spacebar', (-70, -390, 17), (120, 18.2, 6), 2.2, key, .8)
    parts.line('Pen body', [(-318, -235, 5), (-212, -207, 5)], 3.2, metal)
    parts.line('Pen clip', [(-314, -233, 8), (-286, -225.6, 8)], .9, pages)


def area(name, position, target, power, size, color, size_y=None):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.shape = 'RECTANGLE'
    data.size = size
    data.size_y = size_y or size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z', 'Y').to_euler()
    obj['bake_group'] = 'static_environment'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='.pocket-build/validation/desk-scene/current')
    parser.add_argument('--samples', type=int, default=64)
    parser.add_argument('--width', type=int, default=1920)
    parser.add_argument('--no-render', action='store_true')
    parser.add_argument('--export-glb', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    out = (ROOT / args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    monitor()
    append_device('3ds', ASSETS/'new-nintendo-3ds/new-nintendo-3ds.blend', (-205, -60), (45, 0, 10), 7)
    append_device('vita', ASSETS/'ps-vita-2000/ps-vita-2000.blend', (145, -54), (73, 0, -11), 34)
    psp()
    phone('ipod-touch-4', (-44, -98), (81, 0, 7), 3)
    phone('android-budget', (28, -188), (75, 0, -9), 3)
    environment()
    area('Warm window key', (-480, -180, 600), (-40, 0, 140), 8000000, 300, (1, .78, .58), 420)
    area('Cool window rim', (480, 250, 560), (0, 0, 180), 6000000, 180, (.42, .61, 1), 350)
    area('Front soft fill', (160, -320, 230), (0, -65, 80), 1500000, 320, (.66, .79, 1), 90)
    area('Overhead strip', (-40, 100, 650), (0, 0, 0), 3000000, 500, (.84, .90, 1), 65)
    scene.world = bpy.data.worlds.new('Night room')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.07, .10, .17, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .05
    camera = bpy.data.objects.new('Camera__hero', bpy.data.cameras.new('Hero 54mm'))
    bpy.context.collection.objects.link(camera)
    camera.location = (12, -1070, 405)
    target = Vector((0, 20, 160))
    camera.rotation_euler = (target-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = 54
    camera.data.clip_start = .01
    camera.data.clip_end = 100
    focus = empty('Focus__devices')
    focus.location = (0, 10, 230)
    camera.data.dof.use_dof = True
    camera.data.dof.focus_object = focus
    camera.data.dof.aperture_fstop = 11
    scene.camera = camera
    world = empty('DeskScene__millimetres_to_metres')
    for obj in list(scene.objects):
        if obj != world and obj.parent is None:
            obj.parent = world
        if obj.type == 'LIGHT':
            obj.data.energy *= .000001
    world.scale = (.001,)*3
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 11
    scene.cycles.max_bounces = 8
    scene.render.resolution_x = args.width
    scene.render.resolution_y = round(args.width*3/4)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.filepath = '//desk-scene.png'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = -.3
    scene['description'] = 'Central desktop monitor and five handheld devices; blank displays; no webpage UI.'
    scene['screen_binding_manifest'] = 'scene.json'
    bpy.context.view_layer.update()
    # Pack the PSP texture dependencies so the editable file is self-contained.
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'desk-scene.blend'), compress=True)
    manifest = {'schema_version': 1, 'units': 'metres', 'blender': bpy.app.version_string,
                'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'render': {'width': args.width, 'height': scene.render.resolution_y,
                           'samples': args.samples, 'seed': 11, 'view_transform': 'AgX',
                           'look': scene.view_settings.look, 'exposure': scene.view_settings.exposure},
                'camera': camera.name, 'devices': DEVICES, 'screens': SCREENS,
                'sources': SOURCES, 'lighting': {'baked': False, 'renderer': 'Cycles',
                'note': 'Area lights and procedural textures remain in the blend. GLB needs web lighting and texture baking.'},
                'ipod_reference': 'https://support.apple.com/en-us/112431',
                'android_reference': 'Authored generic 4.3-inch budget Android handset; not a manufacturer replica.'}
    (out/'scene.json').write_text(json.dumps(manifest, indent=2)+'\n')
    web_spec = importlib.util.spec_from_file_location('web_projection', Path(__file__).with_name('export-web.py'))
    web_projection = importlib.util.module_from_spec(web_spec)
    web_spec.loader.exec_module(web_projection)
    web_projection.export_web(scene, manifest, out/'web.json')
    if not args.no_render:
        bpy.ops.render.render(write_still=True)
    if args.export_glb:
        # glTF cannot represent Cycles area lights or procedural bump networks.
        # Preserve those in .blend; this export is the geometry/UV handoff.
        bpy.ops.object.select_all(action='DESELECT')
        for obj in list(scene.objects):
            if obj.type in {'MESH', 'CURVE', 'FONT'}:
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target='MESH')
        bpy.ops.export_scene.gltf(filepath=str(out/'desk-scene.glb'), export_format='GLB',
            export_extras=True, export_animations=False, export_cameras=True,
            export_lights=False, export_apply=True)
    print('DESK_SCENE_COMPLETE ' + str(out))


if __name__ == '__main__':
    main()
