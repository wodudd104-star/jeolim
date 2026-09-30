import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import fsSync from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import {
  initDb,
  ensureUsersTable,
  listUsers,
  findUserById,
  findUsersByEmail,
  createUser,
  updateUser,
  deleteUserById,
  countAdmins,
  hashPassword,
  verifyPassword,
  commitDataFiles,
  recordFailedLogin,
  resetFailedLogins,
  hasDb,
  ensureKvTable,
  kvGet,
  kvSet,
} from './src/lib/db.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.set('trust proxy', 1);

// 보안 헤더
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://t1.daumcdn.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// 글로벌 rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (_req, res) => res.status(429).json({ error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.' }),
});

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const SIGNUP_LOG_FILE = path.join(__dirname, 'data', 'signups.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const sessions = new Map();

async function loadSessions() {
  try {
    let raw = null;
    if (hasDb()) {
      raw = await kvGet('sessions');
    } else {
      raw = JSON.parse(fsSync.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
    const now = Date.now();
    for (const [token, session] of Object.entries(raw || {})) {
      if (session && session.expiresAt > now) {
        sessions.set(token, session);
      }
    }
  } catch {
    // 세션 저장소 없음/손상 시 새로 시작
  }
}

let sessionSaveTimer = null;
function scheduleSessionSave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(async () => {
    sessionSaveTimer = null;
    const obj = Object.fromEntries(sessions);
    try {
      if (hasDb()) {
        await kvSet('sessions', obj);
      } else {
        fsSync.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
        fsSync.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
      }
    } catch (err) {
      console.error('[SESSION] 세션 저장 실패:', err.message);
    }
  }, 500);
}

function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, role, expiresAt });
  scheduleSessionSave();
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    scheduleSessionSave();
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
  });
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    expires: new Date(expiresAt),
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session', { httpOnly: true, secure: true, sameSite: 'strict' });
}

async function appendSignupLog(user) {
  let list = [];
  try {
    const raw = await fs.readFile(SIGNUP_LOG_FILE, 'utf-8');
    list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.push({
    ...user,
    loggedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(SIGNUP_LOG_FILE), { recursive: true });
  await fs.writeFile(SIGNUP_LOG_FILE, JSON.stringify(list, null, 2));
  await commitDataFiles([SIGNUP_LOG_FILE]);
}

async function loadLegacyJsonUsers() {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.users)) return parsed.users;
    if (parsed.id) return [parsed];
    return [];
  } catch {
    return [];
  }
}

async function migrateJsonToDb() {
  const db = initDb();
  if (!db) return;
  const legacy = await loadLegacyJsonUsers();
  if (legacy.length === 0) return;

  const existing = await listUsers();
  const existingIds = new Set(existing.map((u) => u.id));
  let migrated = 0;

  for (const u of legacy) {
    if (existingIds.has(u.id)) continue;
    if (!u.id || !u.hash) continue;
    try {
      // bcrypt 해시인지 확인
      if (!u.hash.startsWith('$2')) continue;
      await createUser({
        id: u.id,
        email: u.email || '',
        hash: u.hash,
        role: u.role === 'admin' ? 'admin' : 'user',
        active: u.active !== false,
      });
      migrated++;
    } catch (err) {
      console.error(`Migration failed for ${u.id}:`, err.message);
    }
  }

  if (migrated > 0) {
    console.log(`Migrated ${migrated} users from auth.json to database.`);
  }
}

async function ensureDefaultAdmin() {
  // 복원됨: 기본 관리자 admin/0000 (나중에 제거 예정)
  const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || '0000';
  const admin = await findUserById('admin');
  if (admin) {
    // 기존 admin이 구형(비-bcrypt) 해시를 쓰면 기본 비밀번호로 재설정
    if (!admin.hash || !admin.hash.startsWith('$2')) {
      const hash = await hashPassword(defaultPassword);
      await updateUser('admin', { hash, failed_logins: 0, locked_until: null });
      console.log('[SECURITY] Default admin password reset to default (legacy hash migrated).');
    }
    return;
  }
  const hash = await hashPassword(defaultPassword);
  await createUser({
    id: 'admin',
    email: '',
    hash,
    role: 'admin',
    active: true,
  });
  console.log('[SECURITY] Default admin created (admin/0000) - remove this account before production use.');
}

