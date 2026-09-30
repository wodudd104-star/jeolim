import React, { useEffect, useState } from 'react';
import { supabase, auth } from '../lib/supabase';

const AUTH_SESSION_KEY = 'jc_auth_session';
const AUTH_ROLE_KEY = 'jc_auth_role';
const AUTH_USER_KEY = 'jc_auth_user_v1';

export type AuthUser = {
  id: string;
  role: string;
  email: string;
};

export function isLoggedIn() {
  return sessionStorage.getItem(AUTH_SESSION_KEY) === '1';
}

export function logout() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(AUTH_ROLE_KEY);
  sessionStorage.removeItem(AUTH_USER_KEY);
  supabase.auth.signOut().catch(() => {});
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = sessionStorage.getItem(AUTH_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: AuthUser) {
  sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

export function isAdmin(): boolean {
  return sessionStorage.getItem(AUTH_ROLE_KEY) === 'admin';
}

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const role = session.user.user_metadata?.role === 'admin' ? 'admin' : 'user';
        sessionStorage.setItem(AUTH_SESSION_KEY, '1');
        sessionStorage.setItem(AUTH_ROLE_KEY, role);
        setStoredUser({
          id: session.user.id,
          role,
          email: session.user.email || '',
        });
        onLogin();
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const role = session.user.user_metadata?.role === 'admin' ? 'admin' : 'user';
        sessionStorage.setItem(AUTH_SESSION_KEY, '1');
        sessionStorage.setItem(AUTH_ROLE_KEY, role);
        setStoredUser({
          id: session.user.id,
          role,
          email: session.user.email || '',
        });
        onLogin();
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [onLogin]);

  function handleSignIn() {
    setError('');
    try {
      auth.openSignInModal();
    } catch (err: any) {
      setError(err?.message || '로그인 창을 열 수 없습니다.');
    }
  }

  return (
    <div className='login-overlay'>
      <div className='login-box panel'>
        <h1>절임배추 관리</h1>
        <p>관리자 로그인</p>

        <button type='button' className='btn btn-primary full' onClick={handleSignIn}>
          Verdent로 로그인 / 회원가입
        </button>

        {error && <p className='login-error'>{error}</p>}

        <p className='login-hint'>Google 또는 이메일로 안전하게 로그인합니다.</p>
      </div>
    </div>
  );
}
