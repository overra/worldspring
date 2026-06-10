# Character Model Licenses

Both models are CC0 (Creative Commons Zero, public domain). No attribution required;
credit to Kay Lousberg (www.kaylousberg.com) is appreciated but optional.

## survivor.glb

- **Source asset:** "Knight" from *KayKit : Adventurers Character Pack (1.0)*
- **Author:** Kay Lousberg (www.kaylousberg.com)
- **License:** CC0 1.0 — http://creativecommons.org/publicdomain/zero/1.0/
- **Source URL:** https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
  (file: `addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb`)
- **Modifications:** removed the bundled weapon/shield prop meshes attached to the
  hand slots (the game attaches its own weapons), pruned the animation library from
  76 to 35 game-relevant clips, removed baked animation channels on non-deforming
  IK helper bones, resampled/deduped, meshopt-compressed
  (EXT_meshopt_compression + KHR_mesh_quantization).

## zombie.glb

- **Source asset:** "Skeleton_Minion" from *KayKit Character Pack : Skeletons (1.0)*
- **Author:** Kay Lousberg (www.kaylousberg.com)
- **License:** CC0 1.0 — http://creativecommons.org/publicdomain/zero/1.0/
- **Source URL:** https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0
  (file: `addons/kaykit_character_pack_skeletons/Characters/gltf/Skeleton_Minion.glb`)
- **Modifications:** pruned the animation library from 95 to 27 game-relevant clips,
  removed baked animation channels on non-deforming IK helper bones,
  resampled/deduped, meshopt-compressed
  (EXT_meshopt_compression + KHR_mesh_quantization).

Both characters share the same KayKit universal 41-joint rig (identical bone names),
so animation clips are interchangeable between them.