function isLocked(user) {
  if (!user.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}

function getEmailTransporter() {
  const service = process.env.EMAIL_SERVICE || 'gmail';
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service, auth: { user, pass } });
}

const resetCodes = new Map();

function createResetCode(email) {
  const code = crypto.randomInt(100000, 999999).toString();
  resetCodes.set(email, { code, expiresAt: Date.now() + 30 * 60 * 1000 });
  return code;
}

function verifyResetCode(email, code) {
  const record = resetCodes.get(email);
  if (!record) return false;
  if (record.expiresAt < Date.now()) {
    resetCodes.delete(email);
    return false;
  }
  return record.code === code;
}

async function sendEmail(to, subject, text) {
  const transporter = getEmailTransporter();
  if (!transporter) throw new Error('이메일 발송 설정이 되어있지 않습니다.');
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  await transporter.sendMail({ from, to, subject, text });
}

// 유효성 검사
function validateId(id) {
  if (!id || typeof id !== 'string') return '아이디를 입력해주세요.';
  if (id.length < 3 || id.length > 20) return '아이디는 3~20자 이내여야 합니다.';
  if (!/^[a-zA-Z0-9_]+$/.test(id)) return '아이디는 영문, 숫자, 밑줄만 사용할 수 있습니다.';
  return null;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return '비밀번호를 입력해주세요.';
  if (password.length < 8) return '비밀번호는 최소 8자 이상이어야 합니다.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return '비밀번호는 영문과 숫자를 모두 포함해야 합니다.';
  }
  return null;
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return '이메일을 입력해주세요.';
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) return '올바른 이메일 형식이 아닙니다.';
  return null;
}

app.post('/api/login', authLimiter, async (req, res) => {
  const { id, password } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  if (!password) return res.status(400).json({ error: '비밀번호를 입력해주세요.' });

  const user = await findUserById(id);
  if (!user) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  }

  if (isLocked(user)) {
    return res.status(403).json({ error: '계정이 잠겼습니다. 30분 후 다시 시도해주세요.' });
  }

  const valid = await verifyPassword(password, user.hash);
  if (!valid) {
    await recordFailedLogin(id);
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  }

  if (!user.active) {
    return res.status(403).json({ error: '계정이 비활성화되었습니다. 관리자에게 문의하세요.' });
  }

  await resetFailedLogins(id);
  const { token, expiresAt } = createSession(user.id, user.role);
  setSessionCookie(res, token, expiresAt);
  res.json({ id: user.id, role: user.role, active: user.active, email: user.email });
});

app.post('/api/logout', requireAuth, (_req, res) => {
  const token = _req.cookies?.session;
  if (token) {
    sessions.delete(token);
    scheduleSessionSave();
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await findUserById(req.session.userId);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  res.json({ id: user.id, role: user.role, active: user.active, email: user.email });
});

app.post('/api/register', authLimiter, async (req, res) => {
  const { id, password, email } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  const existingById = await findUserById(id);
  if (existingById) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  const existingByEmail = await findUsersByEmail(email);
  if (existingByEmail.length > 0) {
    return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }

  const hash = await hashPassword(password);
  const newUser = {
    id,
    email,
    hash,
    role: 'user',
    active: false,
  };
  await createUser(newUser);
  await appendSignupLog({ id, email, role: 'user', active: false });
  res.json({ success: true, role: 'user', active: false });
});

app.get('/api/users', requireAdmin, async (_req, res) => {
  const users = await listUsers();
  res.json(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      active: u.active,
      createdAt: u.createdAt,
    }))
  );
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { id, password, email, role, active } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  const existingById = await findUserById(id);
  if (existingById) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  const existingByEmail = await findUsersByEmail(email);
  if (existingByEmail.length > 0) {
    return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }
  const hash = await hashPassword(password);
  await createUser({
    id,
    email,
    hash,
    role: role === 'admin' ? 'admin' : 'user',
    active: !!active,
  });
  res.json({ success: true });
});

