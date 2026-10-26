/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Box3,
  createSystem,
  Entity,
  Grabbed,
  Matrix4,
  OneHandGrabbable,
  Vector3,
  XRPlane,
} from '@iwsdk/core';

/**
 * Distancia máxima en metros entre la base de un objeto y un plano
 * horizontal para que se active el ajuste automático sobre la superficie.
 */
export const SNAP_DISTANCE_METERS = 0.15;

export class SurfaceSnapSystem extends createSystem({
  grabbables: { required: [OneHandGrabbable] },
  grabbedEntities: { required: [OneHandGrabbable, Grabbed] },
  planeEntities: { required: [XRPlane] },
}) {
  private previouslyGrabbed = new Set<Entity>();
  private tempBox = new Box3();
  private tempSize = new Vector3();
  private tempWorldPos = new Vector3();
  private tempPlaneNormal = new Vector3();
  private invPlaneMatrix = new Matrix4();

  init(): void {
    // [DIAG-1] Al soltar un objeto (disqualify de Grabbed), se evalúa si encaja sobre un plano
    this.queries.grabbedEntities.subscribe('disqualify', (entity) => {
      console.log('[SnapDiag] DIAG-1 disqualify event fired for entity index=', entity.index);
      if (entity.active && this.previouslyGrabbed.has(entity)) {
        this.previouslyGrabbed.delete(entity);
        this.snapToNearestHorizontalPlane(entity);
      } else {
        console.log('[SnapDiag] DIAG-1 skip: active=', entity.active, 'inPreviousSet=', this.previouslyGrabbed.has(entity));
      }
    });
  }

  update(): void {
    const currentlyGrabbed = this.queries.grabbedEntities.entities;

    // Detectar entidades que dejaron de estar agarradas en este frame
    for (const entity of this.previouslyGrabbed) {
      if (!currentlyGrabbed.has(entity)) {
        console.log('[SnapDiag] DIAG-1b release detected in update() for entity index=', entity.index);
        this.previouslyGrabbed.delete(entity);
        if (entity.active) {
          this.snapToNearestHorizontalPlane(entity);
        }
      }
    }

    for (const entity of currentlyGrabbed) {
      this.previouslyGrabbed.add(entity);
    }
  }

  /**
   * Evalúa la posición del objeto respecto a los planos horizontales detectados
   * y ajusta su posición y orientación si cumple con la distancia umbral.
   */
  private snapToNearestHorizontalPlane(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) {
      console.log('[SnapDiag] DIAG-3 no object3D on entity');
      return;
    }

    obj.updateWorldMatrix(true, false);

    // Calcular dimensiones del objeto y semialtura cuando está erguido
    this.tempBox.setFromObject(obj);
    this.tempBox.getSize(this.tempSize);
    const halfHeight = this.tempSize.y / 2;

    obj.getWorldPosition(this.tempWorldPos);

    // [DIAG-3] Posición base del objeto
    const objBaseY = this.tempWorldPos.y - halfHeight;
    console.log(
      `[SnapDiag] DIAG-3 object centre worldY=${this.tempWorldPos.y.toFixed(4)} halfH=${halfHeight.toFixed(4)} baseY=${objBaseY.toFixed(4)}`,
    );

    // [DIAG-2] Número de planos detectados
    const planeEntities = [...this.queries.planeEntities.entities];
    console.log(`[SnapDiag] DIAG-2 XRPlane entity count=${planeEntities.length}`);

    let bestPlaneEntity: Entity | null = null;
    let minDistance = Infinity;
    let bestLocalTarget: Vector3 | null = null;

    for (const planeEntity of planeEntities) {
      const planeMesh = planeEntity.object3D;
      if (!planeMesh) {
        console.log('[SnapDiag] DIAG-2 plane has no object3D, skipping');
        continue;
      }

      // [DIAG-2] Altura mundial del plano
      planeMesh.updateWorldMatrix(true, false);
      const planeWorldPos = new Vector3();
      planeMesh.getWorldPosition(planeWorldPos);

      // Obtener el objeto nativo WebXR XRPlane
      const nativePlane = planeEntity.getValue(XRPlane, '_plane') as
        | globalThis.XRPlane
        | undefined;

      const orientation = nativePlane?.orientation ?? '(no nativePlane)';
      console.log(
        `[SnapDiag] DIAG-2 plane index=${planeEntity.index} orientation=${orientation} worldY=${planeWorldPos.y.toFixed(4)} nativePlane=${nativePlane != null}`,
      );

      // Solo planos horizontales
      if (nativePlane?.orientation !== 'horizontal') {
        console.log(`[SnapDiag] DIAG-4 SKIP orientation!='horizontal' (got '${orientation}')`);
        continue;
      }

      // Comprobar que la normal del plano apunta hacia arriba (superficie de apoyo)
      this.tempPlaneNormal.set(0, 1, 0).applyQuaternion(planeMesh.quaternion);
      console.log(`[SnapDiag] DIAG-4 planeNormal.y=${this.tempPlaneNormal.y.toFixed(4)}`);
      if (this.tempPlaneNormal.y < 0.7) {
        console.log('[SnapDiag] DIAG-4 SKIP normal.y < 0.7');
        continue;
      }

      // Convertir la posición del centro del objeto al espacio local del plano
      this.invPlaneMatrix.copy(planeMesh.matrixWorld).invert();
      const localPos = this.tempWorldPos.clone().applyMatrix4(this.invPlaneMatrix);

      // Distancia desde la base del objeto hasta la superficie del plano (y = 0 en local)
      const bottomDistance = localPos.y - halfHeight;
      console.log(
        `[SnapDiag] DIAG-4 localPos.y=${localPos.y.toFixed(4)} bottomDistance=${bottomDistance.toFixed(4)} threshold=[-0.05, ${SNAP_DISTANCE_METERS}]`,
      );

      // Debe estar a menos de SNAP_DISTANCE_METERS (y no excesivamente por debajo del plano)
      if (bottomDistance < -0.05 || bottomDistance > SNAP_DISTANCE_METERS) {
        console.log(`[SnapDiag] DIAG-4 SKIP bottomDistance out of range`);
        continue;
      }

      // Determinar límites del plano usando el polígono nativo de WebXR
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      if (nativePlane.polygon && nativePlane.polygon.length > 0) {
        for (const pt of nativePlane.polygon) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.z < minZ) minZ = pt.z;
          if (pt.z > maxZ) maxZ = pt.z;
        }
        console.log(`[SnapDiag] DIAG-4 polygon bounds x=[${minX.toFixed(3)},${maxX.toFixed(3)}] z=[${minZ.toFixed(3)},${maxZ.toFixed(3)}]`);
      } else {
        console.log('[SnapDiag] DIAG-4 no polygon, using infinite fallback');
        minX = -10; maxX = 10; minZ = -10; maxZ = 10;
      }

      // Margen de tolerancia equivalente al radio horizontal del objeto
      const margin = Math.max(this.tempSize.x, this.tempSize.z) * 0.5;
      const isOverPlane =
        localPos.x >= minX - margin &&
        localPos.x <= maxX + margin &&
        localPos.z >= minZ - margin &&
        localPos.z <= maxZ + margin;

      console.log(
        `[SnapDiag] DIAG-4 localX=${localPos.x.toFixed(3)} localZ=${localPos.z.toFixed(3)} margin=${margin.toFixed(3)} isOverPlane=${isOverPlane}`,
      );

      if (!isOverPlane) {
        console.log('[SnapDiag] DIAG-4 SKIP not over plane polygon');
        continue;
      }

      const absDist = Math.abs(bottomDistance);
      if (absDist < minDistance) {
        minDistance = absDist;
        bestPlaneEntity = planeEntity;
        // La base toca la superficie (y = 0), por lo que el centro queda a halfHeight
        bestLocalTarget = new Vector3(localPos.x, halfHeight, localPos.z);
      }
    }

    // [DIAG-4] Decisión final
    if (bestPlaneEntity && bestLocalTarget) {
      console.log(`[SnapDiag] DIAG-4 SNAP → snapping to plane, dist=${minDistance.toFixed(4)}`);
      const planeMesh = bestPlaneEntity.object3D!;
      // Convertir posición local de destino a coordenadas de mundo
      const targetWorldPos = bestLocalTarget.applyMatrix4(planeMesh.matrixWorld);

      // Colocar derecho (rotación erguida con normal hacia arriba)
      obj.quaternion.set(0, 0, 0, 1);
      obj.rotation.set(0, 0, 0);

      // Ajustar posición para que la base descanse sobre la superficie
      if (obj.parent) {
        obj.parent.worldToLocal(targetWorldPos);
        obj.position.copy(targetWorldPos);
      } else {
        obj.position.copy(targetWorldPos);
      }

      obj.updateMatrixWorld(true);
    } else {
      console.log('[SnapDiag] DIAG-4 NO SNAP → no suitable plane found');
    }
  }
}
