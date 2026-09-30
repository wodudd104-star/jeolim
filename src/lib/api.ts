import { supabase } from './supabase';

const API_URL = ((import.meta as any).env.VITE_API_URL as string) || '';

function getUrl(path: string) {
  return API_URL ? `${API_URL}${path}` : path;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  return headers;
}

export async function sendSms(recipients: string[], message: string) {
  const res = await fetch(getUrl('/api/send-sms'), {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ recipients, message }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchUsers() {
  const res = await fetch(getUrl('/api/users'), {
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(data.error || '사용자 목록 조회 실패');
  return data as { id: string; email: string; role: string; active: boolean; createdAt: string }[];
}

export async function activateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/activate`), {
    method: 'POST',
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '활성화 실패');
  return data;
}

export async function deactivateUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/deactivate`), {
    method: 'POST',
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '비활성화 실패');
  return data;
}

export async function promoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/promote`), {
    method: 'POST',
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '관리자 임명 실패');
  return data;
}

export async function demoteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}/demote`), {
    method: 'POST',
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '일반 사용자로 변경 실패');
  return data;
}

export async function deleteUser(id: string) {
  const res = await fetch(getUrl(`/api/users/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: await getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '삭제 실패');
  return data;
}

export async function createUser(email: string, password: string, role: string, active: boolean) {
  const res = await fetch(getUrl('/api/users'), {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ email, password, role, active }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '회원 추가 실패');
  return data;
}
