import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const AUTH_BACKUP_FILE = path.join(__dirname, 'data', 'members-backup.json');
const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let pool = null;

export function initDb() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });
  return pool;
}

export async function ensureUsersTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      salt VARCHAR(255) NOT NULL,
      hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'user',
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function hashPassword(password) {
  const salt = crypto.randomUUID();
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const computed = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return computed === hash;
}

async function loadJsonUsers() {
  let parsed = null;

  // GitHub에서 최신 데이터를 먼저 가져옵니다 (Render 재시작 대응)
  if (GITHUB_TOKEN) {
    const repo = await getGitHubRepo();
    if (repo) {
      try {
        const data = await fetchFileFromGitHub(repo, 'data/auth.json');
        if (data) {
          parsed = data;
          console.log('[DB] Loaded users from GitHub data/auth.json');
          await saveJsonUsersLocal(parsed);
        }
      } catch (err) {
        console.error('[DB] Failed to fetch auth.json from GitHub:', err.message);
      }
    }
  }

  if (!parsed) {
    try {
      const raw = await fs.readFile(AUTH_FILE, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    try {
      const raw = await fs.readFile(AUTH_BACKUP_FILE, 'utf-8');
      parsed = JSON.parse(raw);
      console.log('[DB] Restored users from members-backup.json');
    } catch {
      parsed = null;
    }
  }

  if (parsed) {
    if (Array.isArray(parsed.users)) return parsed.users;
    if (parsed.id) {
      return [
        {
          id: parsed.id,
          email: parsed.email || '',
          salt: parsed.salt,
          hash: parsed.hash,
          role: parsed.role || 'admin',
          active: parsed.active !== false,
          created_at: parsed.createdAt || new Date().toISOString(),
        },
      ];
    }
  }
  return [];
}

async function saveJsonUsersLocal(users) {
  await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  const payload = JSON.stringify({ users }, null, 2);
  await fs.writeFile(AUTH_FILE, payload);
  await fs.writeFile(AUTH_BACKUP_FILE, payload);
}

async function saveJsonUsers(users) {
  await saveJsonUsersLocal(users);
  if (GITHUB_TOKEN) {
    await commitFilesToGitHub([
      { path: 'data/auth.json', content: JSON.stringify({ users }, null, 2) },
      { path: 'data/members-backup.json', content: JSON.stringify({ users }, null, 2) },
    ]);
  }
}

async function getGitHubRepo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  try {
    const pkgRaw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const url = pkg.repository?.url || '';
    const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    // ignore
  }
  return null;
}

async function fetchRepoFromGitHub() {
  return getGitHubRepo();
}

async function fetchFileFromGitHub(repo, filePath) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.content) return null;
  const decoded = Buffer.from(body.content, 'base64').toString('utf-8');
  return JSON.parse(decoded);
}

async function commitFilesToGitHub(files) {
  const repo = await getGitHubRepo();
  if (!repo) {
    console.error('[AUTO-COMMIT] GITHUB_REPO or package.json repository not set');
    return;
  }

  for (const file of files) {
    try {
      const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}`, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      });
      let sha = null;
      if (getRes.ok) {
        const body = await getRes.json();
        sha = body.sha;
      } else if (getRes.status !== 404) {
        throw new Error(`GET ${file.path} HTTP ${getRes.status}`);
      }

      const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `auto: update ${file.path}`,
          content: Buffer.from(file.content).toString('base64'),
          sha,
        }),
      });
      if (!putRes.ok) {
        const err = await putRes.text();
        throw new Error(`PUT ${file.path} HTTP ${putRes.status}: ${err}`);
      }
      console.log(`[AUTO-COMMIT] ${file.path} updated on GitHub.`);
    } catch (err) {
      console.error(`[AUTO-COMMIT] ${file.path} failed:`, err.message);
    }
  }
}

export async function commitDataFiles(files) {
  if (!GITHUB_TOKEN) return;
  const repo = await getGitHubRepo();
  if (!repo) return;
  const list = [];
  for (const f of files) {
    try {
      const content = await fs.readFile(f, 'utf-8');
      list.push({ path: path.relative(process.cwd(), f).replace(/\\/g, '/'), content });
    } catch {
      // ignore missing
    }
  }
  await commitFilesToGitHub(list);
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    salt: row.salt,
    hash: row.hash,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listUsers() {
  const db = initDb();
  if (db) {
    const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
    return result.rows.map(rowToUser);
  }
  return loadJsonUsers();
}

export async function findUserById(id) {
  const db = initDb();
  if (db) {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  }
  const users = await loadJsonUsers();
  return users.find((u) => u.id === id) || null;
}

export async function findUsersByEmail(email) {
  const db = initDb();
  if (db) {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows.map(rowToUser);
  }
  const users = await loadJsonUsers();
  return users.filter((u) => u.email === email);
}

export async function createUser({ id, email, salt, hash, role, active }) {
  const db = initDb();
  if (db) {
    await db.query(
      'INSERT INTO users (id, email, salt, hash, role, active) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, email, salt, hash, role, active]
    );
    return;
  }
  const users = await loadJsonUsers();
  users.push({
    id,
    email,
    salt,
    hash,
    role,
    active,
    createdAt: new Date().toISOString(),
  });
  await saveJsonUsers(users);
}

export async function updateUser(id, patch) {
  const db = initDb();
  if (db) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(patch)) {
      const col = key === 'createdAt' ? 'created_at' : key;
      fields.push(`${col} = $${idx++}`);
      values.push(value);
    }
    values.push(id);
    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return;
  }
  const users = await loadJsonUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...patch };
    await saveJsonUsers(users);
  }
}

export async function deleteUserById(id) {
  const db = initDb();
  if (db) {
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    return;
  }
  const users = await loadJsonUsers();
  const filtered = users.filter((u) => u.id !== id);
  await saveJsonUsers(filtered);
}

export async function countAdmins(excludeId) {
  const users = await listUsers();
  return users.filter((u) => u.role === 'admin' && u.id !== excludeId).length;
}
