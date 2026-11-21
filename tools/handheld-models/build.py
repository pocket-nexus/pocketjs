"""Author the KTR-001 and PCH-2000 shells in Blender, in millimetres.

Run: Blender --background --python tools/handheld-models/build.py -- [3ds|vita|all]
The saved .blend retains named, editable components. Export batches static
meshes by material and articulation parent; screen UVs and hinge stay separate.
Photographs are visual references only, never projected onto the geometry.
"""
import bpy
import math
import json
import sys
from pathlib import Path
from mathutils import Vector
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'engine/pocket3d/examples/handheld/assets'
QA = ROOT / 'dist/handheld-models'
PI = math.pi
PARENT = None


def material(name, color, roughness=.4, metallic=0, coat=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = roughness
    bs.inputs['Metallic'].default_value = metallic
    bs.inputs['Coat Weight'].default_value = coat
    bs.inputs['Coat Roughness'].default_value = .18
    return m


def finish(obj, name, mat, bevel=0):
    obj.name = name
    if mat: obj.data.materials.append(mat)
    if PARENT: obj.parent = PARENT
    if bevel:
        mod = obj.modifiers.new('Manufactured edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
    if obj.type == 'MESH':
        for p in obj.data.polygons: p.use_smooth = True
        n = obj.modifiers.new('Face weighted normals', 'WEIGHTED_NORMAL')
        n.keep_sharp = True
        n.weight = 40
    return obj


def mesh(name, vertices, faces, mat, bevel=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, mat, bevel)


def outline(w, h, r, steps=14):
    points = []
    radii=r if isinstance(r,(list,tuple)) else [r]*4
    for (sx,sy,start),radius in zip([(1,1,0),(-1,1,90),(-1,-1,180),(1,-1,270)],radii):
        radius=min(radius,w/2,h/2)
        r=radius; cx=sx*(w/2-r); cy=sy*(h/2-r)
        for i in range(steps+1):
            a = math.radians(start+i*90/steps)
            points.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    return points


def slab(name, at, size, radius, mat, bevel=.15):
    w,h,d = size
    pts = outline(w,h,radius)
    n = len(pts)
    v = [(x,y,z) for z in [-d/2,d/2] for x,y in pts]
    f = [tuple(reversed(range(n))),tuple(range(n,n*2))]
    f += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    obj = mesh(name,v,f,mat,bevel)
    obj.location = at
    return obj


def block(name, at, size, mat, bevel=.2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    obj=bpy.context.object
    obj.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(obj,name,mat,bevel)


def disc(name, at, radius, depth, mat, bevel=.12, rotation=None, vertices=48):
    if radius<1.5: vertices=min(vertices,24)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=at)
    obj=bpy.context.object
    if rotation: obj.rotation_euler=rotation
    return finish(obj,name,mat,bevel)


def lathe(name, at, rings, mat, segments=64, caps=True):
    v=[]
    for radius,z in rings:
        v += [(radius*math.cos(i*2*PI/segments), radius*math.sin(i*2*PI/segments),z) for i in range(segments)]
    f=[tuple(reversed(range(segments)))] if caps else []
    for j in range(len(rings)-1):
        f += [(j*segments+i,j*segments+(i+1)%segments,(j+1)*segments+(i+1)%segments,(j+1)*segments+i) for i in range(segments)]
    if caps: f.append(tuple(range((len(rings)-1)*segments,len(rings)*segments)))
    obj=mesh(name,v,f,mat)
    obj.location=at
    return obj


def line(name, points, radius, mat, close=False):
    c=bpy.data.curves.new(name,'CURVE'); c.dimensions='3D'
    c.bevel_depth=radius; c.bevel_resolution=2; c.resolution_u=1
    spline=c.splines.new('POLY'); spline.points.add(len(points)-1)
    for p,co in zip(spline.points,points): p.co=(*co,1)
    spline.use_cyclic_u=close
    obj=bpy.data.objects.new(name,c); bpy.context.collection.objects.link(obj)
    return finish(obj,name,mat)


def inkstroke(name, points, width, mat, closed=True):
    """Flat printed line segments; ink has no cylindrical sidewalls."""
    verts=[]; faces=[]
    for a,b in zip(points,points[1:]+(points[:1] if closed else [])):
        d=Vector(b)-Vector(a); n=Vector((-d.y,d.x,0)).normalized()*width/2
        k=len(verts); verts.extend([Vector(a)+n,Vector(a)-n,Vector(b)-n,Vector(b)+n])
        faces.append((k,k+1,k+2,k+3))
    return mesh(name,verts,faces,mat)


def text(name, value, at, size, mat, rotation=None, align='CENTER', font=None):
    c=bpy.data.curves.new(name,'FONT'); c.body=value; c.size=size
    c.align_x=align; c.align_y='CENTER'; c.extrude=.012; c.resolution_u=5
    if font: c.font=font
    obj=bpy.data.objects.new(name,c); bpy.context.collection.objects.link(obj); obj.location=at
    if rotation: obj.rotation_euler=rotation
    return finish(obj,name,mat)


def surface(name, at, w, h, role):
    m=material(name,(.012,.018,.021),.15,0,.25); m['pocket3d_role']=role
    obj=mesh(name,[(-w/2,-h/2,0),(w/2,-h/2,0),(w/2,h/2,0),(-w/2,h/2,0)],[(0,1,2,3)],m)
    obj.location=at
    uv=obj.data.uv_layers.new(name='Display UV')
    for loop,co in zip(obj.data.polygons[0].loop_indices,[(0,0),(1,0),(1,1),(0,1)]): uv.data[loop].uv=co
    obj['screen_size_mm']=[w,h]
    return obj


def cut(obj, cutter):
    bpy.context.view_layer.objects.active=obj
    # Bake the radiused blank before drilling; applying a later boolean while
    # leaving the bevel above it would bevel an already bevelled result.
    for existing in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=existing.name)
    mod=obj.modifiers.new('Machined opening','BOOLEAN'); mod.operation='DIFFERENCE'; mod.object=cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for p in obj.data.polygons:
        if abs(p.normal.z)>.99: p.use_smooth=False
    bpy.data.objects.remove(cutter,do_unlink=True)


def mark(name, source, at, width, mat, back=False, max_y=None):
    data=json.loads((Path(__file__).parent/'marks'/(source+'.json')).read_text())
    contours=[p for p in data['contours'] if max_y is None or max(v[1] for v in p)<max_y]
    xmin=min(v[0] for p in contours for v in p); xmax=max(v[0] for p in contours for v in p)
    ymin=min(v[1] for p in contours for v in p); ymax=max(v[1] for p in contours for v in p)
    scale=width/(xmax-xmin)
    c=bpy.data.curves.new(name,'CURVE'); c.dimensions='2D'; c.fill_mode='BOTH'; c.resolution_u=1
    for points in contours:
        sp=c.splines.new('POLY'); sp.points.add(len(points)-1); sp.use_cyclic_u=True
        for p,(x,y) in zip(sp.points,points):
            p.co=((x-(xmin+xmax)/2)*scale*(-1 if back else 1),-(y-(ymin+ymax)/2)*scale,0,1)
    obj=bpy.data.objects.new(name,c); bpy.context.collection.objects.link(obj); obj.location=at
    return finish(obj,name,mat)


def hole(name, at, radius, depth, shell, mat, rotation=None):
    cutter=disc(name+' cutter',at,radius,depth,None,0,rotation)
    cut(shell,cutter)
    from mathutils import Euler
    normal=Euler(rotation or (0,0,0)).to_matrix() @ Vector((0,0,1))
    floor=Vector(at)-normal*(depth*.4)
    return disc(name+' dark cavity',floor,radius*.96,.12,mat,0,rotation)


def camera_lens(name,x,y,z,back=False,r=2.65):
    s=-1 if back else 1
    disc(name+' black surround',(x,y,z),r,.3,BLACK,.12)
    disc(name+' machined ring',(x,y,z+s*.18),r*.7,.15,RING,.03)
    disc(name+' optical glass',(x,y,z+s*.3),r*.48,.15,LENS,.05)
    disc(name+' aperture',(x,y,z+s*.39),r*.21,.025,BLACK,.01)
    disc(name+' reflection',(x-r*.12,y+r*.13,z+s*.41),r*.075,.025,GLINT,.01)


def screw(name,x,y,z,back=True):
    s=-1 if back else 1
    disc(name+' recess',(x,y,z),1.45,.2,SEAM,.04)
    disc(name+' head',(x,y,z+s*.12),1.08,.18,METAL,.08)
    for angle in [0,90]:
        b=block(name+' cross',(x,y,z+s*.22),(1.5,.25,.055),BLACK,.05)
        b.rotation_euler.z=math.radians(angle)


def symbol(name, kind, at, size, mat):
    x,y,z=at; r=size/2
    if kind=='circle': pts=[(x+r*math.cos(a*2*PI/40),y+r*math.sin(a*2*PI/40),z) for a in range(40)]
    elif kind=='triangle': pts=[(x,y+r,z),(x-r,y-r*.8,z),(x+r,y-r*.8,z)]
    elif kind=='square': pts=[(x-r,y-r,z),(x+r,y-r,z),(x+r,y+r,z),(x-r,y+r,z)]
    else:
        line(name+' diagonal 1',[(x-r,y-r,z),(x+r,y+r,z)],.14,mat)
        line(name+' diagonal 2',[(x-r,y+r,z),(x+r,y-r,z)],.14,mat)
        return
    line(name,pts,.14,mat,True)


def dpad(x,y,z,mat,split=False):
    # One moulded cross for Nintendo; four separated tapered keys for Sony.
    if not split:
        pts=[(-2.8,9),(2.8,9),(2.8,2.8),(9,2.8),(9,-2.8),(2.8,-2.8),
             (2.8,-9),(-2.8,-9),(-2.8,-2.8),(-9,-2.8),(-9,2.8),(-2.8,2.8)]
        pts=list(reversed(pts)); n=len(pts)
        def cross(name,s,z0,depth,m):
            obj=mesh(name,[(x+px*s,y+py*s,zz) for zz in [z0,z0+depth] for px,py in pts],
                     [tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],m,.3)
            return obj
        cross('D-pad socket',1.07,z-.6,.6,SEAM)
        cross('D-pad',1,z,1.5,mat)
    else:
        disc('Directional cluster recess',(x,y,z-.1),11,.6,BLACK,.4)
        for i in range(4):
            a=i*PI/2
            pts=[(-2.7,3.1),(0,.8),(2.7,3.1),(2.7,8.6),(-2.7,8.6)]
            pts=[(x+px*math.cos(a)-py*math.sin(a),y+px*math.sin(a)+py*math.cos(a)) for px,py in pts]
            n=len(pts)
            mesh('D-pad '+str(i),[(px,py,zz) for zz in [z,z+1.3] for px,py in pts],
                 [tuple(reversed(range(n))),tuple(range(n,n*2))]+[(j,(j+1)%n,(j+1)%n+n,j+n) for j in range(n)],mat,.45)
    for i in range(4):
        a=i*PI/2; dx=-math.sin(a); dy=math.cos(a)
        if split:
            tx=x+dx*6; ty=y+dy*6
            pts=[(tx+dx*.8,ty+dy*.8,z+1.62),(tx-dx*.6+dy*.7,ty-dy*.6-dx*.7,z+1.62),(tx-dx*.6-dy*.7,ty-dy*.6+dx*.7,z+1.62)]
            line('D-pad arrow',pts,.08,INK,True)
        else:
            line('D-pad inset mark',[(x+dx*4,y+dy*4,z+1.54),(x+dx*7,y+dy*7,z+1.54)],.15,INK)


def setup():
    global PARENT,BLACK,SEAM,RING,LENS,GLINT,METAL,INK
    bpy.ops.wm.read_factory_settings(use_empty=True); PARENT=None
    scene=bpy.context.scene
    scene.unit_settings.system='METRIC'; scene.unit_settings.scale_length=.001
    BLACK=material('Deep recess',(.004,.006,.007),.4)
    SEAM=material('Assembly shadow',(.11,.115,.11),.52)
    RING=material('Optical barrel',(.06,.07,.074),.24,.48)
    LENS=material('Coated optical glass',(.015,.034,.046),.09,.48,.4)
    GLINT=material('Lens glint',(.20,.28,.30),.13,.3)
    METAL=material('Satin stainless steel',(.42,.44,.45),.28,.82)
    INK=material('Warm grey markings',(.34,.35,.34),.62)


def nintendo():
    global PARENT
    setup()
    white=material('KTR warm white ABS',(.76,.77,.735),.34,0,.14)
    plate=material('KTR white removable plates',(.80,.80,.77),.40,0,.12)
    edge=material('KTR bezel highlight',(.64,.66,.63),.33)
    rubber=material('KTR grey elastomer',(.38,.40,.41),.71)
    printwhite=material('KTR key legends',(.87,.89,.88),.4)
    seamwhite=material('KTR seam interior',(.37,.39,.36),.6)
    base=slab('Lower chassis',(0,-36.1,4.25),(142,80.6,10.9),10,white,1.1)
    slab('Lower assembly seam',(0,-36.1,7.45),(141.9,80.45,.24),9.9,seamwhite,.09)
    deck=slab('Inner control deck',(0,-36.1,9.25),(141.8,80.3,3.3),9.8,white,.85)
    cover=slab('Bottom removable cover',(0,-39.75,-1.06),(140,64.5,.6),6,plate,.3)
    cut(cover,disc('Stylus finger notch',(12,-73,-1),4.6,3,None,0))
    # The touch surround projects above the controller wings on this model.
    slab('Touch panel raised surround',(0,-38.7,11.0),(79.4,74.6,2.1),7,white,.8)
    slab('Touch glass gasket',(0,-36.8,12.13),(69.2,52.5,.24),.8,seamwhite,.1)
    surface('Screen_Auxiliary',(0,-36.8,12.29),67.68,50.76,'dynamic_screen_auxiliary')
    # Circle pad is a concave rubber cap in a broad circular bowl.
    cut(deck,disc('Circle bowl cut',(-55,-21,11),10.25,4,None,0))
    lathe('Circle pad bowl',(-55,-21,10.93),[(10.7,0),(10.2,-.2),(9.4,-.7),(8,-.95),(6.7,-.5)],white,caps=False)
    lathe('Circle pad',(-55,-21,11.0),[(6.7,0),(7.05,.55),(6.7,1.5),(5.4,1.85),(3.5,1.35),(.1,1.2)],rubber)
    dpad(-55,-47,10.95,white)
    disc('C-stick socket',(46,-12.5,10.95),4.1,.2,seamwhite,.1)
    lathe('C-stick',(46,-12.5,11),[(3.35,0),(3.6,.7),(3.35,1.7),(.1,1.75)],rubber)
    for name,label,x,y,color in [('triangle','X',55,-21.5,(.005,.085,.40)),('circle','A',63,-29.5,(.55,.009,.018)),('cross','B',55,-37.5,(.82,.44,.009)),('square','Y',47,-29.5,(.006,.26,.12))]:
        m=material('KTR '+label+' pigmented resin',color,.42,0,.06)
        disc('Button '+name+' socket',(x,y,10.95),3.95,.2,seamwhite,.05)
        lathe('Button '+name,(x,y,11),[(3.6,0),(3.7,.45),(3.55,1.2),(3.1,1.5),(.1,1.6)],m)
        text(label+' legend',label,(x,y,12.63),3.55,printwhite)
    for label,y in [('START',-54),('SELECT',-62.2)]:
        disc(label+' socket',(45.3,y,10.95),2.4,.15,seamwhite,.05)
        disc(label+' button',(45.3,y,11.35),2.05,.8,white,.25)
        text(label+' emboss',label,(48.6,y,11.0),1.72,edge,align='LEFT')
    slab('HOME socket',(0,-69.7,12.12),(10.9,5.8,.25),2.85,edge,.08)
    slab('HOME button',(0,-69.7,12.3),(10.1,5.05,.42),2.5,white,.14)
    line('Home house',[(-1.8,-69.3,12.54),(0,-67.7,12.54),(1.8,-69.3,12.54)],.1,INK)
    line('Home walls',[(-1.3,-69.3,12.54),(-1.3,-71.1,12.54),(1.3,-71.1,12.54),(1.3,-69.3,12.54)],.09,INK)
    block('Home door',(0,-70.55,12.55),(.6,.95,.03),edge,.03)
    block('Microphone aperture',(29,-74.6,11.05),(.7,1.05,.25),BLACK,.12)
    text('Microphone legend','MIC',(29,-72.7,11.08),1.5,edge)
    for x,mat,name in [(39,material('Blue power light',(.02,.47,.85),.24),'Power'),(47,seamwhite,'Charge'),(55,material('Amber wireless light',(.8,.24,.012),.3),'Wireless')]:
        slab(name+' light pipe',(x,-75.65,10.5),(1.15,2.1,.9),.2,mat,.1)
    # Real front openings, through the lower shell, with recessed liners.
    slot=block('Card slot cut',(-36,-75.4,3.35),(35,5,4.3),None,.15); cut(base,slot)
    block('Game card cavity',(-36,-74.3,3.35),(34.7,2.3,4.0),BLACK,.15)
    line('Cartridge lip',[(-53,-76.65,1.35),(-19,-76.65,1.35)],.2,METAL)
    hole('Headphone jack',(0,-75.4,4.1),2.4,5,base,BLACK,(PI/2,0,0))
    disc('Headphone collar',(0,-76.48,4.1),2.38,.2,RING,.05,(PI/2,0,0))
    disc('Headphone bore',(0,-76.62,4.1),1.77,.2,BLACK,.02,(PI/2,0,0))
    # Stylus is stored lengthwise in the front of the base.
    disc('Stylus garage',(12,-75.9,2.3),2.15,1,edge,.06,(PI/2,0,0))
    disc('Stylus end cap',(12,-76.24,2.3),1.88,1,white,.2,(PI/2,0,0))
    disc('Power bezel',(39,-76.25,4.15),2.62,.4,edge,.1,(PI/2,0,0))
    disc('Power button',(39,-76.5,4.15),2.23,.4,white,.1,(PI/2,0,0))
    text('Power icon','I',(39,-76.75,4.55),2.5,INK,(PI/2,0,0))
    # Back-edge ports, charging contacts and four shoulder keys.
    port=block('AC socket cut',(0,3.7,4.8),(7.8,5,4.5),None); cut(base,port)
    block('AC port shroud',(0,4.22,4.8),(7.7,.3,4.3),METAL,.6)
    block('AC port opening',(0,4.43,4.8),(6.5,.15,3.25),BLACK,.35)
    block('AC contact tongue',(0,4.56,4.1),(4.4,.15,.75),METAL,.1)
    gold=material('Charging contacts',(.55,.37,.12),.3,.7)
    for x in [-7.2,7.2]: block('Cradle charging contact',(x,4.26,4.35),(1.8,.35,3.3),gold,.45)
    block('Infrared transceiver',(24,4.32,4.7),(9.1,.6,3.5),LENS,.8)
    for x,label,width in [(-63,'L',14),(-46.8,'ZL',9),(46.8,'ZR',9),(63,'R',14)]:
        block(label+' shoulder shadow',(x,2.15,5.1),(width+.5,4.7,5.7),edge,1.2)
        block(label+' shoulder',(x,2.5,5.2),(width,4.6,5.25),white,1.0)
        text(label+' shoulder emboss',label,(x,4.9,5.2),2.6,edge,(PI/2,0,PI))
    for x in [-46,46]: screw('Battery cover screw',x,-8.5,-1.45)
    # Fixed collars and a movable central barrel. The pivot is the real axis.
    for x,w in [(-63.5,15),(63.5,15)]: disc('Fixed hinge collar',(x,0,12.3),4.8,w,white,.25,(0,PI/2,0))
    disc('Notification window',(63,0,17.02),.85,.16,BLACK,.12)
    pivot=bpy.data.objects.new('Lid_Hinge',None); bpy.context.collection.objects.link(pivot)
    pivot.location=(0,0,12.3)
    pivot['open_angle_degrees']=155; pivot['closed_angle_degrees']=0
    PARENT=pivot
    # Components are authored in the open-flat frame, then made pivot-local.
    lid_objects_before=set(bpy.data.objects)
    disc('Moving hinge barrel',(0,0,12.3),4.65,111.7,white,.3,(0,PI/2,0))
    upper=slab('Upper lid chassis',(0,39.8,7.4),(142,73.2,5.6),[9.5,9.5,.8,.8],white,.65)
    slab('Upper cover seam',(0,34.8,4.58),(141.6,62.2,.24),[.8,.8,1,1],seamwhite,.08)
    slab('Upper removable faceplate',(0,34.8,4.54),(141.35,62.0,.68),[.8,.8,1,1],plate,.22)
    top=slab('Upper interior',(0,39.8,10.1),(141.65,73,1.0),[9.2,9.2,.7,.7],white,.35)
    slab('Upper LCD bevel',(0,34.6,10.71),(92.5,58.2,.4),2.3,edge,.18)
    slab('Upper LCD white rim',(0,34.6,10.94),(90.6,56.5,.35),1.65,white,.12)
    slab('Upper glass black gasket',(0,34.6,11.14),(86.35,52.35,.18),.45,BLACK,.08)
    surface('Screen_Primary',(0,34.6,11.26),84.6,50.76,'dynamic_screen')
    camera_lens('Inner camera',0,71.2,10.65,r=2.75)
    camera_lens('Face tracking IR',5.35,71.2,10.63,r=1.28)
    for x in [-29.5,29.5]: disc('Rubber lid stop',(x,71.2,10.8),2.1,.6,plate,.3)
    for x in [-59,59]:
        for dx,dy in [(0,0),(-4,0),(4,0),(0,4),(0,-4)]:
            hole('Speaker perforation',(x+dx,46+dy,10.3),.68,3,top,BLACK)
            cut(upper,disc('Inner speaker bore',(x+dx,46+dy,10.3),.68,3,None,0))
    for x,label in [(-70.7,'VOL.'),(70.7,'3D')]:
        slab(label+' slider track',(x,23,10.65),(1.4,14,.18),.4,edge,.05)
        block(label+' slider',(x,22.5,10.9),(1.9,3.1,1.35),white,.4)
        for dy in [-.7,.7]: block(label+' slider rib',(x,22.5+dy,11.65),(1.95,.25,.25),edge,.08)
        text(label+' legend',label,(x+(-6 if x>0 else 7),24,10.67),2.0,edge)
        text(label+' off','OFF',(x+(-4.8 if x>0 else 4.8),16.5,10.67),1.5,edge)
        line(label+' wedge',[(x*.955,18.5,10.68),(x*.955,29.5,10.68),(x*.927,29.5,10.68)],.09,edge,True)
    # Rear stereo cameras occupy the fixed-width upper strip, outside the plate.
    for x in [-17.5,17.5]: camera_lens('Rear stereo camera',x,71.1,4.32,back=True,r=2.45)
    for obj in set(bpy.data.objects)-lid_objects_before:
        if obj.parent==pivot: obj.location.z-=12.3
    PARENT=None
    pivot.rotation_mode='XYZ'
    for frame,opening in [(1,0),(40,155),(60,155),(100,0)]:
        pivot.rotation_euler.x=math.radians(180-opening)
        pivot.keyframe_insert(data_path='rotation_euler',frame=frame,group='Lid')
    pivot.animation_data.action.name='Lid_OpenClose'
    bpy.context.scene.frame_end=100; bpy.context.scene.frame_set(40)
    return 'new-nintendo-3ds',pivot


def vita_outline(w,h):
    # Elliptical endcaps: a Vita is not a rectangular slab with small fillets.
    rx=35.5*w/183.6; ry=h/2; mid=w/2-rx
    pts=[]
    for center,start in [(mid,-90),(-mid,90)]:
        for i in range(49):
            a=math.radians(start+i*180/48)
            pts.append((center+rx*math.cos(a),ry*math.sin(a)))
    return pts


def vita_shell(name,rings,mat):
    v=[]
    for w,h,z in rings: v += [(x,y,z) for x,y in vita_outline(w,h)]
    n=len(vita_outline(1,1)); f=[tuple(reversed(range(n)))]
    for j in range(len(rings)-1): f += [(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for i in range(n)]
    f.append(tuple(range((len(rings)-1)*n,len(rings)*n)))
    return mesh(name,v,f,mat)


def corner_prism(name,points,low,high,mat=None,bevel=0):
    # Keep the curved cut contour after reflecting to the other three corners.
    if sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1]))<0:
        points=list(reversed(points))
    n=len(points)
    return mesh(name,[(x,y,z) for z in [low,high] for x,y in points],
        [tuple(reversed(range(n))),tuple(range(n,2*n))]+
        [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],mat,bevel)


