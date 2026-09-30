import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import './style.css';
import { sendSms } from './lib/api';
import { load, save } from './lib/storage';
import { Order, Product, OrderStatus, PickupType, PaymentStatus, Page } from './types';
import Login, { isAdmin, isLoggedIn, logout } from './components/Login';
import Customers from './components/Customers';
import Admin, { AccountManager, getStoredAccountNumber } from './components/Admin';
import Dashboard from './components/Dashboard';

const STATUS_LIST: OrderStatus[] = ['접수', '준비중', '완료', '취소'];
const PICKUP_LIST: PickupType[] = ['매장방문', '배송'];
const ORDERS_KEY = 'jeolim-cabbage-orders-v3';
const PRODUCTS_KEY = 'jeolim-cabbage-products-v1';

declare global {
  interface Window {
    daum: any;
  }
}

const defaultProducts: Product[] = [
  { id: 'p1', name: '포기김치용', unit: '포기', price: 12000 },
  { id: 'p2', name: '겉절이용', unit: '포기', price: 9000 },
  { id: 'p3', name: '소금 절임배추', unit: 'kg', price: 8000 },
];

function formatDate(date: string | undefined) {
  if (!date) return '-';
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatCurrency(value: number) {
  return value.toLocaleString('ko-KR') + '원';
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function getOrderPublicUrl(orderId: string) {
  const url = new URL(window.location.href);
  url.search = `?order=${orderId}`;
  return url.toString();
}

function getPaymentStatus(order: Order): PaymentStatus {
  if (order.status === '취소') return '완납';
  if (order.depositAmount >= order.totalPrice) return '완납';
  if (order.depositAmount <= 0) return '미납';
  return '부분납';
}

const emptyOrder: Omit<Order, 'id' | 'createdAt'> = {
  name: '',
  phone: '',
  productId: undefined,
  cabbageType: '',
  quantity: 10,
  unit: '포기',
  pricePerUnit: 0,
  totalPrice: 0,
  depositAmount: 0,
  pickup: '매장방문',
  pickupDate: '',
  preparationDate: '',
  address: '',
  memo: '',
  status: '접수',
  deposit: false,
};

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => isLoggedIn());
  const [page, setPage] = useState<Page>('dashboard');
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>(defaultProducts);
  const [filter, setFilter] = useState<OrderStatus | '전체'>('전체');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ ...emptyOrder });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSmsOpen, setIsSmsOpen] = useState(false);
  const [printOrder, setPrintOrder] = useState<Order | null>(null);
  const [isPostcodeOpen, setIsPostcodeOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState(() => getStoredAccountNumber());
  const postcodeWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrders(load(ORDERS_KEY, []));
    setProducts(load(PRODUCTS_KEY, defaultProducts));
  }, []);

  useEffect(() => save(ORDERS_KEY, orders), [orders]);
  useEffect(() => save(PRODUCTS_KEY, products), [products]);

  const filtered = useMemo(() => {
    const term = search.trim();
    return orders
      .filter((o) => (filter === '전체' ? true : o.status === filter))
      .filter((o) =>
        term
          ? o.name.includes(term) ||
            o.phone.includes(term) ||
            o.cabbageType.includes(term) ||
            o.memo.includes(term)
          : true
      )
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [orders, filter, search]);

  const summary = useMemo(() => {
    const activeOrders = orders.filter((o) => o.status !== '취소');
    const totalQuantity = activeOrders.reduce((sum, o) => sum + o.quantity, 0);
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalPrice, 0);
    const totalDeposit = activeOrders.reduce((sum, o) => sum + o.depositAmount, 0);
    const outstanding = totalRevenue - totalDeposit;
    const unpaidCount = activeOrders.filter((o) => getPaymentStatus(o) !== '완납').length;
    const byStatus = STATUS_LIST.map((s) => ({
      status: s,
      count: orders.filter((o) => o.status === s).length,
    }));
    return { totalQuantity, totalRevenue, outstanding, unpaidCount, byStatus };
  }, [orders]);

  function calcTotal(quantity: number, price: number) {
    return Math.max(0, quantity * price);
  }

  function applyProduct(productId: string | undefined, current: typeof form) {
    if (!productId) return current;
    const p = products.find((x) => x.id === productId);
    if (!p) return current;
    const price = p.price;
    return {
      ...current,
      productId,
      cabbageType: p.name,
      unit: p.unit,
      pricePerUnit: price,
      totalPrice: calcTotal(current.quantity, price),
    };
  }

  function resetForm() {
    setForm({ ...emptyOrder });
    setEditingId(null);
  }

  function openNewForm() {
    resetForm();
    setIsFormOpen(true);
  }

  function startEdit(order: Order) {
    setForm({ ...order });
    setEditingId(order.id);
    setIsFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      alert('고객명을 입력해주세요.');
      return;
    }
    if (!form.cabbageType.trim()) {
      alert('품목을 입력해주세요.');
      return;
    }
    const payload = {
      ...form,
      totalPrice: calcTotal(form.quantity, form.pricePerUnit),
    };
    if (editingId) {
      setOrders((prev) =>
        prev.map((o) => (o.id === editingId ? { ...payload, id: editingId, createdAt: o.createdAt } : o))
      );
    } else {
      const newOrder: Order = {
        ...payload,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      setOrders((prev) => [newOrder, ...prev]);
    }
    resetForm();
    setIsFormOpen(false);
  }

  function updateStatus(id: string, status: OrderStatus) {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const patch: Partial<Order> = { status };
        if (status === '준비중' && !o.preparationDate) {
          patch.preparationDate = new Date().toISOString().slice(0, 10);
        }
        return { ...o, ...patch };
      })
    );
  }

  function updatePreparationDate(id: string, date: string) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, preparationDate: date } : o)));
  }

  function toggleDeposit(id: string) {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const nextDeposit = !o.deposit;
        return {
          ...o,
          deposit: nextDeposit,
          depositAmount: nextDeposit ? o.totalPrice : 0,
        };
      })
    );
  }

  function updateDepositAmount(id: string, amount: number) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, depositAmount: amount, deposit: amount >= o.totalPrice } : o)));
  }

  function removeOrder(id: string) {
    if (confirm('이 주문을 삭제할까요?')) {
      setOrders((prev) => prev.filter((o) => o.id !== id));
    }
  }

  function handlePrint(order: Order) {
    setPrintOrder(order);
    setTimeout(() => {
      window.print();
      setPrintOrder(null);
    }, 100);
  }

  function exportExcel() {
    const rows = filtered.map((o) => ({
      접수일: formatDate(o.createdAt),
      고객명: o.name,
      연락처: o.phone,
      품목: o.cabbageType,
      수량: o.quantity,
      단위: o.unit,
      단가: o.pricePerUnit,
      총액: o.totalPrice,
      입금액: o.depositAmount,
      잔액: o.totalPrice - o.depositAmount,
      입금상태: getPaymentStatus(o),
      입금확인: o.deposit ? 'Y' : 'N',
      상태: o.status,
      준비일: formatDate(o.preparationDate),
      수령방식: o.pickup,
      희망일: formatDate(o.pickupDate),
      주소: o.address,
      메모: o.memo,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '주문목록');
    XLSX.writeFile(wb, `절임배추_주문목록_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function handleLogout() {
    logout();
    setLoggedIn(false);
    setPage('orders');
  }

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
        }).embed(postcodeWrapRef.current);
      }, 0);
    } catch (err) {
      alert('주소 검색을 불러오는 중 오류가 발생했습니다.');
    }
  }

  async function copyOrderUrl(order: Order) {
    const url = getOrderPublicUrl(order.id);
    try {
      await navigator.clipboard.writeText(url);
      alert('주문 조회 링크가 복사되었습니다.');
    } catch {
      prompt('주문 조회 링크를 복사해주세요.', url);
    }
  }

  const params = new URLSearchParams(window.location.search);
  const publicOrderId = params.get('order');
  const publicOrder = publicOrderId ? orders.find((o) => o.id === publicOrderId) : undefined;

  if (publicOrderId) {
    return <PublicOrderView order={publicOrder} />;
  }

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  return (
    <main className='app-shell'>
      <div className='container'>
        <header className='app-header'>
          <button className='brand' onClick={() => setPage('dashboard')} title='대시보드로 이동'>
            <span className='brand-icon'>
              <svg viewBox='0 0 24 24' width='32' height='32' fill='none' xmlns='http://www.w3.org/2000/svg'>
                <circle cx='12' cy='12' r='10' fill='#16a34a'/>
                <path d='M12 6c-3 0-5.5 2.5-5.5 6s2.5 6 5.5 6 5.5-2.5 5.5-6-2.5-6-5.5-6z' fill='#dcfce7'/>
                <path d='M12 10c-1.5 0-2.5 1-2.5 2.5s1 2.5 2.5 2.5 2.5-1 2.5-2.5-1-2.5-2.5-2.5z' fill='#16a34a'/>
              </svg>
            </span>
            <div className='brand-text'>
              <p className='eyebrow'>절임배추 관리</p>
              <h1>
                {page === 'dashboard'
                  ? '대시보드'
                  : page === 'orders'
                  ? '주문 관리'
                  : page === 'customers'
                  ? '고객 관리'
                  : '관리자 설정'}
              </h1>
            </div>
          </button>
          <div className='header-actions'>
            <nav className='nav-tabs'>
              <button
                className={`btn ${page === 'dashboard' ? 'active' : ''}`}
                onClick={() => setPage('dashboard')}
              >
                📊 대시보드
              </button>
              <button
                className={`btn ${page === 'orders' ? 'active' : ''}`}
                onClick={() => setPage('orders')}
              >
                주문
              </button>
              {isAdmin() && (
                <button
                  className={`btn ${page === 'customers' ? 'active' : ''}`}
                  onClick={() => setPage('customers')}
                >
                  고객
                </button>
              )}
              {isAdmin() && (
                <button
                  className={`btn ${page === 'admin' ? 'active' : ''}`}
                  onClick={() => setPage('admin')}
                >
                  관리자
                </button>
              )}
            </nav>
            {page === 'orders' && isAdmin() && (
              <>
                <button className='btn' onClick={() => setIsSmsOpen(true)}>
                  ✉ 단체 문자
                </button>
                <button className='btn' onClick={() => setIsSettingsOpen(true)}>
                  ⚙ 품목 설정
                </button>
                <button className='btn btn-primary' onClick={openNewForm}>
                  + 새 주문
                </button>
              </>
            )}
            {page === 'orders' && !isAdmin() && (
              <button className='btn btn-primary' onClick={openNewForm}>
                + 새 주문
              </button>
            )}
            <button className='btn' onClick={handleLogout}>
              로그아웃
            </button>
            {isAdmin() && (
              <button
                className='btn'
                onClick={() => setIsAccountModalOpen(true)}
                title='계좌번호 설정'
              >
                🏦 계좌번호
              </button>
            )}
          </div>
        </header>

        {isAccountModalOpen && (
          <div
            className='modal-overlay'
            onClick={(e) => e.target === e.currentTarget && setIsAccountModalOpen(false)}
          >
            <div className='modal panel account-modal'>
              <div className='modal-header'>
                <h2>계좌번호 설정</h2>
                <button className='btn icon' onClick={() => setIsAccountModalOpen(false)}>
                  ✕
                </button>
              </div>
              <p className='panel-hint'>
                단체 문자 발송 시 {'{계좌번호}'} 변수에 들어갈 계좌번호를 입력하세요.
              </p>
              <AccountManager />
            </div>
          </div>
        )}

        {page === 'dashboard' ? (
          <Dashboard orders={orders} products={products} />
        ) : page === 'customers' && isAdmin() ? (
          <Customers orders={orders} />
        ) : page === 'admin' && isAdmin() ? (
          <Admin />
        ) : (
          <>
            <section className='summary'>
              {summary.byStatus.map(({ status, count }) => (
                <button
                  key={status}
                  className={`summary-card ${filter === status ? 'active' : ''}`}
                  onClick={() => setFilter(filter === status ? '전체' : status)}
                >
                  <span className='summary-label'>{status}</span>
                  <span className='summary-count'>{count}</span>
                </button>
              ))}
              <div className='summary-card total'>
                <span className='summary-label'>총 수량</span>
                <span className='summary-count'>{summary.totalQuantity}</span>
              </div>
              <div className='summary-card revenue'>
                <span className='summary-label'>총 매출</span>
                <span className='summary-count'>{formatCurrency(summary.totalRevenue)}</span>
              </div>
              <div
                className={`summary-card outstanding ${summary.unpaidCount > 0 ? 'alert' : ''}`}
              >
                <span className='summary-label'>미수금 / 미납 {summary.unpaidCount}건</span>
                <span className='summary-count'>{formatCurrency(summary.outstanding)}</span>
              </div>
            </section>

            <section className='toolbar'>
              <input
                type='text'
                className='input search'
                placeholder='이름, 연락처, 품종, 메모 검색'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className='select' value={filter} onChange={(e) => setFilter(e.target.value as OrderStatus | '전체')}>
                <option value='전체'>전체 상태</option>
                {STATUS_LIST.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button className='btn' onClick={exportExcel}>
                📥 엑셀
              </button>
            </section>

            {isFormOpen && (
              <section className='panel form-panel'>
                <h2>{editingId ? '주문 수정' : '새 주문 등록'}</h2>
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
                        onChange={(e) => setForm({ ...form, phone: formatPhone(e.target.value) })}
                        placeholder='010-0000-0000'
                        maxLength={13}
                      />
                    </label>
                    <label>
                      품목
                      <select
                        className='select'
                        value={form.productId || ''}
                        onChange={(e) => setForm(applyProduct(e.target.value || undefined, form))}
                      >
                        <option value=''>직접 입력</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({formatCurrency(p.price)}/{p.unit})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      품목명 (직접 입력 시)
                      <input
                        className='input'
                        value={form.cabbageType}
                        onChange={(e) => setForm({ ...form, cabbageType: e.target.value, productId: undefined })}
                        placeholder='포기김치용, 겉절이용 등'
                      />
                    </label>
                    <label>
                      수량
                      <div className='quantity-row'>
                        <input
                          className='input'
                          type='number'
                          min={1}
                          value={form.quantity}
                          onChange={(e) => {
                            const quantity = Math.max(1, Number(e.target.value));
                            setForm({ ...form, quantity, totalPrice: calcTotal(quantity, form.pricePerUnit) });
                          }}
                        />
                        <input
                          className='input unit-input'
                          value={form.unit}
                          onChange={(e) => setForm({ ...form, unit: e.target.value })}
                          placeholder='단위'
                        />
                      </div>
                    </label>
                    <label>
                      단가
                      <input
                        className='input'
                        type='number'
                        min={0}
                        step={100}
                        value={form.pricePerUnit}
                        onChange={(e) => {
                          const price = Math.max(0, Number(e.target.value));
                          setForm({ ...form, pricePerUnit: price, totalPrice: calcTotal(form.quantity, price) });
                        }}
                      />
                    </label>
                    <label>
                      총액
                      <input className='input' readOnly value={formatCurrency(form.totalPrice)} />
                    </label>
                    <label>
                      입금액
                      <input
                        className='input'
                        type='number'
                        min={0}
                        step={1000}
                        value={form.depositAmount}
                        onChange={(e) => setForm({ ...form, depositAmount: Math.max(0, Number(e.target.value)) })}
                        placeholder='0'
                      />
                    </label>
                    <label>
                      수령 방식
                      <select
                        className='select'
                        value={form.pickup}
                        onChange={(e) => setForm({ ...form, pickup: e.target.value as PickupType })}
                      >
                        {PICKUP_LIST.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      수령/배송 희망일
                      <input
                        className='input'
                        type='date'
                        value={form.pickupDate}
                        onChange={(e) => setForm({ ...form, pickupDate: e.target.value })}
                      />
                    </label>
                    <label>
                      준비일 (접수→준비중 전환일)
                      <input
                        className='input'
                        type='date'
                        value={form.preparationDate}
                        onChange={(e) => setForm({ ...form, preparationDate: e.target.value })}
                      />
                    </label>
                    {form.pickup === '배송' && (
                      <label className='full'>
                        배송 주소
                        <div className='address-row'>
                          <input
                            className='input'
                            value={form.address}
                            onChange={(e) => setForm({ ...form, address: e.target.value })}
                            placeholder='주소를 입력하세요'
                          />
                          <button type='button' className='btn' onClick={openPostcode}>
                            🔍 주소 검색
                          </button>
                        </div>
                      </label>
                    )}
                    <label className='full'>
                      메모
                      <input
                        className='input'
                        value={form.memo}
                        onChange={(e) => setForm({ ...form, memo: e.target.value })}
                        placeholder='특이사항, 소금 농도, 절임 시간 등'
                      />
                    </label>
                  </div>
                  <div className='form-actions'>
                    <button type='button' className='btn' onClick={() => setIsFormOpen(false)}>
                      취소
                    </button>
                    <button type='submit' className='btn btn-primary'>
                      {editingId ? '수정 저장' : '주문 등록'}
                    </button>
                  </div>
                </form>
              </section>
            )}

            {isPostcodeOpen && (
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

            {isSettingsOpen && isAdmin() && (
              <ProductSettingsModal
                products={products}
                onChange={setProducts}
                onClose={() => setIsSettingsOpen(false)}
              />
            )}

            {isSmsOpen && isAdmin() && <SmsModal orders={orders} onClose={() => setIsSmsOpen(false)} />}

            <section className='order-list'>
              {filtered.length === 0 ? (
                <div className='empty'>등록된 주문이 없습니다.</div>
              ) : (
                filtered.map((order) => {
                  const payment = getPaymentStatus(order);
                  const balance = order.totalPrice - order.depositAmount;
                  return (
                    <article key={order.id} className={`order-card status-${order.status}`}>
                      <div className='order-row head'>
                        <div className='order-meta'>
                          <span className='order-name'>{order.name}</span>
                          <span className='order-phone'>{order.phone || '연락처 없음'}</span>
                          <span className='order-date'>{formatDate(order.pickupDate)}</span>
                          {order.status !== '접수' && (
                            <input
                              type='date'
                              className='input prep-date'
                              value={order.preparationDate || ''}
                              onChange={(e) => updatePreparationDate(order.id, e.target.value)}
                              title='준비일'
                            />
                          )}
                          <span className={`tag payment-${payment}`}>{payment}</span>
                        </div>
                        <div className='order-actions'>
                          <button className='btn icon' onClick={() => handlePrint(order)} title='영수증 인쇄'>
                            🖨
                          </button>
                          <button className='btn icon' onClick={() => copyOrderUrl(order)} title='주문 조회 링크 복사'>
                            🔗
                          </button>
                          <select
                            className='select status-select'
                            value={order.status}
                            onChange={(e) => updateStatus(order.id, e.target.value as OrderStatus)}
                          >
                            {STATUS_LIST.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          {isAdmin() && (
                            <button className='btn icon' onClick={() => startEdit(order)} title='수정'>
                              ✎
                            </button>
                          )}
                          {isAdmin() && (
                            <button className='btn icon danger' onClick={() => removeOrder(order.id)} title='삭제'>
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                      <div className='order-row body'>
                        <div className='order-detail'>
                          <span className='tag'>{order.cabbageType}</span>
                          <span className='tag highlight'>
                            {order.quantity} {order.unit}
                          </span>
                          <span className='tag'>{formatCurrency(order.pricePerUnit)}</span>
                          <span className='tag highlight'>{formatCurrency(order.totalPrice)}</span>
                          <span className='tag'>{order.pickup}</span>
                          {order.address && <span className='tag'>{order.address}</span>}
                        </div>
                        <div className='payment-row'>
                          <label className='deposit-label'>
                            입금액
                            <input
                              type='number'
                              className='input deposit-input'
                              min={0}
                              step={1000}
                              value={order.depositAmount}
                              onChange={(e) => updateDepositAmount(order.id, Math.max(0, Number(e.target.value)))}
                            />
                          </label>
                          <span className={`balance ${balance > 0 ? 'unpaid' : ''}`}>
                            잔액: {formatCurrency(balance)}
                          </span>
                        </div>
                        {order.memo && <p className='order-memo'>{order.memo}</p>}
                      </div>
                      <div className='order-row foot'>
                        <label className='deposit-label'>
                          <input
                            type='checkbox'
                            checked={order.deposit}
                            onChange={() => toggleDeposit(order.id)}
                          />
                          완납 처리
                        </label>
                        <span className='created'>접수일: {formatDate(order.createdAt)}</span>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          </>
        )}
      </div>

      <div className='print-only'>
        {printOrder && <Receipt order={printOrder} />}
      </div>
    </main>
  );
}

function personalizeMessage(template: string, order: Order) {
  const balance = order.totalPrice - order.depositAmount;
  return template
    .split('{이름}').join(`${order.name} 고객님`)
    .split('{품목}').join(order.cabbageType)
    .split('{수량}').join(`${order.quantity}${order.unit}`)
    .split('{금액}').join(`미수금 ${formatCurrency(balance)}`)
    .split('{잔액}').join(`잔액 ${formatCurrency(balance)}`)
    .split('{입금액}').join(formatCurrency(order.depositAmount))
    .split('{수령일}').join(formatDate(order.pickupDate))
    .split('{주문URL}').join(getOrderPublicUrl(order.id))
    .split('{계좌번호}').join(getStoredAccountNumber());
}

function Receipt({ order }: { order: Order }) {
  const balance = order.totalPrice - order.depositAmount;
  return (
    <div className='receipt'>
      <h2>절임배추 주문 영수증</h2>
      <div className='receipt-line'>
        <span>주문일</span>
        <span>{formatDate(order.createdAt)}</span>
      </div>
      <div className='receipt-line'>
        <span>고객명</span>
        <span>{order.name}</span>
      </div>
      <div className='receipt-line'>
        <span>연락처</span>
        <span>{order.phone || '-'}</span>
      </div>
      <div className='receipt-line'>
        <span>품목</span>
        <span>{order.cabbageType}</span>
      </div>
      <div className='receipt-line'>
        <span>수량</span>
        <span>
          {order.quantity} {order.unit}
        </span>
      </div>
      <div className='receipt-line'>
        <span>단가</span>
        <span>{formatCurrency(order.pricePerUnit)}</span>
      </div>
      <div className='receipt-line strong'>
        <span>총액</span>
        <span>{formatCurrency(order.totalPrice)}</span>
      </div>
      <div className='receipt-line'>
        <span>입금액</span>
        <span>{formatCurrency(order.depositAmount)}</span>
      </div>
      <div className='receipt-line strong'>
        <span>잔액</span>
        <span>{formatCurrency(balance)}</span>
      </div>
      <div className='receipt-line'>
        <span>수령방식</span>
        <span>{order.pickup}</span>
      </div>
      {order.preparationDate && (
        <div className='receipt-line'>
          <span>준비일</span>
          <span>{formatDate(order.preparationDate)}</span>
        </div>
      )}
      {order.pickupDate && (
        <div className='receipt-line'>
          <span>수령희망일</span>
          <span>{formatDate(order.pickupDate)}</span>
        </div>
      )}
      {order.address && (
        <div className='receipt-line'>
          <span>주소</span>
          <span>{order.address}</span>
        </div>
      )}
      {order.memo && (
        <div className='receipt-line'>
          <span>메모</span>
          <span>{order.memo}</span>
        </div>
      )}
      <div className='receipt-line'>
        <span>입금상태</span>
        <span>{getPaymentStatus(order)}</span>
      </div>
      <p className='receipt-thanks'>이용해주셔서 감사합니다.</p>
    </div>
  );
}

function PublicOrderView({ order }: { order: Order | undefined }) {
  if (!order) {
    return (
      <div className='app-shell'>
        <div className='container'>
          <div className='panel public-order'>
            <h2>주문 조회</h2>
            <p className='empty'>해당 주문을 찾을 수 없습니다.</p>
          </div>
        </div>
      </div>
    );
  }

  const balance = order.totalPrice - order.depositAmount;
  const steps = ['접수', '준비중', '완료'];
  const stepIndex = steps.indexOf(order.status === '취소' ? '접수' : order.status);

  return (
    <div className='app-shell'>
      <div className='container'>
        <div className='panel public-order'>
          <header className='public-order-header'>
            <h2>주문 조회</h2>
            <span className={`tag status-${order.status}`}>{order.status}</span>
          </header>

          <div className='progress-bar'>
            {steps.map((s, idx) => (
              <div
                key={s}
                className={`progress-step ${idx <= stepIndex ? 'active' : ''} ${order.status === '취소' ? 'cancel' : ''}`}
              >
                <span className='step-dot'></span>
                <span className='step-label'>{s}</span>
              </div>
            ))}
          </div>

          <div className='public-order-info'>
            <div className='info-row'>
              <span>주문일</span>
              <span>{formatDate(order.createdAt)}</span>
            </div>
            <div className='info-row'>
              <span>고객명</span>
              <span>{order.name}</span>
            </div>
            <div className='info-row'>
              <span>연락처</span>
              <span>{order.phone || '-'}</span>
            </div>
            <div className='info-row'>
              <span>품목</span>
              <span>{order.cabbageType}</span>
            </div>
            <div className='info-row'>
              <span>수량</span>
              <span>{order.quantity} {order.unit}</span>
            </div>
            <div className='info-row'>
              <span>단가</span>
              <span>{formatCurrency(order.pricePerUnit)}</span>
            </div>
            <div className='info-row strong'>
              <span>총액</span>
              <span>{formatCurrency(order.totalPrice)}</span>
            </div>
            <div className='info-row'>
              <span>입금액</span>
              <span>{formatCurrency(order.depositAmount)}</span>
            </div>
            <div className='info-row strong'>
              <span>잔액</span>
              <span>{formatCurrency(balance)}</span>
            </div>
            <div className='info-row'>
              <span>수령방식</span>
              <span>{order.pickup}</span>
            </div>
            {order.preparationDate && (
              <div className='info-row'>
                <span>준비일</span>
                <span>{formatDate(order.preparationDate)}</span>
              </div>
            )}
            {order.pickupDate && (
              <div className='info-row'>
                <span>수령희망일</span>
                <span>{formatDate(order.pickupDate)}</span>
              </div>
            )}
            {order.address && (
              <div className='info-row'>
                <span>주소</span>
                <span>{order.address}</span>
              </div>
            )}
            {order.memo && (
              <div className='info-row'>
                <span>메모</span>
                <span>{order.memo}</span>
              </div>
            )}
            <div className='info-row'>
              <span>입금상태</span>
              <span>{getPaymentStatus(order)}</span>
            </div>
          </div>

          <p className='public-order-thanks'>이용해주셔서 감사합니다.</p>
        </div>
      </div>
    </div>
  );
}

function ProductSettingsModal({
  products,
  onChange,
  onClose,
}: {
  products: Product[];
  onChange: (p: Product[]) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Product[]>(products);

  function addItem() {
    setItems((prev) => [...prev, { id: crypto.randomUUID(), name: '', unit: '포기', price: 0 }]);
  }

  function updateItem(id: string, patch: Partial<Product>) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  function save() {
    const valid = items.filter((p) => p.name.trim());
    onChange(valid);
    onClose();
  }

  return (
    <div className='modal-overlay' onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className='modal panel'>
        <div className='modal-header'>
          <h2>품목/단가 설정</h2>
          <button className='btn icon' onClick={onClose}>
            ✕
          </button>
        </div>
        <p className='modal-hint'>자주 사용하는 배추 품목과 단가를 등록하면 주문 시 자동으로 적용됩니다.</p>
        <div className='product-list'>
          {items.map((p, idx) => (
            <div key={p.id} className='product-row'>
              <span className='product-index'>{idx + 1}</span>
              <input
                className='input'
                placeholder='품목명'
                value={p.name}
                onChange={(e) => updateItem(p.id, { name: e.target.value })}
              />
              <input
                className='input unit-input'
                placeholder='단위'
                value={p.unit}
                onChange={(e) => updateItem(p.id, { unit: e.target.value })}
              />
              <input
                className='input'
                type='number'
                min={0}
                step={100}
                placeholder='단가'
                value={p.price}
                onChange={(e) => updateItem(p.id, { price: Number(e.target.value) })}
              />
              <button className='btn icon danger' onClick={() => removeItem(p.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className='modal-actions'>
          <button className='btn' onClick={addItem}>
            + 품목 추가
          </button>
          <div className='spacer' />
          <button className='btn' onClick={onClose}>
            취소
          </button>
          <button className='btn btn-primary' onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

function SmsModal({ orders, onClose }: { orders: Order[]; onClose: () => void }) {
  const recipients = useMemo(() => {
    const seen = new Set<string>();
    return orders
      .filter((o) => o.status !== '취소' && o.phone.trim())
      .filter((o) => {
        const dup = seen.has(o.phone);
        seen.add(o.phone);
        return !dup;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [orders]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(recipients.map((r) => r.id))
  );
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const selectedOrders = recipients.filter((r) => selectedIds.has(r.id));
  const previewOrder = selectedOrders[0] || recipients[0];
  const preview = previewOrder ? personalizeMessage(message || '(메시지를 입력하세요)', previewOrder) : '';

  function toggleAll() {
    if (selectedIds.size === recipients.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(recipients.map((r) => r.id)));
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  async function copyToClipboard() {
    if (!previewOrder) return;
    const phoneList = selectedOrders.map((o) => o.phone).join(', ');
    const text = `[수신자]\n${phoneList}\n\n[메시지]\n${preview}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert('클립보드 복사에 실패했습니다.');
    }
  }

  function openSmsApp() {
    if (selectedOrders.length === 0) {
      alert('수신자를 선택하세요.');
      return;
    }
    const phoneList = selectedOrders.map((o) => o.phone).join(',');
    const uri = `sms:${phoneList}?body=${encodeURIComponent(preview)}`;
    window.open(uri, '_blank');
  }

  function applyTemplate(text: string) {
    setMessage((prev) => (prev ? prev + '\n' + text : text));
  }

  async function sendViaApi() {
    if (selectedOrders.length === 0) {
      alert('수신자를 선택하세요.');
      return;
    }
    if (!preview) {
      alert('메시지를 입력하세요.');
      return;
    }
    setSending(true);
    setSendResult(null);
    try {
      const recipients = selectedOrders.map((o) => o.phone);
      const data = await sendSms(recipients, preview);
      setSendResult(`발송 완료: ${data?.sent || 0}건`);
    } catch (err: any) {
      setSendResult(`발송 실패: ${err.message || '오류 발생'}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className='modal-overlay' onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className='modal panel sms-modal'>
        <div className='modal-header'>
          <h2>단체 문자 보내기</h2>
          <button className='btn icon' onClick={onClose}>
            ✕
          </button>
        </div>

        <p className='modal-hint'>
          연락처가 등록된 주문 고객에게 문자를 보냅니다. 실제 발송은 문자앱 연동 또는 SMS
          게이트웨이(API 키 필요)를 추가로 연결해야 합니다.
        </p>

        <div className='sms-section'>
          <div className='sms-section-title'>
            수신자 ({selectedIds.size}/{recipients.length}명)
            <button className='btn small' onClick={toggleAll}>
              {selectedIds.size === recipients.length ? '전체 해제' : '전체 선택'}
            </button>
          </div>
          <div className='recipient-list'>
            {recipients.length === 0 ? (
              <p className='empty-mini'>보낼 수 있는 고객이 없습니다.</p>
            ) : (
              recipients.map((o) => (
                <label key={o.id} className='recipient-row'>
                  <input
                    type='checkbox'
                    checked={selectedIds.has(o.id)}
                    onChange={() => toggleOne(o.id)}
                  />
                  <span className='recipient-name'>{o.name}</span>
                  <span className='recipient-phone'>{formatPhone(o.phone)}</span>
                  <span className='recipient-status'>{o.status}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className='sms-section'>
          <div className='sms-section-title'>메시지</div>
          <div className='template-tags'>
            {['{이름}', '{품목}', '{수량}', '{금액}', '{잔액}', '{입금액}', '{수령일}', '{주문URL}', '{계좌번호}'].map((tag) => (
              <button key={tag} className='btn small tag-btn' onClick={() => applyTemplate(tag)}>
                {tag}
              </button>
            ))}
          </div>
          <textarea
            className='input sms-textarea'
            rows={5}
            placeholder={`안녕하세요 {이름}님.\n주문하신 {품목} {수량} 준비 중입니다.\n남은 금액 {잔액} 입금 부탁드립니다.\n{계좌번호}`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className='sms-preview'>
            <strong>미리보기</strong>
            <p>{preview}</p>
          </div>
        </div>

        <div className='modal-actions'>
          <button className='btn' onClick={copyToClipboard}>
            {copied ? '복사 완료' : '📋 연락처+메시지 복사'}
          </button>
          <button className='btn' onClick={openSmsApp}>
            📱 문자앱 열기
          </button>
          <button className='btn btn-primary' onClick={sendViaApi} disabled={sending}>
            {sending ? '발송 중...' : '📡 API로 발송'}
          </button>
          <div className='spacer' />
          <button className='btn' onClick={onClose}>
            닫기
          </button>
        </div>
        {sendResult && <p className='send-result'>{sendResult}</p>}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
