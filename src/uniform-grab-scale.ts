/**
 * Escalado uniforme al agarrar con dos manos.
 *
 * GrabSystem escala cada eje por separado: al separar las manos el objeto se
 * estira solo a lo largo de la línea entre ellas. Este sistema, que corre
 * después de GrabSystem, toma el eje que más ha cambiado respecto a la escala
 * del inicio del agarre y aplica ese mismo factor a los tres ejes.
 */

import {
  createSystem,
  Entity,
  Grabbed,
  TwoHandsGrabbable,
  Vector3,
} from '@iwsdk/core';

export class UniformGrabScaleSystem extends createSystem({
  held: { required: [TwoHandsGrabbable, Grabbed] },
}) {
  /** Escala de cada objeto al empezar el agarre (un Vector3 por entidad). */
  private startScales = new Map<Entity, Vector3>();

  init(): void {
    this.cleanupFuncs.push(
      this.queries.held.subscribe('qualify', (entity) => {
        const obj = entity.object3D;
        if (!obj) return;
        let start = this.startScales.get(entity);
        if (!start) {
          start = new Vector3();
          this.startScales.set(entity, start);
        }
        start.copy(obj.scale);
      }),
    );
  }

  update(): void {
    for (const entity of this.queries.held.entities) {
      const obj = entity.object3D;
      const start = this.startScales.get(entity);
      if (!obj || !start) continue;

      // Factor del eje que más se ha alejado de su escala inicial
      let factor = 1;
      let maxDeviation = 0;
      for (let axis = 0; axis < 3; axis++) {
        const initial = start.getComponent(axis);
        if (initial === 0) continue;
        const ratio = obj.scale.getComponent(axis) / initial;
        const deviation = Math.abs(Math.log(ratio));
        if (deviation > maxDeviation) {
          maxDeviation = deviation;
          factor = ratio;
        }
      }
      obj.scale.copy(start).multiplyScalar(factor);
    }
  }
}
