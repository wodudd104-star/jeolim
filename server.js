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
  hasKv,
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
// 외부 트래픽은 Tailscale Funnel이 localhost:3000으로 프록시해서 전달함.
// 프록시로 신뢰하는 주소를 loopback으로 제한 → LAN에서 직접 접속하며
// X-Forwarded-For 헤더를 위조해 rate limit을 우회하는 것을 차단.
app.set('trust proxy', 'loopback');

// 보안 헤더
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://t1.daumcdn.net", "https://*.daumcdn.net", "https://*.kakao.com", "https://js.tosspayments.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.daumcdn.net", "https://*.daum.net", "https://*.kakao.com", "https://*.tosspayments.com"],
      connectSrc: ["'self'", "https://*.daumcdn.net", "https://*.daum.net", "https://*.kakao.com", "https://*.tosspayments.com"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://*.daumcdn.net", "https://*.daum.net", "https://*.kakao.com", "https://*.tosspayments.com"],
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
// (앱이 주기적으로 서버와 동기화하므로 여유 있게 설정. 무차별 대입 방지는
//  로그인 authLimiter와 공개 폼 intakeLimiter가 담당)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // 기본 keyGenerator(req.ip 기반, IPv6 정규화 포함) 사용
  handler: (_req, res) => res.status(429).json({ error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.' }),
});

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const SIGNUP_LOG_FILE = path.join(__dirname, 'data', 'signups.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간
// 기본 관리자 비밀번호 (환경변수로 재정의 가능). 외부 공개 환경에서는 반드시 변경할 것.
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || '0000';
// 로그인 시 존재하지 않는 아이디의 응답 시간을 실제 계정과 동일하게 맞추는
// 더미 bcrypt 해시 (타이밍 기반 계정 존재 여부 추론 방지)
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  `timing-equalizer-${crypto.randomBytes(16).toString('hex')}`,
  12
);

const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const sessions = new Map();

async function loadSessions() {
  try {
    let raw = null;
    if (hasKv()) {
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
      if (hasKv()) {
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

// 세션 토큰은 해시(SHA-256)로만 저장 → 세션 파일 유출 시에도 토큰 재사용 불가
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(userId, role, extra = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(hashSessionToken(token), { userId, role, expiresAt, ...extra });
  scheduleSessionSave();
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const key = hashSessionToken(token);
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(key);
    scheduleSessionSave();
    return null;
  }
  return session;
}

async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  // 계정이 삭제되거나 비활성화된 경우 기존 세션도 즉시 차단
  const user = await findUserById(session.userId);
  if (!user || user.active === false) {
    sessions.delete(hashSessionToken(token));
    scheduleSessionSave();
    clearSessionCookie(res);
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  req.session = session;
  req.user = user;
  next();
}

// 특정 사용자의 모든 세션을 무효화 (exceptToken이 있으면 그 토큰만 유지).
// 비밀번호 변경/재설정 시 기존 로그인 세션(해커 세션 포함)을 강제 로그아웃.
function revokeUserSessions(userId, exceptToken) {
  const exceptHash = exceptToken ? hashSessionToken(exceptToken) : null;
  let changed = false;
  for (const [key, s] of sessions) {
    if (s.userId === userId && key !== exceptHash) {
      sessions.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleSessionSave();
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

// 주기적으로 만료된 세션/인증번호 정리 (메모리·저장소 위생)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, s] of sessions) {
    if (!s || s.expiresAt < now) {
      sessions.delete(key);
      changed = true;
    }
  }
  for (const [email, rec] of resetCodes) {
    if (!rec || rec.expiresAt < now) resetCodes.delete(email);
  }
  if (changed) scheduleSessionSave();
}, 30 * 60 * 1000).unref();

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
  // 기본 admin 계정은 최초 설치 시에만 생성한다.
  // DISABLE_DEFAULT_ADMIN=true 가 설정되면 절대 생성하지 않으며,
  // 다른 관리자가 이미 있으면 기본 admin 을 생성하지 않는다.
  if (process.env.DISABLE_DEFAULT_ADMIN === 'true') return;
  const admin = await findUserById('admin');
  if (admin) {
    // 기존 admin이 구형(비-bcrypt) 해시를 쓰면 기본 비밀번호로 재설정
    if (!admin.hash || !admin.hash.startsWith('$2')) {
      const hash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
      await updateUser('admin', { hash, failed_logins: 0, locked_until: null });
      console.log('[SECURITY] Default admin password reset to default (legacy hash migrated).');
    }
    return;
  }
  const users = await listUsers();
  if (users.some((u) => u.role === 'admin')) {
    // 다른 관리자가 이미 있으므로 기본 admin을 되살리지 않음
    console.log('[SECURITY] Default admin not created (another admin exists).');
    return;
  }
  const hash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
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
  resetCodes.set(email, { code, expiresAt: Date.now() + 30 * 60 * 1000, attempts: 0 });
  return code;
}

// 인증번호 검증: 5회 실패 시 무효화, 성공 시 일회용으로 즉시 소진
function verifyResetCode(email, code) {
  const record = resetCodes.get(email);
  if (!record) return false;
  if (record.expiresAt < Date.now() || record.attempts >= 5) {
    resetCodes.delete(email);
    return false;
  }
  record.attempts += 1;
  const ok = record.code === code;
  if (!ok || record.attempts >= 5) {
    resetCodes.delete(email);
    return false;
  }
  resetCodes.delete(email);
  return true;
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

function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return '핸드폰번호를 입력해주세요.';
  const digits = phone.replace(/[^0-9]/g, '');
  if (!/^01[016789][0-9]{7,8}$/.test(digits)) return '올바른 핸드폰번호 형식이 아닙니다. (예: 01012345678)';
  return null;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

app.post('/api/login', authLimiter, async (req, res) => {
  const { id, password } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  if (!password) return res.status(400).json({ error: '비밀번호를 입력해주세요.' });

  const user = await findUserById(id);
  if (!user) {
    // 존재하지 않는 아이디도 bcrypt 비교를 수행해 응답 시간을 동일하게 유지
    await verifyPassword(password, DUMMY_BCRYPT_HASH);
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
  const mustChangePassword = user.id === 'admin' && password === DEFAULT_ADMIN_PASSWORD;
  const { token, expiresAt } = createSession(user.id, user.role, { mustChangePassword });
  setSessionCookie(res, token, expiresAt);
  res.json({
    id: user.id,
    role: user.role,
    active: user.active,
    email: user.email,
    mustChangePassword,
  });
});

app.post('/api/logout', requireAuth, (_req, res) => {
  const token = _req.cookies?.session;
  if (token) {
    sessions.delete(hashSessionToken(token));
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
  res.json({
    id: user.id,
    role: user.role,
    active: user.active,
    email: user.email,
    mustChangePassword: !!req.session.mustChangePassword,
  });
});

app.post('/api/register', authLimiter, async (req, res) => {
  const { id, password, email, phone } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  const phoneError = validatePhone(phone);
  if (phoneError) return res.status(400).json({ error: phoneError });

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
    phone: normalizePhone(phone),
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
      phone: u.phone || '',
      role: u.role,
      active: u.active,
      createdAt: u.createdAt,
    }))
  );
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { id, password, email, phone, role, active } = req.body;
  const idError = validateId(id);
  if (idError) return res.status(400).json({ error: idError });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  const phoneError = validatePhone(phone);
  if (phoneError) return res.status(400).json({ error: phoneError });

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
    phone: normalizePhone(phone),
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

// 회원 비밀번호 초기화 (관리자 전용)
// 새 비밀번호를 직접 지정하거나, 비우면 임시 비밀번호를 자동 생성해 반환한다.
// 초기화 후 해당 회원의 기존 로그인 세션은 모두 해제된다.
app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
    let newPassword = String(req.body?.newPassword || '');
    if (newPassword) {
      if (
        newPassword.length < 8 ||
        newPassword.length > 72 ||
        !/[A-Za-z]/.test(newPassword) ||
        !/[0-9]/.test(newPassword)
      ) {
        return res
          .status(400)
          .json({ error: '비밀번호는 8자 이상이며 영문과 숫자를 포함해야 합니다.' });
      }
    } else {
      // 임시 비밀번호 자동 생성 (영문+숫자 포함 10자)
      newPassword = `jc${crypto.randomInt(10000000, 99999999)}a`;
    }
    const hash = await hashPassword(newPassword);
    await updateUser(target.id, { hash, failed_logins: 0, locked_until: null });
    revokeUserSessions(target.id);
    console.log(`[ADMIN] Password reset for user '${target.id}' by '${req.session.userId}'`);

    // 회원의 핸드폰번호가 등록되어 있으면 새 비밀번호를 문자로 전송
    let smsSent = false;
    let smsNote = '';
    const targetPhone = normalizePhone(target.phone || '');
    if (targetPhone) {
      const smsText = `[절임배추 주문관리] ${target.id}님의 비밀번호가 초기화되었습니다. 새 비밀번호: ${newPassword} 로그인 후 비밀번호를 변경해주세요.`;
      const smsResult = await sendSolapiMessages([targetPhone], smsText);
      smsSent = smsResult.ok;
      smsNote = smsResult.ok ? `${targetPhone}로 문자를 발송했습니다.` : smsResult.error || '';
    } else {
      smsNote = '등록된 핸드폰번호가 없어 문자를 볼 수 없습니다.';
    }
    return res.json({ success: true, tempPassword: newPassword, smsSent, smsNote });
  } catch (err) {
    console.error('[RESET-USER-PW]', err.message);
    return res.status(500).json({ error: '비밀번호 초기화에 실패했습니다.' });
  }
});

app.post('/api/find-id', authLimiter, async (req, res) => {
  const { email } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  // 계정 열거 방지: 등록 여부와 무관하게 동일한 성공 응답
  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.json({ success: true });
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
    // 내부 오류 상세는 서버 로그로만 기록 (SMTP 설정 정보 등 노출 방지)
    console.error('[FIND-ID] 이메일 발송 실패:', err.message);
    res.status(500).json({ error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.post('/api/send-reset-code', authLimiter, async (req, res) => {
  const { email } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });

  // 계정 열거 방지: 등록 여부와 무관하게 동일한 성공 응답
  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.json({ success: true });
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
    // 내부 오류 상세는 서버 로그로만 기록
    console.error('[RESET-CODE] 이메일 발송 실패:', err.message);
    resetCodes.delete(email);
    res.status(500).json({ error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body;
  const emailError = validateEmail(email);
  if (emailError) return res.status(400).json({ error: emailError });
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  if (!code) return res.status(400).json({ error: '인증번호를 입력해주세요.' });

  // 계정 열거 방지: 등록 여부와 무관하게 항상 동일한 응답
  // (코드는 실제 등록된 이메일로 발송된 경우에만 존재할 수 있음)
  const codeValid = verifyResetCode(email, code);
  const users = codeValid ? await findUsersByEmail(email) : [];
  if (!codeValid || users.length === 0) {
    return res.status(400).json({ error: '인증번호가 올바르지 않거나 만료되었습니다.' });
  }
  const hash = await hashPassword(newPassword);
  for (const user of users) {
    await updateUser(user.id, { hash, failed_logins: 0, locked_until: null });
    // 비밀번호 재설정 시 해당 계정의 모든 기존 세션 강제 로그아웃
    revokeUserSessions(user.id);
  }
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
    // 기존 아이디의 다른 세션(다른 기기 로그인) 모두 강제 로그아웃
    const token = req.cookies?.session;
    revokeUserSessions(currentId, token);
    // 세션 갱신
    const session = token ? sessions.get(hashSessionToken(token)) : null;
    if (session) session.userId = newId;
    return res.json({ success: true, id: newId });
  }

  await updateUser(currentId, patch);
  // 비밀번호 변경 시 기본 비밀번호 경고 플래그 해제 + 다른 기기 세션 강제 로그아웃
  if (newPassword) {
    const token = req.cookies?.session;
    revokeUserSessions(currentId, token);
    const session = token ? sessions.get(hashSessionToken(token)) : null;
    if (session) session.mustChangePassword = false;
  }
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

// EUC-KR 기준 바이트 길이 근사 (SMS 90바이트 제한 판정용)
function smsByteLength(text) {
  let n = 0;
  for (const ch of text) n += (ch.codePointAt(0) || 0) < 128 ? 1 : 2;
  return n;
}

// 솔라피 메시지 발송 공통 헬퍼 (단첨문자, 비밀번호 초기화 알림 등에서 재사용)
// 성공 시 { ok: true }, 실패 시 { ok: false, error } 반환
async function sendSolapiMessages(phones, text) {
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const senderKey = process.env.SOLAPI_SENDER_KEY;
  const senderPhone = String(process.env.SOLAPI_SENDER || '').replace(/\D/g, '');

  if (!apiKey || !apiSecret || (!senderKey && !senderPhone)) {
    return { ok: false, error: '문자 API 키가 서버에 등록되지 않았습니다.' };
  }
  const isKakao = !!senderKey;
  const smsType = smsByteLength(text) <= 90 ? 'SMS' : 'LMS';
  try {
    const response = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(apiKey, apiSecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: phones.map((phone) =>
          isKakao
            ? { to: phone, text, type: 'CTA', kakaoOptions: { pfId: senderKey } }
            : { to: phone, from: senderPhone, text, type: smsType }
        ),
      }),
    });
    const result = await response.json();
    if (!response.ok || result.errorCode) {
      console.error('[SMS] Solapi 오류:', JSON.stringify(result).slice(0, 500));
      return {
        ok: false,
        error: `문자 발송이 거절되었습니다. (${result.errorMessage || result.errorCode || `HTTP ${response.status}`})`,
      };
    }
    return { ok: true, result };
  } catch (err) {
    console.error('[SMS] 발송 실패:', err.message);
    return { ok: false, error: '문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' };
  }
}

app.post('/api/send-sms', requireAdmin, async (req, res) => {
  const { recipients, message } = req.body;
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const senderKey = process.env.SOLAPI_SENDER_KEY; // 카카오 알림톡 채널 ID (선택)
  const senderPhone = String(process.env.SOLAPI_SENDER || '').replace(/\D/g, ''); // 발신번호

  if (!apiKey || !apiSecret || (!senderKey && !senderPhone)) {
    return res.status(500).json({
      error:
        '문자 API 키가 서버에 등록되지 않았습니다. 서버의 /opt/jeolim-cabbage/.env 파일에 SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER(발신번호)를 입력하고 서비스를 재시작하세요.',
    });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: '수신자를 입력해주세요.' });
  }
  if (recipients.length > 100) {
    return res.status(400).json({ error: '수신자는 한 번에 최대 100명까지 가능합니다.' });
  }

  const text = String(message || '');
  if (!text.trim()) {
    return res.status(400).json({ error: '메시지를 입력해주세요.' });
  }
  if (text.length > 1000) {
    return res.status(400).json({ error: '메시지는 1000자 이내로 입력해주세요.' });
  }

  const validRecipients = recipients
    .map((p) => String(p).replace(/\D/g, ''))
    .filter((p) => /^0\d{8,10}$/.test(p));

  if (validRecipients.length === 0) {
    return res.status(400).json({ error: '유효한 전화번호가 없습니다.' });
  }

  try {
    // 카카오 채널이 설정되어 있으면 알림톡, 아니면 일반 문자(SMS/LMS)로 발송
    // 90바이트 이하는 SMS, 초과는 LMS로 자동 선택
    const isKakao = !!senderKey;
    const smsType = smsByteLength(text) <= 90 ? 'SMS' : 'LMS';
    const response = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(apiKey, apiSecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: validRecipients.map((phone) =>
          isKakao
            ? { to: phone, text, type: 'CTA', kakaoOptions: { pfId: senderKey } }
            : { to: phone, from: senderPhone, text, type: smsType }
        ),
      }),
    });

    const result = await response.json();
    // Solapi 오류 응답 감지 (errorCode/errorMessage 필드)
    if (!response.ok || result.errorCode) {
      console.error('[SMS] Solapi 오류:', JSON.stringify(result).slice(0, 500));
      return res.status(502).json({
        error: `문자 발송이 거절되었습니다. (${result.errorMessage || result.errorCode || `HTTP ${response.status}`}) 발신번호 등록 상태를 확인해주세요.`,
      });
    }
    return res.json({ success: true, sent: validRecipients.length, result });
  } catch (err) {
    // 내부 오류 상세는 서버 로그로만 기록
    console.error('[SMS] 발송 실패:', err.message);
    return res.status(500).json({ error: '문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// 인증서 다운로드 (다른 기기에서 HTTPS 경고 없이 접속하려면 이 인증서를 설치)
app.get('/cert.pem', (_req, res) => {
  const certPath = path.join(__dirname, 'ssl', 'cert.pem');
  if (fsSync.existsSync(certPath)) {
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="jeolim-cert.pem"');
    return res.sendFile(certPath);
  }
  res.status(404).send('인증서가 아직 생성되지 않았습니다.');
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
// UI상 관리자만 편집하는 데이터 — 서버에서도 관리자 쓰기만 허용
// (orders/customers는 일반 사용자도 주문 등록 과정에서 쓰므로 제외)
const ADMIN_ONLY_DATA_KEYS = new Set([
  'products',
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

// DB(Supabase)가 연결되면 app_kv 테이블에 영구 저장, 오류/미연결 시 로컬 JSON 폭백
async function storeRead(kvKey, file, fallback) {
  if (hasKv()) {
    try {
      const value = await kvGet(kvKey);
      return value === null || value === undefined ? fallback : value;
    } catch (err) {
      console.error(`[STORE] ${kvKey} 읽기 실패, JSON 폭백:`, err.message);
    }
  }
  return readJsonSafe(file, fallback);
}

async function storeWrite(kvKey, file, data) {
  if (hasKv()) {
    try {
      await kvSet(kvKey, data);
      return;
    } catch (err) {
      console.error(`[STORE] ${kvKey} 저장 실패, JSON 폭백:`, err.message);
    }
  }
  await writeJsonSafe(file, data);
}

// ===== 실시간 동기화 (SSE) =====
// 데이터가 바뀌면 로그인된 모든 기기(웹/앱)에 즉시 push하여
// 새로고침 없이 서버와 실시간으로 저장·수정이 반영되게 함.
const sseClients = new Map();

function broadcastChange(key, origin) {
  if (sseClients.size === 0) return;
  const payload = `event: data-changed\ndata: ${JSON.stringify({ key, origin, ts: Date.now() })}\n\n`;
  for (const [res, info] of sseClients) {
    if (origin && info.clientId === origin) continue; // 변경을 보낸 기기 자신은 제외
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

app.get('/api/events', requireAuth, (req, res) => {
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.slice(0, 64) : '';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  sseClients.set(res, { userId: req.session.userId, clientId });
  // 연결 유지용 하트비트 (프록시 타임아웃 방지)
  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { /* 무시 */ }
  }, 25000);
  // 참고: Node 16+에서 req 'close'는 요청 수신 완료 시점에 바로 발생하므로
  // 연결 종료 감지는 반드시 response의 'close' 이벤트로 해야 함.
  res.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

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
    if (ADMIN_ONLY_DATA_KEYS.has(key) && req.session.role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    const store = await storeRead('app_data', APP_DATA_FILE, {});
    store[key] = { value: req.body, savedAt: new Date().toISOString() };
    await storeWrite('app_data', APP_DATA_FILE, store);
    broadcastChange(key, req.headers['x-client-id']);
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
    // 앱 동기화가 서버의 결제 기록을 덮어쓰지 않도록 보존
    const existing = store.orders[req.params.id];
    if (existing && existing.paid) {
      snapshot.paid = existing.paid;
      snapshot.paidAt = existing.paidAt;
      snapshot.paidAmount = existing.paidAmount;
      snapshot.paymentKey = existing.paymentKey;
      snapshot.paymentMethod = existing.paymentMethod;
      snapshot.depositAmount = existing.depositAmount;
    }
    store.orders[req.params.id] = snapshot;
    await storeWrite('public_orders', PUBLIC_ORDERS_FILE, store);
    broadcastChange('orders', req.headers['x-client-id']);
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
    // 결제 식별키는 외부에 노출하지 않음
    const { paymentKey: _paymentKey, ...publicOrder } = order;
    return res.json(publicOrder);
  } catch {
    return res.status(500).json({ error: '주문 조회에 실패했습니다.' });
  }
});

app.delete('/api/public/order/:id', requireAdmin, async (req, res) => {
  try {
    const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
    if (store.orders && store.orders[req.params.id]) {
      delete store.orders[req.params.id];
      await storeWrite('public_orders', PUBLIC_ORDERS_FILE, store);
      broadcastChange('orders', req.headers['x-client-id']);
    }
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '공유 링크 삭제에 실패했습니다.' });
  }
});

// 결제 완료된 공개 주문 목록 — 앱이 주기적으로 가져가 주문 목록에 완납 반영
app.get('/api/payments/public-orders', requireAuth, async (_req, res) => {
  try {
    const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
    const paid = Object.values(store.orders || {})
      .filter((o) => o && o.paid)
      .map((o) => ({
        id: o.id,
        paidAt: o.paidAt,
        paidAmount: o.paidAmount,
        paymentMethod: o.paymentMethod,
      }));
    return res.json(paid);
  } catch {
    return res.status(500).json({ error: '결제 정보 조회에 실패했습니다.' });
  }
});

app.put('/api/public/gallery', requireAuth, async (req, res) => {
  try {
    const { items, notice } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }
    await storeWrite('public_gallery', PUBLIC_GALLERY_FILE, { items, notice: String(notice || '') });
    broadcastChange('gallery', req.headers['x-client-id']);
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

// ===== 고객 자가등록 (공개 URL 접수) =====
const INTAKE_FILE = path.join(__dirname, 'src/lib/data/customer-intake.json');
const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }),
});

// ===== 공개 주문 결제 (토스페이먼츠) =====
// 시크릿 키는 서버 전용 런타임 환경변수(TOSS_SECRET_KEY)로만 주입한다.
// 소스 코드에 키 값이나 fallback을 두지 않는다.
// 실결제 전환 시: 토스페이먼츠 가입 후 라이브 키를 서버 환경변수로 설정하면 됨.
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }),
});

