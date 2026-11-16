/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import './grab-rotation-fix.js';
import { SurfaceSnapSystem } from './surface-snap.js';
import { UniformGrabScaleSystem } from './uniform-grab-scale.js';
import { RemoteEditSystem } from './remote-edit-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(UniformGrabScaleSystem);
  world.registerSystem(SurfaceSnapSystem);
  world.registerSystem(RemoteEditSystem);
});
