import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
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
} from './src/lib/db.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const TARGET_ADMIN_ID = 'wodudd102';
const DEFAULT_ADMIN_PASSWORD = '0000';
const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const SIGNUP_LOG_FILE = path.join(__dirname, 'data', 'signups.json');

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
    if (!u.id || !u.salt || !u.hash) continue;
    try {
      await createUser({
        id: u.id,
        email: u.email || '',
        salt: u.salt,
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

async function runAdminMigration() {
  const user = await findUserById(TARGET_ADMIN_ID);
  if (user) {
    if (user.role !== 'admin' || !user.active) {
      await updateUser(TARGET_ADMIN_ID, { role: 'admin', active: true });
    }
  }

  // 기존 admin 계정이 다른 관리자가 있으면 삭제
  const defaultAdmin = await findUserById('admin');
  if (defaultAdmin) {
    const otherAdmins = (await listUsers()).filter(
      (u) => u.role === 'admin' && u.id !== 'admin'
    );
    if (otherAdmins.length > 0) {
      await deleteUserById('admin');
    }
  }
}

async function ensureDefaultAdmin() {
  const admin = await findUserById('admin');
  if (admin) return;
  const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASSWORD);
  await createUser({
    id: 'admin',
    email: '',
    salt,
    hash,
    role: 'admin',
    active: true,
  });
}

function getEmailTransporter() {
  const service = process.env.EMAIL_SERVICE || 'gmail';
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service, auth: { user, pass } });
}

function generateCode(email) {
  const secret = process.env.EMAIL_CODE_SECRET || 'jeolim-cabbage-secret';
  const slot = Math.floor(Date.now() / (1000 * 60 * 30));
  return crypto
    .createHmac('sha256', secret)
    .update(`${email}:${slot}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
}

function verifyCode(email, code) {
  const current = generateCode(email);
  if (code.toUpperCase() === current) return true;
  const secret = process.env.EMAIL_CODE_SECRET || 'jeolim-cabbage-secret';
  const prevSlot = Math.floor(Date.now() / (1000 * 60 * 30)) - 1;
  const prev = crypto
    .createHmac('sha256', secret)
    .update(`${email}:${prevSlot}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return code.toUpperCase() === prev;
}

async function sendEmail(to, subject, text) {
  const transporter = getEmailTransporter();
  if (!transporter) throw new Error('이메일 발송 설정이 되어있지 않습니다.');
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  await transporter.sendMail({ from, to, subject, text });
}

app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  // 기본 관리자 계정은 항상 로그인 가능
  if (id === 'admin' && password === DEFAULT_ADMIN_PASSWORD) {
    return res.json({ id: 'admin', role: 'admin', active: true, email: '' });
  }

  const user = await findUserById(id);
  if (!user) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  }
  if (!verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  }
  if (!user.active) {
    return res.status(403).json({ error: '계정이 비활성화되었습니다. 관리자에게 문의하세요.' });
  }
  res.json({ id: user.id, role: user.role, active: user.active, email: user.email });
});

app.post('/api/register', async (req, res) => {
  const { id, password, email } = req.body;
  if (!id || !password || !email) {
    return res.status(400).json({ error: '아이디, 비밀번호, 이메일을 모두 입력해주세요.' });
  }

  const existingById = await findUserById(id);
  if (existingById) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  const existingByEmail = await findUsersByEmail(email);
  if (existingByEmail.length > 0) {
    return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }

  const { salt, hash } = hashPassword(password);
  const newUser = {
    id,
    email,
    salt,
    hash,
    role: 'user',
    active: false,
  };
  await createUser(newUser);
  await appendSignupLog({ id, email, role: 'user', active: false });
  res.json({ success: true, role: 'user', active: false });
});

