/**
 * Biblioteca de modelos 3D para el panel de control (solo en desarrollo).
 *
 * - Poly Haven: modelos CC0, sin clave.
 * - Sketchfab: buscar no necesita clave; descargar usa UNA clave del proyecto
 *   (SKETCHFAB_API_TOKEN en .env.local) que nunca sale de este servidor.
 * - Subidas: archivos .glb (o .gltf autocontenidos) arrastrados al panel.
 *
 * Todo se guarda en `saved/models/<clave>/` y se sirve en /__oasis/models/,
 * así una escena guardada sigue funcionando aunque no haya internet.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type {
  ImportedModel,
  LibraryItem,
  LibrarySource,
  LibraryStatus,
} from '../src/remote/protocol.js';

/** Identificación genérica para las APIs públicas (sin datos personales). */
const USER_AGENT = 'OasisWebXR-dev/0.1';
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
};

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class ModelLibrary {
  private polyHavenIndex: Promise<Record<string, PolyHavenAsset>> | null = null;

  constructor(
    private readonly modelsDir: string,
    private readonly sketchfabToken: () => string | undefined,
  ) {}

  status(): LibraryStatus {
    return { sketchfab: !!this.sketchfabToken() };
  }

  // ---------------------------------------------------------------- búsqueda

  async search(source: LibrarySource, query: string): Promise<LibraryItem[]> {
    if (source === 'polyhaven') return this.searchPolyHaven(query);
    if (source === 'sketchfab') return this.searchSketchfab(query);
    return [];
  }

  private async searchPolyHaven(query: string): Promise<LibraryItem[]> {
    this.polyHavenIndex ??= getJson<Record<string, PolyHavenAsset>>(
      'https://api.polyhaven.com/assets?type=models',
    ).catch((error) => {
      this.polyHavenIndex = null; // reintentar la próxima vez
      throw error;
    });
    const assets = await this.polyHavenIndex;
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return Object.entries(assets)
      .filter(([id, a]) => {
        if (!words.length) return true;
        const haystack = normalize(
          [id, a.name, ...(a.tags ?? []), ...(a.categories ?? [])].join(' '),
        );
        return words.every((w) => haystack.includes(w));
      })
      .sort((a, b) => (b[1].download_count ?? 0) - (a[1].download_count ?? 0))
      .slice(0, 48)
      .map(([id, a]) => ({
        source: 'polyhaven' as const,
        id,
        name: a.name,
        thumb: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
        author: Object.keys(a.authors ?? {}).join(', ') || 'Poly Haven',
        license: 'CC0',
      }));
  }

  private async searchSketchfab(query: string): Promise<LibraryItem[]> {
    const url = new URL('https://api.sketchfab.com/v3/search');
    url.searchParams.set('type', 'models');
    url.searchParams.set('downloadable', 'true');
    url.searchParams.set('count', '24');
    url.searchParams.set('sort_by', '-likeCount');
    if (query.trim()) url.searchParams.set('q', query.trim());
    const data = await getJson<{ results: SketchfabModel[] }>(url.toString());
    return (data.results ?? []).map((m) => ({
      source: 'sketchfab' as const,
      id: m.uid,
      name: m.name,
      thumb: pickThumb(m.thumbnails?.images),
      author: m.user?.displayName || m.user?.username || 'Sketchfab',
      license: m.license?.label ?? 'Creative Commons',
    }));
  }

  // ---------------------------------------------------------------- importar

  async list(): Promise<ImportedModel[]> {
    try {
      const text = await readFile(this.indexFile, 'utf8');
      return (JSON.parse(text) as ImportedModel[]).sort((a, b) =>
        b.importedAt.localeCompare(a.importedAt),
      );
    } catch {
      return [];
    }
  }

  async import(source: LibrarySource, id: string): Promise<ImportedModel> {
    if (!/^[\w-]{1,80}$/.test(id)) throw new LibraryError('Identificador de modelo no válido');
    const key = `${source}-${id}`;
    const existing = (await this.list()).find((m) => m.key === key);
    if (existing) return existing;

    let entry: ImportedModel;
    if (source === 'polyhaven') entry = await this.importPolyHaven(id, key);
    else if (source === 'sketchfab') entry = await this.importSketchfab(id, key);
    else throw new LibraryError('Origen desconocido');
    await this.remember(entry);
    return entry;
  }

  private async importPolyHaven(id: string, key: string): Promise<ImportedModel> {
    const files = await getJson<PolyHavenFiles>(`https://api.polyhaven.com/files/${id}`);
    const variants = files.gltf;
    const variant = variants?.['1k'] ?? variants?.['2k'] ?? Object.values(variants ?? {})[0];
    const main = variant?.gltf;
    if (!main?.url) throw new LibraryError('Este modelo no tiene versión glTF', 404);

    const dir = this.dirFor(key);
    const mainName = path.posix.basename(new URL(main.url).pathname);
    await this.saveFile(dir, mainName, await download(main.url));
    for (const [relPath, file] of Object.entries(main.include ?? {})) {
      await this.saveFile(dir, relPath, await download(file.url));
    }

    const info = (await this.searchPolyHaven('')).find((m) => m.id === id);
    const name = info?.name ?? id;
    return {
      key,
      source: 'polyhaven',
      id,
      name,
      thumb: info?.thumb ?? null,
      model: {
        url: `__oasis/models/${key}/${mainName}`,
        credit: `«${name}» de ${info?.author ?? 'Poly Haven'} · Poly Haven · CC0`,
      },
      importedAt: new Date().toISOString(),
    };
  }

  private async importSketchfab(uid: string, key: string): Promise<ImportedModel> {
    const token = this.sketchfabToken();
    if (!token) {
      throw new LibraryError(
        'Falta la clave de Sketchfab del proyecto: añade SKETCHFAB_API_TOKEN=… a .env.local y reinicia npm run dev.',
        412,
      );
    }
    const meta = await getJson<SketchfabModel>(`https://api.sketchfab.com/v3/models/${uid}`);
    let links: SketchfabDownload;
    try {
      links = await getJson<SketchfabDownload>(
        `https://api.sketchfab.com/v3/models/${uid}/download`,
        { Authorization: `Token ${token}` },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        throw new LibraryError('La clave de Sketchfab no es válida. Revisa SKETCHFAB_API_TOKEN en .env.local.', 401);
      }
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
        throw new LibraryError('Sketchfab no permite descargar este modelo. Prueba con otro.', 403);
      }
      throw error;
    }

    const dir = this.dirFor(key);
    let mainName: string;
    if (links.glb?.url) {
      mainName = 'model.glb';
      await this.saveFile(dir, mainName, await download(links.glb.url));
    } else if (links.gltf?.url) {
      const zip = unzipSync(new Uint8Array(await download(links.gltf.url)));
      const names = Object.keys(zip).filter((n) => !n.endsWith('/'));
      const gltfName =
        names.find((n) => /(^|\/)scene\.gltf$/i.test(n)) ?? names.find((n) => /\.gltf$/i.test(n));
      if (!gltfName) throw new LibraryError('El paquete de Sketchfab no trae un archivo glTF', 422);
      for (const name of names) await this.saveFile(dir, name, Buffer.from(zip[name]));
      mainName = gltfName;
    } else {
      throw new LibraryError('Sketchfab no ofrece este modelo en glTF', 422);
    }

    const author = meta.user?.displayName || meta.user?.username || 'Sketchfab';
    const license = meta.license?.label ?? 'Creative Commons';
    return {
      key,
      source: 'sketchfab',
      id: uid,
      name: meta.name,
      thumb: pickThumb(meta.thumbnails?.images),
      model: {
        url: `__oasis/models/${key}/${mainName}`,
        credit: `«${meta.name}» de ${author} · Sketchfab · ${license}`,
      },
      importedAt: new Date().toISOString(),
    };
  }

  /** Guarda un archivo arrastrado al panel. */
  async upload(fileName: string, data: Buffer): Promise<ImportedModel> {
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== '.glb' && ext !== '.gltf') {
      throw new LibraryError('Solo se aceptan archivos .glb o .gltf');
    }
    if (ext === '.glb' && data.subarray(0, 4).toString('latin1') !== 'glTF') {
      throw new LibraryError('El archivo no parece un .glb válido');
    }
    if (ext === '.gltf') {
      let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
      try {
        json = JSON.parse(data.toString('utf8'));
      } catch {
        throw new LibraryError('El archivo .gltf no es un JSON válido');
      }
      const external = [...(json.buffers ?? []), ...(json.images ?? [])].some(
        (r) => r.uri && !r.uri.startsWith('data:'),
      );
      if (external) {
        throw new LibraryError(
          'Este .gltf usa archivos aparte (.bin o texturas). Súbelo como .glb, que lo trae todo en un solo archivo.',
        );
      }
    }

    const hash = createHash('sha1').update(data).digest('hex').slice(0, 10);
    const key = `upload-${hash}`;
    const existing = (await this.list()).find((m) => m.key === key);
    if (existing) return existing;

    const base = path.basename(fileName, ext);
    const safe = `${base.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'modelo'}${ext}`;
    await this.saveFile(this.dirFor(key), safe, data);
    const entry: ImportedModel = {
      key,
      source: 'upload',
      id: hash,
      name: base.replace(/[_-]+/g, ' ').trim() || 'Mi modelo',
      thumb: null,
      model: { url: `__oasis/models/${key}/${safe}`, credit: 'Modelo propio' },
      importedAt: new Date().toISOString(),
    };
    await this.remember(entry);
    return entry;
  }

  // ---------------------------------------------------------------- servir

  /** Sirve /__oasis/models/<ruta>. Devuelve false si la ruta no es válida. */
  async serve(relPath: string, res: ServerResponse): Promise<boolean> {
    const file = path.resolve(this.modelsDir, decodeURIComponent(relPath));
    if (!file.startsWith(path.resolve(this.modelsDir) + path.sep)) return false;
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(info.size));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(await readFile(file));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- internos

  private get indexFile(): string {
    return path.join(this.modelsDir, 'index.json');
  }

  private dirFor(key: string): string {
    return path.join(this.modelsDir, key);
  }

  private async saveFile(dir: string, relPath: string, data: Buffer): Promise<void> {
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new LibraryError('Ruta de archivo no válida dentro del modelo', 422);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  private async remember(entry: ImportedModel): Promise<void> {
    const list = (await this.list()).filter((m) => m.key !== entry.key);
    list.unshift(entry);
    await mkdir(this.modelsDir, { recursive: true });
    await writeFile(this.indexFile, JSON.stringify(list, null, 2), 'utf8');
  }
}

// ------------------------------------------------------------------ HTTP

class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} en ${new URL(url).host}`);
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new HttpError(res.status, url);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new LibraryError('El modelo es demasiado grande (más de 120 MB)', 413);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_DOWNLOAD_BYTES) throw new LibraryError('El modelo es demasiado grande (más de 120 MB)', 413);
  return data;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function pickThumb(images?: { url: string; width: number }[]): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => Math.abs(a.width - 256) - Math.abs(b.width - 256));
  return sorted[0].url;
}

// ------------------------------------------------------------------ tipos externos

interface PolyHavenAsset {
  name: string;
  tags?: string[];
  categories?: string[];
  authors?: Record<string, string>;
  download_count?: number;
}

interface PolyHavenFile {
  url: string;
  size?: number;
  include?: Record<string, { url: string; size?: number }>;
}

interface PolyHavenFiles {
  gltf?: Record<string, { gltf?: PolyHavenFile }>;
}

interface SketchfabModel {
  uid: string;
  name: string;
  user?: { displayName?: string; username?: string };
  license?: { label?: string };
  thumbnails?: { images?: { url: string; width: number }[] };
}

interface SketchfabDownload {
  glb?: { url: string };
  gltf?: { url: string };
}