app.post('/api/users/:id/activate', requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await updateUser(req.params.id, { active: true, failed_logins: 0, locked_until: null });
  res.json({ success: true });
});

app.post('/api/users/:id/deactivate', requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (user.role === 'admin') {
    return res.status(403).json({ error: '관리자 계정은 비활성화할 수 없습니다.' });
  }
  if (user.id === req.session.userId) {
    return res.status(403).json({ error: '자신의 계정은 비활성화할 수 없습니다.' });
  }
  await updateUser(req.params.id, { active: false });
  res.json({ success: true });
});

app.post('/api/users/:id/promote', requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await updateUser(req.params.id, { role: 'admin', active: true });
  res.json({ success: true });
});

app.post('/api/users/:id/demote', requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (user.id === 'admin') {
    return res.status(403).json({ error: '기본 관리자 계정은 일반 사용자로 변경할 수 없습니다.' });
  }
  if (user.id === req.session.userId) {
    return res.status(403).json({ error: '자신의 계정은 일반 사용자로 변경할 수 없습니다.' });
  }
  await updateUser(req.params.id, { role: 'user' });
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (user.id === 'admin') {
    const otherAdmins = (await listUsers()).filter(
      (u) => u.role === 'admin' && u.id !== 'admin'
    );
    if (otherAdmins.length === 0) {
      return res.status(403).json({ error: '다른 관리자가 없어 기본 관리자를 삭제할 수 없습니다.' });
    }
  }
  if (user.id === req.session.userId) {
    return res.status(403).json({ error: '자신의 계정은 삭제할 수 없습니다.' });
  }
  await deleteUserById(req.params.id);
  res.json({ success: true });
});

app.post('/api/find-id', authLimiter, async (req, res) => {
  const { email } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.status(404).json({ error: '등록된 이메일이 없습니다.' });
  }
  try {
    const ids = users.map((u) => u.id).join(', ');
    await sendEmail(
      email,
      '[절임배추 관리] 아이디 안내',
      `안녕하세요.\n\n요청하신 아이디는 "${ids}" 입니다.\n\n감사합니다.`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || '이메일 발송 실패' });
  }
});

app.post('/api/send-reset-code', authLimiter, async (req, res) => {
  const { email } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.status(404).json({ error: '등록된 이메일이 없습니다.' });
  }
  const code = createResetCode(email);
  try {
    await sendEmail(
      email,
      '[절임배추 관리] 비밀번호 재설정 인증번호',
      `안녕하세요.\n\n비밀번호 재설정 인증번호는 "${code}" 입니다.\n\n30분 이내에 입력해주세요.`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || '이메일 발송 실패' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  if (!code) return res.status(400).json({ error: '인증번호를 입력해주세요.' });

  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.status(404).json({ error: '등록된 이메일이 없습니다.' });
  }
  if (!verifyResetCode(email, code)) {
    return res.status(400).json({ error: '인증번호가 올바르지 않거나 만료되었습니다.' });
  }
  const hash = await hashPassword(newPassword);
  for (const user of users) {
    await updateUser(user.id, { hash });
  }
  resetCodes.delete(email);
  res.json({ success: true });
});

