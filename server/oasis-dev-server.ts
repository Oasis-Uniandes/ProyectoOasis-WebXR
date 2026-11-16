/**
 * Plugin de Vite (solo en `npm run dev`) para el panel de control:
 *
 * - Reenvía mensajes panel ⇄ casco por el WebSocket de HMR.
 * - GET/POST /__oasis/scene: lee/guarda la escena en `saved/oasis-scene.json`.
 * - POST /__oasis/ai: convierte una idea escrita en órdenes de edición con
 *   Claude (structured outputs). Necesita ANTHROPIC_API_KEY en `.env.local`.
 * - /__oasis/library/*: biblioteca de modelos (Poly Haven, Sketchfab con la
 *   clave SKETCHFAB_API_TOKEN del proyecto, y archivos subidos).
 *
 * La clave de la API vive solo en este proceso de Node: nunca llega al
 * navegador ni al casco.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { loadEnv, type Plugin } from 'vite';
import { z } from 'zod';
import { LibraryError, MAX_UPLOAD_BYTES, ModelLibrary } from './library.js';
import {
  AI_ENDPOINT,
  type AiRequest,
  type AiResponse,
  BYE_EVENT,
  CMD_EVENT,
  DEFAULT_SETTINGS,
  type OasisSettings,
  PLACE_SIDES,
  type RemoteCommand,
  SCALE_MAX,
  SCALE_MIN,
  SCENE_ENDPOINT,
  LIBRARY_ENDPOINT,
  type LibrarySource,
  MODELS_PATH,
  SETTINGS_ENDPOINT,
  SETTINGS_EVENT,
  SHAPES,
  STATE_EVENT,
} from '../src/remote/protocol.js';

const MODEL = 'claude-opus-5-5';

const SHAPE_LABEL: Record<string, string> = {
  cube: 'Cubo',
  sphere: 'Esfera',
  cylinder: 'Cilindro',
  cone: 'Cono',
  pyramid: 'Pirámide',
  torus: 'Aro',
  capsule: 'Cápsula',
  slab: 'Tabla',
};

// ------------------------------------------------------------------ esquema IA
const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });
const Operation = z.object({
  action: z.enum([
    'add',
    'move_to',
    'move_by',
    'place',
    'rotate',
    'set_rotation',
    'scale',
    'color',
    'rename',
    'delete',
  ]),
  target: z
    .string()
    .describe(
      'Id of an existing object, or for "add" a new reference like "new-1" that later operations can use.',
    ),
  name: z.string().nullable().describe('Display name in Spanish (add/rename).'),
  shape: z.enum(SHAPES).nullable(),
  color: z.string().nullable().describe('Hex color like #3A86FF (add/color).'),
  size_cm: z
    .number()
    .nullable()
    .describe('Characteristic size of a new object in centimeters (add).'),
  position: Point.nullable().describe(
    'World position of the object CENTER in meters (add/move_to).',
  ),
  offset_cm: z
    .object({ right: z.number(), up: z.number(), toward: z.number() })
    .nullable()
    .describe(
      'Relative move in cm from the headset wearer point of view: right, up, toward the wearer (move_by).',
    ),
  anchor: z
    .string()
    .nullable()
    .describe('Object id or new reference to place next to (add/place).'),
  side: z.enum(PLACE_SIDES).nullable(),
  degrees: z
    .number()
    .nullable()
    .describe('Yaw degrees: delta for rotate, absolute for set_rotation.'),
  scale_factor: z
    .number()
    .nullable()
    .describe('Multiplier of the CURRENT size, e.g. 2 = twice as big (scale).'),
});
const Plan = z.object({
  reply: z
    .string()
    .describe('One or two short sentences in Spanish describing what you did.'),
  operations: z.array(Operation),
});
type PlanT = z.infer<typeof Plan>;

const SYSTEM_PROMPT = `You edit a live mixed-reality (AR) scene that a person sees through a Meta Quest headset while another person types ideas in Spanish on a computer.

Coordinates: meters, Y is up, the real floor is y=0. Objects are simple primitives: cube, sphere, cylinder, cone, pyramid, torus (a flat ring), capsule, slab (a flat board 2×size wide, 0.15×size tall, 1.2×size deep). Positions are object centers. "dims" are the current world bounding-box width/height/depth.

You get the current scene as JSON: objects (with ids), the headset wearer (position plus horizontal forward/right unit vectors) and real horizontal surfaces detected in the room (tables, floor) with their height and extent.

Turn the request into operations:
- To stack or put something next to an object, prefer "add"/"place" with an anchor and side (top, left, right, front, back; directions are from the wearer's view). Use "position" for compositions that need precise layouts (e.g. table legs, rings of objects); compute it from the anchor's position and dims so pieces touch without overlapping. Something resting on a surface has center y = surface height + half its height.
- New objects created in the same request can be referenced by their "new-N" target in later operations.
- "el seleccionado" / "esto" refers to selectedId.
- Keep sizes realistic for a tabletop (typically 3–30 cm) unless asked otherwise.
- Use pleasant hex colors. Never delete objects unless explicitly asked.
- If the request is unclear or impossible, return no operations and explain briefly in "reply".
Fill every field; use null for fields that do not apply to an action.`;

// ------------------------------------------------------------------ utilidades
function readBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new LibraryError('El archivo es demasiado grande (máximo 60 MB)', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Petición demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function yawQuat(deg: number): [number, number, number, number] {
  const half = (deg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/** Resumen compacto del estado para el modelo. */
