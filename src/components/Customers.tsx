import React, { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Customer, Order } from '../types';
import { load, save } from '../lib/storage';
import { isAdmin } from './Login';

declare global {
  interface Window {
    daum: any;
  }
}

const CUSTOMERS_KEY = 'jeolim-cabbage-customers-v1';

export function loadCustomers(): Customer[] {
  return load(CUSTOMERS_KEY, []);
}

export function saveCustomers(customers: Customer[]) {
  save(CUSTOMERS_KEY, customers);
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

export default function Customers({ orders }: { orders: Order[] }) {
  const [customers, setCustomers] = useState<Customer[]>(() => loadCustomers());
  const [search, setSearch] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Customer, 'id' | 'createdAt'>>({
    name: '',
    phone: '',
    address: '',
    memo: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const admin = isAdmin();

  const filtered = useMemo(() => {
    const term = search.trim();
    return customers
      .filter((c) =>
        term
          ? c.name.includes(term) ||
            c.phone.includes(term) ||
            c.address.includes(term) ||
            c.memo.includes(term)
          : true
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [customers, search]);

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
    setForm({ name: '', phone: '', address: '', memo: '' });
    setEditingId(null);
  }

  function openNewForm() {
    resetForm();
    setIsFormOpen(true);
  }

  function startEdit(customer: Customer) {
    setForm({
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      memo: customer.memo,
    });
    setEditingId(customer.id);
    setIsFormOpen(true);
  }

  function commitCustomers(next: Customer[]) {
    setCustomers(next);
    saveCustomers(next);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      alert('고객명을 입력해주세요.');
      return;
    }
    if (editingId) {
      const updated = customers.map((c) =>
        c.id === editingId ? { ...c, ...form } : c
      );
      commitCustomers(updated);
    } else {
      const newCustomer: Customer = {
        ...form,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      commitCustomers([...customers, newCustomer]);
    }
    resetForm();
    setIsFormOpen(false);
  }

  function removeCustomer(id: string) {
    if (confirm('이 고객을 삭제할까요?')) {
      commitCustomers(customers.filter((c) => c.id !== id));
    }
  }

  function exportCustomers() {
    const rows = customers.map((c) => ({
      이름: c.name,
      연락처: c.phone,
      주소: c.address,
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
    reader.onload = (event) => {
      try {
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
            memo: getCell(row, ['메모', 'Memo', 'memo', '특이사항', '비고']),
          }))
          .filter((c) => c.name || c.phone)
          .map((c) => ({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            name: c.name,
            phone: formatPhone(c.phone),
            address: c.address,
            memo: c.memo,
          }));

        if (imported.length === 0) {
          alert('업로드할 고객 데이터가 없습니다. 엑셀 형식을 확인해주세요.');
          return;
        }

        if (confirm(`${imported.length}명의 고객을 추가할까요?`)) {
          commitCustomers([...customers, ...imported]);
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
      script.src = '//t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
      script.async = true;
      script.onload = () => resolve(window.daum);
      script.onerror = () => reject(new Error('주소 검색 스크립트를 불러오지 못했습니다.'));
      document.head.appendChild(script);
    });
  }

  async function openPostcode() {
    try {
      const daum = await loadPostcodeScript();
      setIsPostcodeOpen(true);
      setTimeout(() => {
        if (!postcodeWrapRef.current) return;
        new daum.Postcode({
          width: '100%',
          height: '100%',
          oncomplete: (data: any) => {
            setForm((prev) => ({ ...prev, address: data.address }));
            setIsPostcodeOpen(false);
          },
          onresize: () => {
            if (postcodeWrapRef.current) {
              postcodeWrapRef.current.style.height = '100%';
            }
          },
        }).embed(postcodeWrapRef.current);
      }, 0);
    } catch (err) {
      alert('주소 검색을 불러오는 중 오류가 발생했습니다.');
    }
  }

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
      </section>

      {admin && isFormOpen && (
        <section className='panel form-panel'>
          <h2>{editingId ? '고객 수정' : '새 고객 등록'}</h2>
          <form onSubmit={handleSubmit}>
            <div className='form-grid'>
              <label>
                고객명
                <input
                  className='input'
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder='홍길동'
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
                {editingId ? '수정 저장' : '고객 등록'}
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
            return (
              <article key={customer.id} className='customer-card'>
                <div className='customer-row head'>
                  <div className='customer-meta'>
                    <span className='customer-name'>{customer.name}</span>
                    <span className='customer-phone'>
                      {customer.phone || '연락처 없음'}
                    </span>
                    {orderCount > 0 && (
                      <span className='tag highlight'>{orderCount}건 주문</span>
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
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