app.post('/api/update-auth', requireAuth, async (req, res) => {
  const { currentPassword, newId, newPassword, email } = req.body;
  const currentId = req.session.userId;
  const user = await findUserById(currentId);
  if (!user) {
    return res.status(400).json({ error: '서버에 등록된 계정이 없습니다.' });
  }
  if (!currentPassword) {
    return res.status(400).json({ error: '현재 비밀번호를 입력해주세요.' });
  }
  const valid = await verifyPassword(currentPassword, user.hash);
  if (!valid) {
    return res.status(403).json({ error: '현재 비밀번호가 틀렸습니다.' });
  }

  const patch = {};
  if (newId && newId !== currentId) {
    const idError = validateId(newId);
    if (idError) return res.status(400).json({ error: idError });
    const conflict = await findUserById(newId);
    if (conflict) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  if (email && email !== user.email) {
    const emailError = validateEmail(email);
    if (emailError) return res.status(400).json({ error: emailError });
    const conflict = await findUsersByEmail(email);
    if (conflict.length > 0) return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }

  if (newId) patch.id = newId;
  if (email) patch.email = email;
  if (newPassword) {
    const pwError = validatePassword(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });
    patch.hash = await hashPassword(newPassword);
  }

  // id 변경 시 삭제 후 재생성
  if (newId && newId !== currentId) {
    await createUser({
      id: newId,
      email: patch.email || user.email,
      hash: patch.hash || user.hash,
      role: user.role,
      active: user.active,
    });
    await deleteUserById(currentId);
    // 세션 갱신
    const token = req.cookies?.session;
    const session = sessions.get(token);
    if (session) session.userId = newId;
    return res.json({ success: true, id: newId });
  }

  await updateUser(currentId, patch);
  res.json({ success: true, id: currentId });
});

function getAuthHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

app.post('/api/send-sms', requireAuth, async (req, res) => {
  const { recipients, message } = req.body;
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const senderKey = process.env.SOLAPI_SENDER_KEY;

  if (!apiKey || !apiSecret || !senderKey) {
    return res.status(500).json({ error: '서버 환경변수가 설정되지 않았습니다.' });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: '수신자를 입력해주세요.' });
  }

  const validRecipients = recipients
    .map((p) => String(p).replace(/\D/g, ''))
    .filter(Boolean);

  if (validRecipients.length === 0) {
    return res.status(400).json({ error: '유효한 전화번호가 없습니다.' });
  }

  try {
    const response = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(apiKey, apiSecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: validRecipients.map((phone) => ({
          to: phone,
          text: message,
          type: 'CTA',
          kakaoOptions: {
            pfId: senderKey,
          },
        })),
      }),
    });

    const result = await response.json();
    return res.json({ success: true, sent: validRecipients.length, result });
  } catch (err) {
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// ===== 앱 데이터 자동저장 (배포/재배포 시 데이터 보존) =====
const APP_DATA_FILE = path.join(__dirname, 'src/lib/data/app-data.json');
const APP_DATA_KEYS = new Set([
  'orders',
  'products',
  'customers',
  'accounts',
  'gallery',
  'gallery_notice',
]);

// ===== 공유 주문 / 갤러리 스냅샷 (공개 조회용) =====
const PUBLIC_ORDERS_FILE = path.join(__dirname, 'src/lib/data/public-orders.json');
const PUBLIC_GALLERY_FILE = path.join(__dirname, 'src/lib/data/public-gallery.json');

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// DB(Supabase)가 연결되면 app_kv 테이블에 영구 저장, 아니면 로컬 JSON 폭백
async function storeRead(kvKey, file, fallback) {
  if (hasDb()) {
    const value = await kvGet(kvKey);
    return value === null || value === undefined ? fallback : value;
  }
  return readJsonSafe(file, fallback);
}

async function storeWrite(kvKey, file, data) {
  if (hasDb()) {
    await kvSet(kvKey, data);
    return;
  }
  await writeJsonSafe(file, data);
}

app.get('/api/data/all', requireAuth, async (_req, res) => {
  try {
    const store = await storeRead('app_data', APP_DATA_FILE, {});
    const out = {};
    for (const key of Object.keys(store)) {
      if (APP_DATA_KEYS.has(key)) out[key] = store[key] ? store[key].value : undefined;
    }
    return res.json(out);
  } catch {
    return res.status(500).json({ error: '데이터 조회에 실패했습니다.' });
  }
});

app.put('/api/data/:key', requireAuth, async (req, res) => {
  try {
    const key = req.params.key;
    if (!APP_DATA_KEYS.has(key)) {
      return res.status(400).json({ error: '지원하지 않는 데이터 키입니다.' });
    }
    const store = await storeRead('app_data', APP_DATA_FILE, {});
    store[key] = { value: req.body, savedAt: new Date().toISOString() };
    await storeWrite('app_data', APP_DATA_FILE, store);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '데이터 저장에 실패했습니다.' });
  }
});

