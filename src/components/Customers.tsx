import React, { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Customer, Order } from '../types';
import { load, save } from '../lib/storage';
import { compressImage, saveSafely } from '../lib/images';
import { isAdmin } from './Login';

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

export default function Customers({ orders }: { orders: Order[] }) {
  const [customers, setCustomers] = useState<Customer[]>(() => loadCustomers());
  const [search, setSearch] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<Omit<Customer, 'id' | 'createdAt'>>({
    name: '',
    phone: '',
    address: '',
    memo: '',
    photos: [],
    arrivalDate: '',
    quantity: undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const MAX_CUSTOMER_PHOTOS = 5;

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
    setForm({ name: '', phone: '', address: '', memo: '', photos: [], arrivalDate: '', quantity: undefined });
    setEditingId(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
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
      photos: customer.photos || [],
      arrivalDate: customer.arrivalDate || '',
      quantity: customer.quantity,
    });
    setEditingId(customer.id);
    setIsFormOpen(true);
  }

  function commitCustomers(next: Customer[]) {
    setCustomers(next);
    if (!saveSafely((v) => saveCustomers(v as Customer[]), next)) {
      setCustomers(customers);
    }
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const current = form.photos || [];
    const remaining = MAX_CUSTOMER_PHOTOS - current.length;
    if (remaining <= 0) {
      alert(`사진은 최대 ${MAX_CUSTOMER_PHOTOS}장까지 등록할 수 있습니다.`);
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    const targets = files.slice(0, remaining);
    if (files.length > remaining) {
      alert(`최대 ${MAX_CUSTOMER_PHOTOS}장까지 가능하여 ${remaining}장만 추가됩니다.`);
    }
    try {
      const compressed = await Promise.all(targets.map((f) => compressImage(f)));
      setForm((prev) => ({ ...prev, photos: [...(prev.photos || []), ...compressed] }));
    } catch (err: any) {
      alert(err.message || '이미지를 처리하는 중 오류가 발생했습니다.');
    } finally {
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  function removePhoto(index: number) {
    setForm((prev) => ({
      ...prev,
      photos: (prev.photos || []).filter((_, i) => i !== index),
    }));
  }

  function movePhoto(index: number, direction: -1 | 1) {
    setForm((prev) => {
      const photos = [...(prev.photos || [])];
      const target = index + direction;
      if (target < 0 || target >= photos.length) return prev;
      [photos[index], photos[target]] = [photos[target], photos[index]];
      return { ...prev, photos };
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim()) {
      alert('연락처를 입력해주세요.');
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
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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

  function removeSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 ${selectedIds.size}명의 고객을 삭제할까요?`)) return;
    commitCustomers(customers.filter((c) => !selectedIds.has(c.id)));
    setSelectedIds(new Set());
  }

  function exportCustomers() {
    const rows = customers.map((c) => ({
      이름: c.name,
      연락처: c.phone,
      주소: c.address,
      도착일: c.arrivalDate || '',
      수량: c.quantity ?? '',
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
      </section>

      {admin && isFormOpen && (
        <section className='panel form-panel'>
          <h2>{editingId ? '고객 수정' : '새 고객 등록'}</h2>
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
              <div className='full photo-field'>
                <span className='photo-field-label'>
                  사진 (선택, 최대 {MAX_CUSTOMER_PHOTOS}장)
                </span>
                <div className='photo-grid'>
                  {(form.photos || []).map((photo, idx) => (
                    <div key={idx} className='photo-item'>
                      <img src={photo} alt={`고객 사진 ${idx + 1}`} />
                      <div className='photo-item-actions'>
                        <button
                          type='button'
                          className='btn icon small'
                          onClick={() => movePhoto(idx, -1)}
                          disabled={idx === 0}
                          title='앞으로'
                        >
                          ◀
                        </button>
                        <button
                          type='button'
                          className='btn icon small'
                          onClick={() => movePhoto(idx, 1)}
                          disabled={idx === (form.photos || []).length - 1}
                          title='뒤로'
                        >
                          ▶
                        </button>
                        <button
                          type='button'
                          className='btn icon small danger'
                          onClick={() => removePhoto(idx)}
                          title='삭제'
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                  {(form.photos || []).length < MAX_CUSTOMER_PHOTOS && (
                    <button
                      type='button'
                      className='photo-add'
                      onClick={() => photoInputRef.current?.click()}
                    >
                      📷 사진 추가
                      <span className='photo-add-count'>
                        {(form.photos || []).length}/{MAX_CUSTOMER_PHOTOS}
                      </span>
                    </button>
                  )}
                </div>
                <input
                  ref={photoInputRef}
                  type='file'
                  accept='image/*'
                  multiple
                  style={{ display: 'none' }}
                  onChange={handlePhotoSelect}
                />
              </div>
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
              <article
                key={customer.id}
                className={`customer-card${selectedIds.has(customer.id) ? ' selected' : ''}`}
              >
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
                {customer.photos && customer.photos.length > 0 && (
                  <div className='customer-photos'>
                    {customer.photos.map((photo, idx) => (
                      <img key={idx} src={photo} alt={`고객 사진 ${idx + 1}`} />
                    ))}
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
