/**
 * Edición remota en vivo: aplica en el casco las órdenes que llegan desde el
 * panel del computador (`control.html`) y le devuelve el estado de la escena
 * (objetos, posición del casco y superficies reales detectadas).
 *
 * Todo objeto con TwoHandsGrabbable es editable: los de la escena original y
 * los creados desde el panel, que también se pueden agarrar, escalar con dos
 * manos y apoyar sobre superficies (SurfaceSnapSystem).
 *
 * Al arrancar carga la escena guardada desde el panel (si existe).
 */

import {
  AssetManager,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  createSystem,
  CylinderGeometry,
  Entity,
  Euler,
  Grabbed,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TwoHandsGrabbable,
  Vector3,
  XRPlane,
} from '@iwsdk/core';
import {
  BYE_EVENT,
  CMD_EVENT,
  ModelRef,
  NOTICE_EVENT,
  ObjectKind,
  ObjectSnapshot,
  OasisSettings,
  SETTINGS_ENDPOINT,
  SETTINGS_EVENT,
  PlaceSide,
  PlaneSnapshot,
  Quat,
  RemoteCommand,
  RuntimeState,
  SavedScene,
  SCALE_MAX,
  SCALE_MIN,
  SCENE_ENDPOINT,
  ShapeKind,
  STATE_EVENT,
  Vec3,
} from './remote/protocol.js';

/** Cada cuánto se envía el estado al panel (segundos). */
const STATE_INTERVAL_SECONDS = 0.2;
/** Reenvío aunque nada cambie, para que el panel sepa que seguimos vivos. */
const HEARTBEAT_SECONDS = 2;
/** Separación entre objetos colocados uno junto a otro (metros). */
const SIDE_GAP_METERS = 0.01;

interface Editable {
  id: string;
  mesh: Mesh | null;
  /** Material de color (solo formas básicas). */
  material: MeshStandardMaterial | null;
  /** Materiales que brillan al seleccionar (todos los de un modelo). */
  glow: MeshStandardMaterial[];
  baseScale: Vector3;
  shape: ObjectKind | 'other';
  model?: ModelRef;
  size: number;
  remote: boolean;
}

/**
 * Prepara una copia de un modelo importado: materiales propios (para el
 * brillo de selección), sombras, mayor dimensión = `size` y centro en el origen.
 */
function normalizeModel(source: Object3D, size: number): Group {
  const inner = source.clone(true);
  inner.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => m.clone())
      : mesh.material.clone();
  });
  const box = new Box3().setFromObject(inner);
  const dims = box.getSize(new Vector3());
  const maxDim = Math.max(dims.x, dims.y, dims.z) || 1;
  inner.scale.multiplyScalar(size / maxDim);
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  inner.position.sub(box.getCenter(new Vector3()));
  const wrapper = new Group();
  wrapper.add(inner);
  return wrapper;
}

function collectStandardMaterials(root: Object3D): MeshStandardMaterial[] {
  const found: MeshStandardMaterial[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if ((m as MeshStandardMaterial).isMeshStandardMaterial) found.push(m as MeshStandardMaterial);
    }
  });
  return found;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'objeto'
  );
}

function shapeFromGeometry(geometry: BufferGeometry): ShapeKind | 'other' {
  switch (geometry.type) {
    case 'BoxGeometry':
      return 'cube';
    case 'SphereGeometry':
      return 'sphere';
    case 'CylinderGeometry':
      return 'cylinder';
    case 'ConeGeometry':
      return 'cone';
    case 'TorusGeometry':
      return 'torus';
    case 'CapsuleGeometry':
      return 'capsule';
    default:
      return 'other';
  }
}

/** Mayor dimensión de la geometría (tamaño característico). */
function geometrySize(geometry: BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
}