// 결제 승인: 토스 서버에 확인 후 주문에 결제 완료 기록
// 동일 주문에 대한 동시 승인 요청 방지 (이중 승인/경쟁 상태 가드)
const paymentInFlight = new Set();
app.post('/api/public/payment/confirm', paymentLimiter, async (req, res) => {
  try {
    if (!TOSS_SECRET_KEY) {
      return res.status(503).json({ error: '결제 설정이 완료되지 않았습니다. 관리자에게 문의해주세요.' });
    }
    const { paymentKey, orderId, amount } = req.body || {};
    const numericAmount = Number(amount);
    if (!paymentKey || typeof paymentKey !== 'string' || paymentKey.length > 200) {
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다.' });
    }
    if (!orderId || typeof orderId !== 'string' || orderId.length > 100) {
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다.' });
    }
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다.' });
    }
    if (paymentInFlight.has(orderId)) {
      return res.status(409).json({ error: '결제가 이미 처리 중입니다. 잠시 후 확인해주세요.' });
    }
    paymentInFlight.add(orderId);
    try {
      const store = await storeRead('public_orders', PUBLIC_ORDERS_FILE, { orders: {} });
      const order = store.orders?.[orderId];
      if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
      if (order.paid) return res.json({ ok: true, already: true });
      const balance = Number(order.totalPrice || 0) - Number(order.depositAmount || 0);
      if (balance <= 0) return res.status(400).json({ error: '결제할 잔액이 없습니다.' });
      if (numericAmount !== balance) {
        return res.status(400).json({ error: '결제 금액이 주문 잔액과 일치하지 않습니다.' });
      }
      const auth = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
      const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paymentKey, orderId, amount: numericAmount }),
      });
      const tossData = await tossRes.json().catch(() => ({}));
      if (!tossRes.ok) {
        return res.status(402).json({ error: tossData.message || '결제 승인에 실패했습니다.' });
      }
      order.paid = true;
      order.paidAt = new Date().toISOString();
      order.paidAmount = numericAmount;
      order.paymentKey = paymentKey;
      order.paymentMethod = tossData.method || '카드';
      order.depositAmount = Number(order.totalPrice || 0);
      await storeWrite('public_orders', PUBLIC_ORDERS_FILE, store);
      broadcastChange('payment', null);
      return res.json({ ok: true, paidAt: order.paidAt });
    } finally {
      paymentInFlight.delete(orderId);
    }
  } catch {
    return res.status(500).json({ error: '결제 처리 중 오류가 발생했습니다.' });
  }
});

