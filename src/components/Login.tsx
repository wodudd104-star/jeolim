import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

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
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
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

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError(err.message || '로그인에 실패했습니다.');
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !email.includes('@')) {
      setError('올바른 이메일을 입력해주세요.');
      return;
    }
    if (password.length < 6) {
      setError('비밀번호는 최소 6자 이상이어야 합니다.');
      return;
    }
    if (password !== confirm) {
      setError('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setLoading(true);
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { role: 'user', active: false },
      },
    });
    setLoading(false);
    if (err) {
      setError(err.message || '회원가입에 실패했습니다.');
      return;
    }
    if (data.user) {
      const role = data.user.user_metadata?.role === 'admin' ? 'admin' : 'user';
      sessionStorage.setItem(AUTH_SESSION_KEY, '1');
      sessionStorage.setItem(AUTH_ROLE_KEY, role);
      setStoredUser({
        id: data.user.id,
        role,
        email: data.user.email || '',
      });
      onLogin();
    }
  }

  return (
    <div className='login-overlay'>
      <div className='login-box panel'>
        <h1>절임배추 관리</h1>
        <p>{mode === 'login' ? '로그인' : '회원가입'}</p>

        <form onSubmit={mode === 'login' ? handleLogin : handleSignup}>
          <label className='full'>
            이메일
            <input
              type='email'
              className='input full'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder='이메일'
              required
            />
          </label>

          <label className='full'>
            비밀번호
            <input
              type='password'
              className='input full'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder='비밀번호'
              required
              minLength={6}
            />
          </label>

          {mode === 'signup' && (
            <label className='full'>
              비밀번호 확인
              <input
                type='password'
                className='input full'
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder='비밀번호 확인'
                required
                minLength={6}
              />
            </label>
          )}

          {error && <p className='login-error'>{error}</p>}

          <button type='submit' className='btn btn-primary full' disabled={loading}>
            {loading ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>

        <div className='login-toggle'>
          {mode === 'login' ? (
            <>
              아직 계정이 없으신가요?{' '}
              <button type='button' className='link' onClick={() => setMode('signup')}>
                회원가입
              </button>
            </>
          ) : (
            <>
              이미 계정이 있으신가요?{' '}
              <button type='button' className='link' onClick={() => setMode('login')}>
                로그인
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
