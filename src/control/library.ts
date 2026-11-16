/**
 * Ventana «Biblioteca de modelos 3D» del panel: busca en Poly Haven y
 * Sketchfab, importa al servidor, sube archivos propios y lista los modelos
 * ya guardados. Al elegir uno llama a `onChoose`.
 */

import {
  type ImportedModel,
  LIBRARY_ENDPOINT,
  type LibraryItem,
  type LibraryStatus,
} from '../remote/protocol.js';
import { icon } from './icons.js';

type Tab = 'polyhaven' | 'sketchfab' | 'mine';

export interface LibraryCallbacks {
  onChoose(model: ImportedModel): void;
  toast(message: string, kind?: 'error'): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const api = (action: string) => `${import.meta.env.BASE_URL}${LIBRARY_ENDPOINT}/${action}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('No hay conexión con el servidor. ¿Sigue abierto «npm run dev»?');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

/** Miniatura del modelo, o un icono si no tiene. */
function fillThumb(slot: Element, url: string | null): void {
  if (!url) {
    slot.innerHTML = icon('box', 32);
    return;
  }
  const img = new Image();
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = url;
  img.onerror = () => (slot.innerHTML = icon('box', 32));
  slot.append(img);
}

export class ModelLibrary {
  private dialog = $<HTMLDialogElement>('library');
  private grid = $('lib-grid');
  private note = $('lib-note');
  private tab: Tab = 'polyhaven';
  private status: LibraryStatus = { sketchfab: false };
  private searchToken = 0;
  private mine: ImportedModel[] = [];
  /** Miniaturas conocidas por URL de modelo (para la lista de objetos). */
  readonly thumbs = new Map<string, string>();

  constructor(private callbacks: LibraryCallbacks) {
    $('library-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // clic fuera del panel
    });
    this.dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
      b.onclick = () => this.setTab(b.dataset.source as Tab);
    });
    $('lib-search').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search();
    });
    const file = $<HTMLInputElement>('lib-file');
    file.onchange = () => {
      if (file.files?.[0]) void this.upload(file.files[0]);
      file.value = '';
    };
    this.bindDropzone();
    this.bindPageDrop();
    void this.refreshStatus();
    void this.loadMine();
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
    this.setTab(this.tab);
  }

  // ---------------------------------------------------------------- pestañas

  private setTab(tab: Tab): void {
    this.tab = tab;
    this.dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
      const on = b.dataset.source === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    const isMine = tab === 'mine';
    $('lib-search').hidden = isMine;
    $('dropzone').hidden = !isMine;
    this.showNote();
    if (isMine) {
      this.renderMine();
      void this.loadMine();
    } else {
      void this.search();
      $<HTMLInputElement>('lib-q').focus();
    }
  }

  private showNote(): void {
    let text = '';
    if (this.tab === 'polyhaven') {
      text = 'Modelos realistas con licencia CC0: puedes usarlos libremente. Busca en inglés.';
    } else if (this.tab === 'sketchfab') {
      text = this.status.sketchfab
        ? 'Solo se muestran modelos descargables. Busca en inglés; algunos son pesados y tardan en cargar.'
        : 'Puedes buscar y ver modelos, pero para añadirlos falta la clave de Sketchfab del proyecto: agrega SKETCHFAB_API_TOKEN=… al archivo .env.local y reinicia npm run dev.';
    } else {
      text = 'Aquí están los modelos que ya usaste y los que subas. Funcionan sin internet.';
    }
    this.note.textContent = text;
    this.note.hidden = false;
    this.note.dataset.kind = this.tab === 'sketchfab' && !this.status.sketchfab ? 'warn' : '';
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status = await request<LibraryStatus>(api('status'));
    } catch {
      /* el aviso de la pestaña lo explicará al buscar */
    }
    if (this.dialog.open) this.showNote();
  }

  // ---------------------------------------------------------------- búsqueda

  private async search(): Promise<void> {
    if (this.tab === 'mine') return;
    const source = this.tab;
    const q = $<HTMLInputElement>('lib-q').value.trim();
    const token = ++this.searchToken;
    this.grid.innerHTML = '';
    this.grid.append(this.message('Buscando…', 'busy'));
    try {
      const items = await request<LibraryItem[]>(
        `${api('search')}?source=${source}&q=${encodeURIComponent(q)}`,
      );
      if (token !== this.searchToken) return;
      this.grid.innerHTML = '';
      if (!items.length) {
        this.grid.append(
          this.message(q ? `Nada encontrado para «${q}». Prueba con otra palabra en inglés.` : 'No hay resultados.'),
        );
        return;
      }
      for (const item of items) this.grid.append(this.card(item));
    } catch (error) {
      if (token !== this.searchToken) return;
      this.grid.innerHTML = '';
      this.grid.append(this.message(String((error as Error).message), 'error'));
    }
  }

  private card(item: LibraryItem): HTMLElement {
    const known = this.mine.find((m) => m.key === `${item.source}-${item.id}`);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lib-card';
    btn.innerHTML = `
      <span class="lib-thumb"></span>
      <span class="lib-name"></span>
      <span class="lib-meta"></span>
      <span class="lib-state"></span>`;
    fillThumb(btn.querySelector('.lib-thumb')!, item.thumb);
    btn.querySelector('.lib-name')!.textContent = item.name;
    btn.querySelector('.lib-meta')!.textContent = `${item.author} · ${item.license}`;
    const state = btn.querySelector<HTMLElement>('.lib-state')!;
    if (known) state.textContent = 'Ya descargado';
    const needsKey = item.source === 'sketchfab' && !this.status.sketchfab && !known;
    if (needsKey) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = 'Falta la clave de Sketchfab del proyecto (SKETCHFAB_API_TOKEN)';
    }
    btn.onclick = async () => {
      if (needsKey) {
        this.callbacks.toast('Para añadir modelos de Sketchfab falta la clave del proyecto en .env.local', 'error');
        return;
      }
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.classList.add('busy');
      state.textContent = known ? 'Abriendo…' : 'Descargando…';
      try {
        const model = await request<ImportedModel>(api('import'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: item.source, id: item.id }),
        });
        this.remember(model);
        this.choose(model);
      } catch (error) {
        btn.classList.add('failed');
        state.textContent = 'No se pudo';
        this.callbacks.toast((error as Error).message, 'error');
      } finally {
        delete btn.dataset.busy;
        btn.classList.remove('busy');
      }
    };
    return btn;
  }

  // ---------------------------------------------------------------- mis modelos

  private async loadMine(): Promise<void> {
    try {
      this.mine = await request<ImportedModel[]>(api('list'));
      for (const m of this.mine) if (m.thumb) this.thumbs.set(m.model.url, m.thumb);
      if (this.tab === 'mine' && this.dialog.open) this.renderMine();
    } catch {
      /* sin servidor: la lista queda vacía */
    }
  }

  private renderMine(): void {
    this.grid.innerHTML = '';
    if (!this.mine.length) {
      this.grid.append(this.message('Todavía no tienes modelos. Sube un .glb o elige uno en Poly Haven o Sketchfab.'));
      return;
    }
    for (const m of this.mine) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lib-card';
      btn.innerHTML = `
        <span class="lib-thumb"></span>
        <span class="lib-name"></span>
        <span class="lib-meta"></span>`;
      fillThumb(btn.querySelector('.lib-thumb')!, m.thumb);
      btn.querySelector('.lib-name')!.textContent = m.name;
      btn.querySelector('.lib-meta')!.textContent = m.model.credit;
      btn.onclick = () => this.choose(m);
      this.grid.append(btn);
    }
  }

  private remember(model: ImportedModel): void {
    this.mine = [model, ...this.mine.filter((m) => m.key !== model.key)];
    if (model.thumb) this.thumbs.set(model.model.url, model.thumb);
  }

  private choose(model: ImportedModel): void {
    this.dialog.close();
    this.callbacks.onChoose(model);
  }

  // ---------------------------------------------------------------- subir

  private async upload(file: File): Promise<void> {
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      this.callbacks.toast('Solo se pueden subir archivos .glb o .gltf', 'error');
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      this.callbacks.toast('El archivo pesa más de 60 MB. Prueba a comprimirlo o reducir texturas.', 'error');
      return;
    }
    const zone = $('dropzone');
    zone.classList.add('busy');
    const label = zone.querySelector('strong')!;
    const before = label.textContent;
    label.textContent = `Subiendo «${file.name}»…`;
    try {
      const model = await request<ImportedModel>(
        `${api('upload')}?name=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      this.remember(model);
      this.choose(model);
    } catch (error) {
      this.callbacks.toast((error as Error).message, 'error');
    } finally {
      zone.classList.remove('busy');
      label.textContent = before;
    }
  }

  private bindDropzone(): void {
    const zone = $('dropzone');
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.upload(file);
    });
  }

  /** También se puede soltar un .glb en cualquier parte del panel. */
  private bindPageDrop(): void {
    const overlay = $('drop-overlay');
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || this.dialog.open) return;
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        overlay.hidden = true;
      }
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const file = e.dataTransfer?.files?.[0];
      if (file && !this.dialog.open) void this.upload(file);
    });
  }

  private message(text: string, kind?: 'busy' | 'error'): HTMLElement {
    const p = document.createElement('p');
    p.className = 'lib-message';
    if (kind) p.dataset.kind = kind;
    p.textContent = text;
    return p;
  }
}