function describeScene(req: AiRequest): string {
  const { state } = req;
  const yaw = (state.viewer.yawDeg * Math.PI) / 180;
  const forward = [-Math.sin(yaw), 0, -Math.cos(yaw)].map((n) => +n.toFixed(2));
  const right = [-forward[2], 0, forward[0]].map((n) => +n.toFixed(2) || 0);
  const surfaces = state.planes
    .filter((p) => p.orientation === 'horizontal' && p.points.length >= 9)
    .map((p) => {
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      for (let i = 0; i < p.points.length; i += 3) {
        xs.push(p.points[i]);
        ys.push(p.points[i + 1]);
        zs.push(p.points[i + 2]);
      }
      const avg = (a: number[]) => +(a.reduce((s, n) => s + n, 0) / a.length).toFixed(2);
      return {
        height: avg(ys),
        center: [avg(xs), avg(zs)],
        extent_xz: [
          +(Math.max(...xs) - Math.min(...xs)).toFixed(2),
          +(Math.max(...zs) - Math.min(...zs)).toFixed(2),
        ],
      };
    });
  return JSON.stringify({
    selectedId: req.selectedId,
    wearer: { position: state.viewer.position, forward, right },
    surfaces,
    objects: state.objects.map((o) => ({
      id: o.id,
      name: o.name,
      shape: o.shape,
      color: o.color,
      position: o.position,
      dims: o.dims,
      yawDeg: o.rotationDeg,
    })),
  });
}

