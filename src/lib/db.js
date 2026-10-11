import pg from 'pg';
import bcrypt from 'bcrypt';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const AUTH_BACKUP_FILE = path.join(__dirname, 'data', 'members-backup.json');
const DATABASE_URL = process.env.DATABASE_URL;
// 주문내역 전용 DB (미설정 시 기본 DATABASE_URL 사용)
const ORDERS_DATABASE_URL = process.env.ORDERS_DATABASE_URL || process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const SALT_ROUNDS = 12;

let pool = null;
let ordersPool = null;

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

// 주문내역 전용 연결 (별도 DB 지정 시 분리 저장)
export function initOrdersDb() {
  if (!ORDERS_DATABASE_URL) return null;
  if (ordersPool) return ordersPool;
  ordersPool = new pg.Pool({
    connectionString: ORDERS_DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });
  return ordersPool;
}

export async function ensureUsersTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'user',
      active BOOLEAN NOT NULL DEFAULT false,
      failed_logins INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)');
}

// DB 전환 시 기존 auth.json 회원 데이터를 users 테이블로 한 번만 이관
export async function migrateUsersFromFile() {
  const db = initDb();
  if (!db) return;
  const count = await db.query('SELECT COUNT(*)::int AS cnt FROM users');
  if (count.rows[0].cnt > 0) return;
  const users = await loadJsonUsers();
  if (!Array.isArray(users) || users.length === 0) return;
  for (const u of users) {
    if (!u || !u.id || !u.hash) continue;
    // bcrypt 해시만 이관 (구형 평문/SHA 해시는 보안상 제외)
    if (!String(u.hash).startsWith('$2')) continue;
    try {
      await db.query(
        `INSERT INTO users (id, email, phone, hash, role, active, failed_logins, locked_until, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, COALESCE($7::timestamptz, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id,
          u.email || `${u.id}@local.invalid`,
          u.phone || null,
          u.hash,
          u.role || 'user',
          u.active !== false,
          u.createdAt || null,
        ]
      );
      console.log(`[MIGRATE users] ${u.id} 이관 완료`);
    } catch (err) {
      console.error(`[MIGRATE users] ${u.id} 이관 실패:`, err.message);
    }
  }
}

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

async function loadJsonUsers() {
  let parsed = null;

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
  await fs.writeFile(AUTH_FILE, payload, { mode: 0o600 });
  await fs.writeFile(AUTH_BACKUP_FILE, payload, { mode: 0o600 });
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
    phone: row.phone || '',
    hash: row.hash,
    role: row.role,
    active: row.active,
    failed_logins: row.failed_logins,
    locked_until: row.locked_until,
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

export async function createUser({ id, email, phone, hash, role, active }) {
  const db = initDb();
  if (db) {
    await db.query(
      'INSERT INTO users (id, email, phone, hash, role, active) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, email, phone || null, hash, role, active]
    );
    return;
  }
  const users = await loadJsonUsers();
  users.push({
    id,
    email,
    phone: phone || '',
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

export async function recordFailedLogin(id) {
  const db = initDb();
  if (db) {
    await db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN failed_logins + 1 >= 5 THEN NOW() + INTERVAL '30 minutes' ELSE locked_until END
       WHERE id = $1`,
      [id]
    );
    return;
  }
  const users = await loadJsonUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.failed_logins = (user.failed_logins || 0) + 1;
  if (user.failed_logins >= 5) {
    user.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  }
  await saveJsonUsers(users);
}

export async function resetFailedLogins(id) {
  const db = initDb();
  if (db) {
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
    return;
  }
  const users = await loadJsonUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.failed_logins = 0;
  user.locked_until = null;
  await saveJsonUsers(users);
}

// ===== 범용 키-값 저장소 (재배포 시에도 유지되는 영구 저장) =====
// 우선순위: DATABASE_URL(pg) > Supabase REST RPC 브리지 > 로컬 JSON
function kvBridge() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const token = process.env.KV_BRIDGE_TOKEN;
  if (!url || !anonKey || !token) return null;
  return { url: url.replace(/\/$/, '') + '/rest/v1/rpc/kv_bridge', anonKey, token };
}