app.post('/api/public/customer', intakeLimiter, async (req, res) => {
  try {
    const { name, phone, address, memo, arrivalDate, quantity, receiveMethod } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanPhone = String(phone || '').trim();
    const cleanArrivalDate = String(arrivalDate || '');
    const numericQuantity = Number(quantity);
    if (!cleanName) {
      return res.status(400).json({ error: '고객명을 입력해주세요.' });
    }
    if (!cleanPhone) return res.status(400).json({ error: '연락처를 입력해주세요.' });
    const phoneDigits = cleanPhone.replace(/\D/g, '');
    // 한국 전화번호(휴폰/유선)만 허용 — 0으로 시작 9~11자리
    if (!/^0\d{8,10}$/.test(phoneDigits)) {
      return res.status(400).json({ error: '연락처 형식을 확인해주세요.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanArrivalDate)) {
      return res.status(400).json({ error: '도착 예정일을 선택해주세요.' });
    }
    if (!Number.isInteger(numericQuantity) || numericQuantity <= 0 || numericQuantity > 9999) {
      return res.status(400).json({ error: '수량은 1~9999 사이의 정수로 입력해주세요.' });
    }
    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name: cleanName.slice(0, 50),
      phone: cleanPhone.slice(0, 20),
      address: String(address || '').slice(0, 200),
      memo: String(memo || '').slice(0, 500),
      arrivalDate: cleanArrivalDate,
      quantity: numericQuantity,
      receiveMethod: ['방문', '배송', '택배'].includes(receiveMethod) ? receiveMethod : '방문',
    };
    const list = await storeRead('customer_intake', INTAKE_FILE, []);
    const next = Array.isArray(list) ? list : [];
    // 동일 번호로 60초 이내 재접수 시 중복 저장하지 않음 (중복 클릭/스팸 방지)
    const now = Date.now();
    const isDuplicate = next
      .slice(-20)
      .some(
        (e) =>
          String(e.phone || '').replace(/\D/g, '') === phoneDigits &&
          now - Date.parse(e.createdAt) < 60_000
      );
    if (isDuplicate) return res.json({ ok: true });
    next.push(entry);
    while (next.length > 200) next.shift();
    await storeWrite('customer_intake', INTAKE_FILE, next);
    broadcastChange('intake', null);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '접수에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/customer-intake', requireAdmin, async (_req, res) => {
  try {
    const list = await storeRead('customer_intake', INTAKE_FILE, []);
    return res.json(Array.isArray(list) ? list : []);
  } catch {
    return res.status(500).json({ error: '접수 목록 조회에 실패했습니다.' });
  }
});

app.post('/api/customer-intake/ack', requireAdmin, async (req, res) => {
  try {
    const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
    const list = await storeRead('customer_intake', INTAKE_FILE, []);
    const next = (Array.isArray(list) ? list : []).filter((e) => !ids.has(e.id));
    await storeWrite('customer_intake', INTAKE_FILE, next);
    broadcastChange('intake', req.headers['x-client-id']);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: '접수 확인 처리에 실패했습니다.' });
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
    if (hasKv()) {
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
  const sslDir = path.join(__dirname, 'ssl');
  // Tailscale 발급 인증서 우선, 없으면 자체 서명 인증서 사용
  const tsCert = path.join(sslDir, 'tailscale.crt');
  const tsKey = path.join(sslDir, 'tailscale.key');
  const sslCert = fsSync.existsSync(tsCert) ? tsCert : path.join(sslDir, 'cert.pem');
  const sslKey = fsSync.existsSync(tsKey) ? tsKey : path.join(sslDir, 'key.pem');
  if (fsSync.existsSync(sslKey) && fsSync.existsSync(sslCert)) {
    const { createServer } = await import('https');
    const opts = { key: fsSync.readFileSync(sslKey), cert: fsSync.readFileSync(sslCert) };
    createServer(opts, app).listen(PORT, () => {
      console.log(`Server listening on https://0.0.0.0:${PORT}`);
    });
    if (PORT !== 443) {
      createServer(opts, app).listen(443, () => {
        console.log('Server listening on https://0.0.0.0:443');
      }).on('error', (err) => {
        console.log('Port 443 not available:', err.code);
      });
    }
  } else {
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  }
})();
