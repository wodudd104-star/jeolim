const API_URL = ((import.meta as any).env.VITE_API_URL as string) || '';

function getUrl(path: string) {
  return API_URL ? `${API_URL}${path}` : path;
}

function getHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

export async function fetchAllAppData(): Promise<Record<string, unknown> | null> {
  const res = await fetch(getUrl('/api/data/all'), {
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json();
}

export async function syncAppData(key: string, value: unknown) {
  const res = await fetch(getUrl(`/api/data/${encodeURIComponent(key)}`), {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(value),
    credentials: 'include',
    keepalive: true,
  });
  if (!res.ok) throw new Error('데이터 자동저장 실패');
  return res.json();
}

async function throwIfFailed(res: Response, fallback: string) {
  if (res.ok) return;
  const data = await res.json().catch(() => ({} as { error?: string }));
  if (res.status === 401) throw new Error('로그인이 만료되었습니다. 로그아웃 후 다시 로그인해주세요.');
  throw new Error(data.error || `${fallback} (HTTP ${res.status})`);
}

export async function syncPublicOrder(order: unknown) {
  const res = await fetch(getUrl(`/api/public/order/${encodeURIComponent((order as any).id)}`), {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(order),
    credentials: 'include',
  });
  await throwIfFailed(res, '주문 공유 동기화 실패');
  return res.json();
}

export async function fetchPublicOrder(id: string) {
  const res = await fetch(getUrl(`/api/public/order/${encodeURIComponent(id)}`), {
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json();
}

export async function syncPublicGallery(items: unknown[], notice: string) {
  const res = await fetch(getUrl('/api/public/gallery'), {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ items, notice }),
    credentials: 'include',
  });
  await throwIfFailed(res, '갤러리 공유 동기화 실패');
  return res.json();
}

export async function fetchPublicGallery() {
  const res = await fetch(getUrl('/api/public/gallery'), {
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json();
}

export async function sendSms(recipients: string[], message: string) {
  const res = await fetch(getUrl('/api/send-sms'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ recipients, message }),
    credentials: 'include',
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
    headers: getHeaders(),
    body: JSON.stringify({ id, password }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '로그인 실패');
  return data as { id: string; email: string; role: string; active: boolean };
}

export async function logout() {
  const res = await fetch(getUrl('/api/logout'), {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '로그아웃 실패');
  return data;
}

export async function me() {
  const res = await fetch(getUrl('/api/me'), {
    credentials: 'include',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return null;
  return data as { id: string; email: string; role: string; active: boolean };
}

export async function registerAccount(id: string, password: string, email: string) {
  const res = await fetch(getUrl('/api/register'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ id, password, email }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '회원가입 실패');
  return data;
}

export async function fetchUsers() {
  const res = await fetch(getUrl('/api/users'), {
    credentials: 'include',
  });
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(data.error || '사용자 목록 조회 실패');
  return data as { id: string; email: string; role: string; active: boolean; createdAt: string }[];
}

export async function activateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/activate`), {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '활성화 실패');
  return data;
}

export async function deactivateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/deactivate`), {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '비활성화 실패');
  return data;
}

export async function promoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/promote`), {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '관리자 임명 실패');
  return data;
}

export async function demoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/demote`), {
    method: 'POST',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '일반 사용자로 변경 실패');
  return data;
}

export async function deleteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '삭제 실패');
  return data;
}

export async function findIdByEmail(email: string) {
  const res = await fetch(getUrl('/api/find-id'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '아이디 찾기 실패');
  return data;
}

export async function sendResetCode(email: string) {
  const res = await fetch(getUrl('/api/send-reset-code'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '인증번호 발송 실패');
  return data;
}

export async function resetPassword(email: string, code: string, newPassword: string) {
  const res = await fetch(getUrl('/api/reset-password'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, code, newPassword }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '비밀번호 재설정 실패');
  return data;
}

export async function createUser(id: string, password: string, email: string, role: string, active: boolean) {
  const res = await fetch(getUrl('/api/users'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ id, password, email, role, active }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '회원 추가 실패');
  return data;
}

export async function updateServerAuth(
  currentPassword: string,
  newId: string,
  newPassword: string,
  email: string
) {
  const res = await fetch(getUrl('/api/update-auth'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ currentPassword, newId, newPassword, email }),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '서버 계정 정보 수정 실패');
  return data;
}
