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

## EZ-Tree and Three Pinata

- `trees.glb` is generated with `@dgreenheck/ez-tree` 1.1.0.
- Cosmetic barrel-fracture geometry is generated at runtime with
  `@dgreenheck/three-pinata` 2.0.1.
- Source: https://github.com/dgreenheck/ez-tree and
  https://github.com/dgreenheck/three-pinata
- License: MIT. EZ-Tree copyright (c) 2024 Daniel Greenheck; Three Pinata
  copyright (c) 2023 Daniel Greenheck.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
