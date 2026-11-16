/**
 * Panel de control del computador. Se ejecuta en `control.html` (no en el
 * casco): envía órdenes por el WebSocket de HMR, muestra el estado que
 * devuelve la app del casco, guarda la escena y pide ideas a la IA.
 */

import {
  AI_ENDPOINT,
  type AiResponse,
  BYE_EVENT,
  CMD_EVENT,
  DEFAULT_SETTINGS,
  type ImportedModel,
  NOTICE_EVENT,
  type ObjectKind,
  type OasisSettings,
  SETTINGS_ENDPOINT,
  SETTINGS_EVENT,
  type ObjectSnapshot,
  type PlaceSide,
  type Quat,
  type RemoteCommand,
  type RuntimeState,
  type SavedScene,
  SCENE_ENDPOINT,
  type ShapeKind,
  STATE_EVENT,
} from '../remote/protocol.js';
import { hydrateIcons, icon } from './icons.js';
import { ModelLibrary } from './library.js';
import { type GizmoMode, Viewport } from './viewport.js';

const SHAPES: { kind: ShapeKind; label: string; icon: string }[] = [
  { kind: 'cube', label: 'Cubo', icon: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5 M12 12v9"/>' },
  { kind: 'sphere', label: 'Esfera', icon: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>' },
  { kind: 'cylinder', label: 'Cilindro', icon: '<ellipse cx="12" cy="6" rx="6" ry="2.5"/><path d="M6 6v12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6"/>' },
  { kind: 'cone', label: 'Cono', icon: '<path d="M12 3 6 18c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5z"/>' },
  { kind: 'pyramid', label: 'Pirámide', icon: '<path d="M12 3 4 18l8 3 8-3z M12 3v18"/>' },
  { kind: 'torus', label: 'Aro', icon: '<ellipse cx="12" cy="12" rx="9" ry="4.5"/><ellipse cx="12" cy="12" rx="4" ry="1.6"/>' },
  { kind: 'capsule', label: 'Cápsula', icon: '<rect x="8" y="3" width="8" height="18" rx="4"/>' },
  { kind: 'slab', label: 'Tabla', icon: '<path d="M3 11 12 7l9 4-9 4z M3 11v2l9 4 9-4v-2"/>' },
];
const SHAPE_LABEL: Record<string, string> = {
  ...Object.fromEntries(SHAPES.map((s) => [s.kind, s.label])),
  model: 'Modelo 3D',
};
/** Rango del deslizador de tamaño (cm) para formas básicas y para modelos. */
const SIZE_RANGE = { shape: { min: 3, max: 40, value: 10 }, model: { min: 5, max: 200, value: 30 } };
const COLORS: { hex: string; name: string }[] = [
  { hex: '#E63946', name: 'Rojo' },
  { hex: '#F4A261', name: 'Naranja' },
  { hex: '#E9C46A', name: 'Amarillo' },
  { hex: '#2A9D8F', name: 'Verde azulado' },
  { hex: '#3A86FF', name: 'Azul' },
  { hex: '#8338EC', name: 'Morado' },
  { hex: '#FF006E', name: 'Rosa' },
  { hex: '#F1FAEE', name: 'Blanco' },
  { hex: '#8D99AE', name: 'Gris' },
  { hex: '#1D1D1F', name: 'Negro' },
];
const SIDE_TEXT: Record<PlaceSide, string> = {
  top: 'encima de',
  left: 'a la izquierda de',
  right: 'a la derecha de',
  front: 'delante de',
  back: 'detrás de',
  viewer: 'frente al casco',
};
const AI_EXAMPLES = [
  'Pon una esfera dorada encima del objeto elegido',
  'Haz una torre de 3 cubos de colores sobre la mesa',
  'Rodea el objeto elegido con 4 conos pequeños',
  'Pinta todo en tonos azules',
];
const SCENE_NAMES: Record<string, string> = {
  'Simple Cube': 'Cubo rojo',
  'Simple Sphere': 'Esfera',
  'Simple Cylinder': 'Cilindro',
};
const MODE_HINT: Record<GizmoMode, string> = {
  translate: 'Arrastra una flecha de color para mover el objeto',
  rotate: 'Arrastra uno de los aros para girar el objeto',
  scale: 'Arrastra un cuadradito para cambiar el tamaño',
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const apiUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;
const displayName = (o: ObjectSnapshot) => SCENE_NAMES[o.name] ?? o.name;
const cm = (m: number) => Math.round(m * 100);
const fmt = (n: number, digits = 2) =>
  n.toLocaleString('es', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ------------------------------------------------------------------ estado
const runtimes = new Map<string, { state: RuntimeState; seenAt: number }>();
let current: RuntimeState | null = null;
let everConnected = false;
let selectedId: string | null = null;
let addShape: ObjectKind = 'cube';
/** Modelo elegido en la biblioteca (se usa cuando addShape es «model»). */
let chosenModel: ImportedModel | null = null;
let addColor = COLORS[0].hex;
let moveStep = 0.01;
let gizmoMode: GizmoMode = 'translate';
let dirty = false;
let lastSavedAt: Date | null = null;
/** Ids recién pedidos que el casco aún no ha confirmado. */
const pendingIds = new Set<string>();
const nameCounters = new Map<string, number>();
let lastListKey = '';
let aiBusy = false;
let settings: OasisSettings = { ...DEFAULT_SETTINGS };

const hot = import.meta.hot;

// ------------------------------------------------------------------ deshacer
interface HistoryEntry {
  label: string;
  inverse: RemoteCommand[];
  key?: string;
  at: number;
}
const history: HistoryEntry[] = [];

function snapshotOf(id: string): ObjectSnapshot | undefined {
  return current?.objects.find((o) => o.id === id);
}

/** Órdenes que devuelven un objeto al estado de `s`. */
function restoreCommands(s: ObjectSnapshot, stillExists: boolean): RemoteCommand[] {
  if (stillExists) {
    return [
      { type: 'setTransform', id: s.id, position: s.position, quaternion: s.quaternion, scale: s.scale },
      { type: 'color', id: s.id, color: s.color },
      { type: 'rename', id: s.id, name: s.name },
    ];
  }
  if (s.shape === 'other') return [];
  return [
    {
      type: 'add',
      id: s.id,
      name: s.name,
      shape: s.shape,
      model: s.model,
      color: s.color,
      size: s.size,
      anchorId: null,
      side: 'viewer',
      position: s.position,
      quaternion: s.quaternion,
      scale: s.scale,
    },
  ];
}

/**
 * Recuerda el estado actual de `ids` antes de cambiarlos. Con `key`, los
 * cambios seguidos del mismo tipo (flechas, deslizador) se agrupan en uno.
 */
function remember(label: string, ids: string[], key?: string): void {
  const now = Date.now();
  const last = history[history.length - 1];
  if (key && last?.key === key && now - last.at < 1500) {
    last.at = now;
    return;
  }
  const inverse = ids.flatMap((id) => {
    const s = snapshotOf(id);
    return s ? restoreCommands(s, true) : [];
  });
  if (inverse.length) history.push({ label, inverse, key, at: now });
}

function undo(): void {
  const entry = history.pop();
  if (!entry) {
    toast('No hay nada que deshacer');
    return;
  }
  for (const cmd of entry.inverse) mutate(cmd);
  toast(`Deshecho: ${entry.label}`);
  render();
}

// ------------------------------------------------------------------ envío
function send(cmd: RemoteCommand): void {
  hot?.send(CMD_EVENT, cmd);
}

/** Envía un cambio de la escena (marca que hay cambios sin guardar). */
function mutate(cmd: RemoteCommand): void {
  send(cmd);
  if (!dirty) {
    dirty = true;
    renderSaveState();
  }
}

function newId(): string {
  return `obj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextName(base: string): string {
  const n = (nameCounters.get(base) ?? 0) + 1;
  nameCounters.set(base, n);
  return `${base} ${n}`;
}

function selected(): ObjectSnapshot | undefined {
  return selectedId ? snapshotOf(selectedId) : undefined;
}

function select(id: string | null): void {
  if (id === selectedId) return;
  selectedId = id;
  send({ type: 'select', id });
  render();
}

// ------------------------------------------------------------------ avisos
function toast(
  message: string,
  opts: { kind?: 'error'; action?: { label: string; run: () => void } } = {},
): void {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  if (opts.kind) el.dataset.kind = opts.kind;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = message;
  el.append(msg);
  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = opts.action.label;
    btn.onclick = () => {
      opts.action!.run();
      dismiss();
    };
    el.append(btn);
  }
  box.append(el);
  while (box.children.length > 3) box.firstElementChild?.remove();
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  setTimeout(dismiss, opts.action ? 5500 : 3200);
}

// ------------------------------------------------------------------ acciones
function addObject(side: PlaceSide): void {
  if (!current) return;
  const id = newId();
  const isModel = addShape === 'model' && !!chosenModel;
  const name = nextName(isModel ? chosenModel!.name : SHAPE_LABEL[addShape]);
  const anchor = side === 'viewer' ? undefined : selected();
  mutate({
    type: 'add',
    id,
    name,
    shape: isModel ? 'model' : addShape === 'model' ? 'cube' : addShape,
    model: isModel ? chosenModel!.model : undefined,
    color: isModel ? '#ffffff' : addColor,
    size: Number($<HTMLInputElement>('add-size').value) / 100,
    anchorId: anchor?.id ?? null,
    side,
  });
  history.push({ label: `añadir ${name}`, inverse: [{ type: 'delete', id }], at: Date.now() });
  pendingIds.add(id);
  selectedId = id; // el casco también lo selecciona
  const where = anchor ? `${SIDE_TEXT[side]} ${displayName(anchor)}` : SIDE_TEXT.viewer;
  toast(`${name} añadido ${where}${isModel ? ' · puede tardar unos segundos en aparecer' : ''}`, {
    action: { label: 'Deshacer', run: undo },
  });
  render();
}

function duplicateSelected(): void {
  const obj = selected();
  if (!obj) return;
  const id = newId();
  const name = nextName(displayName(obj).replace(/\s\d+$/, ''));
  mutate({ type: 'duplicate', id, name, sourceId: obj.id, side: 'right' });
  history.push({ label: `duplicar ${displayName(obj)}`, inverse: [{ type: 'delete', id }], at: Date.now() });
  pendingIds.add(id);
  selectedId = id;
  toast(`Copia creada a la derecha: ${name}`, { action: { label: 'Deshacer', run: undo } });
  render();
}

function deleteSelected(): void {
  const obj = selected();
  if (!obj) return;
  history.push({ label: `eliminar ${displayName(obj)}`, inverse: restoreCommands(obj, false), at: Date.now() });
  mutate({ type: 'delete', id: obj.id });
  selectedId = null;
  toast(`${displayName(obj)} eliminado`, { action: { label: 'Deshacer', run: undo } });
  render();
}

function move(axis: 'right' | 'up' | 'toward', sign: number): void {
  const obj = selected();
  if (!obj) return;
  remember(`mover ${displayName(obj)}`, [obj.id], `move:${obj.id}`);
  const d = moveStep * sign;
  mutate({
    type: 'move',
    id: obj.id,
    right: axis === 'right' ? d : 0,
    up: axis === 'up' ? d : 0,
    toward: axis === 'toward' ? d : 0,
  });
}

function rotate(degrees: number): void {
  const obj = selected();
  if (!obj) return;
  remember(`girar ${displayName(obj)}`, [obj.id], `rotate:${obj.id}`);
  mutate({ type: 'rotate', id: obj.id, degrees });
}

function setScale(factor: number): void {
  const obj = selected();
  if (!obj || !Number.isFinite(factor)) return;
  remember(`cambiar el tamaño de ${displayName(obj)}`, [obj.id], `scale:${obj.id}`);
  mutate({ type: 'scale', id: obj.id, factor: Math.min(4, Math.max(0.25, factor)) });
}

function setColor(color: string): void {
  const obj = selected();
  if (!obj) return;
  remember(`cambiar el color de ${displayName(obj)}`, [obj.id], `color:${obj.id}`);
  mutate({ type: 'color', id: obj.id, color });
}

function setSizeRange(kind: 'shape' | 'model'): void {
  const range = SIZE_RANGE[kind];
  const input = $<HTMLInputElement>('add-size');
  if (input.min === String(range.min) && input.max === String(range.max)) return;
  input.min = String(range.min);
  input.max = String(range.max);
  input.value = String(range.value);
  $('add-size-out').textContent = `${range.value} cm`;
}

function chooseShape(kind: ShapeKind): void {
  addShape = kind;
  setSizeRange('shape');
  render();
}

function chooseModel(model: ImportedModel): void {
  chosenModel = model;
  addShape = 'model';
  setSizeRange('model');
  render();
  toast(`«${model.name}» listo. Ajusta el tamaño y pulsa dónde ponerlo.`);
}

function yawQuat(deg: number): Quat {
  const half = (deg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

async function saveScene(): Promise<void> {
  const status = $('save-status');
  if (!current) {
    toast('Conecta el casco para poder guardar la escena', { kind: 'error' });
    return;
  }
  const scene: SavedScene = {
    version: 1,
    savedAt: new Date().toISOString(),
    objects: current.objects,
  };
  status.textContent = 'Guardando…';
  status.dataset.kind = '';
  try {
    const res = await fetch(apiUrl(SCENE_ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scene),
    });
    if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
    dirty = false;
    lastSavedAt = new Date();
    renderSaveState();
    toast(`Escena guardada (${scene.objects.length} objetos)`);
  } catch (error) {
    status.textContent = 'No se pudo guardar';
    status.dataset.kind = 'error';
    toast(`No se pudo guardar: ${String(error)}. ¿Sigue abierto «npm run dev»?`, { kind: 'error' });
  }
}

async function runAi(): Promise<void> {
  const input = $<HTMLTextAreaElement>('ai-prompt');
  const prompt = input.value.trim();
  if (aiBusy) return;
  if (!prompt) {
    input.focus();
    showAiResult('error', 'Escribe primero lo que quieres crear o cambiar.');
    return;
  }
  if (!current) {
    showAiResult('error', 'Conecta el casco primero: la IA necesita ver la escena.');
    return;
  }
  aiBusy = true;
  renderAiBusy();
  showAiResult('busy', 'Pensando en tu idea… suele tardar unos segundos.');
  try {
    const res = await fetch(apiUrl(AI_ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, state: current, selectedId }),
    });
    const data = (await res.json()) as AiResponse;
    if (data.error && !data.commands?.length) {
      showAiResult('error', data.error);
      return;
    }
    if (!data.commands.length) {
      showAiResult('error', data.reply || 'No supe qué cambiar. Prueba a describirlo de otra forma.');
      return;
    }

    // Deshacer toda la idea de una vez.
    const created = new Set(data.createdIds);
    const touched = new Set<string>();
    const restores: RemoteCommand[] = [];
    for (const cmd of data.commands) {
      const id = 'id' in cmd ? cmd.id : null;
      if (!id || created.has(id) || touched.has(id)) continue;
      const s = snapshotOf(id);
      if (!s) continue;
      touched.add(id);
      restores.push(...restoreCommands(s, cmd.type !== 'delete'));
    }
    const deletesBack = data.commands.some((c) => c.type === 'delete');
    for (const cmd of data.commands) mutate(cmd);
    history.push({
      label: 'la idea generada',
      inverse: [
        ...data.createdIds.map((id): RemoteCommand => ({ type: 'delete', id })),
        ...(deletesBack ? restores.filter((c) => c.type === 'add') : []),
        ...restores.filter((c) => c.type !== 'add'),
      ],
      at: Date.now(),
    });
    data.createdIds.forEach((id) => pendingIds.add(id));
    if (data.createdIds.length) selectedId = data.createdIds[data.createdIds.length - 1];

    const parts = [];
    if (data.createdIds.length) parts.push(`${data.createdIds.length} objetos nuevos`);
    if (touched.size) parts.push(`${touched.size} objetos cambiados`);
    showAiResult('ok', data.reply || 'Listo.', `${parts.join(' · ')}. Pulsa Ctrl+Z para deshacerlo todo.`);
    input.value = '';
  } catch (error) {
    showAiResult('error', `No se pudo contactar con el servidor (${String(error)}). ¿Sigue abierto «npm run dev»?`);
  } finally {
    aiBusy = false;
    renderAiBusy();
    render();
  }
}

function showAiResult(kind: 'ok' | 'error' | 'busy', text: string, meta?: string): void {
  const result = $('ai-result');
  result.hidden = false;
  result.dataset.kind = kind;
  const ico = kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'sparkles';
  result.innerHTML = `${icon(ico, 18)}<div></div>`;
  const body = result.querySelector('div')!;
  const p = document.createElement('p');
  p.textContent = text;
  body.append(p);
  if (meta) {
    const m = document.createElement('p');
    m.className = 'meta';
    m.textContent = meta;
    body.append(m);
  }
}

function renderAiBusy(): void {
  const btn = $<HTMLButtonElement>('ai-go');
  btn.disabled = aiBusy || !current;
  btn.setAttribute('aria-busy', String(aiBusy));
  $('ai-go-label').textContent = aiBusy ? 'Creando…' : 'Crear';
}

// ------------------------------------------------------------------ render
function swatches(container: HTMLElement, onPick: (c: string) => void): void {
  container.innerHTML = '';
  for (const { hex, name } of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', name);
    b.title = name;
    b.style.setProperty('--c', hex);
    b.style.setProperty('--on', name === 'Blanco' || name === 'Amarillo' ? '#1d1d1f' : '#ffffff');
    b.dataset.color = hex;
    b.onclick = () => onPick(hex);
    container.appendChild(b);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'picker';
  picker.title = 'Otro color';
  picker.setAttribute('aria-label', 'Elegir otro color');
  picker.oninput = () => onPick(picker.value);
  container.appendChild(picker);
}

function markSwatch(container: HTMLElement, color: string | undefined): void {
  const c = color?.toLowerCase();
  container.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.color!.toLowerCase() === c)),
  );
}

function setFieldValue(id: string, value: number): void {
  const input = $<HTMLInputElement>(id);
  if (document.activeElement !== input) input.value = String(value);
}

function renderConnection(): void {
  const conn = $('connection');
  const title = $('connection-title');
  const detail = $('connection-detail');
  if (!hot) {
    conn.dataset.state = 'lost';
    title.textContent = 'Sin servidor';
    detail.textContent = 'Abre esta página desde «npm run dev»';
  } else if (!current && everConnected) {
    conn.dataset.state = 'lost';
    title.textContent = 'Se perdió la conexión';
    detail.textContent = 'Revisa que la app siga abierta en el casco';
  } else if (!current) {
    conn.dataset.state = 'waiting';
    title.textContent = 'Buscando el casco…';
    detail.textContent = 'Abre la app en el Quest';
  } else if (current.device === 'emulator') {
    conn.dataset.state = 'emulator';
    title.textContent = 'Solo emulador · casco sin conectar';
    detail.textContent = 'Los cambios se ven en el Quest simulado del computador';
  } else if (current.inXR) {
    conn.dataset.state = 'live';
    title.textContent = 'En vivo';
    detail.textContent = `${current.device === 'quest' ? 'Meta Quest' : 'Navegador'} en AR · los cambios se ven al instante`;
  } else {
    conn.dataset.state = 'idle';
    title.textContent = 'Conectado, fuera de AR';
    detail.textContent = 'Pulsa «Entrar en AR» en el casco';
  }
}

function applySettings(next: OasisSettings): void {
  settings = next;
  if (!settings.emulatorEnabled) {
    for (const [id, entry] of runtimes) {
      if (entry.state.device === 'emulator') runtimes.delete(id);
    }
    current = pickRuntime();
  }
  const on = settings.emulatorEnabled;
  const btn = $('emulator-toggle');
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('svg')!.outerHTML = icon(on ? 'monitor' : 'monitorOff', 16);
  $('emulator-label').textContent = on ? 'Emulador encendido' : 'Emulador apagado';
  render();
}

async function toggleEmulator(): Promise<void> {
  const enable = !settings.emulatorEnabled;
  try {
    const res = await fetch(apiUrl(SETTINGS_ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emulatorEnabled: enable }),
    });
    if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
    applySettings((await res.json()) as OasisSettings);
    toast(
      enable
        ? 'Emulador encendido: se recarga con la última escena guardada'
        : 'Emulador apagado: el panel solo hablará con tu casco real',
    );
  } catch (error) {
    toast(`No se pudo cambiar el emulador: ${String(error)}`, { kind: 'error' });
  }
}

function renderSaveState(): void {
  const status = $('save-status');
  const btn = $<HTMLButtonElement>('save');
  btn.disabled = !current;
  btn.title = current ? 'Guardar escena (Ctrl+S)' : 'Conecta el casco para guardar';
  if (dirty) {
    status.textContent = 'Cambios sin guardar';
    status.dataset.kind = 'dirty';
  } else if (lastSavedAt) {
    status.textContent = `Guardado a las ${lastSavedAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
    status.dataset.kind = 'ok';
  } else {
    status.textContent = '';
    status.dataset.kind = '';
  }
}

function render(): void {
  renderConnection();
  renderSaveState();
  renderAiBusy();

  const objects = current?.objects ?? [];
  for (const o of objects) pendingIds.delete(o.id);
  if (selectedId && current && !objects.some((o) => o.id === selectedId) && !pendingIds.has(selectedId)) {
    selectedId = null; // se borró (p. ej. desde otro lado)
  }

  viewport.update(current, selectedId);
  $('viewport-empty').hidden = !!current;
  $('viewport-hint').textContent = !current || !objects.length
    ? ''
    : selectedId
      ? MODE_HINT[gizmoMode]
      : 'Toca un objeto para editarlo';

  // Lista (solo se reconstruye si cambia, para no romper clics)
  $('object-count').textContent = String(objects.length);
  $('list-empty').hidden = !!current;
  const list = $('object-list');
  const listKey = JSON.stringify([
    selectedId,
    objects.map((o) => [o.id, o.name, o.color, o.shape, o.grabbed]),
  ]);
  const listChanged = listKey !== lastListKey;
  lastListKey = listKey;
  if (listChanged) {
    const hadFocus = list.contains(document.activeElement);
    list.innerHTML = '';
    for (const o of objects) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'object-item';
      btn.setAttribute('aria-pressed', String(o.id === selectedId));
      btn.innerHTML = `<span class="chip" style="--c:${o.color}"></span><span class="name"></span><span class="kind"></span>`;
      const thumbUrl = o.model ? library.thumbs.get(o.model.url) : undefined;
      if (o.shape === 'model') {
        const chip = btn.querySelector<HTMLElement>('.chip')!;
        chip.classList.add('model');
        if (thumbUrl) chip.style.backgroundImage = `url("${thumbUrl}")`;
        else chip.innerHTML = icon('box', 14);
      }
      btn.querySelector('.name')!.textContent = displayName(o);
      btn.querySelector('.kind')!.textContent = SHAPE_LABEL[o.shape] ?? 'Objeto';
      if (o.grabbed) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.title = 'Alguien lo tiene en la mano en el casco';
        badge.innerHTML = `${icon('hand', 14)}En la mano`;
        btn.append(badge);
      }
      btn.onclick = () => select(o.id === selectedId ? null : o.id);
      li.append(btn);
      list.append(li);
    }
    if (hadFocus) list.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }

  // Añadir
  document.querySelectorAll<HTMLButtonElement>('#shape-grid .shape').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.shape === addShape)),
  );
  markSwatch($('add-swatches'), addColor);
  const usingModel = addShape === 'model' && !!chosenModel;
  $('chosen-model').hidden = !usingModel;
  $('add-swatches').hidden = usingModel;
  $('model-color-note').hidden = !usingModel;
  $('step2-label').textContent = usingModel ? 'Elige el tamaño' : 'Elige color y tamaño';
  if (usingModel) {
    $('chosen-name').textContent = chosenModel!.name;
    $('chosen-credit').textContent = chosenModel!.model.credit;
    const thumb = $('chosen-thumb');
    thumb.style.backgroundImage = chosenModel!.thumb ? `url("${chosenModel!.thumb}")` : '';
    thumb.innerHTML = chosenModel!.thumb ? '' : icon('box', 22);
  }
  const sel = selected();
  const hint = $('anchor-hint');
  const pad = $('add-pad');
  const canAnchor = !!sel && !!current;
  if (!current) {
    hint.textContent = 'Conecta el casco para poder añadir objetos.';
  } else if (sel) {
    hint.innerHTML = 'Se colocará junto a <b></b>, el objeto que estás editando.';
    hint.querySelector('b')!.textContent = displayName(sel);
  } else {
    hint.textContent = 'Para ponerlo junto a otro objeto, primero elígelo en «Editar un objeto». O ponlo frente al casco.';
  }
  pad.classList.toggle('disabled', !canAnchor);
  pad.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = !canAnchor));
  const viewerBtn = $<HTMLButtonElement>('add-viewer');
  viewerBtn.disabled = !current;
  viewerBtn.classList.toggle('primary', !!current && !sel);

  // Editar
  $('edit-empty').hidden = !!sel;
  $('edit-body').hidden = !sel;
  if (sel) {
    const nameInput = $<HTMLInputElement>('edit-name');
    if (document.activeElement !== nameInput) nameInput.value = displayName(sel);
    const editChip = $('edit-chip');
    const selThumb = sel.model ? library.thumbs.get(sel.model.url) : undefined;
    editChip.style.setProperty('--c', sel.color);
    editChip.classList.toggle('model', sel.shape === 'model');
    editChip.style.backgroundImage = selThumb ? `url("${selThumb}")` : '';
    editChip.innerHTML = sel.shape === 'model' && !selThumb ? icon('box', 20) : '';
    $('h-color').closest('section')!.hidden = sel.shape === 'model';
    $('edit-meta').textContent =
      `${SHAPE_LABEL[sel.shape] ?? 'Objeto'} · ${cm(sel.dims[0])} × ${cm(sel.dims[1])} × ${cm(sel.dims[2])} cm` +
      ` · a ${cm(sel.position[1] - sel.dims[1] / 2)} cm del suelo` +
      (sel.model ? ` · ${sel.model.credit}` : '');

    const scale = $<HTMLInputElement>('edit-scale');
    if (document.activeElement !== scale) scale.value = String(sel.factor);
    $('edit-scale-out').textContent = `×${fmt(sel.factor)}`;
    setFieldValue('edit-scale-num', sel.factor);
    setFieldValue('pos-x', cm(sel.position[0]));
    setFieldValue('pos-y', cm(sel.position[1]));
    setFieldValue('pos-z', cm(sel.position[2]));
    setFieldValue('rot-y', sel.rotationDeg);
    markSwatch($('edit-swatches'), sel.color);

    const anchorSel = $<HTMLSelectElement>('place-anchor');
    if (listChanged) {
      const prev = anchorSel.value;
      anchorSel.innerHTML = '';
      for (const o of objects) {
        if (o.id === sel.id) continue;
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = displayName(o);
        anchorSel.appendChild(opt);
      }
      if (prev && objects.some((o) => o.id === prev && o.id !== sel.id)) anchorSel.value = prev;
    }
    $<HTMLButtonElement>('place-go').disabled = anchorSel.options.length === 0;
  }

  const undoBtn = $<HTMLButtonElement>('undo');
  const last = history[history.length - 1];
  undoBtn.disabled = !last;
  undoBtn.title = last ? `Deshacer: ${last.label} (Ctrl+Z)` : 'No hay nada que deshacer';

  $('ai-context').textContent = !current
    ? 'Conecta el casco para usarlo'
    : sel
      ? `Objeto elegido: ${displayName(sel)}`
      : '';
}

