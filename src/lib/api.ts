const API_URL = ((import.meta as any).env.VITE_API_URL as string) || '';

function getUrl(path: string) {
  return API_URL ? `${API_URL}${path}` : path;
}

export async function sendSms(recipients: string[], message: string) {
  const res = await fetch(getUrl('/api/send-sms'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipients, message }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function login(id: string, password: string) {
  const res = await fetch(getUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '로그인 실패');
  return data as { id: string; email: string; role: string; active: boolean };
}

export async function registerAccount(id: string, password: string, email: string) {
  const res = await fetch(getUrl('/api/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password, email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '회원가입 실패');
  return data;
}

export async function fetchUsers() {
  const res = await fetch(getUrl('/api/users'));
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(data.error || '사용자 목록 조회 실패');
  return data as { id: string; email: string; role: string; active: boolean; createdAt: string }[];
}

export async function activateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/activate`), {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '활성화 실패');
  return data;
}

export async function deactivateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/deactivate`), {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '비활성화 실패');
  return data;
}

export async function promoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/promote`), {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '관리자 임명 실패');
  return data;
}

export async function demoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/demote`), {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '일반 사용자로 변경 실패');
  return data;
}

export async function deleteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}`), {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '삭제 실패');
  return data;
}

export async function findIdByEmail(email: string) {
  const res = await fetch(getUrl('/api/find-id'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '아이디 찾기 실패');
  return data;
}

export async function sendResetCode(email: string) {
  const res = await fetch(getUrl('/api/send-reset-code'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '인증번호 발송 실패');
  return data;
}

export async function resetPassword(email: string, code: string, newPassword: string) {
  const res = await fetch(getUrl('/api/reset-password'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '비밀번호 재설정 실패');
  return data;
}

export async function createUser(id: string, password: string, email: string, role: string, active: boolean) {
  const res = await fetch(getUrl('/api/users'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password, email, role, active }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '회원 추가 실패');
  return data;
}

export async function updateServerAuth(
  currentId: string,
  currentPassword: string,
  newId: string,
  newPassword: string,
  email: string
) {
  const res = await fetch(getUrl('/api/update-auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentId, currentPassword, newId, newPassword, email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '서버 계정 정보 수정 실패');
  return data;
}
