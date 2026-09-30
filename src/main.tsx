import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import './style.css';
import { sendSms, syncPublicOrder, fetchPublicOrder, fetchAllAppData, syncAppData, me } from './lib/api';
import { load, save } from './lib/storage';
import { compressImage } from './lib/images';
import { Order, Product, OrderStatus, PickupType, PaymentStatus, Page, Customer } from './types';
import Login, { isAdmin, isLoggedIn, performLogout } from './components/Login';
import Customers, { loadCustomers, updateCustomer } from './components/Customers';
import Admin, { AccountManager, getStoredAccountNumber } from './components/Admin';
import Dashboard from './components/Dashboard';
import Gallery, { PublicGallery } from './components/Gallery';

const STATUS_LIST: OrderStatus[] = ['접수', '준비중', '택배', '현장수령', '완료', '취소'];
const STATUS_FLOW: Partial<Record<OrderStatus, OrderStatus>> = {
  접수: '준비중',
  택배: '완료',
  현장수령: '완료',
};
const PICKUP_LIST: PickupType[] = ['매장방문', '배송'];
const COURIER_LIST = [
  'CJ대한통운',
  '롯데택배',
  '한진택배',
  '로젠택배',
  '우체국택배',
  '경동택배',
  '합동택배',
  'CU편의점택배',
  'GS편의점택배',
  '대신택배',
  '천일택배',
  '농협택배',
  '일양로지스',
  '기타',
];
const ORDERS_KEY = 'jc_orders_v3';
const PRODUCTS_KEY = 'jc_products_v1';

type StoredOrder = Order & { photos?: string[] };

function normalizeOrders(stored: StoredOrder[]): Order[] {
  return stored.map((order) => {
    const legacyPhotos = Array.isArray(order.photos) ? order.photos : [];
    const completionPhotos = Array.isArray(order.completionPhotos)
      ? order.completionPhotos
      : legacyPhotos;
    const { photos: _legacyPhotos, ...rest } = order;
    return completionPhotos.length > 0 ? { ...rest, completionPhotos } : rest;
  });
}

function loadOrders(): Order[] {
  return normalizeOrders(load<StoredOrder[]>(ORDERS_KEY, []));
}

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

