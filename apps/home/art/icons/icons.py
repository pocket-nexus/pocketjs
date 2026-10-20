"""Author Pocket Home's icons in Blender and render each one orthographically.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    --python apps/home/art/icons/icons.py -- --out .pocket-build/home-icons [--only hn,mac]

Every icon is an iOS 6 tile: a lacquered or metal plate with a raised,
beveled object on it, lit from above so top edges catch the light and the
object casts its shadow downward. The tile spans [-1, 1] in x and y; the
camera looks straight down and frames exactly that square. The plate runs
past the frame, so the render is opaque to its edges: bake.ts applies the
rounded-square mask, the gloss, the rim and the drop shadow afterwards, the
same way for every icon.
"""

import argparse
import math
import sys
from pathlib import Path

import bpy

args = argparse.ArgumentParser()
args.add_argument("--out", type=Path, required=True)
args.add_argument("--only", default="")
args.add_argument("--samples", type=int, default=128)
options = args.parse_args(sys.argv[sys.argv.index("--") + 1:])
options.out.mkdir(parents=True, exist_ok=True)

RES = 512
VERDANA_BOLD = "/System/Library/Fonts/Supplemental/Verdana Bold.ttf"


def linear(hex_color):
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c) + (1.0,)


# ---- scene ------------------------------------------------------------------------


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = options.samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = -0.25
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for device in prefs.devices:
            device.use = True
        scene.cycles.device = "GPU"
    except Exception:
        scene.cycles.device = "CPU"

    camera = bpy.data.cameras.new("Camera")
    camera.type = "ORTHO"
    camera.ortho_scale = 2.0
    cam = bpy.data.objects.new("Camera", camera)
    cam.location = (0, 0, 10)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # World: a studio dome, dark overhead so a flat plate shows its own
    # color, bright in a band toward the top of the icon so every bevel that
    # faces up catches a highlight, as under a window.
    world = bpy.data.worlds.new("Studio")
    scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    coord = nodes.new("ShaderNodeTexCoord")
    dot = nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = (0.0, 0.8, 0.6)
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.62
    ramp.color_ramp.elements[0].color = (0.06, 0.06, 0.065, 1)
    ramp.color_ramp.elements[1].position = 0.95
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Strength"].default_value = 0.9
    output = nodes.new("ShaderNodeOutputWorld")
    links.new(coord.outputs["Generated"], dot.inputs[0])
    links.new(dot.outputs["Value"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], background.inputs["Color"])
    links.new(background.outputs["Background"], output.inputs["Surface"])

    # Key: a softbox above and toward the top edge. Fill: a weak one below.
    area("Key softbox", (0, 4.0, 3.5), 3.0, 650)
    area("Fill", (0, -5, 4), 6.0, 120)
    return scene


def area(name, location, size, energy):
    light = bpy.data.lights.new(name, "AREA")
    light.size = size
    light.energy = energy
    obj = bpy.data.objects.new(name, light)
    obj.location = location
    direction = -obj.location.normalized()
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(obj)
    return obj


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ---- materials ----------------------------------------------------------------------


def principled(name, color, rough=0.3, metal=0.0, coat=0.0, coat_rough=0.08):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = linear(color) if isinstance(color, str) else color
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = coat_rough
    return m


def gradient(name, top, bottom, rough=0.35, metal=0.0, coat=0.4, axis=1, lo=-1.0, hi=1.0):
    """A plate whose color runs from `bottom` (at lo) to `top` (at hi) along an
    object axis (y by default)."""
    m = principled(name, top, rough, metal, coat)
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    coord = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    rng = nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value = lo
    rng.inputs["From Max"].default_value = hi
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = linear(bottom)
    ramp.color_ramp.elements[1].color = linear(top)
    links.new(coord.outputs["Object"], sep.inputs[0])
    links.new(sep.outputs[axis], rng.inputs["Value"])
    links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    return m