def vita_corner():
    # The front plate turns inward at each corner, then rejoins the outer rim.
    # This is an inverse-radius cut, not a strip parallel to the endcap ellipse.
    a,b,c,d=Vector((61.5,46)),Vector((63,31.5)),Vector((74,32)),Vector((87,30))
    curve=[]
    for i in range(49):
        t=i/48; p=(1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d
        curve.append(tuple(p))
    def band(gap,outer_inset):
        inside=[]; outside=[]
        for i in range(81):
            x=62+i*.25
            j=next(j for j in range(len(curve)-1) if curve[j][0]<=x<=curve[j+1][0])
            p,q=curve[j],curve[j+1]
            inner=p[1]+(q[1]-p[1])*(x-p[0])/(q[0]-p[0])+gap
            outer=42.55*math.sqrt(1-((x-56.3)/35.5)**2)-outer_inset
            if outer>inner+.15:
                inside.append((x,inner));outside.append((x,outer))
        return outside+list(reversed(inside))
    return curve+[(110,30),(110,60),(55,60)],band


def vita():
    setup()
    shell=material('PCH-2000 charcoal ABS',(.022,.025,.028),.4,0,.16)
    front=material('PCH-2000 front resin',(.012,.014,.017),.46,0,.04)
    glass=material('PCH-2000 glass bezel',(.004,.006,.008),.14,0,.5)
    keys=material('PCH-2000 polished buttons',(.009,.012,.015),.24,0,.35)
    rubber=material('PCH-2000 textured stick rubber',(.032,.034,.035),.79)
    legend=material('PCH-2000 silver legends',(.43,.47,.49),.4,.15)
    trigger=material('PCH-2000 translucent shoulder resin',(.014,.018,.023),.16,0,.45)
    backpad=material('PCH-2000 rear touch panel',(.009,.012,.014),.3,0,.25)
    pattern=material('PCH-2000 touch pattern',(.032,.039,.043),.57)
    base=vita_shell('Rear moulded shell',[(167,73,-7.5),(176,79,-6.5),(181.8,83.5,-3.5),(183.6,85.1,-.5)],shell)
    seam=vita_shell('Perimeter assembly seam',[(183.5,85,-.6),(183.6,85.1,-.2)],BLACK)
    face=vita_shell('Front moulded shell',[(183.6,85.1,-.18),(183.0,84.6,3.3),(180.6,83.4,5.9),(177.8,81.7,7.1)],front)
    notch,corner_band=vita_corner()
    for side,label in [(-1,'L'),(1,'R')]:
        for end in [-1,1]:
            pts=[(side*x,end*y) for x,y in notch]
            cut(face,corner_prism(label+(' lower' if end<0 else ' shoulder')+' inverse radius',pts,-.4,12))
        # Shoulder buttons fill a pocket cut into the body, below the face lip.
        pts=[(side*x,y) for x,y in notch]
        cut(base,corner_prism(label+' shoulder body pocket',pts,-3.2,12))
        cut(seam,corner_prism(label+' shoulder seam clearance',pts,-3.2,12))
        pts=[(side*x,y) for x,y in corner_band(.55,.1)]
        corner_prism(label+' shoulder',pts,-2.75,5.5,trigger,.35)
        text(label+' shoulder legend',label,(side*72.8,36.5,5.53),2.2,legend)
        # The lower corner is open, with a curved outer bridge for the strap.
        # Cut every shell layer so the seam cannot cap the passage in black.
        pts=[(side*x,-y) for x,y in corner_band(.2,1.2)]
        for part in [base,seam]:
            cut(part,corner_prism(label+' lower strap passage',pts,-12,12))
    slab('Continuous central lens',(0,0,7.17),(125.4,81,.28),4.2,glass,.11)
    slab('LCD black border',(0,2.0,7.36),(112.6,64.2,.12),.5,BLACK,.02)
    surface('Screen_Primary',(0,2.0,7.45),110.7,62.75,'dynamic_screen')
    mark('SONY wordmark','Sony_logo',(-50.5,36,7.4),11.7,legend)
    mark('PS VITA wordmark','PlayStation_Vita_logo',(0,-35,7.43),20.1,legend,max_y=145)
    dpad(-75,13.3,7.1,keys,True)
    for kind,x,y in [('triangle',75,21.5),('circle',83.1,13.3),('cross',75,5.1),('square',66.9,13.3)]:
        disc(kind+' socket',(x,y,6.7),3.9,.7,BLACK,.2)
        lathe(kind+' button',(x,y,7),[(3.5,0),(3.7,.7),(3.35,1.5),(.1,1.85)],keys)
        symbol(kind+' symbol',kind,(x,y,8.86),3.1,legend)
    for x in [-69.5,69.5]:
        disc('Stick recessed well',(x,-9.5,7),6.45,.3,BLACK,.2)
        disc('Stick bearing',(x,-9.5,7.3),5.8,.8,RING,.25)
        disc('Stick stem',(x,-9.5,9.1),2.1,3.4,keys,.3)
        lathe('Analog thumb cap',(x,-9.5,10),[(5.3,0),(5.8,.5),(5.75,1.4),(5.25,1.8),(4.3,1.9),(3,1.35),(.1,1.1)],rubber)
        for i in range(48):
            a=i*2*PI/48
            line('Stick grip serration',[(x+5.7*math.cos(a),-9.5+5.7*math.sin(a),10.55),(x+5.68*math.cos(a),-9.5+5.68*math.sin(a),11.15)],.055,BLACK)
    camera_lens('Front camera',66.8,26.8,6.95,r=2.3)
    # The seven speaker perforations form a honeycomb, beneath each grip.
    for x in [-82.8,82.8]:
        for row,n in [(-1,2),(0,3),(1,2)]:
            for col in range(n):
                xx=x+(col-(n-1)/2)*2.05; yy=-10+row*2
                hole('Speaker perforation',(xx,yy,5.7),.69,6,face,BLACK)
    disc('PS button socket',(-70.7,-24.3,6.95),4.35,.35,BLACK,.1)
    disc('PS button',(-70.7,-24.3,7.35),3.75,.9,keys,.28)
    mark('PS key logo','PlayStation_logo',(-70.7,-24.3,7.85),4.5,legend)
    for x,label in [(66.4,'SELECT'),(76,'START')]:
        disc(label+' socket',(x,-24.4,6.86),3.45,.5,BLACK,.15)
        disc(label+' key',(x,-24.4,7.15),2.96,.65,keys,.28)
        text(label+' legend',label,(x,-24.4,7.5),1.03,legend)
    # Top rim controls and game card door.
    block('Top control strip seam',(0,41.9,1.7),(122,1.3,8.6),BLACK,1.1)
    block('Top control strip',(0,42.2,1.7),(121.5,.95,8.1),shell,1)
    for x,label in [(-50,'Power'),(37,'VOL -'),(50,'VOL +')]:
        disc(label+' top recess',(x,42.7,1.9),2.95,.2,BLACK,.08,(PI/2,0,0))
        disc(label+' top key',(x,42.85,1.9),2.6,.35,shell,.18,(PI/2,0,0))
        text(label+' top legend',{'Power':'I','VOL -':'−','VOL +':'+'}[label],(x,43.06,1.9),2.7,legend,(PI/2,0,PI))
    text('Top volume legend','VOL',(43.5,42.83,1.9),1.5,legend,(PI/2,0,PI))
    block('PS Vita card door seam',(0,42.55,1.65),(50.6,.7,7.85),BLACK,.4)
    block('PS Vita card door',(0,42.9,1.65),(49.9,.45,7.2),shell,.3)
    text('Card door mark','PS VITA',(0,43.16,2),3.1,legend,(PI/2,0,PI))
    block('Card door fingernail lip',(0,43.13,-1.55),(4,.2,.45),BLACK,.12)
    for x,col,name in [(-41.5,(.05,.47,.09),'Power'),(-34,(.025,.15,.5),'Notification')]:
        m=material(name+' LED',col,.35)
        block(name+' light',(x,42.76,1.7),(.65,.1,4.3),m,.2)
    # A micro USB port, not the wide PCH-1000 proprietary connector.
    c=block('Micro USB cut',(0,-41.8,-.3),(8.7,6,3.45),None); cut(base,c); c=block('Micro USB front cut',(0,-41.8,-.3),(8.7,6,3.45),None); cut(face,c)
    block('Micro USB shield',(0,-42.45,-.3),(8.6,.5,3.4),METAL,.55)
    block('Micro USB mouth',(0,-42.73,-.3),(7.5,.12,2.45),BLACK,.4)
    block('Micro USB tongue',(0,-42.82,-.45),(5.1,.14,.65),shell,.08)
    for x in [-1.4,-.7,0,.7,1.4]: block('USB contact',(x,-42.9,-.3),(.3,.12,.17),METAL,.02)
    for x,z,r,name in [(24,-.3,2.55,'Headset'),(12,-4.3,.6,'Microphone')]:
        hole(name+' aperture',(x,-41.6,z),r,5,base,BLACK,(PI/2,0,0))
        disc(name+' mouth',(x,-42.55,z),r,.2,BLACK,.05,(PI/2,0,0))
    block('Memory card cover seam',(51,-41.6,-.6),(18,1.1,5.9),BLACK,.5)
    block('Memory card cover',(51,-41.9,-.6),(17.5,.9,5.4),shell,.5)
    block('Memory card cover lip',(51,-42.4,1.5),(12,.15,.8),BLACK,.15)
    for x in [-11,11]:
        disc('USB screw recess',(x,-42.45,1.5),1.75,.2,BLACK,.08,(PI/2,0,0))
        disc('USB screw head',(x,-42.56,1.5),1.2,.15,METAL,.08,(PI/2,0,0))
        for size in [(1.5,.06,.26),(.26,.06,1.5)]: block('USB screw cross',(x,-42.68,1.5),size,BLACK,.02)
    # Rear panel includes the two smooth finger rests and its printed pattern.
    slab('Rear touch perimeter',(0,0,-7.47),(135,59,.25),18,BLACK,.2)
    slab('Rear touch glass',(0,0,-7.65),(132,57,.24),17,backpad,.12)
    for x in [-52,52]:
        o=disc('Rear oval finger rest',(x,0,-7.86),1,.2,shell,.05,vertices=64)
        o.scale.x=12.9; o.scale.y=23
    # Subtle repeating symbols, authored as curves and batched for export.
    for row in range(18):
        for col in range(30):
            x=(col-14.5)*2.35; y=(row-8.5)*2.5
            if abs(x)<6 and abs(y)<5: continue
            shape=['triangle','circle','cross','square'][(row+col)%4]
            # Fine marks use less geometry than the four large front glyphs.
            if shape=='circle': pts=[(x+.38*math.cos(i*PI/4),y+.38*math.sin(i*PI/4),-7.79) for i in range(8)]
            elif shape=='triangle': pts=[(x,y+.4,-7.79),(x-.4,y-.35,-7.79),(x+.4,y-.35,-7.79)]
            elif shape=='cross':
                inkstroke('Rear touch cross 1',[(x-.3,y-.3,-7.79),(x+.3,y+.3,-7.79)],.056,pattern,False)
                inkstroke('Rear touch cross 2',[(x-.3,y+.3,-7.79),(x+.3,y-.3,-7.79)],.056,pattern,False)
                continue
            else: pts=[(x-.3,y-.3,-7.79),(x+.3,y-.3,-7.79),(x+.3,y+.3,-7.79),(x-.3,y+.3,-7.79)]
            inkstroke('Rear touch '+shape,pts,.056,pattern)
    mark('Rear PlayStation logo','PlayStation_logo',(0,0,-7.86),9,legend,back=True)
    slab('Rear camera escutcheon',(0,34,-7.48),(8,4.6,.3),2.2,BLACK,.08)
    camera_lens('Rear camera',0,34,-7.66,back=True,r=1.7)
    for x in [-77,77]:
        for y in [-25,25]:
            cut(base,disc('Screw countersink',(x,y,-7),1.55,6,None,0))
            screw('Rear chassis screw',x,y,-7)
    text('Rear model identification','SONY   PCH-2000   PlayStation Vita',(0,-31.5,-7.58),1.55,legend,(0,PI,0))
    return 'ps-vita-2000',None


def export_model(device,pivot):
    dest=ASSETS/device; dest.mkdir(parents=True,exist_ok=True)
    scene=bpy.context.scene
    scene['source_units']='millimetres'
    scene['reference_manifest']='tools/handheld-models/references.json'
    scene['device_model']='KTR-001' if pivot else 'PCH-2000'
    # Save before batching: the source exposes every manufactured component.
    bpy.ops.wm.save_as_mainfile(filepath=str(dest/(device+'.blend')),compress=True)
    bpy.ops.object.select_all(action='DESELECT')
    objects=[o for o in scene.objects if o.type in {'MESH','CURVE','FONT'}]
    for o in objects:
        bpy.context.view_layer.objects.active=o; o.select_set(True)
        bpy.ops.object.convert(target='MESH')
        for polygon in o.data.polygons:
            if abs(polygon.normal.z)>.99: polygon.use_smooth=False
        o.select_set(False)
    groups=defaultdict(list)
    for o in list(scene.objects):
        if o.type=='MESH':
            # Boolean cut faces can introduce an empty material slot.
            fallback=next((m for m in o.data.materials if m),BLACK)
            for i,m in enumerate(o.data.materials):
                if m is None: o.data.materials[i]=fallback
            groups[(o.parent,tuple(m.name for m in o.data.materials))].append(o)
    for (parent,mats),obs in groups.items():
        if len(obs)<2: continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in obs: o.select_set(True)
        bpy.context.view_layer.objects.active=obs[0]; bpy.ops.object.join()
        obs[0].name=('Lid' if parent else 'Body')+'__'+mats[0]
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(dest/(device+'.glb')),export_format='GLB',
        use_selection=True,export_extras=True,export_animations=True,
        export_animation_mode='ACTIONS',export_frame_range=True,
        export_force_sampling=True,export_yup=True,export_cameras=False,export_lights=False)
    stats={'device':device,'blender':bpy.app.version_string,
           'objects':len([o for o in scene.objects if o.type=='MESH']),
           'triangles':sum(len(p.vertices)-2 for o in scene.objects if o.type=='MESH' for p in o.data.polygons),
           'glb_bytes':(dest/(device+'.glb')).stat().st_size,
           'hinge_node':'Lid_Hinge' if pivot else None}
    (dest/'receipt.json').write_text(json.dumps(stats,indent=2)+'\n')
    print(json.dumps(stats))