function parsePhone(value: string): string {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function parseKoreanDate(value: string): string {
  if (!value) return '';
  const text = String(value).trim();
  const match = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  // 이미 ISO 또는 yyyy-mm-dd 형식이면 그대로
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
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

function normalizePickup(value: string): PickupType {
  const text = String(value).trim();
  if (text.includes('배달') || text.includes('택배') || text.includes('배송')) return '배송';
  return '매장방문';
}

function normalizeStatus(value: string): OrderStatus {
  const text = String(value).trim();
  if (text.includes('현장')) return '현장수령';
  if (text.includes('택배')) return '택배';
  if (text.includes('완료')) return '완료';
  if (text.includes('준비')) return '준비중';
  if (text.includes('취소')) return '취소';
  return '접수';
}

function isDoneStatus(value: string): boolean {
  const text = String(value).trim();
  return text.includes('완료') || text.includes('완납') || text.includes('Y');
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
  courier: '',
  trackingNumber: '',
  reservationTime: '',
  statusMemo: '',
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
  const [loadedCustomerId, setLoadedCustomerId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSmsOpen, setIsSmsOpen] = useState(false);
  const [printOrder, setPrintOrder] = useState<Order | null>(null);
  const [isPostcodeOpen, setIsPostcodeOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [photoModalOrderId, setPhotoModalOrderId] = useState<string | null>(null);
  const [accountNumber, setAccountNumber] = useState(() => getStoredAccountNumber());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const postcodeWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrders(loadOrders());
    setProducts(load(PRODUCTS_KEY, defaultProducts));
  }, []);

  useEffect(() => save(ORDERS_KEY, orders), [orders]);
  useEffect(() => save(PRODUCTS_KEY, products), [products]);

  // ===== 서버 자동저장/복원 (배포·재배포 시 데이터 보존) =====
  const SYNC_KEYS: Record<string, string> = {
    orders: ORDERS_KEY,
    products: PRODUCTS_KEY,
    customers: 'jc_customers_v1',
    accounts: 'jc_accounts',
    gallery: 'jc_gallery_v1',
    gallery_notice: 'jc_gallery_notice_v1',
  };

  const [booted, setBooted] = useState(() => !isLoggedIn());

  // 로그인 상태로 시작하면 서버에 저장된 데이터를 먼저 복원 (로컬이 비어있을 때만)
  useEffect(() => {
    if (!loggedIn) {
      setBooted(true);
      return;
    }
    setBooted(false);
    let alive = true;
    (async () => {
      try {
        // 서버 세션이 만료된 상태(재배포 등)인지 먼저 확인
        const sessionUser = await me();
        if (alive && !sessionUser) {
          await performLogout();
          if (alive) {
            setLoggedIn(false);
            setBooted(true);
            alert('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');
          }
          return;
        }
        const all = await fetchAllAppData();
        if (alive && all) {
          for (const [key, lsKey] of Object.entries(SYNC_KEYS)) {
            const serverValue = (all as any)[key];
            if (serverValue === undefined || serverValue === null) continue;
            const localRaw = localStorage.getItem(lsKey);
            const localEmpty =
              !localRaw ||
              localRaw === '[]' ||
              localRaw === 'null' ||
              localRaw === '""' ||
              localRaw === '{}';
            if (localEmpty) {
              save(lsKey, serverValue);
              if (key === 'orders' && Array.isArray(serverValue)) {
                setOrders(normalizeOrders(serverValue));
              }
              if (key === 'products') setProducts(serverValue);
            }
          }
        }
      } catch {
        // 서버 부재 시 로컬 데이터로 진행
      } finally {
        if (alive) setBooted(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  // 주기적으로 로컬 데이터를 서버에 자동 저장 (변경분만)
  const lastSyncedRef = useRef<Record<string, string>>({});
  const syncNow = useCallback(async () => {
    if (!isLoggedIn()) return;
    for (const [key, lsKey] of Object.entries(SYNC_KEYS)) {
      let raw: string | null = null;
      if (key === 'orders') raw = JSON.stringify(orders ?? []);
      else if (key === 'products') raw = JSON.stringify(products ?? []);
      else raw = localStorage.getItem(lsKey);
      if (raw == null) continue;
      if (lastSyncedRef.current[key] === raw) continue;
      const prev = lastSyncedRef.current[key];
      lastSyncedRef.current[key] = raw;
      try {
        await syncAppData(key, JSON.parse(raw));
      } catch {
        if (prev !== undefined) lastSyncedRef.current[key] = prev;
      }
    }
  }, [orders, products]);

  useEffect(() => {
    const timer = setInterval(syncNow, 10000);
    const flush = () => syncNow();
    window.addEventListener('visibilitychange', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener('visibilitychange', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [syncNow]);

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

  const photoModalOrder = useMemo(
    () => (photoModalOrderId ? orders.find((o) => o.id === photoModalOrderId) : undefined),
    [photoModalOrderId, orders]
  );

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
    setLoadedCustomerId(null);
  }

  function openNewForm() {
    resetForm();
    setIsFormOpen(true);
  }

  const formPhoneDigits = form.phone.replace(/\D/g, '');
  const customerMatches = useMemo(() => {
    if (!isFormOpen || editingId || formPhoneDigits.length < 3) return [];
    return loadCustomers()
      .filter((c) => c.phone.replace(/\D/g, '').includes(formPhoneDigits))
      .slice(0, 8);
  }, [isFormOpen, editingId, formPhoneDigits]);

  const loadedCustomer = useMemo(
    () =>
      loadedCustomerId
        ? loadCustomers().find((c) => c.id === loadedCustomerId)
        : undefined,
    [loadedCustomerId]
  );
  const loadedCustomerActive =
    !!loadedCustomer && loadedCustomer.phone.replace(/\D/g, '') === formPhoneDigits;
  const showCustomerSuggest = customerMatches.length > 0 && !loadedCustomerActive;

  function applyCustomer(customer: Customer) {
    setForm((prev) => {
      const quantity =
        customer.quantity && customer.quantity > 0 ? customer.quantity : prev.quantity;
      return {
        ...prev,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        memo: customer.memo || prev.memo,
        pickupDate: customer.arrivalDate || prev.pickupDate,
        quantity,
        totalPrice: calcTotal(quantity, prev.pricePerUnit),
      };
    });
    setLoadedCustomerId(customer.id);
  }

  function syncLoadedCustomer() {
    if (!loadedCustomerId) return;
    const target = loadCustomers().find((c) => c.id === loadedCustomerId);
    if (!target) return;
    if (target.phone.replace(/\D/g, '') !== form.phone.replace(/\D/g, '')) return;
    const patch: Partial<Customer> = {};
    if (form.name !== target.name) patch.name = form.name;
    if (form.address !== target.address) patch.address = form.address;
    if (form.memo !== target.memo) patch.memo = form.memo;
    if (form.pickupDate && form.pickupDate !== (target.arrivalDate || '')) {
      patch.arrivalDate = form.pickupDate;
    }
    if (form.quantity > 0 && form.quantity !== (target.quantity ?? 0)) {
      patch.quantity = form.quantity;
    }
    if (Object.keys(patch).length > 0) {
      updateCustomer(loadedCustomerId, patch);
    }
  }

  function startEdit(order: Order) {
    setForm({ ...order });
    setEditingId(order.id);
    setIsFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim()) {
      alert('연락처를 입력해주세요.');
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
    syncLoadedCustomer();
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

  function updateOrderFields(id: string, patch: Partial<Order>) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  // 공유(링크 발급)된 주문은 서버에 자동 동기화 → 상대방이 실시간으로 확인 가능
  useEffect(() => {
    if (!loggedIn) return;
    const shared = orders.filter((o) => o.shared);
    if (shared.length === 0) return;
    const timer = setTimeout(() => {
      shared.forEach((o) => {
        syncPublicOrder(o).catch(() => {});
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [orders, loggedIn]);

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

  const MAX_ORDER_PHOTOS = 5;

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
      택배사: o.courier || '',
      운송장번호: o.trackingNumber || '',
      메모: o.memo,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '주문목록');
    XLSX.writeFile(wb, `절임배추_주문목록_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function handleLogout() {
    await performLogout();
    setLoggedIn(false);
    setPage('orders');
  }

  function importOrdersFromExcel(rows: Record<string, any>[]) {
    const imported: Order[] = [];
    const skipped: string[] = [];

    for (const row of rows) {
      const dateText = getCell(row, ['날짜', '도착', '날짜(도착)', '수령일', '희망일', 'date']);
      const address = getCell(row, ['주소', '배송주소', 'address']);
      const name = getCell(row, ['이름', '고객명', '성함', 'name']);
      const phoneRaw = getCell(row, ['연락처', '전화번호', '휴폰', 'phone']);
      const quantityRaw = getCell(row, ['개수', '수량', '수량(개)', 'quantity']);
      const timeText = getCell(row, ['시간', '수령시간', 'time']);
      const pickupText = getCell(row, ['택/배', '수령방식', '배송', 'pickup']);
      const memo = getCell(row, ['요청사항', '메모', '특이사항', 'memo']);
      const doneText = getCell(row, ['완/미완', '완료여부', '상태', 'status', '입금상태']);

      const phone = parsePhone(phoneRaw);
      if (!phone) {
        skipped.push(`전화번호 누락: ${name || '(이름없음)'}`);
        continue;
      }

      const quantity = Number(quantityRaw) || 1;
      const pickup = normalizePickup(pickupText);
      const status = normalizeStatus(doneText);
      const pickupDate = parseKoreanDate(dateText);
      const deposit = isDoneStatus(doneText);

      const product = products[0] || defaultProducts[0];
      const pricePerUnit = product.price;
      const totalPrice = calcTotal(quantity, pricePerUnit);

      imported.push({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        name: name || '',
        phone,
        productId: product.id,
        cabbageType: product.name,
        quantity,
        unit: product.unit,
        pricePerUnit,
        totalPrice,
        depositAmount: deposit ? totalPrice : 0,
        pickup,
        pickupDate,
        preparationDate: '',
        address,
        memo: memo || timeText || '',
        status,
        deposit,
      });
    }

    if (imported.length > 0) {
      setOrders((prev) => [...imported, ...prev]);
    }

    return { imported: imported.length, skipped };
  }

  async function handleExcelImport(e: React.ChangeEvent<HTMLInputElement>) {
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
        const result = importOrdersFromExcel(rows);
        if (result.skipped.length > 0) {
          console.warn('Skipped rows:', result.skipped);
        }
        alert(`${result.imported}건의 주문을 등록했습니다.${result.skipped.length > 0 ? '\n누락: ' + result.skipped.length + '건' : ''}`);
      } catch (err: any) {
        alert(err.message || '엑셀 파일을 읽는 중 오류가 발생했습니다.');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
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
    // 링크 공유 시작: 이후 이 주문의 변경사항은 서버로 실시간 동기화됨
    if (!order.shared) {
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, shared: true } : o)));
    }
    try {
      await syncPublicOrder({ ...order, shared: true });
    } catch {
      // 동기화 실패해도 링크 복사는 진행 (로컬에서만 동작)
    }
    try {
      await navigator.clipboard.writeText(url);
      alert('주문 조회 링크가 복사되었습니다.\n상대방은 진행 상황을 실시간으로 확인할 수 있습니다.');
    } catch {
      prompt('주문 조회 링크를 복사해주세요.', url);
    }
  }

  const params = new URLSearchParams(window.location.search);
  const publicOrderId = params.get('order');
  const publicGallery = params.get('gallery');
  const publicOrder = publicOrderId ? orders.find((o) => o.id === publicOrderId) : undefined;

  if (publicOrderId) {
    return <PublicOrderView orderId={publicOrderId} localOrder={publicOrder} />;
  }

  if (publicGallery) {
    return <PublicGallery />;
  }

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  // 서버 데이터 복원 중에는 로딩 화면 표시 (자식 컴포넌트가 복원된 데이터로 마운트되도록)
  if (!booted) {
    return (
      <main className='app-shell'>
        <div className='container'>
          <div className='panel boot-panel'>
            <h2>데이터를 불러오는 중...</h2>
            <p className='empty'>등록하신 내용을 자동으로 저장·복원하고 있습니다.</p>
          </div>
        </div>
      </main>
    );
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
                  : page === 'gallery'
                  ? '사진 등록'
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
                  className={`btn ${page === 'gallery' ? 'active' : ''}`}
                  onClick={() => setPage('gallery')}
                >
                  🖼 사진등록
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
        ) : page === 'gallery' && isAdmin() ? (
          <Gallery />
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
                📥 엑셀 저장
              </button>
              <button className='btn' onClick={() => fileInputRef.current?.click()}>
                📤 엑셀 등록
              </button>
              <input
                ref={fileInputRef}
                type='file'
                accept='.xlsx,.xls,.csv'
                style={{ display: 'none' }}
                onChange={handleExcelImport}
              />
            </section>

            {isFormOpen && (
              <section className='panel form-panel'>
                <h2>{editingId ? '주문 수정' : '새 주문 등록'}</h2>
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
                    <label className='phone-field'>
                      연락처
                      <input
                        className='input'
                        type='tel'
                        value={form.phone}
                        onChange={(e) => {
                          const phone = formatPhone(e.target.value);
                          setForm({ ...form, phone });
                          if (
                            loadedCustomer &&
                            phone.replace(/\D/g, '') !== loadedCustomer.phone.replace(/\D/g, '')
                          ) {
                            setLoadedCustomerId(null);
                          }
                        }}
                        placeholder='010-0000-0000'
                        maxLength={13}
                        autoComplete='off'
                      />
                      {showCustomerSuggest && (
                        <div className='customer-suggest'>
                          {customerMatches.map((c) => (
                            <button
                              type='button'
                              key={c.id}
                              className='customer-suggest-item'
                              onClick={() => applyCustomer(c)}
                            >
                              <span className='suggest-name'>
                                {c.name || '(이름 없음)'} · {c.phone}
                              </span>
                              {c.address && <span className='suggest-sub'>{c.address}</span>}
                              {(c.arrivalDate || (c.quantity ?? 0) > 0) && (
                                <span className='suggest-sub'>
                                  {c.arrivalDate ? `도착 ${c.arrivalDate}` : ''}
                                  {c.arrivalDate && (c.quantity ?? 0) > 0 ? ' · ' : ''}
                                  {(c.quantity ?? 0) > 0 ? `${c.quantity}개` : ''}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                      {loadedCustomerActive && (
                        <span className='customer-loaded-hint'>
                          ✓ 고객 정보를 불러왔습니다. 수정하면 고객관리에도 자동 반영됩니다.
                        </span>
                      )}
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
                        onChange={(e) => {
                          const pickupDate = e.target.value;
                          // 희망일 입력 시 준비일 자동 설정 (4일 전)
                          const preparationDate = pickupDate
                            ? new Date(new Date(pickupDate).getTime() - 4 * 86400000)
                                .toISOString()
                                .slice(0, 10)
                            : '';
                          setForm((prev) => ({
                            ...prev,
                            pickupDate,
                            preparationDate: preparationDate || prev.preparationDate,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      준비일 (희망일 4일 전 자동 입력)
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
                          <button className='btn icon' onClick={() => copyOrderUrl(order)} title='주문 조회 링크 복사 (실시간 공유)'>
                            🔗
                          </button>
                          {order.status === '준비중' && (
                            <>
                              <button
                                className='btn status-choice-btn courier'
                                onClick={() => updateStatus(order.id, '택배')}
                                title='택배 수령으로 진행'
                              >
                                🚚 택배
                              </button>
                              <button
                                className='btn status-choice-btn visit'
                                onClick={() => updateStatus(order.id, '현장수령')}
                                title='현장 수령으로 진행'
                              >
                                🏪 현장수령
                              </button>
                            </>
                          )}
                          {STATUS_FLOW[order.status] && (
                            <button
                              className='btn status-next-btn'
                              onClick={() => updateStatus(order.id, STATUS_FLOW[order.status]!)}
                              title='다음 단계로 진행'
                            >
                              → {STATUS_FLOW[order.status]}
                            </button>
                          )}
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
                          {order.courier && <span className='tag'>{order.courier}</span>}
                          {order.trackingNumber && (
                            <span className='tag highlight'>운송장 {order.trackingNumber}</span>
                          )}
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
                      {order.status === '택배' && isAdmin() && (
                        <StatusDetailEditor
                          key={`courier-${order.id}-${order.courier}-${order.trackingNumber}-${order.statusMemo}`}
                          mode='택배'
                          order={order}
                          onSave={(patch) => {
                            updateOrderFields(order.id, patch);
                            alert('저장되었습니다.');
                          }}
                        />
                      )}
                      {order.status === '현장수령' && isAdmin() && (
                        <StatusDetailEditor
                          key={`visit-${order.id}-${order.reservationTime}-${order.statusMemo}`}
                          mode='현장수령'
                          order={order}
                          onSave={(patch) => {
                            updateOrderFields(order.id, patch);
                            alert('저장되었습니다.');
                          }}
                        />
                      )}
                      {order.status === '완료' && isAdmin() && (
                        <div className='order-photos'>
                          <div className='order-photos-head'>
                            <span className='order-photos-title'>
                              📷 주문별 완료 사진 ({(order.completionPhotos || []).length}/{MAX_ORDER_PHOTOS})
                            </span>
                            <div className='order-photos-actions'>
                              <button
                                type='button'
                                className='btn small btn-primary order-photo-open'
                                onClick={() => setPhotoModalOrderId(order.id)}
                              >
                                사진 등록
                              </button>
                            </div>
                          </div>
                          {(order.completionPhotos || []).length > 0 && (
                            <div className='order-photo-list'>
                              {(order.completionPhotos || []).map((photo, idx) => (
                                <div key={idx} className='order-photo-item'>
                                  <img src={photo} alt={`완료 사진 ${idx + 1}`} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div className='order-row foot'>
                        <button
                          type='button'
                          className={`btn deposit-toggle ${order.deposit ? 'paid' : ''}`}
                          onClick={() => toggleDeposit(order.id)}
                        >
                          {order.deposit ? '✓ 완납 완료' : '완납 처리'}
                        </button>
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

      {photoModalOrder && (
        <OrderPhotoModal
          order={photoModalOrder}
          maxPhotos={MAX_ORDER_PHOTOS}
          onClose={() => setPhotoModalOrderId(null)}
          onSave={async (photos) => {
            updateOrderFields(photoModalOrder.id, { completionPhotos: photos });
            setPhotoModalOrderId(null);
            if (photoModalOrder.shared) {
              try {
                await syncPublicOrder({ ...photoModalOrder, completionPhotos: photos });
              } catch {
                // 자동 동기화에서 재시도됨
              }
            }
            alert('사진이 저장되었습니다.');
          }}
        />
      )}
    </main>
  );
}

function personalizeMessage(template: string, order: Order) {
  const balance = order.totalPrice - order.depositAmount;
  const trackingText =
    order.courier && order.trackingNumber
      ? `${order.courier} ${order.trackingNumber}`
      : order.trackingNumber || order.courier || '';
  return template
    .split('{이름}').join(`${order.name} 고객님`)
    .split('{품목}').join(order.cabbageType)
    .split('{수량}').join(`${order.quantity}${order.unit}`)
    .split('{금액}').join(`미수금 ${formatCurrency(balance)}`)
    .split('{잔액}').join(`잔액 ${formatCurrency(balance)}`)
    .split('{입금액}').join(formatCurrency(order.depositAmount))
    .split('{수령일}').join(formatDate(order.pickupDate))
    .split('{주문URL}').join(getOrderPublicUrl(order.id))
    .split('{택배사}').join(order.courier || '')
    .split('{운송장번호}').join(trackingText)
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
      {order.courier && (
        <div className='receipt-line'>
          <span>택배사</span>
          <span>{order.courier}</span>
        </div>
      )}
      {order.trackingNumber && (
        <div className='receipt-line'>
          <span>운송장번호</span>
          <span>{order.trackingNumber}</span>
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

function OrderPhotoModal({
  order,
  maxPhotos,
  onClose,
  onSave,
}: {
  order: Order;
  maxPhotos: number;
  onClose: () => void;
  onSave: (photos: string[]) => void | Promise<void>;
}) {
  const [photos, setPhotos] = useState<string[]>(order.completionPhotos || []);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;
    const remaining = maxPhotos - photos.length;
    if (remaining <= 0) {
      alert(`사진은 최대 ${maxPhotos}장까지 등록할 수 있습니다.`);
      return;
    }
    const targets = files.slice(0, remaining);
    if (files.length > remaining) {
      alert(`최대 ${maxPhotos}장까지 가능하여 ${remaining}장만 추가됩니다.`);
    }
    try {
      const compressed = await Promise.all(targets.map((f) => compressImage(f)));
      setPhotos((prev) => [...prev, ...compressed]);
    } catch (err: any) {
      alert(err.message || '이미지를 처리하는 중 오류가 발생했습니다.');
    }
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  function movePhoto(index: number, direction: -1 | 1) {
    setPhotos((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal photo-modal' onClick={(e) => e.stopPropagation()}>
        <header className='modal-header'>
          <h3>📷 완료 사진 등록</h3>
          <button className='btn icon' onClick={onClose} title='닫기'>
            ✕
          </button>
        </header>
        <p className='photo-modal-sub'>
          {order.name} · {order.cabbageType} {order.quantity}
          {order.unit} (최대 {maxPhotos}장)
        </p>
        <div className='photo-grid modal-grid'>
          {photos.map((photo, idx) => (
            <div key={idx} className='photo-item'>
              <img src={photo} alt={`완료 사진 ${idx + 1}`} />
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
                  disabled={idx === photos.length - 1}
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
          {photos.length < maxPhotos && (
            <button
              type='button'
              className='photo-add'
              onClick={() => inputRef.current?.click()}
            >
              📷 사진 추가
              <span className='photo-add-count'>
                {photos.length}/{maxPhotos}
              </span>
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type='file'
          accept='image/*'
          multiple
          style={{ display: 'none' }}
          onChange={handleSelect}
        />
        <footer className='modal-foot'>
          <button type='button' className='btn' onClick={onClose}>
            취소
          </button>
          <button
            type='button'
            className='btn btn-primary'
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(photos);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? '저장 중...' : '저장'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatusDetailEditor({
  mode,
  order,
  onSave,
}: {
  mode: '택배' | '현장수령';
  order: Order;
  onSave: (patch: Partial<Order>) => void;
}) {
  const [courier, setCourier] = useState(order.courier || '');
  const [trackingNumber, setTrackingNumber] = useState(order.trackingNumber || '');
  const [reservationTime, setReservationTime] = useState(order.reservationTime || '');
  const [statusMemo, setStatusMemo] = useState(order.statusMemo || '');

  return (
    <div className='status-detail-box'>
      <span className='status-detail-title'>
        {mode === '택배' ? '🚚 택배 정보' : '🏪 현장수령 정보'}
      </span>
      <div className='status-detail-grid'>
        {mode === '택배' ? (
          <>
            <label>
              택배사
              <select
                className='select'
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
              >
                <option value=''>택배사 선택</option>
                {COURIER_LIST.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              운송장번호
              <input
                className='input'
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                placeholder='운송장번호 입력'
              />
            </label>
          </>
        ) : (
          <label>
            예약시간
            <input
              className='input'
              type='time'
              value={reservationTime}
              onChange={(e) => setReservationTime(e.target.value)}
            />
          </label>
        )}
        <label className='full'>
          메모
          <input
            className='input'
            value={statusMemo}
            onChange={(e) => setStatusMemo(e.target.value)}
            placeholder={mode === '택배' ? '택배 관련 메모' : '현장수령 관련 메모'}
          />
        </label>
      </div>
      <div className='status-detail-actions'>
        <button
          type='button'
          className='btn small btn-primary'
          onClick={() =>
            onSave(
              mode === '택배'
                ? { courier, trackingNumber, statusMemo }
                : { reservationTime, statusMemo }
            )
          }
        >
          저장
        </button>
      </div>
    </div>
  );
}

function PublicOrderView({ orderId, localOrder }: { orderId: string; localOrder?: Order }) {
  const [order, setOrder] = useState<Order | undefined>(localOrder);
  const [checked, setChecked] = useState(false);

  // 서버에서 주문 스냅샷을 폴링하여 진행 상황을 실시간 표시
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const remote = await fetchPublicOrder(orderId);
        if (alive && remote) setOrder(remote);
      } catch {
        // 무시
      }
      if (alive) setChecked(true);
    }
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [orderId]);

  if (!order) {
    return (
      <div className='app-shell'>
        <div className='container'>
          <div className='panel public-order'>
            <h2>주문 조회</h2>
            <p className='empty'>
              {checked ? '해당 주문을 찾을 수 없습니다.' : '주문 정보를 불러오는 중...'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const balance = order.totalPrice - order.depositAmount;
  // 접수 → 준비중 → 수령(택배/현장수령 중 선택) → 완료
  const stepIndexMap: Record<string, number> = { 접수: 0, 준비중: 1, 택배: 2, 현장수령: 2, 완료: 3 };
  const stepIndex =
    order.status === '취소' ? 0 : (stepIndexMap[order.status] ?? 0);
  const steps =
    order.status === '택배' || order.status === '현장수령'
      ? ['접수', '준비중', order.status, '완료']
      : ['접수', '준비중', '수령', '완료'];

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
            {order.courier && (
              <div className='info-row'>
                <span>택배사</span>
                <span>{order.courier}</span>
              </div>
            )}
            {order.trackingNumber && (
              <div className='info-row'>
                <span>운송장번호</span>
                <span>{order.trackingNumber}</span>
              </div>
            )}
            {order.reservationTime && (
              <div className='info-row'>
                <span>예약시간</span>
                <span>{order.reservationTime}</span>
              </div>
            )}
            {order.statusMemo && (
              <div className='info-row'>
                <span>메모</span>
                <span>{order.statusMemo}</span>
              </div>
            )}
            {order.memo && (
              <div className='info-row'>
                <span>주문 메모</span>
                <span>{order.memo}</span>
              </div>
            )}
            <div className='info-row'>
              <span>입금상태</span>
              <span>{getPaymentStatus(order)}</span>
            </div>
          </div>

          {order.status === '완료' && (order.completionPhotos || []).length > 0 && (
            <div className='public-photos'>
              <h3 className='public-photos-title'>📷 완료 사진</h3>
              <div className='public-photos-grid'>
                {(order.completionPhotos || []).map((photo, idx) => (
                  <img key={idx} src={photo} alt={`완료 사진 ${idx + 1}`} />
                ))}
              </div>
            </div>
          )}

          <p className='public-order-thanks'>이용해주셔서 감사합니다.</p>
          <p className='public-refresh-hint'>이 화면은 5초마다 자동으로 최신 상태를 불러옵니다.</p>
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
            {['{이름}', '{품목}', '{수량}', '{금액}', '{잔액}', '{입금액}', '{수령일}', '{주문URL}', '{택배사}', '{운송장번호}', '{계좌번호}'].map((tag) => (
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
