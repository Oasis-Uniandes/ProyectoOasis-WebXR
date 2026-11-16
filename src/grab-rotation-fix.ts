/**
 * Corrige el punto de agarre al rotar un objeto agarrado de cerca.
 *
 * `@pmndrs/pointer-events` (6.6.x), en `SphereIntersector.intersectPointerCapture`,
 * rota el desfase mundial puntero→punto de agarre con `q_old⁻¹ · q_new`. Para
 * un vector en espacio mundial la rotación delta correcta es `q_new · q_old⁻¹`.
 * Con la mano girada al empezar el agarre, el punto calculado se separa del real
 * y el objeto "resbala" bajo los dedos al rotar la muñeca (medido: 4.5 cm con la
 * palma a 7 cm del objeto y un giro de 60°).
 *
 * Este módulo envuelve el método una sola vez y recalcula `point` con el orden
 * correcto. Borrar cuando la dependencia lo corrija.
 */

import { Quaternion, Vector3 } from '@iwsdk/core';
import { SphereIntersector } from '@pmndrs/pointer-events';

type Capture = Parameters<SphereIntersector['intersectPointerCapture']>[0];
type CaptureIntersection = Capture['intersection'];

interface SphereIntersectorInternals {
  fromPosition: Vector3;
  fromQuaternion: Quaternion;
}

const offset = new Vector3();
const deltaQuat = new Quaternion();
const oldQuatInverse = new Quaternion();

const proto = SphereIntersector.prototype as SphereIntersector & {
  __grabRotationFix?: boolean;
};

if (!proto.__grabRotationFix) {
  const original = proto.intersectPointerCapture;

  proto.intersectPointerCapture = function (
    this: SphereIntersector,
    capture: Capture,
  ): CaptureIntersection {
    const result = original.call(this, capture);
    // Sin transformación válida, el original devuelve la intersección previa
    if (result === capture.intersection) return result;

    const previous = capture.intersection;
    const internals = this as unknown as SphereIntersectorInternals;

    // delta mundial = q_new · q_old⁻¹
    oldQuatInverse.copy(previous.pointerQuaternion).invert();
    deltaQuat.copy(internals.fromQuaternion).multiply(oldQuatInverse);

    offset
      .copy(previous.point)
      .sub(previous.pointerPosition)
      .applyQuaternion(deltaQuat);
    result.point.copy(offset).add(internals.fromPosition);
    if (result.pointOnFace) {
      result.distance = result.point.distanceTo(result.pointOnFace);
    }
    return result;
  };

  proto.__grabRotationFix = true;
}
