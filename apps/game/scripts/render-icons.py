# Headless Blender item-icon renderer — run via scripts/render-icons.mjs
# (`pnpm --filter @worldspring/game models:icons`), NOT directly.
#
# Renders each inventory item from apps/game/assets/items.blend to a 128x128
# transparent PNG in apps/game/public/icons/<ItemType>.png — the 2D icons the
# HUD shows (HUD.tsx loads `/icons/<type>.png`, falling back to a color swatch
# when absent). Each icon is the SAME low-poly mesh the 3D renderer uses
# (items.glb), shot from the authoring camera's angle, so icons and in-world
# models stay visually identical.
#
# Rig (matches the look of the original hand-authored icons): orthographic
# camera framing each item from a fixed world direction (+X,-Y,+Z, ~42 deg
# elevation), one key sun from the upper-front plus a soft world-ambient fill,
# EEVEE, AgX view transform, transparent film. The .blend on disk is never
# modified (headless, no save) — the rig is built in-memory each run.
#
# Canteen variants (empty/dirty/clean) share the single `canteen` mesh, so the
# canteen render is copied to all three filenames (water state is conveyed by
# the item name + UI swatch, not the canvas). pistol_v2 / canteen_cap are not
# inventory items and are skipped.
import bpy
import os
import shutil
import sys
from mathutils import Vector

_argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = _argv[0] if _argv else os.path.join("apps", "game", "public", "icons")
# Optional allow-list of ItemType names after the out dir; empty = render all.
ONLY = set(_argv[1:])

# Every ItemType -> the items.glb / items.blend node it renders from. Mirrors
# ITEM_DEFS in packages/shared/src/items.ts; the three canteen states map to the
# single `canteen` mesh.
ITEM_NODE = {
    "beans": "beans", "water_bottle": "water_bottle", "bandage": "bandage",
    "pistol": "pistol", "rifle": "rifle", "shotgun": "shotgun",
    "ammo_9mm": "ammo_9mm", "ammo_762": "ammo_762", "shells": "shells",
    "axe": "axe", "campfire_kit": "campfire_kit", "flashlight": "flashlight",
    "raw_venison": "raw_venison", "cooked_venison": "cooked_venison",
    "wood": "wood", "cloth": "cloth", "scrap": "scrap", "rope": "rope",
    "deer_pelt": "deer_pelt", "knife": "knife", "fishing_rod": "fishing_rod",
    "raw_fish": "raw_fish", "cooked_fish": "cooked_fish",
    "canteen_empty": "canteen", "canteen_dirty": "canteen", "canteen_clean": "canteen",
    "torch": "torch", "first_aid_kit": "first_aid_kit",
    "padded_jacket": "padded_jacket", "backpack": "backpack", "map": "map",
}

# Item -> camera direction (item -> camera). Authoring-camera angle.
VIEW_DIR = Vector((4.07, -5.53, 6.2)).normalized()
# Sun travels FROM here toward the item (high front-left key).
SUN_DIR = Vector((0.35, 0.55, -1.0)).normalized()
RES = 128
MARGIN = 1.18  # ortho framing slack around the item's bounding sphere


def build_rig():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = True
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"

    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.32, 0.34, 0.38, 1.0)
        bg.inputs[1].default_value = 0.42

    cam_data = bpy.data.cameras.new("IconCamData")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("IconCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    sun_data = bpy.data.lights.new("IconSunData", "SUN")
    sun_data.energy = 2.3
    sun_data.angle = 0.14  # ~8 deg soft shadow
    sun = bpy.data.objects.new("IconSun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (-SUN_DIR).to_track_quat("Z", "Y").to_euler()
    return scene, cam, cam_data


def renderable_objects():
    objs = []
    for cn in ("Items", "Props", "BuildingKit"):
        c = bpy.data.collections.get(cn)
        if c:
            objs += list(c.all_objects)
    return objs


def world_bounds(obj):
    pts = []
    for o in [obj] + list(obj.children_recursive):
        if o.type != "MESH":
            continue
        for corner in o.bound_box:
            pts.append(o.matrix_world @ Vector(corner))
    mn = Vector((min(p[i] for p in pts) for i in range(3)))
    mx = Vector((max(p[i] for p in pts) for i in range(3)))
    return mn, mx


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    scene, cam, cam_data = build_rig()
    all_objs = renderable_objects()

    # Render each distinct source node once, then fan out to its ItemType names
    # (so the shared `canteen` mesh renders a single time).
    node_to_names = {}
    for item, node in ITEM_NODE.items():
        if ONLY and item not in ONLY:
            continue
        node_to_names.setdefault(node, []).append(item)

    rendered = []
    for node_name, names in node_to_names.items():
        target = bpy.data.objects.get(node_name)
        if target is None:
            print(f"[render-icons] WARNING: no node '{node_name}' in items.blend — skipped")
            continue
        keep = set([target] + list(target.children_recursive))
        for o in all_objs:
            o.hide_render = o not in keep
        mn, mx = world_bounds(target)
        center = (mn + mx) * 0.5
        radius = (mx - mn).length * 0.5
        cam.location = center + VIEW_DIR * (radius * 6 + 1.0)
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam_data.ortho_scale = radius * 2 * MARGIN

        first = os.path.join(OUT_DIR, f"{names[0]}.png")
        scene.render.filepath = first
        bpy.ops.render.render(write_still=True)
        rendered.append(names[0])
        for extra in names[1:]:
            shutil.copyfile(first, os.path.join(OUT_DIR, f"{extra}.png"))
            rendered.append(extra)
        for o in all_objs:
            o.hide_render = False

    print(f"[render-icons] {len(rendered)} icons -> {OUT_DIR}")
    print(f"[render-icons] {', '.join(sorted(rendered))}")


main()