def setup_studio():
    QA.mkdir(parents=True,exist_ok=True)
    scene=bpy.context.scene
    scene.render.engine='CYCLES'; scene.cycles.samples=32; scene.cycles.use_denoising=True
    scene.render.resolution_x=1440; scene.render.resolution_y=1100; scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'; scene.render.film_transparent=False
    scene.world=bpy.data.worlds.new('Neutral studio'); scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.75,.78,.82,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.18
    scene.view_settings.view_transform='AgX'
    def area(name,pos,power,size):
        data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.shape='DISK'; data.size=size
        obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); obj.location=pos
        obj.rotation_euler=(Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()
    area('Large softbox',(-110,120,240),650000,170)
    area('Side strip',(170,-20,110),240000,130)
    area('Back softbox',(0,50,-220),500000,150)
    camera=bpy.data.cameras.new('Inspection camera'); obj=bpy.data.objects.new('Inspection camera',camera)
    scene.collection.objects.link(obj); scene.camera=obj; camera.type='ORTHO'; camera.ortho_scale=260
    obj.location=(125,-220,300)
    obj.rotation_euler=(Vector((0,-8,17))-obj.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(QA/'inspection.png')


def render_views(device,pivot):
    scene=bpy.context.scene; obj=scene.camera; camera=obj.data
    views=[('front',(0,0,330),(0,0,0),220),('three-quarter',(135,-190,330),(0,-4,4),228),('rear',(80,140,-300),(0,0,0),220),
           ('right-corners',(140,-20,170),(68,0,0),120)]
    if pivot:
        views=[('open-front',(0,-115,370),(0,-5,8),220),('three-quarter',(125,-220,300),(0,-3,12),260),('rear',(90,160,-280),(0,-5,15),220),
               ('closed',(100,-170,240),(0,-37,8),195),('closed-rear',(-70,130,-180),(0,-37,8),195),('hinge-side',(240,-90,80),(0,-32,10),190)]
    for name,pos,target,scale in views:
        if pivot: scene.frame_set(1 if name in {'closed','closed-rear'} else 40)
        obj.location=pos; obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler(); camera.ortho_scale=scale
        scene.render.filepath=str(QA/(device+'-'+name+'.png'))
        bpy.ops.render.render(write_still=True)


if __name__=='__main__':
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    which=args[0] if args else 'all'
    for key,fn in [('3ds',nintendo),('vita',vita)]:
        if which in {'all',key}:
            name,pivot=fn(); setup_studio(); export_model(name,pivot)
            if '--no-render' not in args: render_views(name,pivot)
