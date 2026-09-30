import React, { useState } from 'react';
import { load, save } from '../lib/storage';
import {
  findIdByEmail,
  login,
  registerAccount,
  resetPassword,
  sendResetCode,
} from '../lib/api';

const AUTH_SESSION_KEY = 'jeolim-auth-session';
const AUTH_ROLE_KEY = 'jeolim-auth-role';
const AUTH_USER_KEY = 'jeolim-auth-user-v1';

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
}

export function getStoredUser(): AuthUser | null {
  return load(AUTH_USER_KEY, null);
}

export function setStoredUser(user: AuthUser) {
  save(AUTH_USER_KEY, user);
}

export function isAdmin(): boolean {
  return sessionStorage.getItem(AUTH_ROLE_KEY) === 'admin';
}

type LoginMode = 'login' | 'signup' | 'find';

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<LoginMode>('login');

  // 로그인
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');

  // 회원가입
  const [signupId, setSignupId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [signupEmail, setSignupEmail] = useState('');

  // 찾기
  const [findType, setFindType] = useState<'id' | 'password'>('id');
  const [findEmail, setFindEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function resetMessages() {
    setError('');
    setSuccess('');
  }

  function switchMode(next: LoginMode) {
    setMode(next);
    resetMessages();
    setCodeSent(false);
    setCode('');
    setNewPassword('');
    setNewPasswordConfirm('');
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    try {
      const user = await login(id, password);
      sessionStorage.setItem(AUTH_SESSION_KEY, '1');
      sessionStorage.setItem(AUTH_ROLE_KEY, user.role === 'admin' ? 'admin' : 'user');
      setStoredUser({ id: user.id, role: user.role, email: user.email });
      onLogin();
    } catch (err: any) {
      setError(err.message || '로그인 중 오류가 발생했습니다.');
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    if (!signupId.trim()) {
      setError('아이디를 입력해주세요.');
      return;
    }
    if (!signupPassword.trim()) {
      setError('비밀번호를 입력해주세요.');
      return;
    }
    if (signupPassword !== signupConfirm) {
      setError('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    if (!signupEmail.trim() || !signupEmail.includes('@')) {
      setError('올바른 이메일을 입력해주세요.');
      return;
    }
    try {
      const data = await registerAccount(signupId, signupPassword, signupEmail);
      setSuccess('회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인 가능합니다.');
      setMode('login');
      setId(signupId);
      setSignupId('');
      setSignupPassword('');
      setSignupConfirm('');
      setSignupEmail('');
    } catch (err: any) {
      setError(err.message || '회원가입 중 오류가 발생했습니다.');
    }
  }

  async function handleSendCode(e?: React.FormEvent) {
    e?.preventDefault();
    resetMessages();
    if (!findEmail.trim() || !findEmail.includes('@')) {
      setError('올바른 이메일을 입력해주세요.');
      return;
    }
    setSending(true);
    try {
      if (findType === 'id') {
        await findIdByEmail(findEmail);
        setSuccess('아이디를 이메일로 발송했습니다. 메일함을 확인해주세요.');
      } else {
        await sendResetCode(findEmail);
        setCodeSent(true);
        setSuccess('인증번호를 이메일로 발송했습니다. 메일함을 확인해주세요.');
      }
    } catch (err: any) {
      setError(err.message || '이메일 발송 중 오류가 발생했습니다.');
    } finally {
      setSending(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    if (!code.trim()) {
      setError('인증번호를 입력해주세요.');
      return;
    }
    if (!newPassword.trim()) {
      setError('새 비밀번호를 입력해주세요.');
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError('새 비밀번호와 확인이 일치하지 않습니다.');
      return;
    }
    try {
      await resetPassword(findEmail, code, newPassword);
      setSuccess('비밀번호가 재설정되었습니다. 로그인해주세요.');
      setMode('login');
      setFindEmail('');
      setCode('');
      setNewPassword('');
      setNewPasswordConfirm('');
      setCodeSent(false);
    } catch (err: any) {
      setError(err.message || '비밀번호 재설정 중 오류가 발생했습니다.');
    }
  }

  return (
    <div className='login-overlay'>
      <div className='login-box panel'>
        <h1>절임배추 관리</h1>
        <p>
          관리자{' '}
          {mode === 'login'
            ? '로그인'
            : mode === 'signup'
            ? '회원가입'
            : '아이디·비밀번호 찾기'}
        </p>

        <div className='login-tabs'>
          <button
            className={`btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            로그인
          </button>
          <button
            className={`btn ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => switchMode('signup')}
          >
            회원가입
          </button>
          <button
            className={`btn ${mode === 'find' ? 'active' : ''}`}
            onClick={() => switchMode('find')}
          >
            ID/PW 찾기
          </button>
        </div>

        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <input
              type='text'
              className='input'
              placeholder='아이디'
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoFocus
            />
            <input
              type='password'
              className='input'
              placeholder='비밀번호'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className='login-error'>{error}</p>}
            {success && <p className='login-success'>{success}</p>}
            <button type='submit' className='btn btn-primary full'>
              로그인
            </button>
          </form>
        )}

        {mode === 'signup' && (
          <form onSubmit={handleSignup}>
            <input
              type='text'
              className='input'
              placeholder='아이디'
              value={signupId}
              onChange={(e) => setSignupId(e.target.value)}
              autoFocus
            />
            <input
              type='password'
              className='input'
              placeholder='비밀번호'
              value={signupPassword}
              onChange={(e) => setSignupPassword(e.target.value)}
            />
            <input
              type='password'
              className='input'
              placeholder='비밀번호 확인'
              value={signupConfirm}
              onChange={(e) => setSignupConfirm(e.target.value)}
            />
            <input
              type='email'
              className='input'
              placeholder='이메일 (아이디/비밀번호 찾기용)'
              value={signupEmail}
              onChange={(e) => setSignupEmail(e.target.value)}
            />
            {error && <p className='login-error'>{error}</p>}
            {success && <p className='login-success'>{success}</p>}
            <button type='submit' className='btn btn-primary full'>
              회원가입
            </button>
          </form>
        )}

        {mode === 'find' && (
          <form onSubmit={findType === 'id' ? handleSendCode : handleResetPassword}>
            <div className='find-type'>
              <label>
                <input
                  type='radio'
                  name='findType'
                  checked={findType === 'id'}
                  onChange={() => setFindType('id')}
                />
                아이디 찾기
              </label>
              <label>
                <input
                  type='radio'
                  name='findType'
                  checked={findType === 'password'}
                  onChange={() => setFindType('password')}
                />
                비밀번호 재설정
              </label>
            </div>

            <input
              type='email'
              className='input'
              placeholder='가입한 이메일'
              value={findEmail}
              onChange={(e) => setFindEmail(e.target.value)}
              autoFocus
            />

            {findType === 'id' && (
              <>
                {error && <p className='login-error'>{error}</p>}
                {success && <p className='login-success'>{success}</p>}
                <button
                  type='button'
                  className='btn btn-primary full'
                  onClick={() => handleSendCode()}
                  disabled={sending}
                >
                  {sending ? '발송 중...' : '아이디 이메일로 받기'}
                </button>
              </>
            )}

            {findType === 'password' && (
              <>
                {!codeSent ? (
                  <button
                    type='button'
                    className='btn btn-primary full'
                    onClick={() => handleSendCode()}
                    disabled={sending}
                  >
                    {sending ? '발송 중...' : '인증번호 받기'}
                  </button>
                ) : (
                  <>
                    <input
                      type='text'
                      className='input'
                      placeholder='이메일로 받은 인증번호'
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <input
                      type='password'
                      className='input'
                      placeholder='새 비밀번호'
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <input
                      type='password'
                      className='input'
                      placeholder='새 비밀번호 확인'
                      value={newPasswordConfirm}
                      onChange={(e) => setNewPasswordConfirm(e.target.value)}
                    />
                    <button
                      type='button'
                      className='btn full'
                      onClick={() => handleSendCode()}
                      disabled={sending}
                    >
                      {sending ? '발송 중...' : '인증번호 재발송'}
                    </button>
                  </>
                )}
                {error && <p className='login-error'>{error}</p>}
                {success && <p className='login-success'>{success}</p>}
                {codeSent && (
                  <button type='submit' className='btn btn-primary full'>
                    비밀번호 재설정
                  </button>
                )}
              </>
            )}
          </form>
        )}

        <p className='login-hint'>모든 정보는 서버에 안전하게 저장됩니다.</p>
      </div>
    </div>
  );
}