def brushed_radial(name, light, dark):
    """Concentric brushed metal: a noise read along the distance from the
    centre, so its streaks run around it."""
    m = principled(name, light, 0.32, 1.0)
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    p = nodes["Principled BSDF"]
    coord = nodes.new("ShaderNodeTexCoord")
    length = nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    combine = nodes.new("ShaderNodeCombineXYZ")
    scale = nodes.new("ShaderNodeMath")
    scale.operation = "MULTIPLY"
    scale.inputs[1].default_value = 90.0
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 6.0
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = linear(dark)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = linear(light)
    links.new(coord.outputs["Object"], length.inputs[0])
    links.new(length.outputs["Value"], scale.inputs[0])
    links.new(scale.outputs["Value"], combine.inputs["X"])
    links.new(combine.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m


def fabric(name, color):
    """Woven cloth: a fine noise bump and a matte sheen."""
    m = principled(name, color, 0.75)
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    p = nodes["Principled BSDF"]
    p.inputs["Sheen Weight"].default_value = 0.15
    coord = nodes.new("ShaderNodeTexCoord")
    wave = nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "DIAGONAL"
    wave.inputs["Scale"].default_value = 60.0
    wave.inputs["Distortion"].default_value = 2.0
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    links.new(coord.outputs["Object"], wave.inputs["Vector"])
    links.new(wave.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], p.inputs["Normal"])
    return m


def emissive_gradient(name, top, bottom, strength=1.4, lo=-1.0, hi=1.0):
    m = gradient(name, top, bottom, 0.08, 0.0, 1.0, lo=lo, hi=hi)
    nodes = m.node_tree.nodes
    p = nodes["Principled BSDF"]
    ramp = [n for n in nodes if n.type == "VALTORGB"][0]
    m.node_tree.links.new(ramp.outputs["Color"], p.inputs["Emission Color"])
    p.inputs["Emission Strength"].default_value = strength
    p.inputs["Base Color"].default_value = (0, 0, 0, 1)
    return m


# ---- geometry ----------------------------------------------------------------------


def finish(obj, mat, bevel=0.02, segments=4):
    obj.data.materials.append(mat)
    if bevel:
        b = obj.modifiers.new("Bevel", "BEVEL")
        b.width = bevel
        b.segments = segments
        b.limit_method = "ANGLE"
    for face in obj.data.polygons:
        face.use_smooth = True
    n = obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    n.keep_sharp = True
    return obj


def prism(name, outer, z, depth, mat, bevel=0.02, holes=()):
    """Extrude a polygon (with optional polygon holes) from z to z + depth."""
    import bmesh

    bm = bmesh.new()
    loops = [outer, *holes]
    for index, points in enumerate(loops):
        verts = [bm.verts.new((x, y, z)) for x, y in points]
        for a in range(len(verts)):
            bm.edges.new((verts[a], verts[(a + 1) % len(verts)]))
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=True, edges=bm.edges[:])
    faces = bm.faces[:]
    ext = bmesh.ops.extrude_face_region(bm, geom=faces)
    moved = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, depth), verts=moved)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = link(bpy.data.objects.new(name, mesh))
    return finish(obj, mat, bevel)


def rounded_rect(w, h, r, x=0.0, y=0.0, steps=10, angle=0.0):
    points = []
    for cx, cy, start in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
        for k in range(steps + 1):
            t = math.radians(start + k * 90 / steps)
            px, py = cx + r * math.cos(t), cy + r * math.sin(t)
            points.append((x + px * math.cos(angle) - py * math.sin(angle), y + px * math.sin(angle) + py * math.cos(angle)))
    return points


def circle(r, x=0.0, y=0.0, count=96):
    return [(x + r * math.cos(i * math.tau / count), y + r * math.sin(i * math.tau / count)) for i in range(count)]


