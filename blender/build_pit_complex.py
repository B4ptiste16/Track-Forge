"""
F1-style pit complex for AC BAPTOU, modelled in Blender and exported for the app.

Run headless (no UI needed):
  blender.exe -b --factory-startup --python blender/build_pit_complex.py -- <repo> [<render-dir>]

Writes:
  <repo>/src/data/pitModels.json   geometry the app instances along the pit lane
  <repo>/blender/pit_complex.blend the models, plus an example paddock layout
  <render-dir>/*.png               preview renders (optional)

MODEL FRAME (all three models): +X runs along the pit lane, +Y points AWAY from
the track, +Z is up. Origin centred in X, Y=0 is the face that looks toward the
track, Z=0 is the ground.

Every part is a CLOSED box (or cylinder) with outward faces. Assetto Corsa
culls back faces, so a wall built as a single plane is invisible from one side
- that is why the old garages showed the grass straight through them.

Material names ARE the app's mesh names. TEAM is a placeholder: the app swaps it
for DECOR_TEAM1..8 per team, because a KN5 carries no vertex colour and team
colours therefore need their own materials. UVs are computed by the app in
world space, so Blender only supplies shape and material.
"""
import bmesh
import bpy
import json
import math
import os
import sys

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
REPO = argv[0] if argv else os.getcwd()
RENDERS = argv[1] if len(argv) > 1 else None

GARAGE_W = 14.0     # nominal unit width; the app scales X to the box spacing
GARAGE_D = 10.0     # must equal GARAGE_DEPTH in src/geometry/pitlane.ts

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'

# Preview colours only - the app textures these materials itself.
PREVIEW = {
    'DECOR_PITBLDG': (0.86, 0.87, 0.88, 1), 'DECOR_PITGLASS': (0.14, 0.22, 0.30, 1),
    'DECOR_PITFLOOR': (0.60, 0.61, 0.63, 1), 'DECOR_PITINT': (0.94, 0.94, 0.94, 1),
    'DECOR_STEEL': (0.40, 0.43, 0.48, 1), 'DECOR_ROOF': (0.28, 0.29, 0.31, 1),
    'DECOR_GARAGE': (0.24, 0.26, 0.29, 1), 'DECOR_LAMP': (1.0, 0.97, 0.85, 1),
    'TEAM': (0.42, 0.30, 0.92, 1), 'DECOR_CHASSIS': (0.06, 0.06, 0.07, 1),
}
_mats = {}


def mat(name):
    if name not in _mats:
        m = bpy.data.materials.new(name)
        m.diffuse_color = PREVIEW[name]
        _mats[name] = m
    return _mats[name]


def model(name):
    coll = bpy.data.collections.new(name)
    scene.collection.children.link(coll)
    return coll


def box(coll, material, x0, x1, y0, y1, z0, z1):
    """Closed axis-aligned box, faces wound outward."""
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
    me = bpy.data.meshes.new(material)
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]]
    for f in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
        bm.faces.new([vs[i] for i in f])
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat(material))
    ob = bpy.data.objects.new(material, me)
    coll.objects.link(ob)
    return ob


def wheel(coll, x, y, r=0.5, w=0.32):
    """Closed cylinder, axle along Y."""
    me = bpy.data.meshes.new('wheel')
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=14, radius1=r, radius2=r, depth=w)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, r))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat('DECOR_CHASSIS'))
    ob = bpy.data.objects.new('wheel', me)
    coll.objects.link(ob)


def mirror_x(fn):
    for s in (-1, 1):
        fn(s)


# =====================================================================
# GARAGE UNIT - one per pit box.  x in [-7, 7], y in [0, 10]
#   ground floor   the garage: open front, epoxy floor, lit ceiling, workbenches,
#                  tyre rack, team branding on the back wall, rear roller door
#   first floor    team suites, full-height glazing behind a balcony
#   second floor   media / hospitality, set further back behind a terrace
#   roof           a cantilevered canopy reaching out over the pit lane
# =====================================================================
g = model('garage')
H = GARAGE_W / 2

