import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// No 0/O, 1/l/I so links are easy to read out loud or retype.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 10;
export const ID_PATTERN = /^[A-Za-z0-9]{10}$/;

// Leftover temp/orphan files older than this are swept up by cleanup().
const STALE_MS = 60 * 60 * 1000;

export class TooLargeError extends Error {}
export class EmptyError extends Error {}

function newId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

export function createStore({ dataDir, ttlMs, now = Date.now }) {
  const metaPath = (id) => path.join(dataDir, `${id}.json`);
  const dataPath = (id) => path.join(dataDir, `${id}.bin`);

  async function writeMeta(meta) {
    const tmp = `${metaPath(meta.id)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta));
    await fsp.rename(tmp, metaPath(meta.id));
  }

  async function readMeta(id) {
    try {
      return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async function remove(id) {
    // Meta goes first so the item disappears before its data does.
    await fsp.rm(metaPath(id), { force: true });
    await fsp.rm(dataPath(id), { force: true });
  }

  return {
    async init() {
      await fsp.mkdir(dataDir, { recursive: true });
    },

    // Streams `source` to disk (up to maxBytes) and returns the saved item's metadata.
    async put({ kind, name = null, type, source, maxBytes }) {
      let id;
      do id = newId();
      while (fs.existsSync(metaPath(id)) || fs.existsSync(dataPath(id)));
      const tmp = `${dataPath(id)}.tmp`;

      let size = 0;
      const limit = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) cb(new TooLargeError());
          else cb(null, chunk);
        },
      });

      try {
        await pipeline(source, limit, fs.createWriteStream(tmp, { flags: 'wx' }));
        if (size === 0) throw new EmptyError();
        await fsp.rename(tmp, dataPath(id));
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }

      const createdAt = now();
      const meta = { id, kind, name, type, size, createdAt, expiresAt: createdAt + ttlMs };
      await writeMeta(meta);
      return meta;
    },

    // Returns metadata for a live item, or null if it is missing or expired.
    async get(id) {
      if (!ID_PATTERN.test(id)) return null;
      const meta = await readMeta(id);
      if (!meta) return null;
      if (meta.expiresAt <= now()) {
        await remove(id);
        return null;
      }
      return meta;
    },

    readStream(id) {
      return fs.createReadStream(dataPath(id));
    },

    async readText(id) {
      return fsp.readFile(dataPath(id), 'utf8');
    },

    remove,

    // Deletes expired items plus any temp or orphaned files left by crashes.
    async cleanup() {
      const t = now();
      let removed = 0;
      let files;
      try {
        files = await fsp.readdir(dataDir);
      } catch {
        return 0;
      }
      const names = new Set(files);
      for (const file of files) {
        const full = path.join(dataDir, file);
        const id = file.slice(0, ID_LENGTH);
        if (file.endsWith('.json') && ID_PATTERN.test(id)) {
          const meta = await readMeta(id);
          if (!meta || meta.expiresAt <= t) {
            await remove(id);
            removed++;
          }
        } else if (file.endsWith('.tmp') || (file.endsWith('.bin') && !names.has(`${id}.json`))) {
          try {
            const { mtimeMs } = await fsp.stat(full);
            if (mtimeMs < Date.now() - STALE_MS) await fsp.rm(full, { force: true });
          } catch {
            // Already gone.
          }
        }
      }
      return removed;
    },
  };
}
