/**
 * Protocolo compartido entre el panel de control del computador
 * (`control.html`), el servidor de desarrollo (`server/oasis-dev-server.ts`)
 * y la app que corre en el casco.
 *
 * Panel y casco hablan a través del WebSocket de HMR del servidor de Vite: el
 * plugin reenvía cada mensaje a todos los clientes conectados. Este módulo
 * solo contiene tipos y constantes: no importa three ni @iwsdk/core.
 */

/** Panel → casco: órdenes de edición. */
export const CMD_EVENT = 'oasis:cmd';
/** Casco → panel: estado actual de la escena. */
export const STATE_EVENT = 'oasis:state';

/** Servidor → todos: cambió la configuración (p. ej. emulador apagado). */
export const SETTINGS_EVENT = 'oasis:settings';
/** Casco → panel: esta app deja de participar (p. ej. emulador apagado). */
export const BYE_EVENT = 'oasis:bye';

/** Rutas HTTP del servidor de desarrollo (relativas a la raíz de la app). */
export const SCENE_ENDPOINT = '__oasis/scene';
export const AI_ENDPOINT = '__oasis/ai';
export const SETTINGS_ENDPOINT = '__oasis/settings';
/** Biblioteca de modelos (búsqueda, importación, subida, lista). */
export const LIBRARY_ENDPOINT = '__oasis/library';
/** Prefijo de los archivos de modelos guardados en saved/models/. */
export const MODELS_PATH = '__oasis/models/';
/** Casco → panel: avisos (p. ej. un modelo que no se pudo cargar). */
export const NOTICE_EVENT = 'oasis:notice';

export interface OasisSettings {
  /** Si es false, el emulador (IWER) ignora el panel y no envía su estado. */
  emulatorEnabled: boolean;
}
export const DEFAULT_SETTINGS: OasisSettings = { emulatorEnabled: true };

export const SHAPES = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'pyramid',
  'torus',
  'capsule',
  'slab',
] as const;
export type ShapeKind = (typeof SHAPES)[number];

export const PLACE_SIDES = [
  'top',
  'left',
  'right',
  'front',
  'back',
  'viewer',
] as const;
/**
 * Dónde colocar un objeto respecto al ancla. Las direcciones son relativas a
 * quien lleva el casco: «right» es su derecha, «front» es hacia él.
 * «viewer» ignora el ancla y lo pone delante del casco.
 */
export type PlaceSide = (typeof PLACE_SIDES)[number];

/** Modelo 3D importado (glTF/GLB) guardado en el servidor. */
export interface ModelRef {
  /** Ruta relativa a la raíz de la app, p. ej. «__oasis/models/polyhaven-chair/chair.gltf». */
  url: string;
  /** Crédito/licencia para mostrar (CC-BY exige atribución). */
  credit: string;
}

/** Formas básicas + modelos importados. */
export type ObjectKind = ShapeKind | 'model';

export type LibrarySource = 'polyhaven' | 'sketchfab' | 'upload';

export interface LibraryItem {
  source: LibrarySource;
  id: string;
  name: string;
  thumb: string | null;
  author: string;
  license: string;
}

export interface ImportedModel {
  key: string;
  source: LibrarySource;
  id: string;
  name: string;
  thumb: string | null;
  model: ModelRef;
  importedAt: string;
}

export interface LibraryStatus {
  /** Hay clave de Sketchfab configurada en el servidor. */
  sketchfab: boolean;
}

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type RemoteCommand =
  | {
      type: 'add';
      id: string;
      name: string;
      shape: ObjectKind;
      /** Obligatorio si shape es «model». */
      model?: ModelRef;
      color: string;
      /** Tamaño característico en metros (en modelos: su mayor dimensión). */
      size: number;
      anchorId: string | null;
      side: PlaceSide;
      /** Si se indica, se ignora anchor/side: centro mundial en metros. */
      position?: Vec3;
      quaternion?: Quat;
      scale?: Vec3;
    }
  | {
      type: 'duplicate';
      id: string;
      name: string;
      sourceId: string;
      side: PlaceSide;
    }
  | { type: 'place'; id: string; anchorId: string | null; side: PlaceSide }
  /** Desplazamiento en metros relativo a quien lleva el casco. */
  | { type: 'move'; id: string; right: number; up: number; toward: number }
  /** Transformación absoluta en espacio mundial (lo que mueve el gizmo). */
  | {
      type: 'setTransform';
      id: string;
      position?: Vec3;
      quaternion?: Quat;
      scale?: Vec3;
    }
  | { type: 'rotate'; id: string; degrees: number }
  | { type: 'resetRotation'; id: string }
  /** Escala uniforme absoluta respecto al tamaño de creación. */
  | { type: 'scale'; id: string; factor: number }
  | { type: 'color'; id: string; color: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'requestState' };

export interface ObjectSnapshot {
  id: string;
  name: string;
  shape: ObjectKind | 'other';
  model?: ModelRef;
  color: string;
  /** Tamaño característico de la geometría en metros (sin escalar). */
  size: number;
  /** Posición mundial en metros. */
  position: Vec3;
  /** Rotación mundial. */
  quaternion: Quat;
  /** Escala local. */
  scale: Vec3;
  /** Medidas de la caja envolvente mundial (ancho, alto, fondo) en metros. */
  dims: Vec3;
  factor: number;
  rotationDeg: number;
  /** Creado desde el panel (true) o parte de la escena original (false). */
  remote: boolean;
  grabbed: boolean;
}

export interface PlaneSnapshot {
  id: string;
  orientation: 'horizontal' | 'vertical';
  /** Polígono en coordenadas mundiales: x0,y0,z0,x1,y1,z1… */
  points: number[];
}

export interface RuntimeState {
  runtimeId: string;
  /** «emulator»: IWER (Quest simulado en el navegador), no un casco real. */
  device: 'quest' | 'browser' | 'emulator';
  inXR: boolean;
  selectedId: string | null;
  /** Cabeza de quien lleva el casco. */
  viewer: { position: Vec3; yawDeg: number };
  objects: ObjectSnapshot[];
  planes: PlaneSnapshot[];
}

export interface SavedScene {
  version: 1;
  savedAt: string;
  objects: ObjectSnapshot[];
}

export interface AiRequest {
  prompt: string;
  state: RuntimeState;
  selectedId: string | null;
}

export interface AiResponse {
  reply: string;
  commands: RemoteCommand[];
  /** Ids de objetos nuevos (para «deshacer»). */
  createdIds: string[];
  error?: string;
}

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 4;
