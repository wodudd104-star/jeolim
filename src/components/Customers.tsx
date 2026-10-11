import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Customer, Order } from '../types';
import { load, save } from '../lib/storage';
import { isAdmin } from './Login';
import {
  fetchCustomers,
  createCustomer,
  updateCustomerApi,
  deleteCustomerApi,
} from '../lib/api';

declare global {
  interface Window {
    daum: any;
  }
}

const CUSTOMERS_KEY = 'jc_customers_v1';

export function loadCustomers(): Customer[] {
  return load(CUSTOMERS_KEY, []);
}

export function saveCustomers(customers: Customer[]) {
  save(CUSTOMERS_KEY, customers);
}

export function updateCustomer(id: string, patch: Partial<Customer>) {
  const customers = loadCustomers();
  saveCustomers(customers.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

function normalizeExcelDate(value: string): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const kor = value.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (kor) {
    return `${kor[1]}-${String(kor[2]).padStart(2, '0')}-${String(kor[3]).padStart(2, '0')}`;
  }
  const slash = value.match(/(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (slash) {
    return `${slash[1]}-${String(slash[2]).padStart(2, '0')}-${String(slash[3]).padStart(2, '0')}`;
  }
  const serial = Number(value);
  if (!isNaN(serial) && serial > 30000 && serial < 60000) {
    return new Date(Math.round((serial - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  return '';
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function getCell(row: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') {
      return String(value).trim();
    }
  }
  return '';
}

export default function Customers({ orders, refreshSignal, onOpenSms }: { orders: Order[]; refreshSignal?: number; onOpenSms?: (selected: Customer[]) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);

  // 서버에서 고객 목록을 불러오고 브라우저 localStorage에 개인정보를 남기지 않음
  async function loadFromServer() {
    if (!isAdmin()) return;
    setLoading(true);
    try {
      const list = await fetchCustomers();
      setCustomers(list);
    } catch (err: any) {
      alert(err.message || '고객 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFromServer();
  }, []);

  // 외부에서 갱신을 요청하면 서버에서 다시 불러옴
  useEffect(() => {
    if (refreshSignal === undefined) return;
    loadFromServer();
  }, [refreshSignal]);

  const [search, setSearch] = useState('');
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<Omit<Customer, 'id' | 'createdAt'>>({
    name: '',
    phone: '',
    address: '',
    memo: '',
    arrivalDate: '',
    quantity: undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const admin = isAdmin();

  // 다른 기기에서 고객 정보가 변경되면(SSE) 서버에서 최신 목록을 다시 불러옴
  useEffect(() => {
    const handler = () => loadFromServer();
    window.addEventListener('jc-customers-updated', handler);
    return () => window.removeEventListener('jc-customers-updated', handler);
  }, []);

  async function copyIntakeUrl() {
    const url = `${window.location.origin}/?register=customer`;
    try {
      await navigator.clipboard.writeText(url);
      alert('고객등록 URL이 복사되었습니다.\n고객에게 전송하면 고객이 직접 정보를 입력할 수 있습니다.');
    } catch {
      prompt('고객등록 URL을 복사해주세요.', url);
    }
  }

  // 이름+연락처가 같은 중복 고객 그룹 찾기 (고객등록 URL 중복 접수 정리용)
  const duplicateIds = useMemo(() => {
    const groups = new Map<string, Customer[]>();
    customers.forEach((c) => {
      const key = `${c.name.trim()}|${c.phone.replace(/\D/g, '')}`;
      if (!key.replace('|', '')) return;
      const list = groups.get(key) || [];
      list.push(c);
      groups.set(key, list);
    });
    const ids = new Set<string>();
    groups.forEach((list) => {
      if (list.length > 1) list.forEach((c) => ids.add(c.id));
    });
    return ids;
  }, [customers]);

  const filtered = useMemo(() => {
    const term = search.trim();
    const base = showDuplicatesOnly ? customers.filter((c) => duplicateIds.has(c.id)) : customers;
    return base
      .filter((c) =>
        term
          ? c.name.includes(term) ||
            c.phone.includes(term) ||
            c.address.includes(term) ||
            c.memo.includes(term)
          : true
      )
      .sort((a, b) =>
        showDuplicatesOnly
          ? a.name.localeCompare(b.name, 'ko') ||
            a.phone.localeCompare(b.phone) ||
            a.createdAt.localeCompare(b.createdAt)
          : a.name.localeCompare(b.name, 'ko')
      );
  }, [customers, search, showDuplicatesOnly, duplicateIds]);

  const orderCounts = useMemo(() => {
    const map = new Map<string, number>();
    orders.forEach((o) => {
      const phone = o.phone.replace(/\D/g, '');
      if (!phone) return;
      map.set(phone, (map.get(phone) || 0) + 1);
    });
    return map;
  }, [orders]);

  function resetForm() {
    setForm({ name: '', phone: '', address: '', memo: '', arrivalDate: '', quantity: undefined });
    setEditingId(null);
  }

  function openNewForm() {
    resetForm();
    setIsFormOpen(true);
  }

  function handleOpenSms() {
    const selected = customers.filter((c) => selectedIds.has(c.id));
    if (selected.length === 0) {
      alert('먼저 볂 고객을 선택해주세요.');
      return;
    }
    onOpenSms?.(selected);
  }

  function startEdit(customer: Customer) {
    setForm({
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      memo: customer.memo,
      arrivalDate: customer.arrivalDate || '',
      quantity: customer.quantity,
    });
    setEditingId(customer.id);
    setIsFormOpen(false);
  }

  function cancelEdit() {
    resetForm();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim()) {
      alert('연락처를 입력해주세요.');
      return;
    }
    try {
      if (editingId) {
        await updateCustomerApi(editingId, form);
        await loadFromServer();
      } else {
        await createCustomer(form);
        await loadFromServer();
      }
      resetForm();
      setIsFormOpen(false);
    } catch (err: any) {
      alert(err.message || '저장 중 오류가 발생했습니다.');
    }
  }

  async function removeCustomer(id: string) {
    if (!confirm('이 고객을 삭제할까요?')) return;
    try {
      await deleteCustomerApi(id);
      await loadFromServer();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err: any) {
      alert(err.message || '삭제 중 오류가 발생했습니다.');
    }
  }

  const allSelected =
    admin && filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));
  const someSelected = filtered.some((c) => selectedIds.has(c.id));

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        filtered.forEach((c) => next.delete(c.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((c) => next.add(c.id));
      return next;
    });
  }

  async function removeSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 ${selectedIds.size}명의 고객을 삭제할까요?`)) return;
    try {
      await Promise.all(Array.from(selectedIds).map((id) => deleteCustomerApi(id)));
      await loadFromServer();
      setSelectedIds(new Set());
    } catch (err: any) {
      alert(err.message || '삭제 중 오류가 발생했습니다.');
    }
  }

  async function exportCustomers() {
    // xlsx 라이브러리는 번들에서 분리해 엑셀 기능 사용 시에만 로드 (초기 로딩 속도 개선)
    const XLSX = await import('xlsx');
    const rows = customers.map((c) => ({
      이름: c.name,
      연락처: c.phone,
      주소: c.address,
      도착일: c.arrivalDate || '',
      수량: c.quantity ?? '',
      수령방식: c.receiveMethod || '',
      메모: c.memo,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '고객목록');
    XLSX.writeFile(wb, `절임배추_고객목록_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const XLSX = await import('xlsx');
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, any>[];

        const imported: Customer[] = rows
          .map((row) => ({
            name: getCell(row, ['이름', 'Name', '고객명', 'name', '성명']),
            phone: getCell(row, ['연락처', 'Phone', '전화번호', 'phone', '휴폰', '휴 대폰']),
            address: getCell(row, ['주소', 'Address', 'address', '배송주소']),
            arrivalDate: normalizeExcelDate(
              getCell(row, ['도착일', '도착예정일', '수령일', '수령예정일', '도착날짜'])
            ),
            quantity: (() => {
              const raw = getCell(row, ['수량', '개수', 'quantity', 'Quantity']);
              const n = parseInt(raw.replace(/\D/g, ''), 10);
              return isNaN(n) ? undefined : n;
            })(),
            memo: getCell(row, ['메모', 'Memo', 'memo', '특이사항', '비고']),
          }))
          .filter((c) => c.name || c.phone)
          .map((c) => ({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            name: c.name || '',
            phone: formatPhone(c.phone),
            address: c.address,
            arrivalDate: c.arrivalDate || undefined,
            quantity: c.quantity,
            memo: c.memo,
          }));

        if (imported.length === 0) {
          alert('업로드할 고객 데이터가 없습니다. 엑셀 형식을 확인해주세요.');
          return;
        }

        if (confirm(`${imported.length}명의 고객을 추가할까요?`)) {
          try {
            await Promise.all(imported.map((c) => createCustomer(c)));
            await loadFromServer();
          } catch (err: any) {
            alert(err.message || '일부 고객을 추가하지 못했습니다.');
          }
        }
      } catch (err) {
        alert('엑셀 파일을 읽는 중 오류가 발생했습니다.');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }

  const [isPostcodeOpen, setIsPostcodeOpen] = useState(false);
  const postcodeWrapRef = useRef<HTMLDivElement>(null);

  function loadPostcodeScript(): Promise<typeof window.daum> {
    return new Promise((resolve, reject) => {
      if (window.daum && window.daum.Postcode) {
        resolve(window.daum);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
      script.async = true;
      script.onload = () => resolve(window.daum);
      script.onerror = () => reject(new Error('주소 검색 스크립트를 불러오지 못했습니다.'));
      document.head.appendChild(script);
    });
  }

  function openPostcode() {
    setIsPostcodeOpen(true);
  }

  useEffect(() => {
    if (!isPostcodeOpen) return;
    let cancelled = false;
    loadPostcodeScript()
      .then((daum) => {
        if (cancelled || !postcodeWrapRef.current) return;
        new daum.Postcode({
          width: '100%',
          height: '100%',
          oncomplete: (data: any) => {
            setForm((prev) => ({
              ...prev,
              address: data.roadAddress || data.jibunAddress || data.address || '',
            }));
            setIsPostcodeOpen(false);
          },
        }).embed(postcodeWrapRef.current);
      })
      .catch(() => {
        if (!cancelled) {
          setIsPostcodeOpen(false);
          alert('주소 검색을 불러오는 중 오류가 발생했습니다.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isPostcodeOpen]);

  return (
    <div className='customer-shell'>
      <header className='app-header'>
        <div>
          <p className='eyebrow'>절임배추 관리</p>
          <h1>고객 관리</h1>
        </div>
        <div className='header-actions'>
          {admin && (
            <>
              <button className='btn' onClick={copyIntakeUrl} title='고객이 직접 정보를 입력하는 공개 링크 복사'>
                🔗 고객등록 URL
              </button>
              <button className='btn' onClick={exportCustomers}>
                📤 엑셀 저장
              </button>
              <button className='btn' onClick={() => fileInputRef.current?.click()}>
                📥 엑셀 불러오기
              </button>
              <input
                ref={fileInputRef}
                type='file'
                accept='.xlsx,.xls,.csv'
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
              {onOpenSms && (
                <button className='btn' onClick={handleOpenSms} title='선택한 고객에게 문자를 발송합니다'>
                  ✉️ 선택 문자 발송
                </button>
              )}
              <button className='btn btn-primary' onClick={openNewForm}>
                + 새 고객
              </button>
            </>
          )}
        </div>
      </header>

      <section className='toolbar'>
        <input
          type='text'
          className='input search'
          placeholder='이름, 연락처, 주소, 메모 검색'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {admin && filtered.length > 0 && (
          <div className='selection-controls'>
            <label className='select-all-label'>
              <input
                type='checkbox'
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !allSelected && someSelected;
                }}
                onChange={toggleSelectAll}
              />
              전체 선택
            </label>
            <span className='selection-count'>
              {selectedIds.size > 0 ? `${selectedIds.size}명 선택됨` : ''}
            </span>
            <button
              className='btn danger'
              disabled={selectedIds.size === 0}
              onClick={removeSelected}
            >
              🗑 선택 삭제
            </button>
          </div>
        )}
        {admin && duplicateIds.size > 0 && (
          <button
            className={`btn ${showDuplicatesOnly ? 'btn-primary' : ''}`}
            onClick={() => {
              setShowDuplicatesOnly((prev) => !prev);
              setSelectedIds(new Set());
            }}
            title='이름과 연락처가 같은 중복 고객만 모아서 보고 선택 삭제할 수 있습니다'
          >
            {showDuplicatesOnly ? '← 전체 보기' : `⚠ 중복 고객 ${duplicateIds.size}명 정리`}
          </button>
        )}
      </section>

      {admin && isFormOpen && !editingId && (
        <section className='panel form-panel'>
          <h2>새 고객 등록</h2>
          <form onSubmit={handleSubmit}>
            <div className='form-grid'>
              <label>
                고객명 (선택)
                <input
                  className='input'
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder='미입력 가능'
                />
              </label>
              <label>
                연락처
                <input
                  className='input'
                  type='tel'
                  value={form.phone}
                  onChange={(e) =>
                    setForm({ ...form, phone: formatPhone(e.target.value) })
                  }
                  placeholder='010-0000-0000'
                  maxLength={13}
                />
              </label>
              <label>
                도착 예정일 (선택)
                <input
                  className='input'
                  type='date'
                  value={form.arrivalDate || ''}
                  onChange={(e) => setForm({ ...form, arrivalDate: e.target.value })}
                />
              </label>
              <label>
                수량 (선택)
                <input
                  className='input'
                  type='number'
                  min={0}
                  value={form.quantity ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      quantity:
                        e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
                    })
                  }
                  placeholder='주문 수량'
                />
              </label>
              <label className='full'>
                주소
                <div className='address-row'>
                  <input
                    className='input'
                    value={form.address}
                    onChange={(e) =>
                      setForm({ ...form, address: e.target.value })
                    }
                    placeholder='배송 주소'
                  />
                  <button
                    type='button'
                    className='btn'
                    onClick={openPostcode}
                  >
                    🔍 주소 검색
                  </button>
                </div>
              </label>
              <label className='full'>
                메모
                <input
                  className='input'
                  value={form.memo}
                  onChange={(e) => setForm({ ...form, memo: e.target.value })}
                  placeholder='특이사항'
                />
              </label>
            </div>
            <div className='form-actions'>
              <button
                type='button'
                className='btn'
                onClick={() => setIsFormOpen(false)}
              >
                취소
              </button>
              <button type='submit' className='btn btn-primary'>
                고객 등록
              </button>
            </div>
          </form>
        </section>
      )}

      {admin && isPostcodeOpen && (
        <div
          className='modal-overlay postcode-overlay'
          onClick={(e) => e.target === e.currentTarget && setIsPostcodeOpen(false)}
        >
          <div className='modal panel postcode-modal'>
            <div className='modal-header'>
              <h2>주소 검색</h2>
              <button className='btn icon' onClick={() => setIsPostcodeOpen(false)}>
                ✕
              </button>
            </div>
            <div ref={postcodeWrapRef} className='postcode-wrap'></div>
          </div>
        </div>
      )}

      <section className='customer-list'>
        {filtered.length === 0 ? (
          <div className='empty'>등록된 고객이 없습니다.</div>
        ) : (
          filtered.map((customer) => {
            const phoneDigits = customer.phone.replace(/\D/g, '');
            const orderCount = orderCounts.get(phoneDigits) || 0;
            const isEditing = editingId === customer.id;
            return (
              <article
                key={customer.id}
                className={`customer-card${selectedIds.has(customer.id) ? ' selected' : ''}${isEditing ? ' editing' : ''}`}
              >
                {admin && isEditing ? (
                  <form onSubmit={handleSubmit} className='customer-inline-form'>
                    <div className='form-grid'>
                      <label>
                        고객명 (선택)
                        <input
                          className='input'
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          placeholder='미입력 가능'
                        />
                      </label>
                      <label>
                        연락처
                        <input
                          className='input'
                          type='tel'
                          value={form.phone}
                          onChange={(e) =>
                            setForm({ ...form, phone: formatPhone(e.target.value) })
                          }
                          placeholder='010-0000-0000'
                          maxLength={13}
                        />
                      </label>
                      <label>
                        도착 예정일 (선택)
                        <input
                          className='input'
                          type='date'
                          value={form.arrivalDate || ''}
                          onChange={(e) => setForm({ ...form, arrivalDate: e.target.value })}
                        />
                      </label>
                      <label>
                        수량 (선택)
                        <input
                          className='input'
                          type='number'
                          min={0}
                          value={form.quantity ?? ''}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              quantity:
                                e.target.value === ''
                                  ? undefined
                                  : Math.max(0, Number(e.target.value)),
                            })
                          }
                          placeholder='주문 수량'
                        />
                      </label>
                      <label className='full'>
                        주소
                        <div className='address-row'>
                          <input
                            className='input'
                            value={form.address}
                            onChange={(e) => setForm({ ...form, address: e.target.value })}
                            placeholder='배송 주소'
                          />
                          <button type='button' className='btn' onClick={openPostcode}>
                            🔍 주소 검색
                          </button>
                        </div>
                      </label>
                      <label className='full'>
                        메모
                        <input
                          className='input'
                          value={form.memo}
                          onChange={(e) => setForm({ ...form, memo: e.target.value })}
                          placeholder='특이사항'
                        />
                      </label>
                    </div>
                    <div className='form-actions'>
                      <button type='button' className='btn' onClick={cancelEdit}>
                        취소
                      </button>
                      <button type='submit' className='btn btn-primary'>
                        수정 저장
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className='customer-row head'>
                      {admin && (
                        <input
                          type='checkbox'
                          className='customer-check'
                          checked={selectedIds.has(customer.id)}
                          onChange={() => toggleSelect(customer.id)}
                          aria-label={`${customer.name || customer.phone || '고객'} 선택`}
                        />
                      )}
                      <div className='customer-meta'>
                        <span className='customer-name'>{customer.name}</span>
                        <span className='customer-phone'>
                          {customer.phone || '연락처 없음'}
                        </span>
                        {orderCount > 0 && (
                          <span className='tag highlight'>{orderCount}건 주문</span>
                        )}
                        {customer.receiveMethod && (
                          <span className='tag'>{customer.receiveMethod}</span>
                        )}
                        {customer.arrivalDate && (
                          <span className='tag'>도착 {customer.arrivalDate}</span>
                        )}
                        {(customer.quantity ?? 0) > 0 && (
                          <span className='tag highlight'>{customer.quantity}개</span>
                        )}
                      </div>
                      {admin && (
                        <div className='customer-actions'>
                          <button
                            className='btn icon'
                            onClick={() => startEdit(customer)}
                            title='수정'
                          >
                            ✎
                          </button>
                          <button
                            className='btn icon danger'
                            onClick={() => removeCustomer(customer.id)}
                            title='삭제'
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                    {customer.address && (
                      <p className='customer-address'>{customer.address}</p>
                    )}
                    {customer.memo && (
                      <p className='customer-memo'>{customer.memo}</p>
                    )}
                  </>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