// ------------------------------------------------------------------ montaje
const library = new ModelLibrary({
  onChoose: chooseModel,
  toast: (message, kind) => toast(message, { kind }),
});

const viewport = new Viewport($('viewport'), {
  onSelect: (id) => select(id),
  onTransformStart: (id) => {
    const s = snapshotOf(id);
    if (s) remember(`mover ${displayName(s)} en el visor`, [id]);
  },
  onTransform: (id, position, quaternion, scale) =>
    mutate({ type: 'setTransform', id, position, quaternion, scale }),
});

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyTheme(): void {
  const dark = isDark();
  viewport.setTheme(dark);
  const btn = $('theme');
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.setAttribute('aria-label', dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
  btn.title = dark ? 'Tema claro' : 'Tema oscuro';
}

function setGizmoMode(mode: GizmoMode): void {
  gizmoMode = mode;
  viewport.setMode(mode);
  document.querySelectorAll<HTMLButtonElement>('#gizmo-mode button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  render();
}

function bindToggle(id: string, apply: (on: boolean) => void): void {
  const btn = $<HTMLButtonElement>(id);
  btn.onclick = () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    apply(on);
  };
}

function bindNumber(id: string, onCommit: (value: number) => void): void {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const v = Number(input.value.replace(',', '.'));
    if (Number.isFinite(v)) onCommit(v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

function mount(): void {
  hydrateIcons();

  const grid = $('shape-grid');
  for (const s of SHAPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shape';
    b.setAttribute('role', 'radio');
    b.dataset.shape = s.kind;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${s.icon}</svg><span>${s.label}</span>`;
    b.onclick = () => chooseShape(s.kind);
    grid.appendChild(b);
  }

  swatches($('add-swatches'), (c) => {
    addColor = c;
    render();
  });
  swatches($('edit-swatches'), setColor);

  const size = $<HTMLInputElement>('add-size');
  size.oninput = () => ($('add-size-out').textContent = `${size.value} cm`);

  document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((b) => {
    b.onclick = () => addObject(b.dataset.side as PlaceSide);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) => {
    const [axis, sign] = b.dataset.move!.split(':');
    b.onclick = () => move(axis as 'right' | 'up' | 'toward', Number(sign));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-rotate]').forEach((b) => {
    b.onclick = () => rotate(Number(b.dataset.rotate));
  });
  document.querySelectorAll<HTMLButtonElement>('#step-select button').forEach((b) => {
    b.onclick = () => {
      moveStep = Number(b.dataset.step);
      document.querySelectorAll<HTMLButtonElement>('#step-select button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
    };
  });

  const scale = $<HTMLInputElement>('edit-scale');
  scale.oninput = () => {
    $('edit-scale-out').textContent = `×${fmt(Number(scale.value))}`;
    setScale(Number(scale.value));
  };
  bindNumber('edit-scale-num', setScale);

  const commitPosition = () => {
    const obj = selected();
    if (!obj) return;
    const read = (id: string, fallback: number) => {
      const v = Number($<HTMLInputElement>(id).value.replace(',', '.'));
      return Number.isFinite(v) ? v / 100 : fallback;
    };
    remember(`mover ${displayName(obj)}`, [obj.id]);
    mutate({
      type: 'setTransform',
      id: obj.id,
      position: [read('pos-x', obj.position[0]), read('pos-y', obj.position[1]), read('pos-z', obj.position[2])],
    });
  };
  ['pos-x', 'pos-y', 'pos-z'].forEach((id) => bindNumber(id, commitPosition));
  bindNumber('rot-y', (deg) => {
    const obj = selected();
    if (!obj) return;
    remember(`girar ${displayName(obj)}`, [obj.id]);
    mutate({ type: 'setTransform', id: obj.id, quaternion: yawQuat(deg) });
  });

  const nameInput = $<HTMLInputElement>('edit-name');
  nameInput.addEventListener('change', () => {
    const obj = selected();
    const name = nameInput.value.trim();
    if (!obj || !name) return;
    remember(`renombrar ${displayName(obj)}`, [obj.id]);
    mutate({ type: 'rename', id: obj.id, name });
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
    if (e.key === 'Escape') {
      const obj = selected();
      if (obj) nameInput.value = displayName(obj);
      nameInput.blur();
    }
  });

  $('place-go').onclick = () => {
    const obj = selected();
    const anchorId = $<HTMLSelectElement>('place-anchor').value;
    const side = $<HTMLSelectElement>('place-side').value as PlaceSide;
    if (!obj || !anchorId) return;
    remember(`colocar ${displayName(obj)}`, [obj.id]);
    mutate({ type: 'place', id: obj.id, anchorId, side });
  };
  $('reset-rotation').onclick = () => {
    const obj = selected();
    if (!obj) return;
    remember(`enderezar ${displayName(obj)}`, [obj.id]);
    mutate({ type: 'resetRotation', id: obj.id });
  };
  $('duplicate').onclick = duplicateSelected;
  $('delete').onclick = deleteSelected;
  $('undo').onclick = undo;
  $('deselect').onclick = () => select(null);
  $('save').onclick = () => void saveScene();
  $('emulator-toggle').onclick = () => void toggleEmulator();
  $('open-library').onclick = () => library.open();
  $('chosen-clear').onclick = () => chooseShape('cube');

  // Visor
  document.querySelectorAll<HTMLButtonElement>('#gizmo-mode button').forEach((b) => {
    b.onclick = () => setGizmoMode(b.dataset.mode as GizmoMode);
  });
  bindToggle('snap', (on) => viewport.setSnap(on));
  bindToggle('isolate', (on) => viewport.setIsolate(on));
  $('focus').onclick = () => viewport.focus();

  // Tema
  $('theme').onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('oasis-theme', next);
    } catch {
      /* sin almacenamiento: el tema dura hasta recargar */
    }
    applyTheme();
  };
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  applyTheme();

  // IA
  const chips = $('ai-chips');
  for (const example of AI_EXAMPLES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn';
    chip.textContent = example;
    chip.onclick = () => {
      const area = $<HTMLTextAreaElement>('ai-prompt');
      area.value = example;
      area.focus();
    };
    chips.appendChild(chip);
  }
  $('ai-go').onclick = () => void runAi();
  $<HTMLTextAreaElement>('ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runAi();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault(); // avisa si hay cambios sin guardar
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveScene();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const always: Record<string, () => void> = {
      w: () => setGizmoMode('translate'),
      e: () => setGizmoMode('rotate'),
      r: () => setGizmoMode('scale'),
      f: () => viewport.focus(),
      '?': () => $('help').togglePopover(),
      Escape: () => select(null),
    };
    const withSelection: Record<string, () => void> = {
      ArrowLeft: () => move('right', -1),
      ArrowRight: () => move('right', 1),
      ArrowUp: () => move('toward', -1),
      ArrowDown: () => move('toward', 1),
      PageUp: () => move('up', 1),
      PageDown: () => move('up', -1),
      '[': () => rotate(-15),
      ']': () => rotate(15),
      d: duplicateSelected,
      Delete: deleteSelected,
    };
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fn = always[key] ?? (selectedId ? withSelection[key] : undefined);
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}

/**
 * Si hay varios conectados, manda el casco real (mejor si está en AR); el
 * emulador solo se usa cuando no hay nada más.
 */
function pickRuntime(): RuntimeState | null {
  const now = performance.now();
  let best: { state: RuntimeState; seenAt: number } | null = null;
  const base = { quest: 8, browser: 4, emulator: 0 } as const;
  const score = (s: RuntimeState) => base[s.device] + (s.inXR ? 2 : 0);
  for (const [id, entry] of runtimes) {
    if (now - entry.seenAt > 5000) {
      runtimes.delete(id); // sin latido: desconectado
      continue;
    }
    if (!best || score(entry.state) > score(best.state)) best = entry;
  }
  return best?.state ?? null;
}

mount();
render();

if (hot) {
  hot.on(SETTINGS_EVENT, (next: OasisSettings) => applySettings(next));
  hot.on(NOTICE_EVENT, (notice: { kind?: 'error'; message: string }) =>
    toast(notice.message, { kind: notice.kind }),
  );
  hot.on(BYE_EVENT, ({ runtimeId }: { runtimeId: string }) => {
    runtimes.delete(runtimeId);
    current = pickRuntime();
    render();
  });
  fetch(apiUrl(SETTINGS_ENDPOINT))
    .then((res) => (res.ok ? res.json() : null))
    .then((s: OasisSettings | null) => s && applySettings(s))
    .catch(() => {});

  hot.on(STATE_EVENT, (state: RuntimeState) => {
    if (state.device === 'emulator' && !settings.emulatorEnabled) return;
    runtimes.set(state.runtimeId, { state, seenAt: performance.now() });
    current = pickRuntime();
    // «Se perdió la conexión» solo tiene sentido para un casco real.
    if (state.device !== 'emulator') everConnected = true;
    render();
  });
  setInterval(() => {
    const next = pickRuntime();
    if (next !== current) {
      current = next;
      render();
    }
  }, 1000);
  send({ type: 'requestState' });
}
