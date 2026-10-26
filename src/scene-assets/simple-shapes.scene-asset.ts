/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  SphereGeometry,
  createSceneMaterial,
} from '@iwsdk/core';

const cubeMaterial = createSceneMaterial({
  id: 'simple-cube-material',
  model: 'standard',
  baseColor: '#E63946',
  roughness: 0.35,
  metalness: 0.1,
});

const sphereMaterial = createSceneMaterial({
  id: 'simple-sphere-material',
  model: 'standard',
  baseColor: '#2A9D8F',
  roughness: 0.25,
  metalness: 0.15,
});

const cylinderMaterial = createSceneMaterial({
  id: 'simple-cylinder-material',
  model: 'standard',
  baseColor: '#E76F51',
  roughness: 0.3,
  metalness: 0.2,
});

/** 10 cm Cube */
export function createSimpleCube(): Mesh {
  const geometry = new BoxGeometry(0.1, 0.1, 0.1);
  return new Mesh(geometry, cubeMaterial);
}

/** 10 cm diameter Sphere (radius 0.05 m) */
export function createSimpleSphere(): Mesh {
  const geometry = new SphereGeometry(0.05, 32, 16);
  return new Mesh(geometry, sphereMaterial);
}

/** 10 cm height, 10 cm diameter Cylinder (radius 0.05 m, height 0.1 m) */
export function createSimpleCylinder(): Mesh {
  const geometry = new CylinderGeometry(0.05, 0.05, 0.1, 32);
  return new Mesh(geometry, cylinderMaterial);
}