export function createGeometry(shape: ShapeKind, s: number): BufferGeometry {
  switch (shape) {
    case 'cube':
      return new BoxGeometry(s, s, s);
    case 'sphere':
      return new SphereGeometry(s / 2, 32, 16);
    case 'cylinder':
      return new CylinderGeometry(s / 2, s / 2, s, 32);
    case 'cone':
      return new ConeGeometry(s / 2, s, 32);
    case 'pyramid':
      return new ConeGeometry(s * 0.6, s, 4).rotateY(Math.PI / 4);
    case 'torus':
      return new TorusGeometry(s * 0.35, s * 0.13, 16, 48).rotateX(Math.PI / 2);
    case 'capsule':
      return new CapsuleGeometry(s * 0.3, s * 0.5, 8, 16);
    case 'slab':
      return new BoxGeometry(s * 2, s * 0.15, s * 1.2);
  }
}

function findMesh(root: Object3D): Mesh | null {
  if ((root as Mesh).isMesh) return root as Mesh;
  let found: Mesh | null = null;
  root.traverse((child) => {
    if (!found && (child as Mesh).isMesh) found = child as Mesh;
  });
  return found;
}

/**
 * ¿Casco real, emulador o navegador normal? El plugin de desarrollo de IWSDK
 * marca la página cuando el XR es emulado (IWER); ese navegador además se
 * hace pasar por un Quest, así que el user agent no basta.
 */
function detectDevice(): RuntimeState['device'] {
  const w = window as unknown as {
    __IWER_MCP_MANAGED?: boolean;
    __IWSDK_EMULATION_PROFILE?: { active?: boolean; runtime?: string | null };
  };
  const profile = w.__IWSDK_EMULATION_PROFILE;
  const emulated =
    w.__IWER_MCP_MANAGED === true ||
    (profile?.active === true && profile.runtime !== 'IWER-native-override');
  if (emulated) return 'emulator';
  return /OculusBrowser|Quest/i.test(navigator.userAgent) ? 'quest' : 'browser';
}

