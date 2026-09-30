import React, { useEffect, useState } from 'react';
import { load, save } from '../lib/storage';
import {
  activateUser,
  createUser,
  deactivateUser,
  deleteUser,
  demoteUser,
  fetchUsers,
  promoteUser,
  updateServerAuth,
} from '../lib/api';

const AUTH_USER_KEY = 'jeolim-auth-user-v1';
const ORDERS_KEY = 'jeolim-cabbage-orders-v3';
const CUSTOMERS_KEY = 'jeolim-cabbage-customers-v1';
const PRODUCTS_KEY = 'jeolim-cabbage-products-v1';
const ACCOUNT_NUMBERS_KEY = 'jeolim-cabbage-account-numbers';

export type AdminAuth = {
  id: string;
  password: string;
  email: string;
};

export type AccountInfo = {
  id: string;
  bank: string;
  number: string;
  holder: string;
};

export function getStoredUser() {
  return load(AUTH_USER_KEY, null);
}

export function getStoredAccountNumbers(): AccountInfo[] {
  return load(ACCOUNT_NUMBERS_KEY, []);
}

export function getStoredAccountNumber(): string {
  const list = getStoredAccountNumbers();
  if (list.length === 0) return '';
  return list.map((a) => `${a.bank} ${a.number} ${a.holder}`).join('\n');
}

export function setStoredUser(user: { id: string; role: string; email: string }) {
  save(AUTH_USER_KEY, user);
}