app.get('/api/users', async (_req, res) => {
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

app.post('/api/users', async (req, res) => {
  const { id, password, email, role, active } = req.body;
  if (!id || !password || !email) {
    return res.status(400).json({ error: '아이디, 비밀번호, 이메일을 모두 입력해주세요.' });
  }
  const existingById = await findUserById(id);
  if (existingById) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  const existingByEmail = await findUsersByEmail(email);
  if (existingByEmail.length > 0) {
    return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }
  const { salt, hash } = hashPassword(password);
  await createUser({
    id,
    email,
    salt,
    hash,
    role: role === 'admin' ? 'admin' : 'user',
    active: !!active,
  });
  res.json({ success: true });
});

app.post('/api/users/:id/activate', async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await updateUser(req.params.id, { active: true });
  res.json({ success: true });
});

app.post('/api/users/:id/deactivate', async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (user.role === 'admin') {
    return res.status(403).json({ error: '관리자 계정은 비활성화할 수 없습니다.' });
  }
  await updateUser(req.params.id, { active: false });
  res.json({ success: true });
});

app.post('/api/users/:id/promote', async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  await updateUser(req.params.id, { role: 'admin', active: true });
  res.json({ success: true });
});

app.post('/api/users/:id/demote', async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (user.id === 'admin') {
    return res.status(403).json({ error: '기본 관리자 계정은 일반 사용자로 변경할 수 없습니다.' });
  }
  await updateUser(req.params.id, { role: 'user' });
  res.json({ success: true });
});

app.delete('/api/users/:id', async (req, res) => {
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
  await deleteUserById(req.params.id);
  res.json({ success: true });
});

app.post('/api/find-id', async (req, res) => {
  const { email } = req.body;
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

app.post('/api/send-reset-code', async (req, res) => {
  const { email } = req.body;
  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.status(404).json({ error: '등록된 이메일이 없습니다.' });
  }
  const code = generateCode(email);
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

app.post('/api/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  const users = await findUsersByEmail(email);
  if (users.length === 0) {
    return res.status(404).json({ error: '등록된 이메일이 없습니다.' });
  }
  if (!verifyCode(email, code)) {
    return res.status(400).json({ error: '인증번호가 올바르지 않거나 만료되었습니다.' });
  }
  const { salt, hash } = hashPassword(newPassword);
  for (const user of users) {
    await updateUser(user.id, { salt, hash });
  }
  res.json({ success: true });
});

app.post('/api/update-auth', async (req, res) => {
  const { currentId, currentPassword, newId, newPassword, email } = req.body;
  const user = await findUserById(currentId);
  if (!user) {
    return res.status(400).json({ error: '서버에 등록된 계정이 없습니다.' });
  }
  if (!verifyPassword(currentPassword, user.salt, user.hash)) {
    return res.status(403).json({ error: '현재 아이디 또는 비밀번호가 틀렸습니다.' });
  }
  if (newId && newId !== currentId) {
    const conflict = await findUserById(newId);
    if (conflict) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  if (email && email !== user.email) {
    const conflict = await findUsersByEmail(email);
    if (conflict.length > 0) return res.status(409).json({ error: '이미 사용 중인 이메일입니다.' });
  }

  const patch = {};
  if (newId) patch.id = newId;
  if (email) patch.email = email;
  if (newPassword) {
    const { salt, hash } = hashPassword(newPassword);
    patch.salt = salt;
    patch.hash = hash;
  }

  // id 변경 시 삭제 후 재생성
  if (newId && newId !== currentId) {
    const { salt, hash } = patch.hash ? { salt: patch.salt, hash: patch.hash } : { salt: user.salt, hash: user.hash };
    await createUser({
      id: newId,
      email: patch.email || user.email,
      salt,
      hash,
      role: user.role,
      active: user.active,
    });
    await deleteUserById(currentId);
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

app.post('/api/send-sms', async (req, res) => {
  const { recipients, message } = req.body;
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const senderKey = process.env.SOLAPI_SENDER_KEY;

  if (!apiKey || !apiSecret || !senderKey) {
    return res.status(500).json({ error: '서버 환경변수가 설정되지 않았습니다.' });
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
    await migrateJsonToDb();
    await ensureDefaultAdmin();
    await runAdminMigration();
    const users = await listUsers();
    console.log(`Total users in storage: ${users.length}`);
    console.log(`Users: ${users.map((u) => `${u.id}(${u.role})`).join(', ')}`);
  } catch (err) {
    console.error('Startup error:', err);
  }
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
})();
