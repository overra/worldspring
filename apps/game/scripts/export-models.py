# Headless Blender GLB exporter — run via scripts/export-models.mjs
# (`pnpm --filter @worldspring/game models:export`), NOT directly.
#
# One collection per GLB (apps/game/assets/items.blend holds Items / BuildingKit
# / Props; the `Collection` of camera+lights is ignored). For each, every
# TOP-LEVEL object's location is zeroed before export: the blend lays objects out
# in a grid for authoring, but the runtime fetches each node by name and clones it
# AT ORIGIN — held items positioned by GRIP_TRANSFORMS (CharacterRig.ts), world
# props by placement. Parented children (e.g. the deer's legs, parented to `deer`)
# keep their relative offset, so assemblies stay intact. The .blend on disk is
# never modified (headless, no save). Khronos glTF, +Y up, no Draco/meshopt — the
# conventions CharacterRig.ts documents (node name == ItemType, business-end +Z).
import bpy
import os
import sys

# Args after the `--` separator: [out_dir]
_argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = _argv[0] if _argv else os.path.join("apps", "game", "public", "models")

# Authored collection -> emitted GLB filename.
MANIFEST = {
    "Items": "items.glb",
    "BuildingKit": "building_kit.glb",
    "Props": "props.glb",
}


def export_collection(name: str, out_path: str) -> bool:
    coll = bpy.data.collections.get(name)
    if coll is None:
        print(f"[export-models] ERROR: no collection '{name}' in the blend")
        return False
    # Zero each TOP-LEVEL object's location for the export, then RESTORE it in a
    # finally — so this stays pure: it never leaves the in-memory grid layout
    # mutated, even across the other collections' exports or when run inside an
    # interactive Blender (only `location` is touched; rotation/scale are not).
    saved = {obj: obj.location.copy() for obj in coll.all_objects if obj.parent is None}
    try:
        for obj in saved:
            obj.location = (0.0, 0.0, 0.0)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in coll.all_objects:
            obj.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=out_path,
            export_format="GLB",
            use_selection=True,
            export_yup=True,
        )
    finally:
        for obj, loc in saved.items():
            obj.location = loc
    print(f"[export-models] {name} -> {out_path} ({len(coll.all_objects)} objects)")
    return True


os.makedirs(OUT_DIR, exist_ok=True)
ok = True
for coll_name, fname in MANIFEST.items():
    if not export_collection(coll_name, os.path.join(OUT_DIR, fname)):
        ok = False
sys.exit(0 if ok else 1)