export function AccountManager() {
  const [accounts, setAccounts] = useState<AccountInfo[]>(() => getStoredAccountNumbers());
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState({ bank: '', number: '', holder: '' });

  function commit(next: AccountInfo[]) {
    setAccounts(next);
    save(ACCOUNT_NUMBERS_KEY, next);
  }

  function addAccount() {
    if (!form.bank.trim() || !form.number.trim() || !form.holder.trim()) {
      alert('은행명, 계좌번호, 예금주를 모두 입력해주세요.');
      return;
    }
    const newAccount: AccountInfo = {
      id: crypto.randomUUID(),
      bank: form.bank.trim(),
      number: form.number.trim(),
      holder: form.holder.trim(),
    };
    commit([...accounts, newAccount]);
    setForm({ bank: '', number: '', holder: '' });
    setIsAdding(false);
  }

  function removeAccount(id: string) {
    if (confirm('이 계좌를 삭제할까요?')) {
      commit(accounts.filter((a) => a.id !== id));
    }
  }

  return (
    <div className='account-manager'>
      <div className='account-list'>
        {accounts.length === 0 ? (
          <p className='empty'>등록된 계좌가 없습니다.</p>
        ) : (
          accounts.map((a) => (
            <div key={a.id} className='account-item'>
              <div className='account-info'>
                <span className='account-bank'>{a.bank}</span>
                <span className='account-number'>{a.number}</span>
                <span className='account-holder'>{a.holder}</span>
              </div>
              <button className='btn icon danger' onClick={() => removeAccount(a.id)} title='삭제'>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {!isAdding ? (
        <button className='btn btn-primary' onClick={() => setIsAdding(true)}>
          + 계좌 추가
        </button>
      ) : (
        <div className='account-form'>
          <div className='form-grid three'>
            <label>
              은행
              <input
                className='input'
                value={form.bank}
                onChange={(e) => setForm({ ...form, bank: e.target.value })}
                placeholder='농협'
              />
            </label>
            <label>
              계좌번호
              <input
                className='input'
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
                placeholder='352-1234-5678-90'
              />
            </label>
            <label>
              예금주
              <input
                className='input'
                value={form.holder}
                onChange={(e) => setForm({ ...form, holder: e.target.value })}
                placeholder='홍길동'
              />
            </label>
          </div>
          <div className='form-actions'>
            <button className='btn' onClick={() => setIsAdding(false)}>
              취소
            </button>
            <button className='btn btn-primary' onClick={addAccount}>
              추가
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const [currentUser] = useState(() => getStoredUser() || { id: '', role: 'admin', email: '' });
  const [currentPassword, setCurrentPassword] = useState('');
  const [newId, setNewId] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const [users, setUsers] = useState<
    { id: string; email: string; role: string; active: boolean; createdAt: string }[]
  >([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    id: '',
    password: '',
    confirm: '',
    email: '',
    role: 'user',
    active: true,
  });

  useEffect(() => {
    loadUserList();
  }, []);

  async function loadUserList() {
    setLoadingUsers(true);
    try {
      const list = await fetchUsers();
      setUsers(list);
    } catch (err: any) {
      setMessage(err.message || '사용자 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingUsers(false);
    }
  }

  async function handleCredentialsChange(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    if (!currentUser) {
      setMessage('로그인 정보가 없습니다.');
      return;
    }
    if (!currentPassword.trim()) {
      setMessage('현재 비밀번호를 입력해주세요.');
      return;
    }
    if (!newId.trim()) {
      setMessage('새 아이디를 입력해주세요.');
      return;
    }
    if (!newPassword.trim()) {
      setMessage('새 비밀번호를 입력해주세요.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage('새 비밀번호와 확인이 일치하지 않습니다.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setMessage('올바른 이메일을 입력해주세요.');
      return;
    }

    try {
      await updateServerAuth(currentUser.id, currentPassword, newId, newPassword, email);
      setStoredUser({ id: newId, role: currentUser.role, email });
      setCurrentPassword('');
      setNewId('');
      setNewPassword('');
      setConfirmPassword('');
      setEmail('');
      setMessage('아이디, 비밀번호, 이메일이 변경되었습니다.');
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '서버 연동 중 오류가 발생했습니다.');
    }
  }

  async function toggleActive(user: typeof users[number]) {
    try {
      if (user.active) {
        await deactivateUser(user.id);
      } else {
        await activateUser(user.id);
      }
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '상태 변경 실패');
    }
  }

  async function promote(user: typeof users[number]) {
    try {
      await promoteUser(user.id);
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '관리자 임명 실패');
    }
  }

  async function demote(user: typeof users[number]) {
    try {
      await demoteUser(user.id);
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '일반 사용자로 변경 실패');
    }
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    if (!addForm.id.trim() || !addForm.password.trim() || !addForm.email.trim()) {
      setMessage('아이디, 비밀번호, 이메일을 모두 입력해주세요.');
      return;
    }
    if (addForm.password !== addForm.confirm) {
      setMessage('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    try {
      await createUser(addForm.id, addForm.password, addForm.email, addForm.role, addForm.active);
      setAddForm({ id: '', password: '', confirm: '', email: '', role: 'user', active: true });
      setIsAddOpen(false);
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '회원 추가 실패');
    }
  }

  async function removeUser(user: typeof users[number]) {
    if (!confirm(`'${user.id}' 계정을 삭제할까요?`)) return;
    try {
      await deleteUser(user.id);
      loadUserList();
    } catch (err: any) {
      setMessage(err.message || '삭제 실패');
    }
  }

  function clearAllData() {
    if (
      confirm(
        '정말 모든 데이터를 삭제할까요?\n주문, 고객, 품목 설정이 모두 사라집니다.'
      )
    ) {
      localStorage.removeItem(ORDERS_KEY);
      localStorage.removeItem(CUSTOMERS_KEY);
      localStorage.removeItem(PRODUCTS_KEY);
      alert('모든 데이터가 삭제되었습니다. 페이지를 새로고침합니다.');
      window.location.reload();
    }
  }

  return (
    <div className='admin-shell'>
      <header className='app-header'>
        <div>
          <p className='eyebrow'>절임배추 관리</p>
          <h1>관리자 설정</h1>
        </div>
      </header>

      <section className='panel account-panel'>
        <div className='account-panel-header'>
          <div>
            <h2>계좌번호 설정</h2>
            <p className='panel-hint'>
              단체 문자 발송 시 {'{계좌번호}'} 변수에 들어갈 계좌번호를 입력하세요.
            </p>
          </div>
          <AccountManager />
        </div>
      </section>

      <section className='panel'>
        <h2>아이디 / 비밀번호 / 이메일 변경</h2>
        <form onSubmit={handleCredentialsChange} className='admin-form'>
          <label>
            현재 비밀번호
            <input
              type='password'
              className='input'
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder='현재 비밀번호'
            />
          </label>
          <label>
            새 아이디
            <input
              type='text'
              className='input'
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder='새 아이디'
            />
          </label>
          <label>
            새 비밀번호
            <input
              type='password'
              className='input'
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder='새 비밀번호'
            />
          </label>
          <label>
            새 비밀번호 확인
            <input
              type='password'
              className='input'
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder='새 비밀번호 확인'
            />
          </label>
          <label>
            이메일 (ID/PW 찾기용)
            <input
              type='email'
              className='input'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder='이메일'
            />
          </label>
          {message && <p className='admin-message'>{message}</p>}
          <button type='submit' className='btn btn-primary'>
            변경 저장
          </button>
        </form>
      </section>

      <section className='panel'>
        <div className='admin-section-header'>
          <h2>회원 관리</h2>
          <div className='header-actions'>
            <button className='btn btn-primary' onClick={() => setIsAddOpen(true)}>
              + 회원 직접 추가
            </button>
            <button className='btn' onClick={loadUserList} disabled={loadingUsers}>
              {loadingUsers ? '불러오는 중...' : '새로고침'}
            </button>
          </div>
        </div>
        <p className='panel-hint'>
          회원가입한 사용자는 기본적으로 비활성화 상태입니다. 관리자가 승인(활성화)해야
          로그인할 수 있습니다.
        </p>

        {isAddOpen && (
          <form onSubmit={handleAddUser} className='admin-form add-user-form'>
            <div className='form-grid'>
              <label>
                아이디
                <input
                  className='input'
                  value={addForm.id}
                  onChange={(e) => setAddForm({ ...addForm, id: e.target.value })}
                  placeholder='아이디'
                />
              </label>
              <label>
                이메일
                <input
                  type='email'
                  className='input'
                  value={addForm.email}
                  onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                  placeholder='이메일'
                />
              </label>
              <label>
                비밀번호
                <input
                  type='password'
                  className='input'
                  value={addForm.password}
                  onChange={(e) => setAddForm({ ...addForm, password: e.target.value })}
                  placeholder='비밀번호'
                />
              </label>
              <label>
                비밀번호 확인
                <input
                  type='password'
                  className='input'
                  value={addForm.confirm}
                  onChange={(e) => setAddForm({ ...addForm, confirm: e.target.value })}
                  placeholder='비밀번호 확인'
                />
              </label>
              <label>
                권한
                <select
                  className='select'
                  value={addForm.role}
                  onChange={(e) => setAddForm({ ...addForm, role: e.target.value })}
                >
                  <option value='user'>사용자</option>
                  <option value='admin'>관리자</option>
                </select>
              </label>
              <label className='checkbox-label'>
                <input
                  type='checkbox'
                  checked={addForm.active}
                  onChange={(e) => setAddForm({ ...addForm, active: e.target.checked })}
                />
                가입 즉시 활성화
              </label>
            </div>
            <div className='form-actions'>
              <button type='button' className='btn' onClick={() => setIsAddOpen(false)}>
                취소
              </button>
              <button type='submit' className='btn btn-primary'>
                회원 추가
              </button>
            </div>
          </form>
        )}

        {users.length === 0 ? (
          <div className='empty'>등록된 회원이 없습니다.</div>
        ) : (
          <div className='user-list'>
            {users.map((user) => (
              <div key={user.id} className={`user-row ${user.active ? 'active' : 'inactive'}`}>
                <div className='user-info'>
                  <span className='user-id'>{user.id}</span>
                  <span className='user-email'>{user.email}</span>
                  <span className={`tag ${user.role === 'admin' ? 'highlight' : ''}`}>
                    {user.role === 'admin' ? '관리자' : '사용자'}
                  </span>
                  <span className={`tag ${user.active ? 'payment-완납' : 'payment-미납'}`}>
                    {user.active ? '활성' : '비활성'}
                  </span>
                </div>
                <div className='user-actions'>
                  {user.role !== 'admin' && (
                    <button
                      className={`btn ${user.active ? '' : 'btn-primary'}`}
                      onClick={() => toggleActive(user)}
                    >
                      {user.active ? '비활성화' : '활성화'}
                    </button>
                  )}
                  {user.role !== 'admin' && (
                    <button className='btn btn-primary' onClick={() => promote(user)}>
                      관리자 임명
                    </button>
                  )}
                  {user.role === 'admin' && user.id !== 'admin' && (
                    <button className='btn' onClick={() => demote(user)}>
                      사용자로 변경
                    </button>
                  )}
                  {user.id !== currentUser.id && (
                    <button
                      className='btn icon danger'
                      onClick={() => removeUser(user)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className='panel danger-panel'>
        <h2>데이터 초기화</h2>
        <p>
          모든 주문, 고객, 품목 설정 데이터를 삭제합니다. 삭제 후에는 복구할 수
          없으므로 신중하게 사용하세요.
        </p>
        <button className='btn btn-danger' onClick={clearAllData}>
          ⚠ 모든 데이터 삭제
        </button>
      </section>
    </div>
  );
}
