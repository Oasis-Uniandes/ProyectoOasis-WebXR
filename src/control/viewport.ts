/**
 * Visor 3D del panel de control: refleja la escena del casco y permite mover,
 * rotar y escalar el objeto seleccionado con un gizmo (como en Unity).
 *
 * Este módulo corre SOLO en control.html, una página aparte que no carga la
 * app ni @iwsdk/core. Por eso aquí sí se importa `three` directamente (no hay
 * otra instancia de three en esta página con la que duplicarse).
 */

import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  Box3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type {
  ObjectKind,
  ObjectSnapshot,
  PlaneSnapshot,
  Quat,
  RuntimeState,
  ShapeKind,
  Vec3,
} from '../remote/protocol.js';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface ViewportCallbacks {
  onSelect(id: string | null): void;
  /** Justo antes de empezar a arrastrar el gizmo (para poder deshacer). */
  onTransformStart(id: string): void;
  onTransform(id: string, position: Vec3, quaternion: Quat, scale: Vec3): void;
}

/** Mantener en sincronía con createGeometry de src/remote-edit-system.ts. */
function createGeometry(shape: ShapeKind | 'other', s: number): BufferGeometry {
  switch (shape) {
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
    default:
      return new BoxGeometry(s, s, s);
  }
}

interface ViewObject {
  /** Contenedor con la transformación del casco (lo que mueve el gizmo). */
  root: Group;
  /** Forma o modelo que define el contenido (para rehacerlo si cambia). */
  contentKey: string;
  /** Material de color (formas básicas); los modelos conservan los suyos. */
  colorMat: MeshStandardMaterial | null;
  /** Materiales que se iluminan al seleccionar. */
  glow: MeshStandardMaterial[];
}

const gltfLoader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF>>();

/** Mismo criterio que normalizeModel del casco: mayor dimensión = size, centrado. */
function normalizeModel(source: Object3D, size: number): Object3D {
  const inner = source.clone(true);
  inner.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone();
    }
  });
  const box = new Box3().setFromObject(inner);
  const dims = box.getSize(new Vector3());
  inner.scale.multiplyScalar(size / (Math.max(dims.x, dims.y, dims.z) || 1));
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  inner.position.sub(box.getCenter(new Vector3()));
  return inner;
}

function standardMaterials(root: Object3D): MeshStandardMaterial[] {
  const found: MeshStandardMaterial[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if ((m as MeshStandardMaterial).isMeshStandardMaterial) found.push(m as MeshStandardMaterial);
    }
  });
  return found;
}

function disposeTree(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  });
}

const SEND_INTERVAL_MS = 50;
/** Tras soltar el gizmo, ignorar estados viejos del casco un momento. */
const SETTLE_MS = 500;

export class Viewport {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(50, 1, 0.01, 100);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private objects = new Map<string, ViewObject>();
  private planes = new Map<string, { obj: Object3D; key: string }>();
  private planeGroup = new Group();
  private grid = new GridHelper(6, 60, '#62666d', '#3e4248');
  private viewer = new Group();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private downAt = new Vector2();

  private selectedId: string | null = null;
  private dragging = false;
  private draggedId: string | null = null;
  private ignoreUntil = 0;
  private lastSend = 0;
  private isolate = false;
  private framed = false;