async function kvRpc(bridge, op, key, value) {
  const res = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: bridge.anonKey,
      Authorization: `Bearer ${bridge.anonKey}`,
    },
    body: JSON.stringify({ p_op: op, p_key: key, p_value: value ?? null, p_token: bridge.token }),
  });
  if (!res.ok) throw new Error(`kv rpc 실패 (HTTP ${res.status})`);
  const data = await res.json();
  if (data && data.error) throw new Error(`kv rpc 오류: ${data.error}`);
  return data;
}

export function hasKv() {
  return !!initDb() || !!kvBridge();
}

export async function ensureKvTable() {
  const db = initDb();
  if (!db) return; // 브리지 모드는 마이그레이션으로 app_kv가 이미 생성됨
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function kvGet(key) {
  const db = initDb();
  if (db) {
    const result = await db.query('SELECT value FROM app_kv WHERE key = $1', [key]);
    return result.rows[0] ? result.rows[0].value : null;
  }
  const bridge = kvBridge();
  if (!bridge) return null;
  const data = await kvRpc(bridge, 'get', key, null);
  return data && data.ok && data.v !== undefined ? data.v : null;
}

export async function kvSet(key, value) {
  const db = initDb();
  if (db) {
    await db.query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return;
  }
  const bridge = kvBridge();
  if (!bridge) return;
  await kvRpc(bridge, 'set', key, value);
}

// ===== customers / orders 전용 테이블 =====
// 개인정보(고객)와 주문 데이터를 app_kv가 아닌 별도 테이블로 격리 저장한다.

export async function ensureCustomersTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // 고객 개인정보를 각각의 개별 컬럼으로 저장 (이름/전화번호/주소/상세주소/메모/도착일/수량/수령방법)
  await db.query(`
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS address TEXT,
      ADD COLUMN IF NOT EXISTS address_detail TEXT,
      ADD COLUMN IF NOT EXISTS memo TEXT,
      ADD COLUMN IF NOT EXISTS arrival_date TEXT,
      ADD COLUMN IF NOT EXISTS quantity INTEGER,
      ADD COLUMN IF NOT EXISTS receive_method TEXT,
      ADD COLUMN IF NOT EXISTS app_created_at TEXT
  `);
  // 검색용 인덱스
  await db.query('CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone)');
  // 기존 JSONB 블롭 데이터를 개별 컬럼으로 1회 백필
  await db.query(`
    UPDATE customers SET
      name = data->>'name',
      phone = data->>'phone',
      address = data->>'address',
      address_detail = data->>'addressDetail',
      memo = data->>'memo',
      arrival_date = data->>'arrivalDate',
      quantity = CASE WHEN data->>'quantity' ~ '^[0-9]+$' THEN (data->>'quantity')::int ELSE NULL END,
      receive_method = data->>'receiveMethod',
      app_created_at = data->>'createdAt'
    WHERE name IS NULL
  `);
}

// 개별 컬럼에 저장할 값 추출
function customerColumnValues(c) {
  return {
    name: c.name ?? null,
    phone: c.phone ?? null,
    address: c.address ?? null,
    addressDetail: c.addressDetail ?? null,
    memo: c.memo ?? null,
    arrivalDate: c.arrivalDate ?? null,
    quantity: typeof c.quantity === 'number' ? c.quantity : null,
    receiveMethod: c.receiveMethod ?? null,
    createdAt: c.createdAt ?? null,
  };
}

// 개별 컬럼 행을 API용 고객 객체로 복원 (컬럼이 비어 있으면 JSONB 폴백)
function customerFromRow(row) {
  if (row.name === null && row.data) return row.data;
  return {
    ...(row.data || {}),
    id: row.id,
    name: row.name ?? row.data?.name ?? '',
    phone: row.phone ?? row.data?.phone ?? '',
    address: row.address ?? row.data?.address ?? '',
    addressDetail: row.address_detail ?? row.data?.addressDetail ?? undefined,
    memo: row.memo ?? row.data?.memo ?? '',
    arrivalDate: row.arrival_date ?? row.data?.arrivalDate ?? undefined,
    quantity: row.quantity ?? row.data?.quantity ?? undefined,
    receiveMethod: row.receive_method ?? row.data?.receiveMethod ?? undefined,
    createdAt: row.app_created_at ?? row.data?.createdAt ?? '',
  };
}