# ---- ground floor: the garage itself (z 0..5)
box(g, 'DECOR_PITFLOOR', -6.85, 6.85, 0.0, 9.7, 0.0, 0.05)
mirror_x(lambda s: box(g, 'DECOR_PITINT', s * 6.85, s * 6.92, 0.4, 9.7, 0.0, 5.0))    # wall, inside skin
mirror_x(lambda s: box(g, 'DECOR_PITBLDG', s * 6.92, s * H, 0.0, GARAGE_D, 0.0, 5.0))  # wall, outside skin
mirror_x(lambda s: box(g, 'DECOR_PITBLDG', s * 6.2, s * 6.92, 0.0, 0.4, 0.0, 5.0))    # front piers
box(g, 'TEAM', -6.2, 6.2, 0.0, 0.4, 4.2, 5.0)                                     # team fascia board
box(g, 'DECOR_GARAGE', -6.2, 6.2, 0.4, 0.85, 3.75, 4.2)                           # shutter, rolled up
box(g, 'DECOR_PITINT', -6.85, 6.85, 0.4, 9.7, 4.5, 4.6)                           # ceiling
for y in (2.4, 4.9, 7.4):                                                          # strip lights
    box(g, 'DECOR_LAMP', -5.2, 5.2, y, y + 0.16, 4.42, 4.5)
# back wall with a rear roller door at x 3.0..6.2
for x0, x1, z0, z1 in ((-6.85, 3.0, 0.0, 5.0), (6.2, 6.85, 0.0, 5.0), (3.0, 6.2, 4.0, 5.0)):
    box(g, 'DECOR_PITINT', x0, x1, 9.7, 9.78, z0, z1)
    box(g, 'DECOR_PITBLDG', x0, x1, 9.78, GARAGE_D, z0, z1)
box(g, 'DECOR_GARAGE', 3.0, 6.2, 9.8, 9.92, 0.0, 4.0)                             # rear door, closed
box(g, 'TEAM', -6.0, 2.4, 9.62, 9.7, 1.0, 3.6)                                    # team graphic inside
box(g, 'DECOR_STEEL', -6.85, -6.05, 1.5, 4.5, 0.0, 0.95)                          # workbenches
box(g, 'DECOR_STEEL', -6.85, -6.05, 5.2, 8.6, 0.0, 0.95)
box(g, 'DECOR_CHASSIS', 6.15, 6.85, 4.2, 8.6, 0.0, 1.25)                          # tyre rack, against the wall

# ---- first floor: team suites (z 5..9)
box(g, 'DECOR_PITBLDG', -H, H, -1.0, GARAGE_D, 5.0, 5.4)                          # slab + balcony
box(g, 'DECOR_PITGLASS', -6.95, 6.95, 0.35, 0.45, 5.4, 9.0)                       # glazing
mirror_x(lambda s: box(g, 'DECOR_STEEL', s * 6.95, s * H, -0.05, 0.5, 5.4, 9.0))     # mullion fins
box(g, 'DECOR_PITGLASS', -H, H, -1.0, -0.94, 5.4, 6.5)                            # glass balustrade
mirror_x(lambda s: box(g, 'DECOR_PITBLDG', s * 6.85, s * H, 0.45, 9.7, 5.4, 9.0))
box(g, 'DECOR_PITBLDG', -H, H, 9.7, GARAGE_D, 5.4, 6.4)                           # back: wall,
box(g, 'DECOR_PITGLASS', -6.85, 6.85, 9.8, 9.9, 6.4, 8.4)                         #   window band,
box(g, 'DECOR_PITBLDG', -H, H, 9.7, GARAGE_D, 8.4, 9.0)                           #   wall