def plate(mat):
    bpy.ops.mesh.primitive_plane_add(size=3.2, location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = "Plate"
    obj.data.materials.append(mat)
    return obj


def text(body, font, size, x, y, z, depth, mat, bevel=0.012):
    curve = bpy.data.curves.new("Text " + body, "FONT")
    curve.body = body
    curve.font = bpy.data.fonts.load(font)
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = depth / 2
    curve.bevel_depth = bevel
    curve.bevel_resolution = 4
    obj = link(bpy.data.objects.new("Text " + body, curve))
    obj.location = (x, y, z + depth / 2 + bevel)
    obj.data.materials.append(mat)
    return obj


def tube(name, points, z, radius, mat, closed=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 6
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, (x, y) in zip(spline.points, points):
        point.co = (x, y, z, 1)
    spline.use_cyclic_u = closed
    obj = link(bpy.data.objects.new(name, curve))
    obj.data.materials.append(mat)
    return obj


def gear_outline(teeth, tip, root, steps=12, land=0.42):
    """A spur gear's outline: each tooth a trapezoid with eased flanks."""
    points = []
    count = teeth * steps
    for i in range(count):
        phase = (i % steps) / steps
        # 0..land: tip, then a flank down, the root, a flank up.
        flank = (1 - land) / 4
        if phase < land:
            r = tip
        elif phase < land + flank:
            r = tip - (tip - root) * (phase - land) / flank
        elif phase < land + 3 * flank:
            r = root
        else:
            r = root + (tip - root) * (phase - land - 3 * flank) / flank
        a = i * math.tau / count + math.pi / 2
        points.append((r * math.cos(a), r * math.sin(a)))
    return points


# ---- icons -------------------------------------------------------------------------


def settings():
    plate(brushed_radial("Brushed steel", "dde1e6", "a3aab3"))
    # A dark ring the gear sits in, like the recess of iOS 6's Settings.
    prism("Recess", circle(0.86), 0.0, 0.02, principled("Recess", "3a3f47", 0.4, 0.7), 0.012)
    gun = principled("Gunmetal", "6a727e", 0.28, 0.85)
    steel = principled("Polished steel", "d8dde4", 0.16, 1.0)
    # Six windows through the gear's web, between hub and rim.
    windows = [
        list(reversed(rounded_rect(0.13, 0.17, 0.055, 0.47 * math.cos(a), 0.47 * math.sin(a), angle=a + math.pi / 2)))
        for a in [k * math.tau / 6 + math.pi / 6 for k in range(6)]
    ]
    prism("Gear", gear_outline(12, 0.80, 0.63), 0.02, 0.14, gun, 0.025, holes=[list(reversed(circle(0.30))), *windows])
    prism("Hub ring", circle(0.30), 0.02, 0.17, steel, 0.03, holes=[list(reversed(circle(0.17)))])
    prism("Axle", circle(0.17), 0.02, 0.10, principled("Axle", "2b2f35", 0.3, 0.9), 0.02)


def mac():
    plate(gradient("Sky lacquer", "7cc8ff", "1653c4", 0.28, coat=0.6))
    alu = principled("Aluminium", "c9ced5", 0.3, 1.0)
    dark = principled("Bezel glass", "0d0f12", 0.06, 0.0, 1.0, 0.02)
    # The lid faces the viewer; the deck below it is seen at a steep angle.
    prism("Lid", rounded_rect(1.44, 0.98, 0.07, 0, 0.17), 0.18, 0.05, alu, 0.02)
    prism("Bezel", rounded_rect(1.38, 0.92, 0.05, 0, 0.17), 0.23, 0.012, dark, 0.006)
    prism("Display", rounded_rect(1.20, 0.74, 0.01, 0, 0.18), 0.243, 0.004, emissive_gradient("Desktop", "4fb8f5", "1a3fa8", 0.9, -0.2, 0.55), 0)
    # A sheen across the display glass, from the softbox.
    prism("Hinge", rounded_rect(1.40, 0.05, 0.02, 0, -0.335), 0.17, 0.04, principled("Hinge", "2f3338", 0.35, 0.8), 0.01)
    deck = [(-0.74, -0.36), (0.74, -0.36), (0.86, -0.54), (-0.86, -0.54)]
    prism("Deck", deck, 0.14, 0.06, alu, 0.02)
    prism("Keys", [(-0.6, -0.38), (0.6, -0.38), (0.66, -0.47), (-0.66, -0.47)], 0.20, 0.006, principled("Keys", "202326", 0.5, 0.2), 0.003)
    prism("Thumb notch", rounded_rect(0.22, 0.03, 0.012, 0, -0.53), 0.20, 0.004, principled("Notch", "7d838b", 0.3, 1.0), 0.002)


def hn():
    plate(gradient("Orange lacquer", "ff8d2e", "f05300", 0.24, coat=0.8))
    enamel = principled("White enamel", "fbfbf8", 0.22, 0.0, 0.6)
    outer = rounded_rect(1.30, 1.30, 0.06)
    inner = list(reversed(rounded_rect(1.12, 1.12, 0.03)))
    prism("Frame", outer, 0.0, 0.07, enamel, 0.02, holes=[inner])
    text("Y", VERDANA_BOLD, 1.18, 0.0, -0.03, 0.0, 0.07, enamel, 0.014)


def nexus():
    plate(gradient("Plum lacquer", "4a2a72", "160a26", 0.4, coat=0.5))
    confetti = [
        ("ff5fa2", -0.70, 0.68, 0.5), ("4fd6ff", 0.62, 0.74, -0.4), ("ffd23f", 0.78, 0.18, 1.1),
        ("9b7bff", -0.78, -0.12, 1.3), ("ffd23f", -0.62, -0.78, -0.9), ("4fd6ff", 0.70, -0.72, 0.7),
        ("ff5fa2", 0.12, 0.84, 1.4), ("9b7bff", 0.36, -0.86, -0.2),
    ]
    for color, x, y, a in confetti:
        prism("Confetti", rounded_rect(0.16, 0.055, 0.024, x, y, 6, a), 0.0, 0.03, principled("Confetti " + color, color, 0.3, 0.0, 0.5), 0.012)
    # The pocket: a straight top, straight sides, a round bottom.
    top, side, bottom, half = 0.46, -0.02, -0.66, 0.66
    rx, ry = half, side - bottom
    outline = [(-half, top), (half, top)]
    outline += [(rx * math.cos(-k * math.pi / 40), side + ry * math.sin(-k * math.pi / 40)) for k in range(41)]
    navy = fabric("Denim", "161a4a")
    prism("Pocket", outline, 0.02, 0.08, navy, 0.03)
    gold = principled("Gold piping", "f6c445", 0.28, 0.7, 0.3)
    tube("Piping", outline, 0.11, 0.045, gold, closed=True)
    # Stitching: a straight seam under the hem, a wave across the middle.
    cream = principled("Thread", "f3e6c4", 0.6)
    for k in range(9):
        x = -0.52 + k * 0.13
        prism("Hem stitch", rounded_rect(0.075, 0.025, 0.011, x, 0.31), 0.10, 0.012, cream, 0.006)
    colors = ["ff5fa2", "4fd6ff", "ffd23f"]
    for k in range(8):
        x = -0.48 + k * 0.137
        y = -0.08 + 0.07 * math.sin(k * 1.25)
        slope = 0.07 * 1.25 * math.cos(k * 1.25) / 0.137
        prism("Wave stitch", rounded_rect(0.09, 0.034, 0.015, x, y, 6, math.atan(slope)), 0.104, 0.014, principled("Stitch " + str(k), colors[k % 3], 0.4), 0.007)
    for x in (-0.53, 0.53):
        prism("Rivet", circle(0.055, x, 0.36, 32), 0.10, 0.04, gold, 0.02)


def wifi():
    plate(gradient("Blue lacquer", "6cb6fb", "1a5fd0", 0.26, coat=0.7))
    enamel = principled("White enamel", "fbfbf8", 0.22, 0.0, 0.6)
    cx, cy = 0.0, -0.46
    for r in (0.34, 0.60, 0.86):
        t = 0.15
        span = math.radians(46)
        outer = [(cx + r * math.cos(math.pi / 2 + a), cy + r * math.sin(math.pi / 2 + a)) for a in [span - 2 * span * i / 24 for i in range(25)]]
        inner = [(cx + (r - t) * math.cos(math.pi / 2 + a), cy + (r - t) * math.sin(math.pi / 2 + a)) for a in [-span + 2 * span * i / 24 for i in range(25)]]
        prism("Arc", outer + inner, 0.0, 0.08, enamel, 0.025)
    prism("Dot", circle(0.11, cx, cy + 0.02), 0.0, 0.08, enamel, 0.03)


def apps():
    plate(gradient("Violet lacquer", "c592f7", "6a31c3", 0.26, coat=0.7))
    enamel = principled("White enamel", "fbfbf8", 0.22, 0.0, 0.6)
    for x in (-0.33, 0.33):
        for y in (-0.33, 0.33):
            prism("Cell", rounded_rect(0.52, 0.52, 0.12, x, y), 0.0, 0.09, enamel, 0.03)


ICONS = {"settings": settings, "mac": mac, "hn": hn, "nexus": nexus, "wifi": wifi, "apps": apps}

only = [name for name in options.only.split(",") if name]
for name, build in ICONS.items():
    if only and name not in only:
        continue
    scene = reset()
    build()
    scene.render.filepath = str(options.out / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"rendered {name} -> {scene.render.filepath}")
