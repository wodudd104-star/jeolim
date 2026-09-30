import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[WARN] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. User management endpoints will fail.');
}

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

async function requireAuth(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: '유효하지 않은 인증입니다.' });
  }
  const active = data.user.user_metadata?.active !== false;
  if (!active) {
    return res.status(403).json({ error: '계정이 비활성화되었습니다. 관리자에게 문의하세요.' });
  }
  req.user = data.user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    const role = req.user.user_metadata?.role;
    if (role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
  });
}

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

app.get('/api/users', requireAdmin, async (_req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  const users = (data.users || []).map((u) => ({
    id: u.id,
    email: u.email || '',
    role: u.user_metadata?.role === 'admin' ? 'admin' : 'user',
    active: u.user_metadata?.active !== false,
    createdAt: u.created_at,
  }));
  res.json(users);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { email, password, role, active } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: role === 'admin' ? 'admin' : 'user', active: !!active },
  });
  if (error) {
    return res.status(409).json({ error: error.message });
  }
  res.json({ success: true, id: data.user.id });
});

app.post('/api/users/:id/activate', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
  if (!userData.user) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    user_metadata: { ...userData.user.user_metadata, active: true },
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.post('/api/users/:id/deactivate', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
  if (!userData.user) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  if (userData.user.user_metadata?.role === 'admin') {
    return res.status(403).json({ error: '관리자 계정은 비활성화할 수 없습니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    user_metadata: { ...userData.user.user_metadata, active: false },
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.post('/api/users/:id/promote', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
  if (!userData.user) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    user_metadata: { ...userData.user.user_metadata, role: 'admin', active: true },
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.post('/api/users/:id/demote', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
  if (!userData.user) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
    user_metadata: { ...userData.user.user_metadata, role: 'user' },
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
  if (!userData.user) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  if (req.params.id === req.user.id) {
    return res.status(403).json({ error: '자신의 계정은 삭제할 수 없습니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/bootstrap-admin', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: '서버 인증 설정이 되어있지 않습니다.' });
  }
  const { email, password, secret } = req.body;
  const expectedSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(403).json({ error: '관리자 생성 비밀키가 올바르지 않습니다.' });
  }
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '이메일과 6자 이상의 비밀번호를 입력해주세요.' });
  }

  const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
  const hasAdmin = (existing.users || []).some(
    (u) => u.user_metadata?.role === 'admin'
  );
  if (hasAdmin) {
    return res.status(409).json({ error: '관리자 계정이 이미 존재합니다.' });
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin', active: true },
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, id: data.user.id });
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