/** Traduce el plan del modelo a órdenes del protocolo. */
function planToCommands(plan: PlanT, req: AiRequest): AiResponse {
  const existing = new Map(req.state.objects.map((o) => [o.id, o]));
  const refs = new Map<string, string>();
  const factors = new Map<string, number>();
  const commands: RemoteCommand[] = [];
  const createdIds: string[] = [];
  const stamp = Date.now().toString(36);

  const resolve = (ref: string | null): string | null => {
    if (!ref) return null;
    if (refs.has(ref)) return refs.get(ref)!;
    return existing.has(ref) ? ref : null;
  };

  plan.operations.forEach((op, i) => {
    if (op.action === 'add') {
      const shape = op.shape ?? 'cube';
      const id = `ai-${stamp}-${i}`;
      refs.set(op.target, id);
      createdIds.push(id);
      factors.set(id, 1);
      const anchorId = resolve(op.anchor);
      commands.push({
        type: 'add',
        id,
        name: op.name || SHAPE_LABEL[shape],
        shape,
        color: op.color || '#8D99AE',
        size: Math.min(1.5, Math.max(0.01, (op.size_cm ?? 10) / 100)),
        anchorId,
        side: op.side ?? (anchorId ? 'top' : 'viewer'),
        position: op.position ? [op.position.x, op.position.y, op.position.z] : undefined,
      });
      if (op.degrees) commands.push({ type: 'rotate', id, degrees: op.degrees });
      return;
    }

    const id = resolve(op.target);
    if (!id) return;
    switch (op.action) {
      case 'move_to':
        if (op.position) {
          commands.push({
            type: 'setTransform',
            id,
            position: [op.position.x, op.position.y, op.position.z],
          });
        }
        break;
      case 'move_by':
        if (op.offset_cm) {
          commands.push({
            type: 'move',
            id,
            right: op.offset_cm.right / 100,
            up: op.offset_cm.up / 100,
            toward: op.offset_cm.toward / 100,
          });
        }
        break;
      case 'place':
        commands.push({
          type: 'place',
          id,
          anchorId: resolve(op.anchor),
          side: op.side ?? 'top',
        });
        break;
      case 'rotate':
        if (op.degrees) commands.push({ type: 'rotate', id, degrees: op.degrees });
        break;
      case 'set_rotation':
        commands.push({ type: 'setTransform', id, quaternion: yawQuat(op.degrees ?? 0) });
        break;
      case 'scale': {
        const current = factors.get(id) ?? existing.get(id)?.factor ?? 1;
        const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, current * (op.scale_factor ?? 1)));
        factors.set(id, next);
        commands.push({ type: 'scale', id, factor: next });
        break;
      }
      case 'color':
        if (op.color) commands.push({ type: 'color', id, color: op.color });
        break;
      case 'rename':
        if (op.name) commands.push({ type: 'rename', id, name: op.name });
        break;
      case 'delete':
        commands.push({ type: 'delete', id });
        break;
    }
  });

  return { reply: plan.reply, commands, createdIds };
}

let client: Anthropic | null = null;

async function runAi(req: AiRequest): Promise<AiResponse> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(Plan) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Scene:\n${describeScene(req)}\n\nRequest (Spanish): ${req.prompt}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    return { reply: 'No puedo hacer esa petición.', commands: [], createdIds: [] };
  }
  if (!response.parsed_output) {
    return {
      reply: 'No entendí la respuesta del modelo. Intenta escribirlo de otra forma.',
      commands: [],
      createdIds: [],
      error: `stop_reason=${response.stop_reason}`,
    };
  }
  return planToCommands(response.parsed_output, req);
}

function aiErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'La clave de la API no es válida. Revisa ANTHROPIC_API_KEY en .env.local.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Demasiadas peticiones seguidas. Espera unos segundos y vuelve a intentarlo.';
  }
  if (error instanceof Anthropic.APIError) {
    return `Error de la API (${error.status ?? 'sin estado'}): ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication method|api ?key/i.test(message)) {
    return 'Falta la clave de la API: crea el archivo .env.local con ANTHROPIC_API_KEY=… y reinicia npm run dev.';
  }
  return message;
}

// ------------------------------------------------------------------ plugin
export function oasisDevServer(): Plugin {
  let sceneFile = '';
  let settingsFile = '';
  let settings: OasisSettings = { ...DEFAULT_SETTINGS };
  let library!: ModelLibrary;
  return {
    name: 'oasis-dev-server',
    apply: 'serve',
    configResolved(config) {
      sceneFile = path.join(config.root, 'saved', 'oasis-scene.json');
      settingsFile = path.join(config.root, 'saved', 'oasis-settings.json');
      const env = loadEnv(config.mode, config.root, ['ANTHROPIC_', 'SKETCHFAB_']);
      if (env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      }
      if (env.SKETCHFAB_API_TOKEN && !process.env.SKETCHFAB_API_TOKEN) {
        process.env.SKETCHFAB_API_TOKEN = env.SKETCHFAB_API_TOKEN;
      }
      library = new ModelLibrary(path.join(config.root, 'saved', 'models'), () =>
        process.env.SKETCHFAB_API_TOKEN?.trim() || undefined,
      );
    },
    configureServer(server) {
      for (const event of [CMD_EVENT, STATE_EVENT, BYE_EVENT]) {
        server.ws.on(event, (data) => server.ws.send(event, data));
      }

      // Configuración persistente (sobrevive a reinicios del servidor).
      readFile(settingsFile, 'utf8')
        .then((text) => (settings = { ...DEFAULT_SETTINGS, ...JSON.parse(text) }))
        .catch(() => {});

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        try {
          // ------------------------------------------------ modelos 3D
          const modelsAt = url.indexOf(`/${MODELS_PATH}`);
          if (modelsAt !== -1 && req.method === 'GET') {
            const rel = url.slice(modelsAt + MODELS_PATH.length + 1);
            if (!(await library.serve(rel, res))) sendJson(res, 404, { error: 'Modelo no encontrado' });
            return;
          }
          const libAt = url.indexOf(`/${LIBRARY_ENDPOINT}/`);
          if (libAt !== -1) {
            const action = url.slice(libAt + LIBRARY_ENDPOINT.length + 2);
            const params = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              if (action === 'status') return sendJson(res, 200, library.status());
              if (action === 'list') return sendJson(res, 200, await library.list());
              if (action === 'search') {
                const source = (params.get('source') ?? 'polyhaven') as LibrarySource;
                return sendJson(res, 200, await library.search(source, params.get('q') ?? ''));
              }
              if (action === 'import' && req.method === 'POST') {
                const body = JSON.parse(await readBody(req)) as { source: LibrarySource; id: string };
                return sendJson(res, 200, await library.import(body.source, String(body.id)));
              }
              if (action === 'upload' && req.method === 'POST') {
                const name = params.get('name') ?? 'modelo.glb';
                return sendJson(res, 200, await library.upload(name, await readBinary(req, MAX_UPLOAD_BYTES)));
              }
              return sendJson(res, 404, { error: 'Acción desconocida' });
            } catch (error) {
              server.config.logger.error(`[oasis-library] ${String(error)}`);
              const status = error instanceof LibraryError ? error.status : 502;
              const message =
                error instanceof LibraryError
                  ? error.message
                  : 'No se pudo contactar con la biblioteca. ¿Hay conexión a internet?';
              return sendJson(res, status, { error: message });
            }
          }

          if (url.endsWith(`/${SETTINGS_ENDPOINT}`)) {
            if (req.method === 'POST') {
              const patch = JSON.parse(await readBody(req)) as Partial<OasisSettings>;
              if (typeof patch.emulatorEnabled === 'boolean') {
                settings = { ...settings, emulatorEnabled: patch.emulatorEnabled };
              }
              await mkdir(path.dirname(settingsFile), { recursive: true });
              await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
              server.ws.send(SETTINGS_EVENT, settings);
            }
            res.setHeader('Cache-Control', 'no-store');
            sendJson(res, 200, settings);
            return;
          }

          if (url.endsWith(`/${SCENE_ENDPOINT}`)) {
            if (req.method === 'GET') {
              try {
                const text = await readFile(sceneFile, 'utf8');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(text);
              } catch {
                sendJson(res, 404, { error: 'No hay escena guardada' });
              }
              return;
            }
            if (req.method === 'POST') {
              const scene = JSON.parse(await readBody(req));
              if (!Array.isArray(scene?.objects)) {
                sendJson(res, 400, { error: 'Escena inválida' });
                return;
              }
              await mkdir(path.dirname(sceneFile), { recursive: true });
              await writeFile(sceneFile, JSON.stringify(scene, null, 2), 'utf8');
              sendJson(res, 200, { ok: true, file: 'saved/oasis-scene.json' });
              return;
            }
          }

          if (url.endsWith(`/${AI_ENDPOINT}`) && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as AiRequest;
            if (!body?.prompt?.trim() || !body.state) {
              sendJson(res, 400, { error: 'Falta el texto o el estado de la escena' });
              return;
            }
            try {
              sendJson(res, 200, await runAi(body));
            } catch (error) {
              server.config.logger.error(`[oasis-ai] ${String(error)}`);
              const failure: AiResponse = {
                reply: '',
                commands: [],
                createdIds: [],
                error: aiErrorMessage(error),
              };
              sendJson(res, 200, failure);
            }
            return;
          }
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
          return;
        }
        next();
      });
    },
  };
}