export class RemoteEditSystem extends createSystem({
  editables: { required: [TwoHandsGrabbable] },
  planes: { required: [XRPlane] },
}) {
  private readonly runtimeId = Math.random().toString(36).slice(2, 10);
  private device: RuntimeState['device'] = 'browser';
  /** Emulador apagado desde el panel. */
  private dormant = false;

  private commands: RemoteCommand[] = [];
  private byId = new Map<string, Entity>();
  private info = new Map<Entity, Editable>();
  /** Datos que se asignarán a una entidad creada desde el panel al cualificar. */
  private pending = new Map<
    Entity,
    { id: string; shape: ObjectKind; size: number; model?: ModelRef }
  >();
  /** Modelos que se están descargando; sus órdenes esperan aquí. */
  private loading = new Map<string, RemoteCommand[]>();

  private selectedId: string | null = null;
  private pulseTime = 0;
  private stateTimer = 0;
  private heartbeatTimer = 0;
  private lastSent = '';

  private headPos = new Vector3();
  private forward = new Vector3();
  private right = new Vector3();
  private dir = new Vector3();
  private tempA = new Vector3();
  private tempB = new Vector3();
  private tempQuat = new Quaternion();
  private parentQuat = new Quaternion();
  private tempEuler = new Euler(0, 0, 0, 'YXZ');
  private ownBox = new Box3();
  private anchorBox = new Box3();
  private ownHalf = new Vector3();
  private anchorHalf = new Vector3();
  private anchorCenter = new Vector3();
  private centerOffset = new Vector3();
  private worldPos = new Vector3();

  init(): void {
    this.device = detectDevice();
    this.cleanupFuncs.push(
      this.queries.editables.subscribe('qualify', (entity) =>
        this.register(entity),
      ),
      this.queries.editables.subscribe('disqualify', (entity) =>
        this.unregister(entity),
      ),
    );
    // Los objetos de la escena ya existen cuando se registra el sistema.
    for (const entity of this.queries.editables.entities) this.register(entity);

    const hot = import.meta.hot;
    if (!hot) return; // build de producción: sin panel remoto
    const onCommand = (cmd: RemoteCommand) => {
      if (!this.dormant) this.commands.push(cmd);
    };
    hot.on(CMD_EVENT, onCommand);
    this.cleanupFuncs.push(() => hot.off?.(CMD_EVENT, onCommand));

    if (this.device === 'emulator') {
      const onSettings = (s: OasisSettings) => this.applySettings(s);
      hot.on(SETTINGS_EVENT, onSettings);
      this.cleanupFuncs.push(() => hot.off?.(SETTINGS_EVENT, onSettings));
      fetch(`${import.meta.env.BASE_URL}${SETTINGS_ENDPOINT}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((s: OasisSettings | null) => s && this.applySettings(s))
        .catch(() => {});
    }

    void this.loadSavedScene();
  }

  /**
   * Emulador apagado desde el panel: deja de escuchar órdenes y de enviar su
   * estado. Al volver a encenderlo se recarga para partir de la escena guardada.
   */
  private applySettings(settings: OasisSettings): void {
    if (this.device !== 'emulator') return;
    const off = !settings.emulatorEnabled;
    if (off && !this.dormant) {
      this.dormant = true;
      this.commands.length = 0;
      import.meta.hot?.send(BYE_EVENT, { runtimeId: this.runtimeId });
    } else if (!off && this.dormant) {
      location.reload();
    }
  }

  update(delta: number): void {
    if (this.dormant) return;
    if (this.commands.length > 0) {
      for (const cmd of this.commands) this.apply(cmd);
      this.commands.length = 0;
      this.stateTimer = STATE_INTERVAL_SECONDS; // responder enseguida
    }

    this.updateHighlight(delta);

    this.stateTimer += delta;
    this.heartbeatTimer += delta;
    if (this.stateTimer >= STATE_INTERVAL_SECONDS) {
      this.stateTimer = 0;
      this.sendState();
    }
  }

  // ---------------------------------------------------------------- guardado

  /** Recrea la escena guardada con el botón «Guardar» del panel. */
  private async loadSavedScene(): Promise<void> {
    let saved: SavedScene;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${SCENE_ENDPOINT}`);
      if (!res.ok) return;
      saved = (await res.json()) as SavedScene;
    } catch {
      return;
    }
    if (!saved?.objects) return;

    const savedIds = new Set(saved.objects.map((o) => o.id));
    for (const info of this.info.values()) {
      if (!info.remote && !savedIds.has(info.id)) {
        this.commands.push({ type: 'delete', id: info.id });
      }
    }
    for (const o of saved.objects) {
      if (o.remote) {
        if (o.shape === 'other') continue;
        this.commands.push({
          type: 'add',
          id: o.id,
          name: o.name,
          shape: o.shape,
          model: o.model,
          color: o.color,
          size: o.size,
          anchorId: null,
          side: 'viewer',
          position: o.position,
          quaternion: o.quaternion,
          scale: o.scale,
        });
      } else if (this.byId.has(o.id)) {
        this.commands.push(
          {
            type: 'setTransform',
            id: o.id,
            position: o.position,
            quaternion: o.quaternion,
            scale: o.scale,
          },
          { type: 'color', id: o.id, color: o.color },
          { type: 'rename', id: o.id, name: o.name },
        );
      }
    }
    this.commands.push({ type: 'select', id: null });
  }

  // ---------------------------------------------------------------- registro

  private register(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj || this.info.has(entity)) return;
    const pending = this.pending.get(entity);
    this.pending.delete(entity);

    let id = pending?.id;
    if (!id) {
      const base = slug(obj.name || `objeto-${entity.index}`);
      id = base;
      for (let n = 2; this.byId.has(id); n++) id = `${base}-${n}`;
    }

    const isModel = pending?.shape === 'model';
    const mesh = isModel ? null : findMesh(obj);
    let material: MeshStandardMaterial | null = null;
    if (mesh && !Array.isArray(mesh.material)) {
      const original = mesh.material as Material;
      if ((original as MeshStandardMaterial).isMeshStandardMaterial) {
        // Material propio para poder cambiar color/resaltado sin afectar a otros.
        material = pending
          ? (original as MeshStandardMaterial)
          : (original as MeshStandardMaterial).clone();
        mesh.material = material;
      }
    }

    this.byId.set(id, entity);
    this.info.set(entity, {
      id,
      mesh,
      material,
      glow: isModel ? collectStandardMaterials(obj) : material ? [material] : [],
      model: pending?.model,
      baseScale: obj.scale.clone(),
      shape:
        pending?.shape ?? (mesh ? shapeFromGeometry(mesh.geometry) : 'other'),
      size: pending?.size ?? (mesh ? geometrySize(mesh.geometry) : 0.1),
      remote: !!pending,
    });
  }

  private unregister(entity: Entity): void {
    const info = this.info.get(entity);
    if (!info) return;
    this.info.delete(entity);
    if (this.byId.get(info.id) === entity) this.byId.delete(info.id);
    if (this.selectedId === info.id) this.selectedId = null;
  }

  // ---------------------------------------------------------------- órdenes

  private apply(cmd: RemoteCommand): void {
    const targetId = 'id' in cmd ? cmd.id : null;
    if (targetId && cmd.type !== 'add' && this.loading.has(targetId)) {
      this.loading.get(targetId)!.push(cmd); // se aplica cuando termine de cargar
      return;
    }
    switch (cmd.type) {
      case 'requestState':
        this.lastSent = '';
        return;
      case 'add':
        this.add(cmd);
        return;
      case 'duplicate':
        this.duplicate(cmd);
        return;
      case 'select':
        this.setSelected(cmd.id);
        return;
    }

    const entity = this.byId.get(cmd.id);
    const obj = entity?.object3D;
    const info = entity && this.info.get(entity);
    if (!entity || !obj || !info) return;

    switch (cmd.type) {
      case 'place': {
        if (cmd.anchorId === cmd.id) return;
        const anchor = cmd.anchorId ? this.byId.get(cmd.anchorId) : undefined;
        this.placeRelative(obj, anchor?.object3D ?? null, cmd.side);
        return;
      }
      case 'move':
        this.computeViewerFrame();
        obj.getWorldPosition(this.worldPos);
        this.worldPos
          .addScaledVector(this.right, cmd.right)
          .addScaledVector(Object3D.DEFAULT_UP, cmd.up)
          .addScaledVector(this.forward, -cmd.toward);
        this.setWorldPosition(obj, this.worldPos);
        return;
      case 'setTransform':
        this.setWorldTransform(obj, info, cmd.position, cmd.quaternion, cmd.scale);
        return;
      case 'rotate':
        obj.rotateOnWorldAxis(
          Object3D.DEFAULT_UP,
          (cmd.degrees * Math.PI) / 180,
        );
        return;
      case 'resetRotation':
        obj.quaternion.identity();
        return;
      case 'scale': {
        const f = Math.min(SCALE_MAX, Math.max(SCALE_MIN, cmd.factor));
        obj.scale.copy(info.baseScale).multiplyScalar(f);
        return;
      }
      case 'color':
        info.material?.color.set(cmd.color);
        return;
      case 'rename':
        obj.name = cmd.name;
        return;
      case 'delete':
        if (this.selectedId === cmd.id) this.setSelected(null);
        entity.dispose();
        return;
    }
  }

  /** Descarga (o toma de la caché) un modelo y lo crea como un objeto más. */
  private addModel(cmd: Extract<RemoteCommand, { type: 'add' }>): void {
    const model = cmd.model;
    if (!model || this.loading.has(cmd.id)) return;
    this.loading.set(cmd.id, []);
    AssetManager.loadGLTF(`${import.meta.env.BASE_URL}${model.url}`, model.url)
      .then((gltf) => {
        const deferred = this.loading.get(cmd.id) ?? [];
        this.loading.delete(cmd.id);
        if (this.byId.has(cmd.id) || deferred.some((c) => c.type === 'delete')) return;
        const root = normalizeModel(gltf.scene, cmd.size);
        const entity = this.spawn(root, cmd.id, cmd.name, 'model', cmd.size, model);
        this.placeNew(root, entity, cmd);
        for (const c of deferred) this.commands.push(c);
      })
      .catch((error) => {
        this.loading.delete(cmd.id);
        console.warn('[Oasis] No se pudo cargar el modelo', model.url, error);
        import.meta.hot?.send(NOTICE_EVENT, {
          kind: 'error',
          message: `El casco no pudo cargar «${cmd.name}». Prueba con otro modelo.`,
        });
      });
  }

  private placeNew(
    obj: Object3D,
    entity: Entity,
    cmd: Extract<RemoteCommand, { type: 'add' }>,
  ): void {
    if (cmd.position) {
      this.setWorldTransform(obj, this.info.get(entity)!, cmd.position, cmd.quaternion, cmd.scale);
    } else {
      if (cmd.quaternion) obj.quaternion.fromArray(cmd.quaternion);
      if (cmd.scale) obj.scale.fromArray(cmd.scale);
      const anchor = cmd.anchorId ? this.byId.get(cmd.anchorId) : undefined;
      this.placeRelative(obj, anchor?.object3D ?? null, cmd.side);
      this.setSelected(cmd.id);
    }
  }

  private add(cmd: Extract<RemoteCommand, { type: 'add' }>): void {
    if (this.byId.has(cmd.id)) return;
    if (cmd.shape === 'model') {
      this.addModel(cmd);
      return;
    }
    const material = new MeshStandardMaterial({
      color: cmd.color,
      roughness: 0.35,
      metalness: 0.1,
    });
    const mesh = new Mesh(createGeometry(cmd.shape, cmd.size), material);
    const entity = this.spawn(mesh, cmd.id, cmd.name, cmd.shape, cmd.size);
    this.placeNew(mesh, entity, cmd);
  }

  private duplicate(cmd: Extract<RemoteCommand, { type: 'duplicate' }>): void {
    if (this.byId.has(cmd.id)) return;
    const source = this.byId.get(cmd.sourceId);
    const sourceObj = source?.object3D;
    const sourceInfo = source && this.info.get(source);
    if (sourceObj && sourceInfo?.shape === 'model' && sourceInfo.model) {
      this.addModel({
        type: 'add',
        id: cmd.id,
        name: cmd.name,
        shape: 'model',
        model: sourceInfo.model,
        color: '#ffffff',
        size: sourceInfo.size,
        anchorId: cmd.sourceId,
        side: cmd.side,
        quaternion: sourceObj.quaternion.toArray() as Quat,
        scale: sourceObj.scale.toArray() as Vec3,
      });
      return;
    }
    if (!sourceObj || !sourceInfo?.mesh) return;

    const material = sourceInfo.material
      ? sourceInfo.material.clone()
      : new MeshStandardMaterial({ color: '#cccccc' });
    material.emissive.setRGB(0, 0, 0);
    const mesh = new Mesh(sourceInfo.mesh.geometry.clone(), material);
    mesh.scale.copy(sourceObj.scale);
    mesh.quaternion.copy(sourceObj.quaternion);
    const entity = this.spawn(
      mesh,
      cmd.id,
      cmd.name,
      sourceInfo.shape === 'other' ? 'cube' : sourceInfo.shape,
      sourceInfo.size,
    );
    this.info.get(entity)?.baseScale.copy(sourceInfo.baseScale);

    this.placeRelative(mesh, sourceObj, cmd.side);
    this.setSelected(cmd.id);
  }

  private spawn(
    mesh: Object3D,
    id: string,
    name: string,
    shape: ObjectKind,
    size: number,
    model?: ModelRef,
  ): Entity {
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const entity = this.world.createTransformEntity(mesh);
    this.pending.set(entity, { id, shape, size, model });
    entity.addComponent(TwoHandsGrabbable, {
      scaleMin: [SCALE_MIN, SCALE_MIN, SCALE_MIN],
      scaleMax: [SCALE_MAX, SCALE_MAX, SCALE_MAX],
    });
    // Por si la suscripción no cualificó de forma síncrona.
    this.register(entity);
    // Los objetos nuevos nacen con escala 1: su tamaño va en la geometría.
    this.info.get(entity)?.baseScale.set(1, 1, 1);
    return entity;
  }

  // ---------------------------------------------------------------- colocación

  /** Horizontal forward/right de quien lleva el casco. */
  private computeViewerFrame(): void {
    const camera = this.world.camera;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.headPos);
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
  }

  private placeRelative(
    obj: Object3D,
    anchor: Object3D | null,
    side: PlaceSide,
  ): void {
    this.computeViewerFrame();
    obj.updateWorldMatrix(true, true);
    this.ownBox.setFromObject(obj);
    this.ownBox.getSize(this.ownHalf).multiplyScalar(0.5);
    obj.getWorldPosition(this.worldPos);
    this.ownBox.getCenter(this.centerOffset).sub(this.worldPos);

    const target = this.tempA;
    if (!anchor || side === 'viewer') {
      target
        .copy(this.headPos)
        .addScaledVector(this.forward, 0.45)
        .setY(this.headPos.y - 0.2);
    } else {
      anchor.updateWorldMatrix(true, true);
      this.anchorBox.setFromObject(anchor);
      this.anchorBox.getSize(this.anchorHalf).multiplyScalar(0.5);
      this.anchorBox.getCenter(this.anchorCenter);

      if (side === 'top') {
        target.set(
          this.anchorCenter.x,
          this.anchorBox.max.y + this.ownHalf.y + 0.002,
          this.anchorCenter.z,
        );
      } else {
        const d = this.dir;
        if (side === 'right') d.copy(this.right);
        else if (side === 'left') d.copy(this.right).negate();
        else if (side === 'front') d.copy(this.forward).negate();
        else d.copy(this.forward);
        const reach =
          Math.abs(d.x) * (this.anchorHalf.x + this.ownHalf.x) +
          Math.abs(d.z) * (this.anchorHalf.z + this.ownHalf.z) +
          SIDE_GAP_METERS;
        target
          .copy(this.anchorCenter)
          .addScaledVector(d, reach)
          // Misma base que el ancla: queda apoyado sobre la misma superficie.
          .setY(this.anchorBox.min.y + this.ownHalf.y);
      }
    }

    this.tempB.copy(target).sub(this.centerOffset);
    this.setWorldPosition(obj, this.tempB);
  }

  private setWorldPosition(obj: Object3D, world: Vector3): void {
    if (obj.parent) {
      obj.parent.updateWorldMatrix(true, false);
      obj.parent.worldToLocal(world);
    }
    obj.position.copy(world);
  }

  private setWorldTransform(
    obj: Object3D,
    info: Editable,
    position?: Vec3,
    quaternion?: Quat,
    scale?: Vec3,
  ): void {
    if (position) {
      this.worldPos.set(position[0], position[1], position[2]);
      this.setWorldPosition(obj, this.worldPos);
    }
    if (quaternion) {
      this.tempQuat.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      if (obj.parent) {
        obj.parent.getWorldQuaternion(this.parentQuat).invert();
        this.tempQuat.premultiply(this.parentQuat);
      }
      obj.quaternion.copy(this.tempQuat).normalize();
    }
    if (scale) {
      const b = info.baseScale;
      obj.scale.set(
        Math.min(SCALE_MAX * b.x, Math.max(SCALE_MIN * b.x, scale[0])),
        Math.min(SCALE_MAX * b.y, Math.max(SCALE_MIN * b.y, scale[1])),
        Math.min(SCALE_MAX * b.z, Math.max(SCALE_MIN * b.z, scale[2])),
      );
    }
  }

  // ---------------------------------------------------------------- selección

  private setSelected(id: string | null): void {
    if (this.selectedId && this.selectedId !== id) {
      const prev = this.byId.get(this.selectedId);
      for (const mat of (prev && this.info.get(prev)?.glow) ?? []) mat.emissive.setRGB(0, 0, 0);
    }
    this.selectedId = id && this.byId.has(id) ? id : null;
    this.pulseTime = 0;
  }

  /** El objeto seleccionado en el panel brilla suavemente en el casco. */
  private updateHighlight(delta: number): void {
    if (!this.selectedId) return;
    const entity = this.byId.get(this.selectedId);
    const mats = entity && this.info.get(entity)?.glow;
    if (!mats?.length) return;
    this.pulseTime += delta;
    const glow = 0.12 + 0.12 * Math.sin(this.pulseTime * 5);
    for (const mat of mats) mat.emissive.setRGB(glow, glow, glow);
  }

  // ---------------------------------------------------------------- estado

  /** Se ejecuta a 5 Hz (no por frame): las asignaciones aquí son aceptables. */
  private sendState(): void {
    const hot = import.meta.hot;
    if (!hot) return;

    const objects: ObjectSnapshot[] = [];
    for (const [entity, info] of this.info) {
      const obj = entity.object3D;
      if (!obj || !entity.active) continue;
      obj.updateWorldMatrix(true, true);
      obj.getWorldPosition(this.worldPos);
      obj.getWorldQuaternion(this.tempQuat);
      this.ownBox.setFromObject(obj).getSize(this.tempA);
      this.tempEuler.setFromQuaternion(this.tempQuat, 'YXZ');
      const base = info.baseScale.x || 1;
      objects.push({
        id: info.id,
        name: obj.name || info.id,
        shape: info.shape,
        model: info.model,
        color: info.material
          ? `#${info.material.color.getHexString()}`
          : '#999999',
        size: r3(info.size),
        position: [r3(this.worldPos.x), r3(this.worldPos.y), r3(this.worldPos.z)],
        quaternion: [
          r3(this.tempQuat.x),
          r3(this.tempQuat.y),
          r3(this.tempQuat.z),
          r3(this.tempQuat.w),
        ],
        scale: [r3(obj.scale.x), r3(obj.scale.y), r3(obj.scale.z)],
        dims: [r3(this.tempA.x), r3(this.tempA.y), r3(this.tempA.z)],
        factor: r2(obj.scale.x / base),
        rotationDeg: Math.round((this.tempEuler.y * 180) / Math.PI),
        remote: info.remote,
        grabbed: entity.hasComponent(Grabbed),
      });
    }

    const planes: PlaneSnapshot[] = [];
    for (const planeEntity of this.queries.planes.entities) {
      const mesh = planeEntity.object3D;
      const native = planeEntity.getValue(XRPlane, '_plane') as
        | globalThis.XRPlane
        | undefined;
      if (!mesh || !native?.polygon?.length) continue;
      mesh.updateWorldMatrix(true, false);
      const points: number[] = [];
      for (const p of native.polygon) {
        this.tempB.set(p.x, p.y, p.z).applyMatrix4(mesh.matrixWorld);
        points.push(r2(this.tempB.x), r2(this.tempB.y), r2(this.tempB.z));
      }
      planes.push({
        id: `plane-${planeEntity.index}`,
        orientation: native.orientation === 'vertical' ? 'vertical' : 'horizontal',
        points,
      });
    }

    this.computeViewerFrame();
    const state: RuntimeState = {
      runtimeId: this.runtimeId,
      device: this.device,
      inXR: this.world.renderer.xr.isPresenting,
      selectedId: this.selectedId,
      viewer: {
        // Redondeado para no reenviar el estado por micro-movimientos.
        position: [r2(this.headPos.x), r2(this.headPos.y), r2(this.headPos.z)],
        yawDeg:
          Math.round(
            (Math.atan2(-this.forward.x, -this.forward.z) * 180) / Math.PI / 5,
          ) * 5,
      },
      objects,
      planes,
    };
    const json = JSON.stringify(state);
    if (json === this.lastSent && this.heartbeatTimer < HEARTBEAT_SECONDS) {
      return;
    }
    this.lastSent = json;
    this.heartbeatTimer = 0;
    hot.send(STATE_EVENT, state);
  }
}