  constructor(
    private container: HTMLElement,
    private callbacks: ViewportCallbacks,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color('#2b2e33');
    this.scene.add(new HemisphereLight('#f5f0e6', '#3a3530', 1.2));
    this.scene.add(new AmbientLight('#ffffff', 0.25));
    const sun = new DirectionalLight('#fff4e0', 1.6);
    sun.position.set(-1.5, 4, 2);
    this.scene.add(sun);

    // Suelo real: rejilla de 10 cm.
    this.scene.add(this.grid);
    this.scene.add(this.planeGroup);
    this.buildViewerMarker();

    this.camera.position.set(0.6, 1.6, 0.6);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 1, -0.5);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = Boolean(e.value);
      this.orbit.enabled = !this.dragging;
      if (this.dragging) {
        this.draggedId = this.selectedId;
        if (this.draggedId) this.callbacks.onTransformStart(this.draggedId);
      } else {
        this.sendTransform(true);
        this.ignoreUntil = performance.now() + SETTLE_MS;
      }
    });
    this.gizmo.addEventListener('objectChange', () => this.sendTransform(false));

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this.downAt.set(e.clientX, e.clientY));
    dom.addEventListener('pointerup', (e) => this.onClick(e));
    dom.addEventListener('dblclick', () => this.focus());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.orbit.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ---------------------------------------------------------------- API

  /** Fondo y rejilla acordes al tema del panel. */
  setTheme(dark: boolean): void {
    (this.scene.background as Color).set(dark ? '#2b2e33' : '#e4e5e7');
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = dark
      ? new GridHelper(6, 60, '#62666d', '#3e4248')
      : new GridHelper(6, 60, '#a7a8aa', '#cfd1d4');
    this.scene.add(this.grid);
  }

  setMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
  }

  setLocal(local: boolean): void {
    this.gizmo.setSpace(local ? 'local' : 'world');
  }

  setSnap(on: boolean): void {
    this.gizmo.setTranslationSnap(on ? 0.01 : null);
    this.gizmo.setRotationSnap(on ? Math.PI / 12 : null);
    this.gizmo.setScaleSnap(on ? 0.05 : null);
  }

  setIsolate(on: boolean): void {
    this.isolate = on;
    this.applyVisibility();
    this.focus();
  }

  /** Encuadra el seleccionado (o toda la escena). */
  focus(): void {
    const box = new Box3();
    const sel = this.selectedId ? this.objects.get(this.selectedId) : undefined;
    if (sel) box.setFromObject(sel.root);
    else for (const o of this.objects.values()) if (o.root.visible) box.expandByObject(o.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.06);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.5, 0.7).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
  }

  update(state: RuntimeState | null, selectedId: string | null): void {
    const objects = state?.objects ?? [];
    const seen = new Set<string>();
    const now = performance.now();
    for (const o of objects) {
      seen.add(o.id);
      const view = this.ensureObject(o);
      const busy =
        o.id === this.draggedId && (this.dragging || now < this.ignoreUntil);
      if (!busy) {
        view.root.position.fromArray(o.position);
        view.root.quaternion.fromArray(o.quaternion);
        view.root.scale.fromArray(o.scale);
      }
      view.colorMat?.color.set(o.color);
    }
    for (const [id, view] of this.objects) {
      if (seen.has(id)) continue;
      if (this.gizmo.object === view.root) this.gizmo.detach();
      this.scene.remove(view.root);
      disposeTree(view.root);
      this.objects.delete(id);
    }

    this.updatePlanes(state?.planes ?? []);
    if (state) {
      this.viewer.visible = true;
      this.viewer.position.fromArray(state.viewer.position);
      this.viewer.rotation.set(0, (state.viewer.yawDeg * Math.PI) / 180, 0);
    } else {
      this.viewer.visible = false;
    }

    this.setSelected(selectedId);
    if (!this.framed && objects.length > 0) {
      this.framed = true;
      this.frameFromViewer(state!);
    }
  }

  // ---------------------------------------------------------------- interno

  private setSelected(id: string | null, force = false): void {
    const changed = id !== this.selectedId || force;
    this.selectedId = id;
    for (const [oid, view] of this.objects) {
      const g = oid === id ? 0.12 : 0;
      for (const m of view.glow) m.emissive.setRGB(g, g, g);
    }
    const target = id ? this.objects.get(id)?.root : undefined;
    if (target && this.gizmo.object !== target) this.gizmo.attach(target);
    if (!target && this.gizmo.object) this.gizmo.detach();
    if (changed) {
      this.applyVisibility();
      if (this.isolate) this.focus();
    }
  }

  private applyVisibility(): void {
    for (const [id, view] of this.objects) {
      view.root.visible = !this.isolate || !this.selectedId || id === this.selectedId;
    }
    this.planeGroup.visible = !this.isolate;
  }

  private ensureObject(o: ObjectSnapshot): ViewObject {
    const key = `${o.shape}:${o.size}:${o.model?.url ?? ''}`;
    let view = this.objects.get(o.id);
    if (!view) {
      const root = new Group();
      root.userData.id = o.id;
      this.scene.add(root);
      view = { root, contentKey: '', colorMat: null, glow: [] };
      this.objects.set(o.id, view);
    }
    if (view.contentKey !== key) {
      view.contentKey = key;
      this.setContent(view, o.shape, o.size, o.color, o.model?.url);
      this.applyVisibility();
    }
    return view;
  }

  /** Rellena el contenedor con una forma básica o con un modelo importado. */
  private setContent(
    view: ViewObject,
    shape: ObjectKind | 'other',
    size: number,
    color: string,
    modelUrl?: string,
  ): void {
    for (const child of [...view.root.children]) {
      view.root.remove(child);
      disposeTree(child);
    }
    if (shape === 'model' && modelUrl) {
      // Marcador mientras se descarga: un cubo de alambre del tamaño final.
      const placeholder = new Mesh(
        new BoxGeometry(size, size, size),
        new MeshBasicMaterial({ color: '#649bc7', wireframe: true }),
      );
      view.root.add(placeholder);
      view.colorMat = null;
      view.glow = [];
      const key = view.contentKey;
      let pending = gltfCache.get(modelUrl);
      if (!pending) {
        pending = gltfLoader.loadAsync(`${import.meta.env.BASE_URL}${modelUrl}`);
        gltfCache.set(modelUrl, pending);
      }
      pending
        .then((gltf) => {
          if (view.contentKey !== key) return; // cambió mientras cargaba
          view.root.remove(placeholder);
          disposeTree(placeholder);
          const model = normalizeModel(gltf.scene, size);
          view.root.add(model);
          view.glow = standardMaterials(model);
          this.setSelected(this.selectedId, true);
        })
        .catch(() => {
          (placeholder.material as MeshBasicMaterial).color.set('#b23a45');
        });
      return;
    }
    const mat = new MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });
    view.root.add(new Mesh(createGeometry(shape === 'model' ? 'cube' : shape, size), mat));
    view.colorMat = mat;
    view.glow = [mat];
  }

  private updatePlanes(planes: PlaneSnapshot[]): void {
    const seen = new Set<string>();
    for (const p of planes) {
      seen.add(p.id);
      const key = p.points.join(',');
      const existing = this.planes.get(p.id);
      if (existing?.key === key) continue;
      if (existing) this.planeGroup.remove(existing.obj);
      const obj = this.buildPlane(p);
      this.planeGroup.add(obj);
      this.planes.set(p.id, { obj, key });
    }
    for (const [id, entry] of this.planes) {
      if (!seen.has(id)) {
        this.planeGroup.remove(entry.obj);
        this.planes.delete(id);
      }
    }
  }

  /** Superficies reales del cuarto: mesas/suelo rellenos, paredes en línea. */
  private buildPlane(p: PlaneSnapshot): Object3D {
    const outline = new BufferGeometry();
    outline.setAttribute('position', new Float32BufferAttribute(p.points, 3));
    const group = new Group();
    group.add(new LineLoop(outline, new LineBasicMaterial({ color: '#649bc7', transparent: true, opacity: 0.6 })));
    if (p.orientation === 'horizontal' && p.points.length >= 9) {
      const tris: number[] = [];
      const n = p.points.length / 3;
      for (let i = 1; i < n - 1; i++) {
        tris.push(...p.points.slice(0, 3), ...p.points.slice(i * 3, i * 3 + 3), ...p.points.slice((i + 1) * 3, (i + 1) * 3 + 3));
      }
      const fill = new BufferGeometry();
      fill.setAttribute('position', new Float32BufferAttribute(tris, 3));
      group.add(new Mesh(fill, new MeshBasicMaterial({ color: '#649bc7', transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false })));
    }
    return group;
  }

  /** Marcador del casco: cabeza + flecha hacia donde mira. */
  private buildViewerMarker(): void {
    const head = new Mesh(
      new SphereGeometry(0.06, 16, 12),
      new MeshStandardMaterial({ color: '#a8853f', roughness: 0.5 }),
    );
    const nose = new Mesh(
      new ConeGeometry(0.035, 0.12, 12).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: '#a8853f', roughness: 0.5 }),
    );
    nose.position.z = -0.1;
    this.viewer.add(head, nose);
    this.viewer.visible = false;
    this.scene.add(this.viewer);
  }

  /** Primera vista: detrás y por encima del casco, mirando a los objetos. */
  private frameFromViewer(state: RuntimeState): void {
    const box = new Box3();
    for (const view of this.objects.values()) box.expandByObject(view.root);
    const center = box.getCenter(new Vector3());
    const head = new Vector3().fromArray(state.viewer.position);
    const back = head.clone().sub(center).setY(0);
    if (back.lengthSq() < 1e-4) back.set(0, 0, 1);
    back.normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(back, 0.9).add(new Vector3(0.25, 0.45, 0));
  }

  private sendTransform(final: boolean): void {
    const id = this.draggedId ?? this.selectedId;
    const view = id ? this.objects.get(id) : undefined;
    if (!id || !view) return;
    const now = performance.now();
    if (!final && now - this.lastSend < SEND_INTERVAL_MS) return;
    this.lastSend = now;
    const m = view.root;
    const r = (n: number) => Math.round(n * 10000) / 10000;
    this.callbacks.onTransform(
      id,
      [r(m.position.x), r(m.position.y), r(m.position.z)],
      [r(m.quaternion.x), r(m.quaternion.y), r(m.quaternion.z), r(m.quaternion.w)],
      [r(m.scale.x), r(m.scale.y), r(m.scale.z)],
    );
  }

  private onClick(e: PointerEvent): void {
    if (this.dragging || e.button !== 0) return;
    if (this.downAt.distanceTo(new Vector2(e.clientX, e.clientY)) > 4) return; // fue un giro de cámara
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = [...this.objects.values()].map((v) => v.root).filter((r) => r.visible);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    let node: Object3D | null = hit?.object ?? null;
    while (node && node.userData.id === undefined) node = node.parent;
    if (node) this.callbacks.onSelect(node.userData.id as string);
    else if (!this.gizmo.dragging && !this.gizmo.axis) this.callbacks.onSelect(null);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
