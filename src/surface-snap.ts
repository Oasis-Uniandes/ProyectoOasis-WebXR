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
  Euler,
  Grabbed,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  XRPlane,
} from '@iwsdk/core';

/**
 * Distancia máxima en metros entre la base de un objeto y un plano
 * horizontal para que se active el ajuste automático sobre la superficie.
 * Si el objeto se suelta más lejos de cualquier superficie, se queda flotando.
 */
export const SNAP_DISTANCE_METERS = 0.15;

/** Duración en segundos de la animación de asentado sobre la superficie. */
export const SETTLE_DURATION_SECONDS = 0.3;

/** Tolerancia en metros por debajo del plano (objeto ligeramente hundido). */
const BELOW_TOLERANCE_METERS = 0.05;

/** |Y| mínima de la normal mundial para considerar un plano horizontal. */
const MIN_HORIZONTAL_NORMAL_Y = 0.7;

/** Estado de una animación de asentado (posición y rotación locales). */
interface SettleAnimation {
  active: boolean;
  elapsed: number;
  startPos: Vector3;
  targetPos: Vector3;
  startQuat: Quaternion;
  targetQuat: Quaternion;
}

export class SurfaceSnapSystem extends createSystem({
  grabbedEntities: { required: [Grabbed] },
  planeEntities: { required: [XRPlane] },
}) {
  /** Objetos soltados en este frame; se procesan en el siguiente update(). */
  private pendingRelease = new Set<Entity>();
  /** Una animación reutilizable por entidad (se crea solo la primera vez). */
  private animations = new Map<Entity, SettleAnimation>();

  private tempBox = new Box3();
  private tempWorldPos = new Vector3();
  private tempLocalPos = new Vector3();
  private tempTarget = new Vector3();
  private tempPlaneNormal = new Vector3();
  private tempPlaneQuat = new Quaternion();
  private tempWorldQuat = new Quaternion();
  private tempParentQuat = new Quaternion();
  private tempUprightQuat = new Quaternion();
  private tempEuler = new Euler(0, 0, 0, 'YXZ');
  private invPlaneMatrix = new Matrix4();

  init(): void {
    // Al soltar (deja de tener Grabbed) se encola; se evalúa en el siguiente
    // frame para que GrabSystem ya no vuelva a escribir la pose de la mano.
    this.cleanupFuncs.push(
      this.queries.grabbedEntities.subscribe('disqualify', (entity) => {
        if (entity.active) this.pendingRelease.add(entity);
      }),
      // Si se vuelve a agarrar durante la animación, se cancela.
      this.queries.grabbedEntities.subscribe('qualify', (entity) => {
        this.pendingRelease.delete(entity);
        const anim = this.animations.get(entity);
        if (anim) anim.active = false;
      }),
    );
  }

  update(delta: number): void {
    for (const entity of this.pendingRelease) {
      if (entity.active && !entity.hasComponent(Grabbed)) {
        this.startSettleOnSurfaceBelow(entity);
      }
    }
    this.pendingRelease.clear();

    for (const [entity, anim] of this.animations) {
      if (!anim.active) continue;
      const obj = entity.object3D;
      if (!entity.active || !obj) {
        anim.active = false;
        continue;
      }
      anim.elapsed += delta;
      const t = Math.min(anim.elapsed / SETTLE_DURATION_SECONDS, 1);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cúbico
      obj.position.lerpVectors(anim.startPos, anim.targetPos, eased);
      obj.quaternion.slerpQuaternions(anim.startQuat, anim.targetQuat, eased);
      if (t >= 1) anim.active = false;
    }
  }

  /**
   * Busca el plano horizontal más cercano justo debajo del objeto (dentro de
   * su polígono en X/Z y a menos de SNAP_DISTANCE_METERS) y anima el objeto
   * hasta quedar recto, girado sobre su centro, con la base apoyada en él.
   * Si no hay ninguno, no lo mueve y se queda flotando.
   */
  private startSettleOnSurfaceBelow(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;

    obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(this.tempWorldPos);

    // Rotación recta: se conserva solo el giro horizontal (yaw) del objeto.
    obj.getWorldQuaternion(this.tempWorldQuat);
    this.tempEuler.setFromQuaternion(this.tempWorldQuat, 'YXZ');
    this.tempUprightQuat.setFromAxisAngle(Object3D.DEFAULT_UP, this.tempEuler.y);
    // Pasar la rotación mundial recta a espacio local del padre.
    if (obj.parent) {
      obj.parent.getWorldQuaternion(this.tempParentQuat).invert();
      this.tempUprightQuat.premultiply(this.tempParentQuat);
    }

    // Distancia del centro a la base medida con el objeto YA recto
    // (la caja del objeto inclinado es más alta y lo dejaría flotando).
    const anim = this.getAnimation(entity);
    anim.startQuat.copy(obj.quaternion);
    obj.quaternion.copy(this.tempUprightQuat);
    obj.updateWorldMatrix(false, true);
    this.tempBox.setFromObject(obj);
    obj.quaternion.copy(anim.startQuat);
    obj.updateWorldMatrix(false, true);

    const centreToBase = this.tempWorldPos.y - this.tempBox.min.y;
    const margin =
      Math.max(
        this.tempBox.max.x - this.tempBox.min.x,
        this.tempBox.max.z - this.tempBox.min.z,
      ) * 0.5;

    let bestPlane: Entity | null = null;
    let bestSurfaceDistance = Infinity;

    for (const planeEntity of this.queries.planeEntities.entities) {
      const planeMesh = planeEntity.object3D;
      const nativePlane = planeEntity.getValue(XRPlane, '_plane') as
        | globalThis.XRPlane
        | undefined;
      if (!planeMesh || nativePlane?.orientation !== 'horizontal') continue;

      planeMesh.updateWorldMatrix(true, false);
      // Altura mundial de la superficie del plano
      const planeY = planeMesh.matrixWorld.elements[13];

      // El plano debe ser horizontal en espacio mundial. El signo de la normal
      // no es fiable: el Quest reporta mesas con el eje Y del plano hacia abajo.
      // Los techos se descartan por altura (el objeto queda por debajo).
      planeMesh.getWorldQuaternion(this.tempPlaneQuat);
      this.tempPlaneNormal.set(0, 1, 0).applyQuaternion(this.tempPlaneQuat);
      if (Math.abs(this.tempPlaneNormal.y) < MIN_HORIZONTAL_NORMAL_Y) continue;

      // Centro del objeto en el espacio local del plano para comprobar X/Z
      this.invPlaneMatrix.copy(planeMesh.matrixWorld).invert();
      this.tempLocalPos.copy(this.tempWorldPos).applyMatrix4(this.invPlaneMatrix);

      // Primero X/Z: el objeto debe estar encima del polígono del plano
      if (!this.isOverPolygon(nativePlane, this.tempLocalPos, margin)) continue;

      // Después la altura mundial: base (recta) del objeto sobre la superficie
      const bottomDistance = this.tempWorldPos.y - centreToBase - planeY;
      if (
        bottomDistance < -BELOW_TOLERANCE_METERS ||
        bottomDistance > SNAP_DISTANCE_METERS
      ) {
        continue;
      }

      if (bottomDistance < bestSurfaceDistance) {
        bestSurfaceDistance = bottomDistance;
        bestPlane = planeEntity;
      }
    }

    if (!bestPlane) return;

    // Destino: mismo centro en X/Z, base sobre la altura mundial del plano
    const surfaceY = bestPlane.object3D!.matrixWorld.elements[13];
    this.tempTarget.set(
      this.tempWorldPos.x,
      surfaceY + centreToBase,
      this.tempWorldPos.z,
    );
    if (obj.parent) obj.parent.worldToLocal(this.tempTarget);

    anim.startPos.copy(obj.position);
    anim.targetPos.copy(this.tempTarget);
    anim.targetQuat.copy(this.tempUprightQuat);
    anim.elapsed = 0;
    anim.active = true;
  }

  private getAnimation(entity: Entity): SettleAnimation {
    let anim = this.animations.get(entity);
    if (!anim) {
      anim = {
        active: false,
        elapsed: 0,
        startPos: new Vector3(),
        targetPos: new Vector3(),
        startQuat: new Quaternion(),
        targetQuat: new Quaternion(),
      };
      this.animations.set(entity, anim);
    }
    return anim;
  }

  /** Comprueba si (x, z) local cae dentro de los límites del polígono más un margen. */
  private isOverPolygon(
    plane: globalThis.XRPlane,
    local: Vector3,
    margin: number,
  ): boolean {
    const polygon = plane.polygon;
    if (!polygon || polygon.length === 0) return false;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const pt of polygon) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.z < minZ) minZ = pt.z;
      if (pt.z > maxZ) maxZ = pt.z;
    }
    return (
      local.x >= minX - margin &&
      local.x <= maxX + margin &&
      local.z >= minZ - margin &&
      local.z <= maxZ + margin
    );
  }
}