app.put('/api/public/order/:id', requireAuth, async (req, res) => {
  try {
    const snapshot = req.body;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }
    if (snapshot.id !== req.params.id) {
      return res.status(400).json({ error: '주문 ID가 일치하지 않습니다.' });
    }
    const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
    if (!store.orders || typeof store.orders !== 'object') store.orders = {};
    store.orders[req.params.id] = snapshot;
    await storeWrite('public_orders', PUBLIC_ORDERS_FILE, store);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: '주문 공유 저장에 실패했습니다.' });
  }
});

app.get('/api/public/order/:id', async (req, res) => {
  try {
    const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
    const order = (store.orders || {})[req.params.id];
    if (!order) return res.status(404).json({ error: 'not found' });
    return res.json(order);
  } catch {
    return res.status(500).json({ error: '주문 조회에 실패했습니다.' });
  }
});

app.delete('/api/public/order/:id', requireAuth, async (req, res) => {
  try {
    const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
    if (store.orders && store.orders[req.params.id]) {
      delete store.orders[req.params.id];
      await storeWrite('public_orders', PUBLIC_ORDERS_FILE, store);
    }
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '공유 링크 삭제에 실패했습니다.' });
  }
});

app.put('/api/public/gallery', requireAuth, async (req, res) => {
  try {
    const { items, notice } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }
    await storeWrite('public_gallery', PUBLIC_GALLERY_FILE, { items, notice: String(notice || '') });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '갤러리 저장에 실패했습니다.' });
  }
});

app.get('/api/public/gallery', async (_req, res) => {
  try {
    const data = await storeRead('public_gallery', PUBLIC_GALLERY_FILE, null);
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: '갤러리 조회에 실패했습니다.' });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    const dbUrlSet = !!process.env.DATABASE_URL;
    console.log(`[STARTUP] DATABASE_URL ${dbUrlSet ? 'is set' : 'is NOT set'} (storage: ${dbUrlSet ? 'PostgreSQL' : 'local JSON'})`);
    await ensureUsersTable();
    await ensureKvTable();
    await loadSessions();
    await migrateJsonToDb();
    // DB 모드 첫 부팅 시 이미지에 포함된 JSON 데이터를 DB로 이관
    if (hasDb()) {
      for (const [kvKey, file, fallback] of [
        ['app_data', APP_DATA_FILE, {}],
        ['public_orders', PUBLIC_ORDERS_FILE, { orders: {} }],
        ['public_gallery', PUBLIC_GALLERY_FILE, null],
      ]) {
        try {
          const existing = await kvGet(kvKey);
          if (existing === null || existing === undefined) {
            const local = await readJsonSafe(file, null);
            if (local !== null) await kvSet(kvKey, local);
            else if (fallback !== null) await kvSet(kvKey, fallback);
          }
        } catch (err) {
          console.error(`[MIGRATE] ${kvKey} 이관 실패:`, err.message);
        }
      }
    }
    await ensureDefaultAdmin();
    const users = await listUsers();
    console.log(`Total users in storage: ${users.length}`);
    console.log(`Users: ${users.map((u) => `${u.id}(${u.role})`).join(', ')}`);
  } catch (err) {
    console.error('Startup error:', err);
  }
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
})();
