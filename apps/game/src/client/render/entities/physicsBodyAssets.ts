// App-lifetime geometry/material registry for generic dynamic bodies. The
// barrel is intentionally a closed CylinderGeometry: the intact-body renderer
// and Three Pinata fracture templates share this exact watertight source.

import * as THREE from "three";
import { BARREL_HALF_XZ, BARREL_HALF_Y } from "@worldspring/shared/constants";

export const BODY_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
export const BARREL_GEOMETRY = new THREE.CylinderGeometry(
  BARREL_HALF_XZ,
  BARREL_HALF_XZ,
  BARREL_HALF_Y * 2,
  12,
);

export const CRATE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#8a6b42",
  roughness: 0.85,
});
export const TRUNK_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#5e4426",
  roughness: 0.95,
});
export const BARREL_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#7a6a3e",
  roughness: 0.7,
  metalness: 0.4,
});
export const BARREL_INNER_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#a87843",
  roughness: 0.9,
  metalness: 0.1,
  flatShading: true,
});