export async function ensureOrdersTable() {
  const db = initOrdersDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listCustomers() {
  const db = initDb();
  if (db) {
    const result = await db.query(`
      SELECT id, data, name, phone, address, address_detail, memo,
             arrival_date, quantity, receive_method, app_created_at
      FROM customers
      ORDER BY COALESCE(name, data->>'name')
    `);
    return result.rows.map(customerFromRow);
  }
  return null;
}

export async function insertCustomer(customer) {
  const db = initDb();
  if (db) {
    const v = customerColumnValues(customer);
    await db.query(
      `INSERT INTO customers (id, data, name, phone, address, address_detail, memo,
                              arrival_date, quantity, receive_method, app_created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (id) DO UPDATE SET
         data = EXCLUDED.data,
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         address = EXCLUDED.address,
         address_detail = EXCLUDED.address_detail,
         memo = EXCLUDED.memo,
         arrival_date = EXCLUDED.arrival_date,
         quantity = EXCLUDED.quantity,
         receive_method = EXCLUDED.receive_method,
         app_created_at = EXCLUDED.app_created_at,
         updated_at = NOW()`,
      [
        customer.id,
        JSON.stringify(customer),
        v.name,
        v.phone,
        v.address,
        v.addressDetail,
        v.memo,
        v.arrivalDate,
        v.quantity,
        v.receiveMethod,
        v.createdAt,
      ]
    );
    return;
  }
  return null;
}

export async function updateCustomerDb(id, patch) {
  const db = initDb();
  if (db) {
    // 현재 데이터에 패치를 병합한 뒤 개별 컬럼도 함께 갱신
    const cur = await db.query('SELECT data FROM customers WHERE id = $1', [id]);
    if (!cur.rows[0]) return;
    const merged = { ...(cur.rows[0].data || {}), ...patch };
    const v = customerColumnValues(merged);
    await db.query(
      `UPDATE customers SET
         data = data || $2::jsonb,
         name = $3, phone = $4, address = $5, address_detail = $6, memo = $7,
         arrival_date = $8, quantity = $9, receive_method = $10, app_created_at = $11,
         updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        JSON.stringify(patch),
        v.name,
        v.phone,
        v.address,
        v.addressDetail,
        v.memo,
        v.arrivalDate,
        v.quantity,
        v.receiveMethod,
        v.createdAt,
      ]
    );
    return;
  }
  return null;
}

export async function deleteCustomerDb(id) {
  const db = initDb();
  if (db) {
    await db.query('DELETE FROM customers WHERE id = $1', [id]);
    return;
  }
  return null;
}

export async function listOrders() {
  const db = initOrdersDb();
  if (db) {
    const result = await db.query("SELECT data FROM orders ORDER BY data->>'createdAt' DESC");
    return result.rows.map((r) => r.data);
  }
  return null;
}

export async function getOrderDb(id) {
  const db = initOrdersDb();
  if (db) {
    const result = await db.query('SELECT data FROM orders WHERE id = $1', [id]);
    return result.rows[0] ? result.rows[0].data : null;
  }
  return null;
}

export async function insertOrder(order) {
  const db = initOrdersDb();
  if (db) {
    await db.query(
      `INSERT INTO orders (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [order.id, JSON.stringify(order)]
    );
    return;
  }
  return null;
}

export async function updateOrderDb(id, order) {
  const db = initOrdersDb();
  if (db) {
    await db.query(
      `UPDATE orders SET data = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(order)]
    );
    return;
  }
  return null;
}

export async function deleteOrderDb(id) {
  const db = initOrdersDb();
  if (db) {
    await db.query('DELETE FROM orders WHERE id = $1', [id]);
    return;
  }
  return null;
}

// 삭제된 주문 ID 기록(tombstone).
// 전체 동기화(목록 통째로 저장)에서 오래된 기기가 삭제된 주문을 되살리는 것을 막는다.
export async function ensureOrderTombstonesTable() {
  const db = initOrdersDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders_deleted (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function addOrderTombstone(id) {
  const db = initOrdersDb();
  if (!db) return;
  await db.query(
    'INSERT INTO orders_deleted (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
    [id]
  );
}

export async function listOrderTombstones() {
  const db = initOrdersDb();
  if (!db) return new Set();
  const result = await db.query('SELECT id FROM orders_deleted');
  return new Set(result.rows.map((r) => r.id));
}

export async function migrateCustomersFromFile(filePath) {
  const db = initDb();
  if (!db) return;
  const fsSync = (await import('fs')).default;
  if (!fsSync.existsSync(filePath)) return;
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) return;
    const count = await db.query('SELECT COUNT(*)::int AS cnt FROM customers');
    if (count.rows[0].cnt > 0) return;
    for (const c of list) {
      if (c && c.id) await insertCustomer(c);
    }
  } catch (err) {
    console.error('[MIGRATE customers] 실패:', err.message);
  }
}

export async function migrateOrdersFromFile(filePath) {
  const db = initOrdersDb();
  if (!db) return;
  const fsSync = (await import('fs')).default;
  if (!fsSync.existsSync(filePath)) return;
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    const store = JSON.parse(raw);
    const orders = Object.values(store.orders || {});
    if (!Array.isArray(orders) || orders.length === 0) return;
    const count = await db.query('SELECT COUNT(*)::int AS cnt FROM orders');
    if (count.rows[0].cnt > 0) return;
    for (const o of orders) {
      if (o && o.id) await insertOrder(o);
    }
  } catch (err) {
    console.error('[MIGRATE orders] 실패:', err.message);
  }
}

// ===== 공개 갤러리(사진등록) 전용 테이블 =====
// 사진 데이터를 app_kv가 아닌 별도 테이블로 격리 저장한다.

export async function ensureGalleryTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS gallery (
      key TEXT PRIMARY KEY,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      notice TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getGalleryDb() {
  const db = initDb();
  if (db) {
    const result = await db.query("SELECT items, notice FROM gallery WHERE key = 'public'");
    if (result.rows[0]) {
      return { items: result.rows[0].items || [], notice: result.rows[0].notice || '' };
    }
    return { items: [], notice: '' };
  }
  return null;
}

export async function setGalleryDb(items, notice) {
  const db = initDb();
  if (db) {
    await db.query(
      `INSERT INTO gallery (key, items, notice, updated_at) VALUES ('public', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET items = EXCLUDED.items, notice = EXCLUDED.notice, updated_at = NOW()`,
      [JSON.stringify(items || []), String(notice || '')]
    );
    return;
  }
  return null;
}

export async function migrateGalleryFromFile(filePath) {
  const db = initDb();
  if (!db) return;
  const fsSync = (await import('fs')).default;
  if (!fsSync.existsSync(filePath)) return;
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    const store = JSON.parse(raw);
    const count = await db.query("SELECT COUNT(*)::int AS cnt FROM gallery WHERE key = 'public'");
    if (count.rows[0].cnt > 0) return;
    await setGalleryDb(store.items || [], store.notice || '');
  } catch (err) {
    console.error('[MIGRATE gallery] 실패:', err.message);
  }
}

// ===== 자재구입목록 전용 테이블 =====
// 자재 데이터를 app_kv 단일 블롭에서 분리해 주문/고객과 동일한 방식으로
// 서버 DB에 실시간 저장한다. 오래된 기기의 전체 동기화가 자재를 지우는 사고 방지.

export async function ensureMaterialsTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function ensureMaterialsDeletedTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS materials_deleted (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listMaterials() {
  const db = initDb();
  if (db) {
    const result = await db.query("SELECT data FROM materials ORDER BY data->>'date' DESC, data->>'createdAt' DESC");
    return result.rows.map((r) => r.data);
  }
  return null;
}

export async function insertMaterial(material) {
  const db = initDb();
  if (db) {
    await db.query(
      `INSERT INTO materials (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [material.id, JSON.stringify(material)]
    );
    return;
  }
  return null;
}

export async function deleteMaterialDb(id) {
  const db = initDb();
  if (db) {
    await db.query('DELETE FROM materials WHERE id = $1', [id]);
    return;
  }
  return null;
}

export async function addMaterialTombstone(id) {
  const db = initDb();
  if (!db) return;
  await db.query(
    'INSERT INTO materials_deleted (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
    [id]
  );
}

export async function listMaterialTombstones() {
  const db = initDb();
  if (!db) return new Set();
  const result = await db.query('SELECT id FROM materials_deleted');
  return new Set(result.rows.map((r) => r.id));
}

// ===== 앱 데이터 키별 저장 (품목/단가, 계좌 등 전체 DB 실시간 연동) =====
// app_kv(app_data) 단일 블롭 덮어쓰기 사고를 방지하기 위해 키마다 개별 행으로 저장한다.

export function hasDb() {
  return !!initDb();
}

export async function ensureAppDataKeysTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_data_keys (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// 반환값: null = DB 미사용, undefined = 행 없음, 그 외 = 저장된 값
export async function appKeyGet(key) {
  const db = initDb();
  if (!db) return null;
  const result = await db.query('SELECT value FROM app_data_keys WHERE key = $1', [key]);
  return result.rows[0] ? result.rows[0].value : undefined;
}

export async function appKeySet(key, value) {
  const db = initDb();
  if (!db) return;
  await db.query(
    `INSERT INTO app_data_keys (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// 기존 app_kv(app_data) 블롭에 남아 있는 키들을 키별 테이블로 한 번만 이관
export async function migrateAppDataKeysFromStore(keys) {
  const db = initDb();
  if (!db) return;
  try {
    const store = await kvGet('app_data');
    if (!store || typeof store !== 'object') return;
    for (const key of keys) {
      const existing = await db.query('SELECT 1 FROM app_data_keys WHERE key = $1', [key]);
      if (existing.rows.length > 0) continue;
      const entry = store[key];
      if (entry === undefined) continue;
      // 스토어 형식은 { value, savedAt } 또는 원본 값
      const value = entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry
        ? entry.value
        : entry;
      if (value === undefined) continue;
      await db.query(
        'INSERT INTO app_data_keys (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, JSON.stringify(value)]
      );
    }
  } catch (err) {
    console.error('[MIGRATE app_data_keys] 실패:', err.message);
  }
}

// ===== 영수증 사진 전용 테이블 =====
// 영수증 base64를 자재 데이터에 인라인으로 넣으면 localStorage 한도 초과와
// 동기화 비대화를 유발하므로, 사진은 이 테이블에 별도 저장하고 자재에는 참조 ID만 둔다.

export async function ensureReceiptsTable() {
  const db = initDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function saveReceipt(id, data) {
  const db = initDb();
  if (!db) return;
  await db.query(
    `INSERT INTO receipts (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [id, data]
  );
}

// 없으면 null 반환
export async function getReceipt(id) {
  const db = initDb();
  if (!db) return null;
  const result = await db.query('SELECT data FROM receipts WHERE id = $1', [id]);
  return result.rows[0] ? result.rows[0].data : null;
}

// 기존 자재에 인라인으로 들어 있던 영수증을 receipts 테이블로 1회 이관
export async function migrateMaterialReceipts() {
  const db = initDb();
  if (!db) return;
  try {
    const result = await db.query(
      "SELECT id, data FROM materials WHERE data->>'receipt' IS NOT NULL AND data->>'receipt' <> ''"
    );
    for (const row of result.rows) {
      const receipt = row.data.receipt;
      await saveReceipt(row.id, receipt);
      const updated = { ...row.data, receiptId: row.id };
      delete updated.receipt;
      await db.query('UPDATE materials SET data = $2, updated_at = NOW() WHERE id = $1', [
        row.id,
        JSON.stringify(updated),
      ]);
    }
    if (result.rows.length > 0) {
      console.log(`[MIGRATE receipts] ${result.rows.length}건 이관 완료`);
    }
  } catch (err) {
    console.error('[MIGRATE receipts] 실패:', err.message);
  }
}

// 기존 app_kv(app_data) 블롭에 남아 있던 자재 데이터를 테이블로 한 번만 이관
export async function migrateMaterialsFromStore() {
  const db = initDb();
  if (!db) return;
  try {
    const count = await db.query('SELECT COUNT(*)::int AS cnt FROM materials');
    if (count.rows[0].cnt > 0) return;
    const store = await kvGet('app_data');
    // 스토어 형식은 { materials: { value: [...], savedAt } } 또는 { materials: [...] }
    let materials = store && store.materials;
    if (materials && !Array.isArray(materials) && Array.isArray(materials.value)) {
      materials = materials.value;
    }
    if (!Array.isArray(materials)) materials = [];
    for (const m of materials) {
      if (m && m.id) await insertMaterial(m);
    }
    if (materials.length > 0) {
      console.log(`[MIGRATE materials] ${materials.length}건 이관 완료`);
    }
  } catch (err) {
    console.error('[MIGRATE materials] 실패:', err.message);
  }
}