# ---- second floor: media / hospitality, set back behind a terrace (z 9..12.5)
box(g, 'DECOR_PITBLDG', -H, H, -1.0, GARAGE_D, 9.0, 9.4)
box(g, 'DECOR_PITGLASS', -6.95, 6.95, 1.15, 1.25, 9.4, 12.5)
mirror_x(lambda s: box(g, 'DECOR_STEEL', s * 6.95, s * H, 1.1, 1.3, 9.4, 12.5))
box(g, 'DECOR_PITGLASS', -H, H, -1.0, -0.94, 9.4, 10.5)
mirror_x(lambda s: box(g, 'DECOR_PITBLDG', s * 6.85, s * H, 1.25, 9.7, 9.4, 12.5))
box(g, 'DECOR_PITBLDG', -H, H, 9.7, GARAGE_D, 9.4, 10.2)
box(g, 'DECOR_PITGLASS', -6.85, 6.85, 9.8, 9.9, 10.2, 12.0)
box(g, 'DECOR_PITBLDG', -H, H, 9.7, GARAGE_D, 12.0, 12.5)

# ---- roof: canopy cantilevered 3.5 m out over the pit lane
box(g, 'DECOR_PITBLDG', -H, H, -3.5, 10.2, 12.5, 12.75)                           # white soffit
box(g, 'DECOR_ROOF', -H, H, -3.5, 10.2, 12.75, 12.95)                             # membrane
box(g, 'DECOR_STEEL', -H, H, -3.7, -3.5, 12.35, 13.05)                            # edge beam

# =====================================================================
# MOTORHOME - one per team, in the paddock facing the garages.
#   x in [-8.2, 8.2], y in [-1.6, 10.6]: a glass ground floor, a team-clad
#   upper floor with a window band, and a roof terrace under a team canopy
# =====================================================================
mh = model('motorhome')
box(mh, 'DECOR_PITFLOOR', -8.2, 8.2, -0.6, 10.6, 0.0, 0.15)                       # deck
box(mh, 'DECOR_PITGLASS', -7.4, 7.4, 0.8, 9.2, 0.15, 3.6)                         # glass ground floor
box(mh, 'DECOR_PITBLDG', -8.1, 8.1, -0.1, 10.1, 3.6, 4.0)                         # slab
box(mh, 'DECOR_PITGLASS', -7.95, 7.95, 0.05, 9.95, 4.0, 7.4)                      # upper floor glass
box(mh, 'TEAM', -8.05, 8.05, 0.0, 10.0, 4.0, 4.8)                                 # team band, lower
box(mh, 'TEAM', -8.05, 8.05, 0.0, 10.0, 6.6, 7.4)                                 # team band, upper
box(mh, 'DECOR_PITBLDG', -8.2, 8.2, -0.2, 10.2, 7.4, 7.75)                        # roof slab
for args in ((-8.2, 8.2, -0.2, -0.14), (-8.2, 8.2, 10.14, 10.2), (-8.2, -8.14, -0.2, 10.2), (8.14, 8.2, -0.2, 10.2)):
    box(mh, 'DECOR_PITGLASS', *args, 7.75, 8.8)                                   # terrace balustrade
for x in (-5.8, 5.8):
    for y in (2.6, 9.4):
        box(mh, 'DECOR_STEEL', x - 0.08, x + 0.08, y - 0.08, y + 0.08, 7.75, 10.0)
box(mh, 'TEAM', -6.2, 6.2, 2.2, 9.8, 10.0, 10.3)                                  # terrace canopy
box(mh, 'DECOR_STEEL', -1.8, 1.8, -1.6, 0.8, 3.0, 3.2)                            # entrance canopy
mirror_x(lambda s: box(mh, 'DECOR_STEEL', s * 1.5, s * 1.65, -1.5, -1.35, 0.15, 3.0))

# =====================================================================
# TRANSPORTER - one per team, parked behind its garages.
#   x in [-8.0, 8.45], y in [-1.27, 1.27]
# =====================================================================
tr = model('transporter')
box(tr, 'TEAM', -8.0, 5.6, -1.25, 1.25, 1.15, 4.0)                                # trailer
box(tr, 'DECOR_CHASSIS', -8.0, 5.6, -1.0, 1.0, 0.95, 1.15)
box(tr, 'TEAM', 5.8, 8.3, -1.25, 1.25, 1.0, 3.75)                                 # cab
box(tr, 'DECOR_PITGLASS', 8.3, 8.33, -1.15, 1.15, 2.25, 3.4)                      # windscreen
mirror_x(lambda s: box(tr, 'DECOR_PITGLASS', 6.9, 8.1, s * 1.25, s * 1.27, 2.4, 3.3))
box(tr, 'DECOR_CHASSIS', 8.3, 8.45, -1.22, 1.22, 0.45, 1.15)                      # bumper
box(tr, 'DECOR_CHASSIS', 5.6, 8.3, -1.0, 1.0, 0.7, 1.0)
for x in (-6.6, -5.3, -4.0, 6.1, 7.5):
    for y in (-1.06, 1.06):
        wheel(tr, x, y)


# =====================================================================
# EXPORT
# =====================================================================
def export(coll):
    v, t, tm = [], [], []
    for ob in coll.objects:
        me = ob.data
        mw = ob.matrix_world
        for poly in me.polygons:
            name = me.materials[poly.material_index].name
            idx = []
            for li in poly.loop_indices:
                co = mw @ me.vertices[me.loops[li].vertex_index].co
                idx.append(len(v))
                v.append([round(co.x, 4), round(co.y, 4), round(co.z, 4)])
            for k in range(1, len(idx) - 1):          # fan: keeps the outward winding
                t.append([idx[0], idx[k], idx[k + 1]])
                tm.append(name)
    lo = [min(p[i] for p in v) for i in range(3)]
    hi = [max(p[i] for p in v) for i in range(3)]
    return {'v': v, 't': t, 'tm': tm, 'min': lo, 'max': hi}


out = {'garageWidth': GARAGE_W, 'garageDepth': GARAGE_D}
for c in (g, mh, tr):
    out[c.name] = export(c)
with open(os.path.join(REPO, 'src', 'data', 'pitModels.json'), 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print('EXPORT', {k: (len(out[k]['v']), len(out[k]['t'])) for k in ('garage', 'motorhome', 'transporter')})

# =====================================================================
# EXAMPLE LAYOUT + PREVIEW RENDERS
#   four garages on the lane, and behind them the paddock as the app lays it
#   out: transporters, the paddock street, then the motorhomes facing back
# =====================================================================
layout = bpy.data.collections.new('example_layout')
scene.collection.children.link(layout)
for c in (g, mh, tr):
    scene.view_layers[0].layer_collection.children[c.name].exclude = True


def place(src, x, y, rot=0.0):
    e = bpy.data.objects.new(src.name + '_inst', None)
    e.instance_type = 'COLLECTION'
    e.instance_collection = src
    e.location = (x, y, 0)
    e.rotation_euler = (0, 0, rot)
    layout.objects.link(e)


for i in range(4):
    place(g, -21 + i * GARAGE_W, 0)
for team in range(2):
    cx = -14 + team * 28
    place(tr, cx, GARAGE_D + 3.0)
    place(mh, cx, GARAGE_D + 11.5)

ground = box(layout, 'DECOR_PITFLOOR', -45, 45, -30, 40, -0.06, -0.01)
lane = box(layout, 'DECOR_CHASSIS', -45, 45, -8, 0, -0.01, 0.0)

if RENDERS:
    os.makedirs(RENDERS, exist_ok=True)
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_shadows = True
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    scene.render.resolution_x, scene.render.resolution_y = 1400, 800
    scene.world = bpy.data.worlds.new('w')
    scene.world.color = (0.62, 0.72, 0.85)
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 28
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = bpy.data.objects.new('target', None)
    scene.collection.objects.link(target)
    con = cam.constraints.new('TRACK_TO')
    con.target = target
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    shots = {
        'from_pitlane': ((-26, -34, 9), (2, 6, 6)),
        'garage_closeup': ((-3, -11, 2.6), (1, 6, 2.6)),
        'paddock': ((30, 52, 16), (-4, 14, 3)),
        'aerial': ((-50, -40, 45), (0, 10, 0)),
    }
    for name, (loc, look) in shots.items():
        cam.location = loc
        target.location = look
        scene.render.filepath = os.path.join(RENDERS, f'{name}.png')
        bpy.ops.render.render(write_still=True)
    print('RENDERED', list(shots))

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REPO, 'blender', 'pit_complex.blend'))
print('SAVED blend')
