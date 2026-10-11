import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'pretendard/dist/web/static/pretendard-dynamic-subset.css';
import './style.css';
import { sendSms, syncPublicOrder, fetchPublicOrder, cancelPublicOrder, fetchAllAppData, syncAppData, me, submitPublicCustomer, fetchCustomerIntake, ackCustomerIntake, confirmPublicPayment, fetchPublicPayments, subscribeEvents, updateServerAuth, fetchCustomers, createCustomer, updateCustomerApi, deleteOrderApi } from './lib/api';
import { load, save } from './lib/storage';
import { compressImages } from './lib/images';
import { Order, Product, OrderStatus, PickupType, PaymentStatus, Page, Customer } from './types';
import Login, { isAdmin, isLoggedIn, mustChangePassword, performLogout, getStoredUser, setStoredUser } from './components/Login';
import Customers from './components/Customers';
import Admin, { AccountManager, getStoredAccountNumber } from './components/Admin';
import Dashboard from './components/Dashboard';
import Gallery, { PublicGallery } from './components/Gallery';
import { Materials } from './components/Materials';

const STATUS_LIST: OrderStatus[] = ['접수', '준비중', '택배', '현장수령', '완료', '취소', '환불완료'];
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

function isDuplicateCustomerIntake(left: Order, right: Order): boolean {
  if (!left.intakeId || !right.intakeId) return false;
  if (left.intakeId === right.intakeId) return true;
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const leftPhone = left.phone.replace(/\D/g, '');
  const rightPhone = right.phone.replace(/\D/g, '');
  return (
    leftPhone.length > 0 &&
    leftPhone === rightPhone &&
    left.name.trim() === right.name.trim() &&
    left.pickupDate === right.pickupDate &&
    left.pickup === right.pickup &&
    left.cabbageType === right.cabbageType &&
    left.quantity === right.quantity &&
    left.pricePerUnit === right.pricePerUnit &&
    left.memo.trim() === right.memo.trim() &&
    Number.isFinite(leftCreatedAt) &&
    Number.isFinite(rightCreatedAt) &&
    Math.abs(leftCreatedAt - rightCreatedAt) < 60_000
  );
}

function normalizeOrders(stored: StoredOrder[]): Order[] {
  const uniqueOrders: StoredOrder[] = [];
  for (const order of stored) {
    if (uniqueOrders.some((existing) => isDuplicateCustomerIntake(existing, order))) continue;
    uniqueOrders.push(order);
  }
  return uniqueOrders.map((order) => {
      const legacyPhotos = Array.isArray(order.photos) ? order.photos : [];
      const completionPhotos = Array.isArray(order.completionPhotos)
        ? order.completionPhotos
        : legacyPhotos;
      const { photos: _legacyPhotos, ...rest } = order;
      const totalPrice = Math.max(0, Number(order.quantity) || 0) * Math.max(0, Number(order.pricePerUnit) || 0);
      const storedDeposit = Math.max(0, Number(order.depositAmount) || 0);
      const legacyFullPayment = !!order.paid && Number(order.paidAmount) >= totalPrice && totalPrice > 0;
      const depositAmount = Math.min(totalPrice, Math.max(storedDeposit, legacyFullPayment ? totalPrice : 0));
      const fullyPaid = totalPrice > 0 && depositAmount >= totalPrice;
      return {
        ...rest,
        depositAmount,
        paid: fullyPaid,
        deposit: fullyPaid,
        ...(completionPhotos.length > 0 ? { completionPhotos } : {}),
      };
    });
}

function loadOrders(): Order[] {
  return normalizeOrders(load<StoredOrder[]>(ORDERS_KEY, []));
}

// 품목 미설정 시 사용하는 안전한 폴백 (기본 메뉴 하드코딩 제거)
const fallbackProduct: Product = { id: '', name: '절임배추', unit: '박스', price: 0 };

function resolveProduct(products: Product[]): Product {
  return products[0] || fallbackProduct;
}

// URL 접수 고객 데이터로 주문 자동 생성 (첫 품목 기준, 이후 수정 가능)
function buildOrderFromIntake(entry: Customer, products: Product[]): Order {
  const product = resolveProduct(products);
  const quantity = Number(entry.quantity) > 0 ? Number(entry.quantity) : 1;
  const pickup: PickupType =
    entry.receiveMethod === '배송' || entry.receiveMethod === '택배' ? '배송' : '매장방문';
  const memoParts = ['[고객등록 URL 접수]'];
  if (entry.receiveMethod) memoParts.push(`수령: ${entry.receiveMethod}`);
  if (entry.memo) memoParts.push(String(entry.memo));
  return {
    id: crypto.randomUUID(),
    createdAt: entry.createdAt || new Date().toISOString(),
    name: entry.name || '',
    phone: entry.phone || '',
    productId: product.id,
    cabbageType: product.name,
    quantity,
    unit: product.unit,
    pricePerUnit: product.price,
    totalPrice: quantity * product.price,
    depositAmount: 0,
    pickup,
    pickupDate: entry.arrivalDate || '',
    preparationDate: '',
    address: entry.address || '',
    addressDetail: entry.addressDetail || '',
    memo: memoParts.join(' / '),
    status: '접수',
    deposit: false,
    intakeId: entry.id,
  };
}

// 서버의 결제 완료 기록 (orderId → 결제 정보) — 폴스루로 갱신됨
const paymentsRef = {
  current: new Map<string, { paidAt?: string; paidAmount?: number; paymentMethod?: string; depositAmount?: number; totalPrice?: number }>(),
};

// 서버의 누적 입금액과 총액을 주문에 반영해 결제 상태를 계산한다.
function applyPublicPayments(current: Order[]): { next: Order[]; changed: boolean } {
  const pending = paymentsRef.current;
  if (pending.size === 0) return { next: current, changed: false };
  let changed = false;
  const next = current.map((o) => {
    const pay = pending.get(o.id);
    if (!pay) return o;
    const totalPrice = Math.max(0, Number(o.totalPrice) || 0);
    const serverDeposit = Number(pay.depositAmount);
    const depositAmount = Math.min(
      totalPrice,
      Math.max(0, Number.isFinite(serverDeposit) ? serverDeposit : Number(pay.paidAmount) || Number(o.depositAmount) || 0)
    );
    const fullyPaid = totalPrice > 0 && depositAmount >= totalPrice;
    const paidAt = pay.paidAt ?? o.paidAt;
    const paymentMethod = pay.paymentMethod ?? o.paymentMethod;
    const transactionAmount = pay.paidAmount ?? o.paidAmount;
    if (
      o.totalPrice === totalPrice &&
      o.depositAmount === depositAmount &&
      o.paid === fullyPaid &&
      o.deposit === fullyPaid &&
      o.paidAt === paidAt &&
      o.paymentMethod === paymentMethod &&
      o.paidAmount === transactionAmount
    ) return o;
    changed = true;
    return {
      ...o,
      totalPrice,
      paid: fullyPaid,
      deposit: fullyPaid,
      paidAt,
      paidAmount: transactionAmount,
      paymentMethod,
      depositAmount,
    };
  });
  return { next, changed };
}

// URL 자가등록(공개 폼)으로 접수된 고객을 서버 DB에 병합한다.
// 고객 목록 전체를 통째로 덮어쓰지 않고 고객 한 명씩 서버 API로 추가/수정한다.
// (localStorage의 오래된 목록이 서버 DB를 통째로 덮어써 고객이 사라지는 사고 방지)
async function mergeCustomerIntake(products: Product[], appendOrders?: (orders: Order[]) => void) {
  // 접수 목록 조회는 관리자 전용 API이므로 일반회원은 호출하지 않음 (403 방지)
  if (!isAdmin()) return;
  try {
    const entries = await fetchCustomerIntake();
    if (!Array.isArray(entries) || entries.length === 0) return;
    // 서버(DB)의 최신 고객 목록 기준으로 이름+연락처 중복 여부 판단
    const serverCustomers = await fetchCustomers().catch(() => [] as Customer[]);
    const phoneKey = (v: string) => String(v || '').replace(/\D/g, '');
    const byNamePhone = new Map<string, Customer>();
    for (const c of serverCustomers) {
      if (c && c.id) byNamePhone.set(`${String(c.name || '').trim()}|${phoneKey(c.phone)}`, c);
    }
    for (const e of entries as Customer[]) {
      if (!e || !e.id) continue;
      const key = `${String(e.name || '').trim()}|${phoneKey(e.phone)}`;
      const prev = byNamePhone.get(key);
      try {
        if (prev) {
          // 기존 고객 정보에 새 접수 내용(주소/상세주소/메모/수령방법/도착일/수량)을 합병
          await updateCustomerApi(prev.id, {
            address: e.address || prev.address,
            addressDetail: e.addressDetail || prev.addressDetail,
            memo: e.memo || prev.memo,
            receiveMethod: e.receiveMethod || prev.receiveMethod,
            arrivalDate: e.arrivalDate || prev.arrivalDate,
            quantity: e.quantity ?? prev.quantity,
          });
        } else {
          // 새 고객은 서버에 개별 추가
          await createCustomer({
            name: e.name,
            phone: e.phone,
            address: e.address || '',
            addressDetail: e.addressDetail || '',
            memo: e.memo || '',
            arrivalDate: e.arrivalDate,
            quantity: e.quantity,
            receiveMethod: e.receiveMethod,
          });
        }
      } catch {
        // 개별 실패는 무시하고 다음 접수 처리 (다음 주기에 재시도됨)
      }
    }
    // 접수된 고객은 주문 목록에도 자동 등록 (intakeId로 중복 방지)
    const existingOrders = loadOrders();
    const seenIntake = new Set(
      existingOrders.map((o) => o.intakeId).filter(Boolean) as string[]
    );
    const newOrders: Order[] = [];
    for (const entry of entries as Customer[]) {
      if (!entry || !entry.id || seenIntake.has(entry.id)) continue;
      const order = buildOrderFromIntake(entry, products);
      seenIntake.add(entry.id);
      if (existingOrders.some((existingOrder) => isDuplicateCustomerIntake(existingOrder, order))) continue;
      existingOrders.push(order);
      newOrders.push(order);
    }
    if (newOrders.length > 0 && appendOrders) appendOrders(newOrders);
    await ackCustomerIntake((entries as Customer[]).map((e) => e.id));
    // 고객 관리 화면이 서버에서 다시 불러오도록 신호
    window.dispatchEvent(new Event('jc-customers-updated'));
  } catch {
    // 서버 부재 시 무시
  }
}

// 두 기기에서 동시에 저장했을 때 한쪽 데이터를 지우지 않도록
// 서버 값과 로컬 값을 id 기준으로 합친다. 같은 id는 방금 편집한 로컬 값을 유지하고,
// 서버에만 있는 항목(다른 기기에서 추가한 고객/품목/주문)은 살려서 함께 저장한다.
// 로컬 변경의 서버 저장은 이 함수 남는 곳을 피해 직접 수행한다.
// (함수 바깥에서 호출하는 기존 동기화와 충돌하지 않도록 syncNow와 같은 규칙 사용)
async function pushProductsToServer(products: Product[]) {
  if (!isLoggedIn()) return false;
  try {
    await syncAppData('products', products);
    return true;
  } catch {
    return false;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mergeServerAndLocal(
  serverValue: unknown,
  localValue: unknown,
  ancestorValue?: unknown
): unknown {
  if (!Array.isArray(serverValue) || !Array.isArray(localValue)) return localValue;
  const idOf = (v: unknown) =>
    v && typeof v === 'object' && (v as any).id ? String((v as any).id) : null;
  const serverMap = new Map<string, unknown>();
  for (const item of serverValue) {
    const id = idOf(item);
    if (id) serverMap.set(id, item);
  }
  const ancestorMap = new Map<string, unknown>();
  if (Array.isArray(ancestorValue)) {
    for (const item of ancestorValue) {
      const id = idOf(item);
      if (id) ancestorMap.set(id, item);
    }
  }
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of localValue) {
    const id = idOf(item);
    if (!id) {
      out.push(item);
      continue;
    }
    seen.add(id);
    const serverItem = serverMap.get(id);
    const ancestorItem = ancestorMap.get(id);
    const localChanged =
      ancestorItem === undefined || JSON.stringify(item) !== JSON.stringify(ancestorItem);
    if (serverItem === undefined) {
      // 서버에 없는 항목:
      // - 원격에서 삭제되었고 로컬에서 수정한 적 없으면 삭제를 수용한다 (되살아나지 않음)
      // - 로컬에서 새로 만들었거나 수정 중이면 로컬 항목을 유지한다
      if (!localChanged && ancestorItem !== undefined) continue;
      out.push(item);
      continue;
    }
    // 같은 항목이 양쪽에 있으면:
    // - 로컬에서 수정한 적 없으면 서버(다른 기기) 변경을 수용
    // - 로컬에서 수정 중이면 로컬 값을 유지 (다음 푸시로 전파됨)
    out.push(localChanged ? item : serverItem);
  }
  // 서버에만 있는 항목(다른 기기에서 새로 등록)은 추가한다
  for (const [id, item] of serverMap) {
    if (!seen.has(id)) out.push(item);
  }
  return out;
}

declare global {
  interface Window {
    daum: any;
  }
}

function normalizeProducts(value: unknown): Product[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => p && typeof p === 'object' && (p as Product).name)
    .map((p) => ({
      id: (p as Product).id || crypto.randomUUID(),
      name: String((p as Product).name).trim(),
      unit: String((p as Product).unit || '포기').trim() || '포기',
      price: Number((p as Product).price) || 0,
    }));
}

function formatDate(date: string | undefined) {
  if (!date) return '-';
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatCurrency(value: number) {
  return (Number(value) || 0).toLocaleString('ko-KR') + '원';
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
  if (order.totalPrice > 0 && order.depositAmount >= order.totalPrice) return '완납';
  if (order.depositAmount <= 0) return '미납';
  return '부분납';
}

function getBalance(order: Order): number {
  return Math.max(0, order.totalPrice - order.depositAmount);
}

// 수령/배송 희망일 기준 설정한 기간 전으로 준비일 자동 계산
// ('YYYY-MM-DD'는 UTC 기준으로 파싱되므로 시차 오차 없이 안전)
function calcPreparationDate(pickupDate: string, preparationDays = 4): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) return '';
  return new Date(new Date(pickupDate).getTime() - preparationDays * 86400000)
    .toISOString()
    .slice(0, 10);
}

function getDefaultPickupDate(preparationDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + preparationDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  addressDetail: '',
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
  const [products, setProducts] = useState<Product[]>([]);
  const [preparationDays, setPreparationDays] = useState(() => load('jc_preparation_days', 4));
  const [filter, setFilter] = useState<OrderStatus | '미납' | '부분납' | '완납' | '전체'>('전체');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ ...emptyOrder });
  const [quantityDraft, setQuantityDraft] = useState(String(emptyOrder.quantity));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadedCustomerId, setLoadedCustomerId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSmsOpen, setIsSmsOpen] = useState(false);
  const [smsCustomers, setSmsCustomers] = useState<Customer[] | null>(null);
  const [printOrder, setPrintOrder] = useState<Order | null>(null);
  const [isPostcodeOpen, setIsPostcodeOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSalesStatsOpen, setIsSalesStatsOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    email: '',
    phone: '',
  });
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [myProfile, setMyProfile] = useState<{ id: string; email: string; phone: string }>({
    id: '',
    email: '',
    phone: '',
  });
  const [photoModalOrderId, setPhotoModalOrderId] = useState<string | null>(null);
  const [accountNumber, setAccountNumber] = useState(() => getStoredAccountNumber());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const postcodeWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrders(loadOrders());
    // 로그인 상태에서는 서버 싱크가 최신 품목/단가를 가져오므로 localStorage를 덮어쓰지 않는다.
    if (!isLoggedIn()) {
      setProducts(load(PRODUCTS_KEY, []));
    }
  }, []);

  useEffect(() => save(ORDERS_KEY, orders), [orders]);
  useEffect(() => save(PRODUCTS_KEY, products), [products]);
  useEffect(() => {
    setOrders((prev) => {
      let changed = false;
      const next = prev.map((order) => {
        const preparationDate = calcPreparationDate(order.pickupDate, preparationDays);
        if (preparationDate !== (order.preparationDate || '')) changed = true;
        return preparationDate === (order.preparationDate || '')
          ? order
          : { ...order, preparationDate };
      });
      return changed ? next : prev;
    });
  }, [preparationDays]);

  // ===== 서버 자동저장/복원 (배포·재배포 시 데이터 보존) =====
  // gallery는 제외: 사진은 /api/public/gallery 를 통해 서버 기준으로 저장·연동됨
  // (빈 기기의 localStorage가 서버 사진을 덮어써서 초기화되는 문제 방지)
  const SYNC_KEYS: Record<string, string> = {
    orders: ORDERS_KEY,
    products: PRODUCTS_KEY,
    // customers는 제외: 로컬 목록이 서버 DB를 통째로 덮어쓰는 사고를 막는다.
    // 고객 추가/수정/삭제는 항상 서버 API(/api/customers)로 개별 처리된다.
    // accounts(계좌번호)도 제외: 서버 전용 파일로 관리하며 로컬 저장소에 남기지 않는다.
    accounts: 'jc_accounts',
    materials: 'jc-materials',
    preparationDays: 'jc_preparation_days',
  };

  // 서버 데이터 로딩/저장 기록 (실시간 동기화 추적용)
  function logSync(action: string, key: string, detail?: string) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    console.log(`[데이터동기화] ${time} ${action} · ${key}${detail ? ` · ${detail}` : ''}`);
  }

  const [booted, setBooted] = useState(() => !isLoggedIn());

  // 접수된 고객 데이터를 주문 목록 앞에 추가 (중복 방지)
  const appendIntakeOrders = useCallback((newOrders: Order[]) => {
    setOrders((prev) => {
      const seenIntake = new Set(
        prev.map((o) => o.intakeId).filter(Boolean) as string[]
      );
      const toAdd: Order[] = [];
      for (const order of newOrders) {
        if (order.intakeId && seenIntake.has(order.intakeId)) continue;
        if (
          [...prev, ...toAdd].some((existing) => isDuplicateCustomerIntake(existing, order))
        ) continue;
        if (order.intakeId) seenIntake.add(order.intakeId);
        toAdd.push(order);
      }
      return toAdd.length > 0 ? [...toAdd.slice().reverse(), ...prev] : prev;
    });
  }, []);

  // 서버의 결제 완료 기록을 가져와 주문 목록에 완납 반영
  const syncPayments = useCallback(async () => {
    if (!isLoggedIn()) return;
    try {
      const list = await fetchPublicPayments();
      if (Array.isArray(list)) {
        paymentsRef.current = new Map(
          list.filter((p) => p && p.id).map((p) => [p.id, p])
        );
      }
    } catch {
      return;
    }
    setOrders((prev) => {
      const { next, changed } = applyPublicPayments(prev);
      return changed ? next : prev;
    });
  }, []);

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
          // 로그인 시에는 서버를 기준으로 복원한다. 이전 기기의 오래된
          // localStorage가 서버의 최신 데이터를 덮어쓰지 않도록 한다.
          for (const key of Object.keys(SYNC_KEYS)) {
            const serverValue = (all as any)[key];
            if (serverValue === undefined || serverValue === null) continue;
            const count = Array.isArray(serverValue) ? ` ${serverValue.length}건` : '';
            logSync('로딩', key, count);
            applyServerValue(key, serverValue);
          }
        }
      } catch {
        // 서버 부재 시 로컬 데이터로 진행
      } finally {
        if (alive) setBooted(true);
      }
      // URL 자가등록으로 접수된 고객을 고객관리/주문 목록에 병합
      await mergeCustomerIntake(products, appendIntakeOrders);
      // 결제 완료된 주문을 완납 처리
      await syncPayments();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  // 주기적으로 로컬 데이터를 서버에 자동 저장 (변경분만)
  const lastSyncedRef = useRef<Record<string, string>>({});

  // 서버에서 받은 값을 로컬(화면 상태 + localStorage)에 적용한다.
  // 반환값은 실제로 적용된 값(orders는 정규화된 값)이다.
  const applyServerValue = useCallback((key: string, value: unknown): unknown => {
    if (key === 'orders' && Array.isArray(value)) {
      const next = normalizeOrders(value as Order[]);
      lastSyncedRef.current[key] = JSON.stringify(next);
      setOrders((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      return next;
    }
    if (key === 'products' && Array.isArray(value)) {
      const next = normalizeProducts(value);
      lastSyncedRef.current[key] = JSON.stringify(next);
      setProducts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      return next;
    }
    if (key === 'preparationDays') {
      const days = Math.max(0, Math.min(60, Number(value) || 0));
      lastSyncedRef.current[key] = JSON.stringify(days);
      save('jc_preparation_days', days);
      setPreparationDays(days);
      return days;
    }
    const lsKey = SYNC_KEYS[key];
    if (!lsKey) return value;
    // 영수증 사진이 포함된 자재 데이터 등은 localStorage 용량 한도를 초과할 수 있다.
    // 저장 실패가 전체 동기화/적용을 중단시키지 않도록 예외를 흡수하고
    // 화면 상태는 서버 값을 기준으로 유지한다.
    lastSyncedRef.current[key] = JSON.stringify(value);
    try {
      save(lsKey, value);
    } catch {
      // 용량 초과 시에도 서버 값은 화면에 반영된다 (서버 DB가 원본)
    }
    if (key === 'accounts') {
      // 계좌번호는 로컬 저장소에 남기지 않고 화면 상태에만 반영한다
      localStorage.removeItem('jc_accounts');
      setAccountNumber(
        (value as { bank: string; number: string; holder: string }[])
          .map((a) => `${a.bank} ${a.number} ${a.holder}`)
          .join('\n')
      );
      return value;
    }
    if (key === 'customers') {
      setCustomersRefresh((v) => v + 1);
      window.dispatchEvent(new Event('jc-customers-updated'));
    }
    if (key === 'materials') {
      // localStorage 저장이 실패해도 화면이 최신 자재 목록을 유지하도록
      // 서버 값을 이벤트 payload로 직접 전달한다.
      window.dispatchEvent(new CustomEvent('jc-materials-updated', { detail: value }));
    }
    return value;
  }, []);

  const hydratedRef = useRef(false);
  const syncNow = useCallback(async () => {
    if (!isLoggedIn()) return;
    // 하이드레이션 전에는 절대 저장(push)하지 않는다.
    // 로그인 직후 앱이 서버 데이터를 받아오기 전에 빈 목록을 저장하면
    // 서버의 주문/고객이 전부 지워지는 사고가 발생했었다.
    // 첫 풀이 성공하기 전까지는 풀만 수행한다.
    if (!hydratedRef.current) {
      try {
        const first = (await fetchAllAppData()) as Record<string, unknown> | null;
        if (first) {
          for (const [key, lsKey] of Object.entries(SYNC_KEYS)) {
            const serverValue = (first as any)[key];
            if (serverValue === undefined || serverValue === null) continue;
            const applied = applyServerValue(key, serverValue);
            lastSyncedRef.current[key] = JSON.stringify(
              key === 'orders' || key === 'products'
                ? applied
                : safeParse(localStorage.getItem(lsKey) || 'null') ?? applied
            );
          }
          hydratedRef.current = true;
        }
      } catch {
        // 서버 조회 실패 시 다음 주기에 재시도 (저장은 계속 보류)
      }
      return;
    }
    // 먼저 서버의 최신 데이터를 확인한다 (풀).
    // - 로컬에 변경이 없는 키는 서버 값을 적용해 오래 떠 있던 기기(SSE 끊김)의
    //   화면을 최신 상태로 되돌린다. 과거 데이터를 들고 저장하는 사고를 막는다.
    // - 로컬에 변경이 있는 키는 서버 변경분과 병합해 저장하므로 다른 기기에서
    //   저장한 고객/품목/주문이 이 기기의 저장으로 지워지지 않는다.
    let serverAll: Record<string, unknown> | null = null;
    try {
      serverAll = (await fetchAllAppData()) as Record<string, unknown> | null;
    } catch {
      serverAll = null;
    }
    for (const [key, lsKey] of Object.entries(SYNC_KEYS)) {
      // 계좌번호(accounts)는 서버 전용 파일(/api/account-numbers)로 관리한다.
      // 앱에서는 서버에서 읽기만 하고 자동저장으로 서버 값을 덮어쓰지 않는다.
      if (key === 'accounts') {
        const serverValue = serverAll ? (serverAll as any)[key] : undefined;
        if (serverValue !== undefined && serverValue !== null) {
          applyServerValue(key, serverValue);
        }
        continue;
      }
      let raw: string | null = null;
      if (key === 'orders') raw = JSON.stringify(orders ?? []);
      else if (key === 'products') raw = JSON.stringify(products ?? []);
      else raw = localStorage.getItem(lsKey);
      if (raw == null) continue;
      const serverValue = serverAll ? (serverAll as any)[key] : undefined;
      const serverRaw =
        serverValue === undefined || serverValue === null ? null : JSON.stringify(serverValue);

      // 로컬에 변경이 없는데 서버에 새 변경이 있으면 서버 값을 적용한다 (풀)
      if (lastSyncedRef.current[key] === raw) {
        if (!serverRaw || serverRaw === raw) continue;
        const pullCount = Array.isArray(serverValue) ? ` ${serverValue.length}건` : '';
        logSync('수신', key, pullCount);
        const applied = applyServerValue(key, serverValue);
        const appliedRaw = JSON.stringify(applied);
        if (appliedRaw !== serverRaw) {
          // 정규화 등으로 로컬 형태가 서버와 다르면 서버도 동일 형태로 맞춘다
          try {
            await syncAppData(key, applied);
          } catch {
            // 다음 주기에 다시 시도
          }
        }
        continue;
      }

      // 로컬에 변경이 있음 → 서버에 마지막 동기화 이후 다른 기기의 변경이
      // 있으면 3-way 병합해서, 이 기기의 저장으로 다른 기기 데이터를 지우지 않는다
      const prev = lastSyncedRef.current[key];
      let valueToPush: unknown = JSON.parse(raw);
      if (serverRaw && serverRaw !== prev && serverRaw !== raw) {
        const ancestor = prev !== undefined ? safeParse(prev) : undefined;
        valueToPush = applyServerValue(key, mergeServerAndLocal(serverValue, valueToPush, ancestor));
      }
      lastSyncedRef.current[key] = JSON.stringify(valueToPush);
      try {
        const pushCount = Array.isArray(valueToPush) ? ` ${valueToPush.length}건` : '';
        logSync('저장', key, pushCount);
        await syncAppData(key, valueToPush);
      } catch {
        if (prev !== undefined) lastSyncedRef.current[key] = prev;
      }
    }
    // 사용 중에도 새로 접수된 고객을 주기적으로 병합
    await mergeCustomerIntake(products, appendIntakeOrders);
    // 결제 완료된 주문을 주기적으로 완납 처리
    await syncPayments();
  }, [orders, products, preparationDays, syncPayments, applyServerValue]);

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

  // 데이터가 바뀌면 10초 주기를 기다리지 않고 0.6초 안에 서버로 즉시 저장
  useEffect(() => {
    const t = setTimeout(() => { syncNow(); }, 600);
    return () => clearTimeout(t);
  }, [syncNow]);

  // ===== SSE 이벤트 수신 시 즉시 병합 동기화 =====
  // 다른 기기에서 변경이 왔는데 이 기기에 미전송 수정이 있으면
  // 무시하지 않고 곧바로 병합 동기화를 실행해 양쪽 변경을 모두 반영한다.
  const syncNowRef = useRef(syncNow);
  useEffect(() => { syncNowRef.current = syncNow; }, [syncNow]);
  const eventSyncTimerRef = useRef<number | null>(null);
  function scheduleEventSync() {
    if (eventSyncTimerRef.current != null) return;
    eventSyncTimerRef.current = window.setTimeout(() => {
      eventSyncTimerRef.current = null;
      void syncNowRef.current();
    }, 400);
  }

  // ===== 서버 실시간 동기화 (SSE) =====
  // 다른 기기에서 저장·수정한 내용, 공개폼 접수, 카드 결제 완료를
  // 새로고침 없이 즉시 화면에 반영한다.
  const ordersRef = useRef(orders);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  // ===== 일반회원 데이터 격리 =====
  // 일반회원은 화면에 본인 주문(계정 연락처와 동일한 연락처)만 표시한다.
  // 서버도 /api/data/all 조회·저장을 동일 기준으로 제한한다.
  // 주의: 동기화(sync)에는 항상 전체 orders를 사용해야 다른 회원 데이터가 지워지지 않는다.
  const visibleOrders = useMemo(() => {
    if (isAdmin()) return orders;
    const phone = (getStoredUser()?.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return [];
    return orders.filter((o) => (o.phone || '').replace(/[^0-9]/g, '') === phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, loggedIn, myProfile.phone]);
  const visibleOrdersRef = useRef(visibleOrders);
  useEffect(() => { visibleOrdersRef.current = visibleOrders; }, [visibleOrders]);
  // 일반회원은 주문 등록/수정 시 연락처가 본인 계정 번호로 고정된다
  function myAccountPhone() {
    if (isAdmin()) return '';
    return (getStoredUser()?.phone || '').replace(/[^0-9]/g, '');
  }
  const productsRef = useRef(products);
  useEffect(() => { productsRef.current = products; }, [products]);

  // 다른 기기에서 고객/갤러리/관리자 데이터가 바뀌었을 때 해당 화면을 갱신하는 신호
  const [customersRefresh, setCustomersRefresh] = useState(0);
  const [galleryRefresh, setGalleryRefresh] = useState(0);
  const [adminRefresh, setAdminRefresh] = useState(0);

  // ===== 현장수령 예약시간 알림 =====
  // - 수령 날짜가 없거나 준비일로 남아 있으면 '오늘'로 간주해서
  //   사용자가 원하는 팝업 알림이 확실히 뜨도록 한다.
  // - 예약시간으로부터 1시간 동안은 배너가 계속 표시된다(새로고침/재접속필도 유지).
  // - '확인'을 누르면 이번 실행(세션) 동안만 숨기고, 앱을 다시 열면 다시 표시된다.
  //   (기존에는 한 번 알리면 영구히 다시 뜨지 않아 앱에서 문구가 보이지 않는 문제가 있었다.)
  const [pickupAlerts, setPickupAlerts] = useState<{ key: string; id: string; name: string; time: string }[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set(load<string[]>('jc_notified_v1', [])));
  const dismissedRef = useRef<Set<string>>(new Set());

  // 시스템 알림을 쓸 수 없는 앱(웹뷰) 환경에서도 들리도록 짧은 비프음 재생
  function playAlertBeep() {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = 880;
        const t = ctx.currentTime + i * 0.35;
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.exponentialRampToValueAtTime(0.4, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.32);
      }
      osc_cleanup(ctx);
    } catch { /* 미지원 환경 무시 */ }
  }
  function osc_cleanup(ctx: AudioContext) {
    setTimeout(() => { void ctx.close().catch(() => undefined); }, 2000);
  }

  useEffect(() => {
    function check() {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`;
      const due: { key: string; id: string; name: string; time: string }[] = [];
      for (const o of visibleOrdersRef.current) {
        if (o.status !== '현장수령' || !o.reservationTime) continue;
        // 예약 날짜 우선, 없으면 수령일, 둘 다 유효하지 않으면 오늘로 대체
        const rawDay = /^\d{4}-\d{2}-\d{2}$/.test(o.reservationDate || '')
          ? o.reservationDate!
          : /^\d{4}-\d{2}-\d{2}$/.test(o.pickupDate || '')
            ? o.pickupDate
            : today;
        const target = new Date(`${rawDay}T${o.reservationTime}:00`);
        if (isNaN(target.getTime())) continue;
        const diff = now.getTime() - target.getTime();
        // 예약시간이 지났고 1시간 이내인 경우에만 알림
        if (diff < 0 || diff > 60 * 60 * 1000) continue;
        const key = `${o.id}:${rawDay}:${o.reservationTime}`;
        due.push({ key, id: o.id, name: o.name, time: o.reservationTime });
      }
      // 배너는 1시간 윈도우 남아 있는 동안 계속 표시 (세션에서 '확인' 누른 것만 숨김)
      setPickupAlerts(due.filter((d) => !dismissedRef.current.has(d.key)));
      // 소리/진동/시스템 알림은 새로 도래한 건에 대해 1번만
      const fresh = due.filter((d) => !notifiedRef.current.has(d.key));
      if (fresh.length > 0) {
        for (const d of fresh) notifiedRef.current.add(d.key);
        save('jc_notified_v1', [...notifiedRef.current]);
        for (const a of fresh) {
          // 시스템 알림 (권한이 허용된 경우) — 앱 화면 배너는 항상 표시됨
          try {
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('⏰ 현장수령 예약 시간', {
                body: `${a.name} 고객 현장수령 예약시간(${a.time})이 되었습니다.`,
                tag: `pickup-${a.id}`,
              });
            }
          } catch { /* 미지원 환경 무시 */ }
        }
        try { navigator.vibrate?.([300, 100, 300]); } catch { /* 무시 */ }
        playAlertBeep();
      }
    }
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, []);

  async function enableNotifications() {
    if (!('Notification' in window)) {
      alert('이 기기/앱에서는 시스템 알림을 지원하지 않습니다.\n앱 화면 내 알림 배너로 표시됩니다.');
      return;
    }
    if (Notification.permission === 'granted') {
      alert('알림이 이미 켜져 있습니다. 현장수령 예약시간이 되면 알림이 옵니다.');
      return;
    }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      alert('알림이 켜졌습니다. 현장수령 예약시간이 되면 알림이 옵니다.');
    } else {
      alert('알림 권한이 거부되었습니다. 브라우저/앱 설정에서 알림을 허용해주세요.');
    }
  }

  useEffect(() => {
    if (!loggedIn) return;
    const close = subscribeEvents((key) => {
      if (key === 'intake') {
        void mergeCustomerIntake(products, appendIntakeOrders);
        return;
      }
      if (key === 'payment') {
        void syncPayments();
        return;
      }
      // 갤러리는 서버 기준 저장 방식: 서버에서 다시 불러오라고 화면에 신호만 보냄
      if (key === 'gallery' || key === 'gallery_notice') {
        setGalleryRefresh((v) => v + 1);
        return;
      }
      // 고객도 서버 기준: 고객 관리 화면이 서버에서 다시 불러오도록 신호만 보냄
      if (key === 'customers') {
        setCustomersRefresh((v) => v + 1);
        return;
      }
      const lsKey = SYNC_KEYS[key];
      if (!lsKey) return;
      // 아직 서버로 못 보낸 로컬 수정이 있으면 병합 동기화를 즉시 실행한다
      // (기존에는 무시했지만, 그러면 다른 기기 변경이 이 기기에 늦게/안 반영됨)
      let raw: string | null = null;
      if (key === 'orders') raw = JSON.stringify(ordersRef.current ?? []);
      else if (key === 'products') raw = JSON.stringify(productsRef.current ?? []);
      else raw = localStorage.getItem(lsKey);
      if (raw != null && lastSyncedRef.current[key] !== raw) {
        scheduleEventSync();
        return;
      }
      void (async () => {
        try {
          const all = await fetchAllAppData();
          if (!all) return;
          const serverValue = (all as any)[key];
          if (serverValue === undefined || serverValue === null) return;
          if (lastSyncedRef.current[key] === JSON.stringify(serverValue)) return;
          applyServerValue(key, serverValue);
        } catch { /* 무시 */ }
      })();
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, appendIntakeOrders, syncPayments]);

  const filtered = useMemo(() => {
    const term = search.trim();
    return visibleOrders
      .filter((o) => {
        if (filter === '전체') return true;
        if (filter === '미납' || filter === '부분납' || filter === '완납') {
          return getPaymentStatus(o) === filter;
        }
        return o.status === filter;
      })
      .filter((o) =>
        term
          ? o.name.includes(term) ||
            o.phone.includes(term) ||
            o.cabbageType.includes(term) ||
            o.memo.includes(term)
          : true
      )
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [visibleOrders, filter, search]);

  const photoModalOrder = useMemo(
    () => (photoModalOrderId ? orders.find((o) => o.id === photoModalOrderId) : undefined),
    [photoModalOrderId, orders]
  );

  // ===== 회원정보수정 모달 =====
  const openProfileModal = () => {
    setProfileError('');
    setProfileSuccess('');
    setProfileForm({ currentPassword: '', newPassword: '', confirmPassword: '', email: '', phone: '' });
    setIsProfileOpen(true);
    void (async () => {
      try {
        const info = await me();
        if (!info) return;
        const p = { id: info.id, email: info.email || '', phone: info.phone || '' };
        setMyProfile(p);
        setProfileForm((f) => ({ ...f, email: p.email, phone: p.phone }));
      } catch { /* 무시 */ }
    })();
  };

  const submitProfile = async () => {
    setProfileError('');
    setProfileSuccess('');
    const f = profileForm;
    if (!f.currentPassword) {
      setProfileError('현재 비밀번호를 입력해주세요.');
      return;
    }
    if (f.newPassword) {
      if (f.newPassword.length < 8 || !/[A-Za-z]/.test(f.newPassword) || !/[0-9]/.test(f.newPassword)) {
        setProfileError('새 비밀번호는 8자 이상이며 영문과 숫자를 포함해야 합니다.');
        return;
      }
      if (f.newPassword !== f.confirmPassword) {
        setProfileError('새 비밀번호가 서로 다릅니다.');
        return;
      }
    }
    const emailChanged = f.email.trim() !== myProfile.email;
    if (emailChanged && !/^\S+@\S+\.\S+$/.test(f.email.trim())) {
      setProfileError('올바른 이메일을 입력해주세요.');
      return;
    }
    const phoneDigits = f.phone.replace(/[^0-9]/g, '');
    if (f.phone.trim() && !/^01[016789][0-9]{7,8}$/.test(phoneDigits)) {
      setProfileError('올바른 핸드폰번호를 입력해주세요. (예: 01012345678)');
      return;
    }
    if (!f.newPassword && !emailChanged && phoneDigits === myProfile.phone) {
      setProfileError('변경할 항목이 없습니다.');
      return;
    }
    setProfileBusy(true);
    try {
      await updateServerAuth(f.currentPassword, '', f.newPassword, f.email.trim(), phoneDigits);
      setMyProfile((p) => ({ ...p, email: f.email.trim(), phone: phoneDigits }));
      const stored = getStoredUser();
      if (stored) setStoredUser({ ...stored, phone: phoneDigits });
      setProfileForm((prev) => ({ ...prev, currentPassword: '', newPassword: '', confirmPassword: '' }));
      setProfileSuccess('회원정보가 저장되었습니다. 다른 기기의 로그인은 해제됩니다.');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '회원정보 수정에 실패했습니다.');
    } finally {
      setProfileBusy(false);
    }
  };

  const visibleStatusList: OrderStatus[] = isAdmin()
    ? STATUS_LIST
    : ['접수', '준비중', '완료'];

  const summary = useMemo(() => {
    const activeOrders = visibleOrders.filter((o) => o.status !== '취소');
    const totalQuantity = activeOrders.reduce((sum, o) => sum + o.quantity, 0);
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalPrice, 0);
    const totalDeposit = activeOrders.reduce((sum, o) => sum + o.depositAmount, 0);
    const outstanding = totalRevenue - totalDeposit;
    const unpaidCount = activeOrders.filter((o) => getPaymentStatus(o) !== '완납').length;
    const byStatus = visibleStatusList.map((s) => ({
      status: s,
      count: visibleOrders.filter((o) => o.status === s).length,
    }));
    return { totalQuantity, totalRevenue, outstanding, unpaidCount, byStatus };
  }, [visibleOrders, visibleStatusList]);

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
    setQuantityDraft(String(emptyOrder.quantity));
    setEditingId(null);
    setLoadedCustomerId(null);
  }

  function openNewForm() {
    const pickupDate = getDefaultPickupDate(preparationDays);
    resetForm();
    const base = {
      ...emptyOrder,
      phone: myAccountPhone(),
      pickupDate,
      preparationDate: calcPreparationDate(pickupDate, preparationDays),
    };
    setForm(products.length > 0 ? applyProduct(products[0].id, base) : base);
    setIsFormOpen(true);
  }

  const formPhoneDigits = form.phone.replace(/\D/g, '');
  // 고객 자동완성/동기화는 서버(DB)의 최신 고객 목록을 사용한다
  const [serverCustomers, setServerCustomers] = useState<Customer[]>([]);
  const refreshServerCustomers = useCallback(async () => {
    if (!isLoggedIn() || !isAdmin()) return;
    try {
      const list = await fetchCustomers();
      if (Array.isArray(list)) setServerCustomers(list);
    } catch {
      // 서버 부재 시 무시
    }
  }, []);
  useEffect(() => {
    if (!loggedIn) return;
    refreshServerCustomers();
    const handler = () => refreshServerCustomers();
    window.addEventListener('jc-customers-updated', handler);
    return () => window.removeEventListener('jc-customers-updated', handler);
  }, [loggedIn, refreshServerCustomers]);
  const customerMatches = useMemo(() => {
    if (!isFormOpen || editingId || formPhoneDigits.length < 3) return [];
    return serverCustomers
      .filter((c) => c.phone.replace(/\D/g, '').includes(formPhoneDigits))
      .slice(0, 8);
  }, [isFormOpen, editingId, formPhoneDigits, serverCustomers]);

  const loadedCustomer = useMemo(
    () =>
      loadedCustomerId
        ? serverCustomers.find((c) => c.id === loadedCustomerId)
        : undefined,
    [loadedCustomerId, serverCustomers]
  );
  const loadedCustomerActive =
    !!loadedCustomer && loadedCustomer.phone.replace(/\D/g, '') === formPhoneDigits;
  const showCustomerSuggest = customerMatches.length > 0 && !loadedCustomerActive;

  function applyCustomer(customer: Customer) {
    setForm((prev) => {
      const quantity =
        customer.quantity && customer.quantity > 0 ? customer.quantity : prev.quantity;
      const nextPickup = customer.arrivalDate || prev.pickupDate;
      return {
        ...prev,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        memo: customer.memo || prev.memo,
        pickupDate: nextPickup,
        // 고객 선택으로 희망일이 채워지면 준비일도 함께 자동 설정
        preparationDate: prev.preparationDate || calcPreparationDate(nextPickup, preparationDays),
        quantity,
        totalPrice: calcTotal(quantity, prev.pricePerUnit),
      };
    });
    setQuantityDraft(String(customer.quantity && customer.quantity > 0 ? customer.quantity : form.quantity));
    setLoadedCustomerId(customer.id);
  }

  function syncLoadedCustomer() {
    if (!loadedCustomerId) return;
    const target = serverCustomers.find((c) => c.id === loadedCustomerId);
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
    if (Object.keys(patch).length > 0 && isAdmin()) {
      // 고객 정보 변경은 서버(DB)에 직접 반영
      updateCustomerApi(loadedCustomerId, patch).catch(() => {});
      setServerCustomers((prev) =>
        prev.map((c) => (c.id === loadedCustomerId ? { ...c, ...patch } : c))
      );
    }
  }

  function startEdit(order: Order) {
    setForm({ ...order });
    setQuantityDraft(String(order.quantity));
    setEditingId(order.id);
    setIsFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      alert('고객명을 입력해주세요.');
      return;
    }
    if (!form.phone.trim()) {
      alert('연락처를 입력해주세요.');
      return;
    }
    if (!form.cabbageType.trim()) {
      alert('품목을 선택해주세요.');
      return;
    }
    const quantity = Number(quantityDraft);
    if (!quantityDraft.trim() || !Number.isInteger(quantity) || quantity <= 0) {
      alert('수량을 1개 이상 입력해주세요.');
      return;
    }
    const totalPrice = calcTotal(quantity, form.pricePerUnit);
    const depositAmount = Math.min(totalPrice, Math.max(0, Number(form.depositAmount) || 0));
    const fullyPaid = totalPrice > 0 && depositAmount >= totalPrice;
    const payload = {
      ...form,
      phone: myAccountPhone() || form.phone,
      quantity,
      totalPrice,
      depositAmount,
      paid: fullyPaid,
      deposit: fullyPaid,
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
        if (status === '환불완료') {
          patch.depositAmount = 0;
          patch.deposit = false;
        }
        return { ...o, ...patch };
      })
    );
  }

  function updatePreparationDate(id: string, date: string) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, preparationDate: date } : o)));
  }

  function savePreparationDays(days: number) {
    setPreparationDays(days);
    save('jc_preparation_days', days);
    setOrders((prev) =>
      prev.map((order) => ({
        ...order,
        preparationDate: calcPreparationDate(order.pickupDate, days),
      }))
    );
  }

  function updateOrderFields(id: string, patch: Partial<Order>) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  function updateOwnOrderQuantity(id: string, quantity: number) {
    if (isAdmin()) return;
    const nextQuantity = Math.max(1, Math.floor(Number(quantity) || 0));
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const totalPrice = calcTotal(nextQuantity, o.pricePerUnit);
        const depositAmount = Math.min(o.depositAmount, totalPrice);
        const paid = totalPrice > 0 && depositAmount >= totalPrice;
        return { ...o, quantity: nextQuantity, totalPrice, depositAmount, paid, deposit: paid };
      })
    );
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
          paid: nextDeposit,
          depositAmount: nextDeposit ? o.totalPrice : 0,
        };
      })
    );
  }

  function updateDepositAmount(id: string, amount: number) {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const depositAmount = Math.min(Math.max(0, amount), Math.max(0, o.totalPrice));
        const fullyPaid = o.totalPrice > 0 && depositAmount >= o.totalPrice;
        return { ...o, depositAmount, deposit: fullyPaid, paid: fullyPaid };
      })
    );
  }

  function removeOrder(id: string) {
    if (confirm('이 주문을 삭제할까요?')) {
      // 서버(DB)에서 먼저 삭제한다. 삭제 기록(tombstone)이 남아
      // 다른 기기의 오래된 목록이 이 주문을 되살리지 못하게 한다.
      if (isLoggedIn() && isAdmin()) {
        deleteOrderApi(id)
          .then(() => {
            setOrders((prev) => prev.filter((o) => o.id !== id));
            window.dispatchEvent(new Event('jc-orders-updated'));
          })
          .catch((err) => alert(err.message || '주문 삭제에 실패했습니다.'));
        return;
      }
      setOrders((prev) => prev.filter((o) => o.id !== id));
    }
  }

  async function cancelOwnOrder(order: Order) {
    if (isAdmin() || order.status === '완료' || order.status === '취소') return;
    const warning =
      '주문을 취소하시겠습니까?\n\n카드결제 후 취소 시 환불까지 영업일 기준 7일 이상이 소요 될 수 있습니다';
    if (!confirm(warning)) return;
    try {
      const result = await cancelPublicOrder(order.id);
      const cancelled: Order = result?.order
        ? { ...order, ...result.order }
        : { ...order, status: '취소', statusMemo: '고객 요청으로 주문 취소' };
      setOrders((prev) => prev.map((o) => (o.id === order.id ? cancelled : o)));
    } catch (err: any) {
      alert(err?.message || '주문 취소에 실패했습니다.');
    }
  }

  const MAX_ORDER_PHOTOS = 5;

  function handlePrint(order: Order) {
    // 새 창에 영수증을 띄워 인쇄 (모바일/웹뷰에서도 동작)
    const w = window.open('', '_blank', 'width=420,height=680');
    if (w) {
      w.document.write(buildReceiptHtml(order));
      w.document.close();
      return;
    }
    // 팝업이 차단된 경우 현재 화면에서 인쇄
    setPrintOrder(order);
  }

  // 팝업 차단 폴백: 렌더링 완료 후 인쇄하고 afterprint 시 정리
  useEffect(() => {
    if (!printOrder) return;
    const timer = setTimeout(() => {
      const cleanup = () => setPrintOrder(null);
      window.addEventListener('afterprint', cleanup, { once: true });
      window.print();
      setTimeout(cleanup, 3000);
    }, 250);
    return () => clearTimeout(timer);
  }, [printOrder]);

  async function exportExcel() {
    // xlsx 라이브러리는 번들에서 분리해 엑셀 기능 사용 시에만 로드 (초기 로딩 속도 개선)
    const XLSX = await import('xlsx');
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
      주소: o.addressDetail ? `${o.address} ${o.addressDetail}` : o.address,
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

    for (const [index, row] of rows.entries()) {
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
        skipped.push(`전화번호 누락 (행 ${index + 1})`);
        continue;
      }

      const quantity = Number(quantityRaw) || 1;
      const pickup = normalizePickup(pickupText);
      const status = normalizeStatus(doneText);
      const pickupDate = parseKoreanDate(dateText);
      const deposit = isDoneStatus(doneText);

      const product = resolveProduct(products);
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
        // 엑셀 등록 시에도 희망일 기준 준비일 자동 설정 (4일 전)
        preparationDate: calcPreparationDate(pickupDate, preparationDays),
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
    reader.onload = async (event) => {
      try {
        const XLSX = await import('xlsx');
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

  async function copyOrderUrl(order: Order) {
    if (!isAdmin()) {
      alert('공유 링크는 관리자만 발급할 수 있습니다.');
      return;
    }
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

  async function sendOrderUrlBySms(order: Order) {
    if (!isAdmin()) {
      alert('주문 조회 문자 발송은 관리자만 사용할 수 있습니다.');
      return;
    }
    const phone = String(order.phone || '').replace(/\D/g, '');
    if (!/^0\d{8,10}$/.test(phone)) {
      alert('해당 주문에 유효한 연락처가 없습니다.');
      return;
    }
    const url = getOrderPublicUrl(order.id);
    try {
      if (!order.shared) {
        setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, shared: true } : o)));
      }
      await syncPublicOrder({ ...order, shared: true });
      const message = `[절임배추 주문관리]
${order.name || '고객'}님, 주문 조회 링크입니다.
주문: ${order.cabbageType} ${order.quantity}${order.unit}
링크: ${url}`;
      await sendSms([phone], message);
      alert(`${formatPhone(order.phone)}로 주문 조회 링크를 발송했습니다.`);
    } catch (err: any) {
      alert(`문자 발송에 실패했습니다.\n${err?.message || '문자 API 설정을 확인해주세요.'}`);
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

  if (params.get('register') === 'customer') {
    return <CustomerIntakeView />;
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
              <img src='/logo.webp' alt='도화 로고' width='64' height='64' />
            </span>
            <div className='brand-text'>
              <p className='eyebrow'>도화유통</p>
              <h1>
                {page === 'dashboard'
                  ? '대시보드'
                  : page === 'orders'
                  ? '주문 관리'
                  : page === 'customers'
                  ? '고객 관리'
                  : page === 'gallery'
                  ? '사진 등록'
                  : page === 'materials'
                  ? '자재·매출 관리'
                  : '관리자 설정'}
              </h1>
            </div>
          </button>
          <div className='header-actions'>
            <div className='menu-wrap'>
              <button
                className={`btn ${isMenuOpen ? 'active' : ''}`}
                onClick={() => setIsMenuOpen((v) => !v)}
                title='더보기 메뉴'
              >
                ☰ 메뉴
              </button>
              {isMenuOpen && (
                <>
                  <div className='menu-backdrop' onClick={() => setIsMenuOpen(false)} />
                  <div className='menu-dropdown' role='menu'>
                    {isAdmin() && (
                      <>
                        <button
                          className='menu-item'
                          onClick={() => { setIsMenuOpen(false); setPage('gallery'); }}
                        >
                          🖼 사진등록
                        </button>
                        <button
                          className='menu-item'
                          onClick={() => { setIsMenuOpen(false); setPage('materials'); }}
                        >
                          📦 자재/매출
                        </button>
                        <button
                          className='menu-item'
                          onClick={() => { setIsMenuOpen(false); setIsSettingsOpen(true); }}
                        >
                          ⚙️ 품목/단가 설정
                        </button>
                        <button
                          className='menu-item'
                          onClick={() => { setIsMenuOpen(false); setIsAccountModalOpen(true); }}
                        >
                          🏦 계좌번호 설정
                        </button>
                        <div className='menu-divider' />
                      </>
                    )}
                    <button
                      className='menu-item'
                      onClick={() => { setIsMenuOpen(false); openProfileModal(); }}
                    >
                      👤 회원정보 수정
                    </button>
                    <button
                      className='menu-item'
                      onClick={() => { setIsMenuOpen(false); enableNotifications(); }}
                    >
                      🔔 수령시간 알림 켜기
                    </button>
                    <div className='menu-divider' />
                    <button
                      className='menu-item menu-item-danger'
                      onClick={() => { setIsMenuOpen(false); handleLogout(); }}
                    >
                      로그아웃
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {pickupAlerts.length > 0 && (
          <div className='pickup-alert-banner' role='alert'>
            <span>
              ⏰ <strong>{pickupAlerts[0].name}</strong> 고객 현장수령 예약시간(
              {pickupAlerts[0].time})이 되었습니다.
              {pickupAlerts.length > 1 ? ` 외 ${pickupAlerts.length - 1}건` : ''}
            </span>
            <button
              className='btn'
              onClick={() => {
                for (const a of pickupAlerts) dismissedRef.current.add(a.key);
                setPickupAlerts([]);
              }}
            >
              확인
            </button>
          </div>
        )}

        {isAdmin() && mustChangePassword() && (
          <div className='security-banner' role='alert'>
            <span>
              ⚠ 관리자 계정이 기본 비밀번호(0000)를 사용 중입니다. 외부에 공개된 서버이므로
              지금 바로 변경해주세요.
            </span>
            <button className='btn' onClick={() => { setPage('admin'); setAdminRefresh((n) => n + 1); }}>
              비밀번호 변경하기
            </button>
          </div>
        )}

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

        {isProfileOpen && (
          <div
            className='modal-overlay'
            onClick={(e) => e.target === e.currentTarget && setIsProfileOpen(false)}
          >
            <div className='modal panel account-modal'>
              <div className='modal-header'>
                <h2>회원정보수정</h2>
                <button className='btn icon' onClick={() => setIsProfileOpen(false)}>
                  ✕
                </button>
              </div>
              <p className='panel-hint'>
                아이디: <strong>{myProfile.id}</strong> — 수정 내용 저장 시 현재 비밀번호 확인이 필요합니다.
              </p>
              <label>
                이메일
                <input
                  type='email'
                  className='input'
                  value={profileForm.email}
                  onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                  placeholder='example@email.com'
                />
              </label>
              <label>
                핸드폰번호 (비밀번호 초기화 문자 수신용)
                <input
                  type='tel'
                  className='input'
                  value={profileForm.phone}
                  onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                  placeholder='01012345678'
                />
              </label>
              <label>
                새 비밀번호 (변경 시에만 입력)
                <input
                  type='password'
                  className='input'
                  value={profileForm.newPassword}
                  onChange={(e) => setProfileForm({ ...profileForm, newPassword: e.target.value })}
                  placeholder='8자 이상, 영문+숫자 포함'
                />
              </label>
              {profileForm.newPassword && (
                <label>
                  새 비밀번호 확인
                  <input
                    type='password'
                    className='input'
                    value={profileForm.confirmPassword}
                    onChange={(e) => setProfileForm({ ...profileForm, confirmPassword: e.target.value })}
                    placeholder='새 비밀번호를 다시 입력'
                  />
                </label>
              )}
              <label>
                현재 비밀번호 (필수)
                <input
                  type='password'
                  className='input'
                  value={profileForm.currentPassword}
                  onChange={(e) => setProfileForm({ ...profileForm, currentPassword: e.target.value })}
                  placeholder='본인 확인을 위해 입력'
                />
              </label>
              {profileError && <p className='form-error'>{profileError}</p>}
              {profileSuccess && <p className='form-success'>{profileSuccess}</p>}
              <div className='form-actions'>
                <button type='button' className='btn' onClick={() => setIsProfileOpen(false)}>
                  닫기
                </button>
                <button
                  type='button'
                  className='btn btn-primary'
                  onClick={() => void submitProfile()}
                  disabled={profileBusy}
                >
                  {profileBusy ? '저장 중...' : '저장'}
                </button>
              </div>
            </div>
          </div>
        )}

        <>
        {page === 'dashboard' ? (
          <Dashboard
            orders={visibleOrders}
            products={products}
            preparationDays={preparationDays}
            canEditPreparation={isAdmin()}
            onSavePreparationDays={savePreparationDays}
            onNavigate={(p) => setPage(p)}
            onStatusFilter={(status) => setFilter(status as typeof filter)}
          />
        ) : page === 'customers' && isAdmin() ? (
          <>
            <Customers orders={orders} refreshSignal={customersRefresh} onOpenSms={(selected) => { setSmsCustomers(selected); setIsSmsOpen(true); }} />
            {isSmsOpen && isAdmin() && <SmsModal orders={orders} customers={smsCustomers} onClose={() => setIsSmsOpen(false)} />}
          </>
        ) : page === 'gallery' && isAdmin() ? (
          <Gallery refreshSignal={galleryRefresh} />
        ) : page === 'materials' && isAdmin() ? (
          <Materials orders={orders} />
        ) : page === 'admin' && isAdmin() ? (
          <Admin
            orders={orders}
            refreshSignal={adminRefresh}
            onOpenSms={() => {
              setPage('orders');
              setSmsCustomers(null);
              setIsSmsOpen(true);
            }}
            onOpenSalesStats={() => {
              setPage('orders');
              setIsSalesStatsOpen(true);
            }}
            onOpenPayment={() => setIsPaymentOpen(true)}
          />
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
              <div
                className={`summary-card outstanding ${summary.unpaidCount > 0 ? 'alert' : ''}`}
              >
                <span className='summary-label'>
                  {summary.unpaidCount > 0 ? `입금금액 / 미납 ${summary.unpaidCount}건` : '입금완료'}
                </span>
                <span className='summary-count'>
                  {summary.unpaidCount > 0 ? formatCurrency(summary.outstanding) : '입금완료'}
                </span>
              </div>
            </section>

            {isAdmin() && <section className='toolbar'>
              <input
                type='text'
                className='input search'
                placeholder='이름, 연락처, 품종, 메모 검색'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className='select' value={filter} onChange={(e) => setFilter(e.target.value as OrderStatus | '전체')}>
                <option value='전체'>전체 상태</option>
                {visibleStatusList.map((s) => (
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
            </section>}

            {isFormOpen && (
              <section className='panel form-panel'>
                <h2>{editingId ? '주문 수정' : '새 주문 등록'}</h2>
                <form onSubmit={handleSubmit}>
                  <div className='form-grid'>
                    <label>
                      고객명 (필수)
                      <input
                        className='input'
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder='고객명'
                      />
                    </label>
                    <label className='phone-field'>
                      연락처
                      <input
                        className='input'
                        type='tel'
                        value={form.phone}
                        disabled={!isAdmin() && !!myAccountPhone()}
                        title={!isAdmin() ? '일반회원은 계정에 등록된 연락처로 고정됩니다.' : undefined}
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
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({formatCurrency(p.price)}/{p.unit})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      수량
                      <div className='quantity-row'>
                        <input
                          className='input'
                          type='number'
                          min={1}
                          value={quantityDraft}
                          onChange={(e) => {
                            const value = e.target.value;
                            setQuantityDraft(value);
                            const quantity = Number(value);
                            if (value.trim() && Number.isInteger(quantity) && quantity > 0) {
                              setForm((prev) => ({
                                ...prev,
                                quantity,
                                totalPrice: calcTotal(quantity, prev.pricePerUnit),
                              }));
                            }
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
                      <input
                        className='input'
                        readOnly
                        value={formatCurrency(calcTotal(form.quantity, form.pricePerUnit))}
                      />
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
                      잔액
                      <input
                        className='input'
                        readOnly
                        value={formatCurrency(Math.max(0, calcTotal(form.quantity, form.pricePerUnit) - form.depositAmount))}
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
                          setForm((prev) => {
                            // 희망일 변경 시 준비일 자동 갱신 (4일 전)
                            // 단, 사용자가 준비일을 직접 수정한 값이면 덮어쓰지 않음
                            const auto = calcPreparationDate(pickupDate, preparationDays);
                            const prevAuto = calcPreparationDate(prev.pickupDate || '', preparationDays);
                            const wasAutoOrEmpty =
                              !prev.preparationDate || prev.preparationDate === prevAuto;
                            return {
                              ...prev,
                              pickupDate,
                              preparationDate: wasAutoOrEmpty ? auto : prev.preparationDate,
                            };
                          });
                        }}
                      />
                    </label>
                    {isAdmin() && (
                      <label>
                        준비일 (희망일 기준 자동 입력)
                        <input
                          className='input'
                          type='date'
                          value={form.preparationDate}
                          onChange={(e) => setForm({ ...form, preparationDate: e.target.value })}
                        />
                      </label>
                    )}
                    {form.pickup === '배송' && (
                      <>
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
                      <label className='full'>
                        상세 주소 (수동 입력)
                        <input
                          className='input'
                          value={form.addressDetail || ''}
                          onChange={(e) => setForm({ ...form, addressDetail: e.target.value })}
                          placeholder='동/호수, 건물명 등 상세주소를 입력하세요'
                          autoComplete='off'
                        />
                      </label>
                      </>
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
                          {order.status !== '접수' && isAdmin() && (
                            <input
                              type='date'
                              className='input prep-date'
                              value={order.preparationDate || ''}
                              onChange={(e) => updatePreparationDate(order.id, e.target.value)}
                              title='준비일'
                            />
                          )}
                          <span className={`tag payment-${payment}`}>{payment}</span>
                          {order.status === '환불완료' && (
                            <span className='refund-badge'>환불완료</span>
                          )}
                        </div>
                        <div className='order-actions'>
                          <button className='btn icon' onClick={() => handlePrint(order)} title='영수증 인쇄'>
                            🖨
                          </button>
                          {isAdmin() && (
                            <button
                              className={`btn icon refund-icon ${order.status === '환불완료' ? 'done' : ''}`}
                              onClick={() => {
                                if (order.status === '환불완료') return;
                                if (window.confirm('환불 완료 처리하시겠습니까?')) {
                                  updateStatus(order.id, '환불완료');
                                }
                              }}
                              title={order.status === '환불완료' ? '환불 완료됨' : '환불 완료 처리'}
                            >
                              💸
                            </button>
                          )}
                          {isAdmin() && (
                            <button className='btn icon' onClick={() => sendOrderUrlBySms(order)} title='주문 조회 링크 문자 발송'>
                              📱
                            </button>
                          )}
                          {isAdmin() && order.status === '준비중' && (
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
                          {isAdmin() && STATUS_FLOW[order.status] && (
                            <button
                              className='btn status-next-btn'
                              onClick={() => updateStatus(order.id, STATUS_FLOW[order.status]!)}
                              title='다음 단계로 진행'
                            >
                              → {STATUS_FLOW[order.status]}
                            </button>
                          )}
                          {isAdmin() && <select
                            className='select status-select'
                            value={order.status}
                            onChange={(e) => updateStatus(order.id, e.target.value as OrderStatus)}
                          >
                            {STATUS_LIST.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>}
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
                            {isAdmin() ? (
                              `${order.quantity} ${order.unit}`
                            ) : (
                              <label className='quantity-edit'>
                                수량
                                <input
                                  className='input quantity-input'
                                  type='number'
                                  min={1}
                                  step={1}
                                  value={order.quantity}
                                  onChange={(e) => updateOwnOrderQuantity(order.id, Number(e.target.value))}
                                  aria-label='주문 수량'
                                />
                                {order.unit}
                              </label>
                            )}
                          </span>
                          <span className='tag'>{formatCurrency(order.pricePerUnit)}</span>
                          <span className='tag highlight'>{formatCurrency(order.totalPrice)}</span>
                          <span className='tag'>{order.pickup}</span>
                          {order.address && (
                            <span className='tag'>
                              {order.address}
                              {order.addressDetail ? ` ${order.addressDetail}` : ''}
                            </span>
                          )}
                          {order.courier && <span className='tag'>{order.courier}</span>}
                          {order.trackingNumber && (
                            <span className='tag highlight'>운송장 {order.trackingNumber}</span>
                          )}
                        </div>
                        <div className='payment-row'>
                          <label className='deposit-label'>
                            입금액
                            {isAdmin() && <input
                              type='number'
                              className='input deposit-input'
                              min={0}
                              step={1000}
                              value={order.depositAmount}
                              onChange={(e) => updateDepositAmount(order.id, Math.max(0, Number(e.target.value)))}
                            />}
                          </label>
                          <span className='deposit-display'>입금액: {formatCurrency(order.depositAmount)}</span>
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
                        {isAdmin() && <button
                          type='button'
                          className={`btn deposit-toggle ${order.deposit ? 'paid' : ''}`}
                          onClick={() => toggleDeposit(order.id)}
                        >
                          {order.deposit ? '✓ 완납 완료' : '완납 처리'}
                        </button>}
                        {isAdmin() && (
                          <button
                            type='button'
                            className={`btn refund-toggle ${order.status === '환불완료' ? 'done' : ''}`}
                            onClick={() => {
                              if (order.status === '환불완료') return;
                              if (window.confirm('환불 완료 처리하시겠습니까?')) {
                                updateStatus(order.id, '환불완료');
                              }
                            }}
                          >
                            {order.status === '환불완료' ? '✓ 환불 완료' : '환불 완료'}
                          </button>
                        )}
                        {!isAdmin() && order.status !== '완료' && order.status !== '취소' && order.status !== '환불완료' && (
                          <button
                            type='button'
                            className='btn order-cancel-button'
                            onClick={() => cancelOwnOrder(order)}
                          >
                            주문 취소
                          </button>
                        )}
                        <span className='created'>접수일: {formatDate(order.createdAt)}</span>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          </>
        )}
        </>

        {isSettingsOpen && isAdmin() && (
          <ProductSettingsModal
            products={products}
            onChange={setProducts}
            onClose={() => setIsSettingsOpen(false)}
          />
        )}
        {isPaymentOpen && isAdmin() && <PaymentModal orders={orders} products={products} onChange={setOrders} onClose={() => setIsPaymentOpen(false)} />}
        {isSmsOpen && isAdmin() && <SmsModal orders={orders} customers={smsCustomers} onClose={() => setIsSmsOpen(false)} />}
        {isSalesStatsOpen && isAdmin() && <SalesStatsModal orders={orders} onClose={() => setIsSalesStatsOpen(false)} />}
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

      {page === 'orders' && (
        <button className='fab' onClick={openNewForm}>
          ＋ 새 주문
        </button>
      )}

      <nav className='bottom-nav' aria-label='주요 메뉴'>
        <button
          className={page === 'dashboard' ? 'on' : ''}
          aria-current={page === 'dashboard' ? 'page' : undefined}
          onClick={() => setPage('dashboard')}
        >
          🏠<span>홈</span>
        </button>
        <button
          className={page === 'orders' ? 'on' : ''}
          aria-current={page === 'orders' ? 'page' : undefined}
          onClick={() => setPage('orders')}
        >
          📋<span>주문</span>
        </button>
        {isAdmin() && (
          <button
            className={page === 'customers' ? 'on' : ''}
            aria-current={page === 'customers' ? 'page' : undefined}
            onClick={() => setPage('customers')}
          >
            👥<span>고객</span>
          </button>
        )}
        {isAdmin() && (
          <button
            className={page === 'admin' ? 'on' : ''}
            aria-current={page === 'admin' ? 'page' : undefined}
            onClick={() => { setPage('admin'); setAdminRefresh((n) => n + 1); }}
          >
            ⚙️<span>관리</span>
          </button>
        )}
      </nav>
    </main>
  );
}

function personalizeMessage(template: string, recipient: Order | Customer) {
  const order = recipient as Order;
  const customer = recipient as Customer;
  const balance = (order.totalPrice || 0) - (order.depositAmount || 0);
  const trackingText =
    order.courier && order.trackingNumber
      ? `${order.courier} ${order.trackingNumber}`
      : order.trackingNumber || order.courier || '';
  return template
    .split('{이름}').join(`${recipient.name} 고객님`)
    .split('{품목}').join(order.cabbageType || '')
    .split('{수량}').join(order.quantity ? `${order.quantity}${order.unit || '개'}` : '')
    .split('{금액}').join(Number.isFinite(balance) ? `미수금 ${formatCurrency(balance)}` : '')
    .split('{잔액}').join(Number.isFinite(balance) ? `잔액 ${formatCurrency(balance)}` : '')
    .split('{입금액}').join(order.depositAmount ? formatCurrency(order.depositAmount) : '')
    .split('{수령일}').join(formatDate(order.pickupDate || customer.arrivalDate || ''))
    .split('{주문URL}').join(order.id ? getOrderPublicUrl(order.id) : '')
    .split('{택배사}').join(order.courier || '')
    .split('{운송장번호}').join(trackingText)
    .split('{계좌번호}').join(getStoredAccountNumber() || '');
}

function escapeHtml(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 영수증 인쇄용 독립 HTML (새 창에서 인쇄 대화상자가 뜨고, 버튼으로 재인쇄도 가능)
function buildReceiptHtml(order: Order) {
  const balance = order.totalPrice - order.depositAmount;
  const line = (label: string, value: string, strong = false) =>
    `<div class="line${strong ? ' strong' : ''}"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  const optional = (label: string, v?: string) => (v ? line(label, v) : '');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>영수증 - ${escapeHtml(order.name)}</title>
<style>
  @font-face { font-family: 'PretendardPrint'; src: url('/fonts/Pretendard-Regular.woff2') format('woff2'); font-weight: 400; font-display: swap; }
  @font-face { font-family: 'PretendardPrint'; src: url('/fonts/Pretendard-Bold.woff2') format('woff2'); font-weight: 700; font-display: swap; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 12px; background: #fff; color: #000;
    font-family: 'PretendardPrint', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; }
  .receipt { max-width: 80mm; margin: 0 auto; font-size: 13px; line-height: 1.6; }
  h2 { text-align: center; font-size: 17px; margin: 0 0 14px; }
  .line { display: flex; justify-content: space-between; gap: 12px;
    border-bottom: 1px dashed #999; padding: 4px 0; }
  .line span:first-child { flex-shrink: 0; }
  .line span:last-child { text-align: right; word-break: break-all; }
  .line.strong { font-weight: 700; }
  .thanks { text-align: center; margin-top: 16px; }
  .print-btn { display: block; width: 100%; max-width: 80mm; margin: 18px auto 0;
    padding: 10px; font-size: 15px; font-weight: 700; background: #166534;
    color: #fff; border: 0; border-radius: 8px; cursor: pointer; }
  @media print { .print-btn { display: none; } }
  @page { margin: 8mm; }
</style>
</head>
<body onload="setTimeout(function(){ try { window.print(); } catch (e) {} }, 350)">
  <div class="receipt">
    <h2>절임배추 주문 영수증</h2>
    ${line('주문일', formatDate(order.createdAt))}
    ${line('고객명', order.name)}
    ${line('연락처', order.phone || '-')}
    ${line('품목', order.cabbageType)}
    ${line('수량', `${order.quantity} ${order.unit}`)}
    ${line('단가', formatCurrency(order.pricePerUnit))}
    ${line('총액', formatCurrency(order.totalPrice), true)}
    ${line('입금액', formatCurrency(order.depositAmount))}
    ${line('잔액', formatCurrency(balance), true)}
    ${line('수령방식', order.pickup)}
    ${optional('수령희망일', order.pickupDate ? formatDate(order.pickupDate) : '')}
    ${optional('주소', order.addressDetail ? `${order.address} ${order.addressDetail}` : order.address)}
    ${optional('택배사', order.courier)}
    ${optional('운송장번호', order.trackingNumber)}
    ${optional('메모', order.memo)}
    ${line('입금상태', getPaymentStatus(order))}
    ${order.status === '환불완료' ? line('환불상태', '환불완료', true) : ''}
    <p class="thanks">이용해주셔서 감사합니다.</p>
  </div>
  <button class="print-btn" onclick="window.print()">🖨️ 인쇄하기</button>
</body>
</html>`;
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
      {isAdmin() && order.preparationDate && (
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
          <span>
            {order.address}
            {order.addressDetail ? ` ${order.addressDetail}` : ''}
          </span>
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
      {order.status === '환불완료' && (
        <div className='receipt-line strong'>
          <span>환불상태</span>
          <span>환불완료</span>
        </div>
      )}
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
  const [progress, setProgress] = useState('');
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
      // 한 장씩 순차 처리 (스마트폰에서 동시 처리 시 메모리 부족으로 실패하는 것 방지)
      const { images, errors } = await compressImages(targets, (done, total) =>
        setProgress(`사진 처리 중... (${done}/${total})`)
      );
      setProgress('');
      if (images.length > 0) {
        setPhotos((prev) => [...prev, ...images]);
      }
      if (errors.length > 0) {
        alert(`일부 사진을 등록하지 못했습니다.\n${errors.join('\n')}`);
      }
    } catch (err: any) {
      setProgress('');
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
        {progress && <p className='photo-modal-sub'>{progress}</p>}
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
  const [reservationDate, setReservationDate] = useState(
    order.reservationDate || order.pickupDate || ''
  );
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
          <>
            <label>
              예약 날짜
              <input
                className='input'
                type='date'
                value={reservationDate}
                onChange={(e) => setReservationDate(e.target.value)}
              />
            </label>
            <label>
              예약 시간
              <input
                className='input'
                type='time'
                value={reservationTime}
                onChange={(e) => setReservationTime(e.target.value)}
              />
            </label>
          </>
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
                : { reservationDate, reservationTime, statusMemo }
            )
          }
        >
          저장
        </button>
      </div>
    </div>
  );
}

// 공개 고객 자가등록 폼 (?register=customer) - 로그인 없이 접근 가능
function CustomerIntakeView() {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    address: '',
    addressDetail: '',
    memo: '',
    arrivalDate: '',
    quantity: '',
  });
  const [receiveMethod, setReceiveMethod] = useState<'방문' | '배송' | '택배'>('방문');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [isPostcodeOpen, setIsPostcodeOpen] = useState(false);
  const postcodeWrapRef = useRef<HTMLDivElement>(null);

  function loadPostcodeScript(): Promise<any> {
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      alert('고객명을 입력해주세요.');
      return;
    }
    if (!form.phone.trim()) {
      alert('연락처를 입력해주세요.');
      return;
    }
    if (!form.arrivalDate) {
      alert('도착 예정일을 선택해주세요.');
      return;
    }
    const quantity = Number(form.quantity);
    if (!form.quantity.trim() || !Number.isInteger(quantity) || quantity <= 0) {
      alert('수량을 1개 이상 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      await submitPublicCustomer({
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        addressDetail: form.addressDetail.trim(),
        memo: form.memo.trim(),
        arrivalDate: form.arrivalDate || undefined,
        quantity,
        receiveMethod,
      });
      setDone(true);
    } catch (err: any) {
      alert(err?.message || '접수에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className='app-shell'>
        <div className='container'>
          <div className='panel public-order'>
            <h2>접수 완료</h2>
            <p className='empty'>
              정보가 정상적으로 접수되었습니다.
              <br />
              감사합니다.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='app-shell'>
      <div className='container'>
        <section className='panel form-panel'>
          <h2>고객 정보 등록</h2>
          <p className='panel-hint'>
            아래 양식을 입력하고 [완료] 버튼을 눌러주세요. 고객명, 연락처, 도착 예정일, 수량은 필수입니다.
          </p>
          <form onSubmit={handleSubmit}>
            <div className='form-grid'>
              <label>
                고객명
                <input
                  className='input'
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder='고객명'
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
                도착 예정일
                <input
                  className='input'
                  type='date'
                  required
                  value={form.arrivalDate}
                  onChange={(e) => setForm({ ...form, arrivalDate: e.target.value })}
                />
              </label>
              <label>
                수량
                <input
                  className='input'
                  type='number'
                  required
                  min={1}
                  step={1}
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  placeholder='주문 수량'
                />
              </label>
              <label className='full'>
                수령 방법
                <div className='address-row'>
                  {(['방문', '배송', '택배'] as const).map((m) => (
                    <button
                      key={m}
                      type='button'
                      className={`btn status-choice-btn ${m === '택배' ? 'courier' : 'visit'}`}
                      style={
                        receiveMethod === m
                          ? { outline: '2px solid #166534', outlineOffset: '1px' }
                          : { opacity: 0.55 }
                      }
                      onClick={() => setReceiveMethod(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
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
                <input
                  className='input'
                  value={form.addressDetail}
                  onChange={(e) => setForm({ ...form, addressDetail: e.target.value })}
                  placeholder='동/호수, 건축물명 등 상세주소를 입력하세요'
                  style={{ marginTop: 8 }}
                />
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
              <button type='submit' className='btn btn-primary' disabled={submitting}>
                {submitting ? '접수 중...' : '완료'}
              </button>
            </div>
          </form>
        </section>

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
      </div>
    </div>
  );
}

// 토스페이먼츠 클라이언트 키 (공개 브라우저 설정값)
// 빌드 시 VITE_TOSS_CLIENT_KEY 환경변수로 주입된다. 소스에 키 값을 직접 쓰지 않는다.
const TOSS_CLIENT_KEY = (import.meta.env.VITE_TOSS_CLIENT_KEY as string) || '';

function loadTossScript(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).TossPayments) {
      resolve((window as any).TossPayments);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.tosspayments.com/v2/standard';
    script.async = true;
    script.onload = () => resolve((window as any).TossPayments);
    script.onerror = () => reject(new Error('결제 모듈을 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
}

function PublicOrderView({ orderId, localOrder }: { orderId: string; localOrder?: Order }) {
  const [order, setOrder] = useState<Order | undefined>(localOrder);
  const [checked, setChecked] = useState(false);
  const [payMessage, setPayMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [payLoading, setPayLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  // 결제 완료/실패 후 리다이렉트 처리 (토스가 URL에 결과 파라미터를 붙여 돌려볼냄)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentKey = params.get('paymentKey');
    const payOrderId = params.get('orderId');
    const amount = Number(params.get('amount'));
    const failMessage = params.get('message');
    const cleanUrl = () => {
      const url = new URL(window.location.href);
      ['paymentKey', 'orderId', 'amount', 'code', 'message', 'paymentType'].forEach((k) =>
        url.searchParams.delete(k)
      );
      window.history.replaceState({}, '', url.toString());
    };
    if (paymentKey && payOrderId === orderId && amount > 0) {
      setPayLoading(true);
      setPayMessage({ kind: 'info', text: '결제를 확인하는 중입니다...' });
      confirmPublicPayment(paymentKey, payOrderId, amount)
        .then(async (result) => {
          cleanUrl();
          if (result?.waitingDeposit) {
            setPayMessage({ kind: 'info', text: '가상계좌가 발급되었습니다. 아래 계좌로 입금해주세요.' });
          } else {
            setPayMessage({ kind: 'info', text: '결제가 완료되었습니다. 감사합니다.' });
          }
          const remote = await fetchPublicOrder(orderId).catch(() => null);
          if (remote) setOrder(remote);
        })
        .catch((err) => {
          cleanUrl();
          setPayMessage({ kind: 'error', text: err?.message || '결제 승인에 실패했습니다.' });
        })
        .finally(() => setPayLoading(false));
    } else if (failMessage) {
      setPayMessage({ kind: 'error', text: `결제가 취소되었습니다. (${failMessage})` });
      cleanUrl();
    }
  }, [orderId]);

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

  async function handlePay(balance: number, method: 'CARD' | 'VIRTUAL_ACCOUNT' = 'CARD') {
    if (!order) return;
    if (!TOSS_CLIENT_KEY) {
      setPayMessage({
        kind: 'error',
        text: '결제 설정이 완료되지 않았습니다. 관리자에게 문의해주세요.',
      });
      return;
    }
    if (method === 'VIRTUAL_ACCOUNT' && !order.name?.trim()) {
      setPayMessage({ kind: 'error', text: '가상계좌 발급에는 주문자 이름이 필요합니다.' });
      return;
    }
    setPayLoading(true);
    try {
      const TossPayments = await loadTossScript();
      const toss = TossPayments(TOSS_CLIENT_KEY);
      const payment = toss.payment({ customerKey: TossPayments.ANONYMOUS });
      const url = new URL(window.location.origin + window.location.pathname);
      url.searchParams.set('order', orderId);
      await payment.requestPayment({
        method,
        amount: { currency: 'KRW', value: balance },
        orderId,
        orderName: `${order.cabbageType} ${order.quantity}${order.unit}`,
        successUrl: url.toString(),
        failUrl: url.toString(),
        customerName: order.name,
        customerMobilePhone: order.phone ? order.phone.replace(/\D/g, '') : undefined,
      });
    } catch {
      setPayLoading(false);
      setPayMessage({ kind: 'error', text: '결제 창을 여는 중 오류가 발생했습니다.' });
    }
  }

  async function handleCancelOrder() {
    if (!order || cancelLoading || order.status === '완료' || order.status === '취소') return;
    const warning =
      '주문을 취소하시겠습니까?\n\n카드결제 후 취소 시 환불까지 영업일 기준 7일 이상이 소요 될 수 있습니다';
    if (!window.confirm(warning)) return;
    setCancelLoading(true);
    setPayMessage({ kind: 'info', text: '주문 취소를 처리하는 중입니다...' });
    try {
      const result = await cancelPublicOrder(order.id);
      if (result?.order) setOrder(result.order);
      else setOrder({ ...order, status: '취소', statusMemo: '고객 요청으로 주문 취소' });
      setPayMessage({ kind: 'info', text: '주문이 취소되었습니다.' });
    } catch (err: any) {
      setPayMessage({ kind: 'error', text: err?.message || '주문 취소에 실패했습니다.' });
    } finally {
      setCancelLoading(false);
    }
  }

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
                <span>예약일시</span>
                <span>
                  {order.reservationDate ? `${order.reservationDate} ` : ''}
                  {order.reservationTime}
                </span>
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
              <span>{order.paid ? '완납 (카드결제)' : getPaymentStatus(order)}</span>
            </div>
          </div>

          {payMessage && (
            <div className={`pay-message ${payMessage.kind === 'error' ? 'pay-message-error' : ''}`}>
              {payMessage.text}
            </div>
          )}

          {order.paid ? (
            <div className='pay-complete-box'>
              <strong>결제 완료</strong>
              <span>
                {formatCurrency(order.paidAmount ?? order.totalPrice)}
                {order.paymentMethod ? ` · ${order.paymentMethod}` : ' · 카드'}
                {order.paidAt ? ` · ${formatDate(order.paidAt)}` : ''}
              </span>
            </div>
          ) : (
            <>
              {order.virtualAccount && order.paymentMethod === '가상계좌' && (
                <div className='pay-complete-box va-box'>
                  <strong>🏦 가상계좌 입금 안내</strong>
                  <span className='va-account'>
                    {order.virtualAccount.bank} {order.virtualAccount.accountNumber}
                  </span>
                  <span>예금주: {order.virtualAccount.customerName || order.name}</span>
                  <span className='va-amount'>입금액: {formatCurrency(balance)}</span>
                  {order.virtualAccount.dueDate && (
                    <span>입금기한: {formatDate(order.virtualAccount.dueDate)}</span>
                  )}
                  <span className='va-waiting'>입금 확인 후 자동으로 결제 완료 처리됩니다.</span>
                </div>
              )}
              {balance > 0 &&
                order.status !== '취소' &&
                !order.virtualAccount && (
                  <div className='pay-buttons'>
                    <button
                      type='button'
                      className='pay-button'
                      disabled={payLoading}
                      onClick={() => handlePay(balance, 'CARD')}
                    >
                      {payLoading ? '결제 준비 중...' : `💳 카드결제 ${formatCurrency(balance)}`}
                    </button>
                    <button
                      type='button'
                      className='pay-button va-button'
                      disabled={payLoading}
                      onClick={() => handlePay(balance, 'VIRTUAL_ACCOUNT')}
                    >
                      🏦 가상계좌 입금
                    </button>
                  </div>
                )}
            </>
          )}

          {order.status !== '완료' && order.status !== '취소' && (
            <button
              type='button'
              className='btn order-cancel-button'
              disabled={cancelLoading || payLoading}
              onClick={handleCancelOrder}
            >
              {cancelLoading ? '취소 처리 중...' : '주문 취소'}
            </button>
          )}

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
  const [saving, setSaving] = useState(false);

  function addItem() {
    setItems((prev) => [...prev, { id: crypto.randomUUID(), name: '', unit: '포기', price: 0 }]);
  }

  function updateItem(id: string, patch: Partial<Product>) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const valid = items.filter((p) => p.name.trim());
      // 먼저 서버에 저장해 다른 기기/재배포 후에도 유지되도록 한다.
      const ok = await pushProductsToServer(valid);
      if (!ok) {
        alert('서버 저장에 실패했습니다. 로그인 상태와 네트워크를 확인해주세요.');
        return;
      }
      onChange(valid);
      onClose();
    } finally {
      setSaving(false);
    }
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
          <button className='btn btn-primary' onClick={save} disabled={saving}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SmsModal({ orders, customers: initialCustomers, onClose }: { orders?: Order[]; customers?: Customer[] | null; onClose: () => void }) {
  // 선택된 고객이 전달되면 그 목록을, 없으면(관리자 메뉴에서 열 때)
  // 서버에서 전체 고객을 불러와 수신자를 선택할 수 있게 한다.
  const [customers, setCustomers] = useState<Customer[] | null>(
    initialCustomers && initialCustomers.length ? initialCustomers : null
  );
  useEffect(() => {
    if (customers) return;
    if (!isAdmin()) return;
    fetchCustomers()
      .then((list) => setCustomers(list))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const recipients = useMemo(() => {
    const seen = new Set<string>();
    const source = customers?.length ? customers : (orders || []);
    return source
      .filter((r: any) => {
        if (customers?.length) return true;
        return r.status !== '취소';
      })
      .filter((r) => r.phone?.trim())
      .filter((r) => {
        const dup = seen.has(r.phone);
        seen.add(r.phone);
        return !dup;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [orders, customers]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(recipients.map((r) => r.id))
  );
  // 고객 목록이 서버에서 로드되면 기본 전체 선택
  useEffect(() => {
    setSelectedIds(new Set(recipients.map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients]);
  const [message, setMessage] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const selectedRecipients = recipients.filter((r) => selectedIds.has(r.id));
  const filteredRecipients = recipientSearch.trim()
    ? recipients.filter(
        (r) =>
          r.name.includes(recipientSearch.trim()) ||
          r.phone.includes(recipientSearch.trim().replace(/\D/g, ''))
      )
    : recipients;
  const previewRecipient = selectedRecipients[0] || recipients[0];
  const preview = previewRecipient ? personalizeMessage(message || '(메시지를 입력하세요)', previewRecipient) : '';

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
    if (!previewRecipient) return;
    const phoneList = selectedRecipients.map((r) => r.phone).join(', ');
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
    if (selectedRecipients.length === 0) {
      alert('수신자를 선택하세요.');
      return;
    }
    const phoneList = selectedRecipients.map((r) => r.phone).join(',');
    const uri = `sms:${phoneList}?body=${encodeURIComponent(preview)}`;
    window.open(uri, '_blank');
  }

  function applyTemplate(text: string) {
    setMessage((prev) => (prev ? prev + '\n' + text : text));
  }

  async function sendViaApi() {
    if (selectedRecipients.length === 0) {
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
      const recipients = selectedRecipients.map((r) => r.phone);
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
          연락처가 등록된 고객에게 문자를 보냅니다. 실제 발송은 문자앱 연동 또는 SMS
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
              <>
              <input
                type='text'
                className='input recipient-search'
                placeholder='이름 또는 연락처로 검색'
                value={recipientSearch}
                onChange={(e) => setRecipientSearch(e.target.value)}
              />
              {filteredRecipients.length === 0 ? (
                <p className='empty-mini'>검색 결과가 없습니다.</p>
              ) : (
                filteredRecipients.map((r) => (
                  <label key={r.id} className='recipient-row'>
                    <input
                      type='checkbox'
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                    />
                    <span className='recipient-name'>{r.name}</span>
                    <span className='recipient-phone'>{formatPhone(r.phone)}</span>
                    <span className='recipient-status'>{(r as any).status || ''}</span>
                  </label>
                ))
              )}
              </>
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

// 매출통계 상세: 취소 제외 주문 기준 매출·수량·품목별 집계
function PaymentModal({
  orders,
  products,
  onChange,
  onClose,
}: {
  orders: Order[];
  products: Product[];
  onChange: (orders: Order[]) => void;
  onClose: () => void;
}) {
  const [workingOrders, setWorkingOrders] = useState<Order[]>(() => [...orders]);
  const [edits, setEdits] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const o of workingOrders) {
      if (o.status !== '취소' && o.totalPrice > 0) {
        map[o.id] = o.depositAmount || 0;
      }
    }
    return map;
  });
  const [newForm, setNewForm] = useState({
    name: '',
    phone: '',
    memo: '',
    amount: 0,
  });
  const [saving, setSaving] = useState(false);
  const [tossPayLoading, setTossPayLoading] = useState(false);
  const [message, setMessage] = useState('');

  const newTotal = Math.max(0, newForm.amount);

  const targetOrders = useMemo(() => {
    return workingOrders
      .filter((o) => o.status !== '취소' && o.totalPrice > 0)
      .sort(
        (a, b) =>
          b.totalPrice - (b.depositAmount || 0) - (a.totalPrice - (a.depositAmount || 0))
      );
  }, [workingOrders]);

  function updateDeposit(id: string, value: number) {
    const order = workingOrders.find((o) => o.id === id);
    if (!order) return;
    const deposit = Math.min(order.totalPrice, Math.max(0, value));
    setEdits((prev) => ({ ...prev, [id]: deposit }));
  }

  function buildNewOrder(): Order | null {
    if (!newForm.name.trim() || newTotal <= 0) {
      return null;
    }
    return {
      id: crypto.randomUUID(),
      name: newForm.name.trim(),
      phone: parsePhone(newForm.phone) || '',
      cabbageType: newForm.memo.trim() || '결제',
      quantity: 1,
      unit: '건',
      totalPrice: newTotal,
      depositAmount: 0,
      status: '접수',
      createdAt: new Date().toISOString(),
      address: '',
      memo: newForm.memo.trim() || '수동 결제 입력',
      pricePerUnit: newTotal,
      pickup: '매장방문',
      pickupDate: '',
      paid: false,
      deposit: false,
    };
  }

  function resetNewForm() {
    setNewForm({
      name: '',
      phone: '',
      memo: '',
      amount: 0,
    });
  }

  function addPayment() {
    const order = buildNewOrder();
    if (!order) {
      setMessage('고객명, 메뉴, 금액을 확인해주세요.');
      return;
    }
    setWorkingOrders((prev) => [order, ...prev]);
    setEdits((prev) => ({ ...prev, [order.id]: order.depositAmount }));
    resetNewForm();
    setMessage('');
  }

  async function handleTossPay() {
    if (!TOSS_CLIENT_KEY) {
      setMessage('토스 결제 설정(VITE_TOSS_CLIENT_KEY)이 완료되지 않았습니다.');
      return;
    }
    const order = buildNewOrder();
    if (!order) {
      setMessage('고객명, 메뉴, 금액을 확인해주세요.');
      return;
    }
    try {
      setTossPayLoading(true);
      setMessage('토스 결제 창을 여는 중입니다...');
      const nextOrders = [order, ...workingOrders];
      await syncAppData('orders', nextOrders);
      await syncPublicOrder(order);
      setWorkingOrders(nextOrders);
      setEdits((prev) => ({ ...prev, [order.id]: order.depositAmount }));
      onChange(nextOrders);
      resetNewForm();
      const url = new URL(window.location.origin + window.location.pathname);
      url.searchParams.set('order', order.id);
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
      setMessage('토스 결제 페이지를 열었습니다. 결제 완료 후 새로고침하면 반영됩니다.');
    } catch (err: any) {
      setMessage(err?.message || '토스 결제 준비 중 오류가 발생했습니다.');
    } finally {
      setTossPayLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const updated = workingOrders.map((o) => {
        if (o.status === '취소') return o;
        const depositAmount = Math.min(
          o.totalPrice,
          Math.max(0, edits[o.id] ?? o.depositAmount ?? 0)
        );
        const fullyPaid = o.totalPrice > 0 && depositAmount >= o.totalPrice;
        return { ...o, depositAmount, deposit: fullyPaid, paid: fullyPaid };
      });
      await syncAppData('orders', updated);
      onChange(updated);
      setMessage('저장되었습니다.');
      setTimeout(() => onClose(), 800);
    } catch (err: any) {
      setMessage(err.message || '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className='modal-overlay' onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className='modal panel payment-modal'>
        <div className='modal-header'>
          <h2>💳 결제 입력</h2>
          <button className='btn icon' onClick={onClose}>
            ✕
          </button>
        </div>
        <p className='modal-hint'>고객과 금액을 입력해 새 결제를 추가하거나, 기존 주문의 입금액을 수정합니다.</p>

        <div className='payment-section'>
          <div className='sms-section-title'>새 결제 추가</div>
          <div className='payment-form amount-payment-form'>
            <input
              className='input'
              placeholder='고객명'
              value={newForm.name}
              onChange={(e) => setNewForm((p) => ({ ...p, name: e.target.value }))}
            />
            <input
              className='input'
              placeholder='연락처'
              value={newForm.phone}
              onChange={(e) => setNewForm((p) => ({ ...p, phone: e.target.value }))}
            />
            <input
              className='input'
              placeholder='결제 내용 (예: 김치 10포기)'
              value={newForm.memo}
              onChange={(e) => setNewForm((p) => ({ ...p, memo: e.target.value }))}
            />
            <input
              className='input'
              type='number'
              min={0}
              placeholder='결제 금액'
              value={newForm.amount}
              onChange={(e) => setNewForm((p) => ({ ...p, amount: Math.max(0, Number(e.target.value)) }))}
            />
            <div className='payment-total'>
              합계: <strong>{formatCurrency(newTotal)}</strong>
            </div>
            <button className='btn btn-primary' onClick={addPayment} disabled={tossPayLoading}>
              + 추가
            </button>
            <button
              className='btn toss-pay-button'
              onClick={handleTossPay}
              disabled={tossPayLoading || newTotal <= 0}
            >
              {tossPayLoading ? '결제 준비 중...' : '토스로 결제'}
            </button>
          </div>
        </div>

        <div className='payment-list'>
          <div className='sms-section-title'>기존 주문 입금 수정</div>
          {targetOrders.length === 0 ? (
            <p className='empty'>결제를 입력할 주문이 없습니다.</p>
          ) : (
            targetOrders.map((o) => {
              const deposit = edits[o.id] ?? o.depositAmount ?? 0;
              const balance = o.totalPrice - deposit;
              return (
                <div key={o.id} className='payment-row'>
                  <div className='payment-info'>
                    <div className='payment-name'>{o.name || '(이름없음)'}</div>
                    <div className='payment-detail'>
                      {o.cabbageType} · {o.quantity}
                      {o.unit} · 총 {formatCurrency(o.totalPrice)}
                    </div>
                    <div className='payment-status'>잔액: {formatCurrency(Math.max(0, balance))}</div>
                  </div>
                  <div className='payment-input'>
                    <label>입금액</label>
                    <input
                      type='number'
                      min={0}
                      max={o.totalPrice}
                      value={deposit}
                      onChange={(e) => updateDeposit(o.id, Number(e.target.value))}
                    />
                    <button className='btn small' onClick={() => updateDeposit(o.id, o.totalPrice)}>
                      전액
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className='modal-actions'>
          {message && <span className='send-result'>{message}</span>}
          <div className='spacer' />
          <button className='btn' onClick={onClose} disabled={saving}>
            닫기
          </button>
          <button className='btn btn-primary' onClick={save} disabled={saving}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 매출통계 상세: 취소 제외 주문 기준 매출·수량·품목별 집계
function SalesStatsModal({ orders, onClose }: { orders: Order[]; onClose: () => void }) {
  const stats = useMemo(() => {
    const active = orders.filter((o) => o.status !== '취소');
    const totalRevenue = active.reduce((sum, o) => sum + (Number(o.totalPrice) || 0), 0);
    const totalQty = active.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
    const totalCount = active.length;
    const byType = new Map<string, { count: number; qty: number; revenue: number }>();
    for (const o of active) {
      const key = o.cabbageType || '기타';
      const agg = byType.get(key) || { count: 0, qty: 0, revenue: 0 };
      agg.count += 1;
      agg.qty += Number(o.quantity) || 0;
      agg.revenue += Number(o.totalPrice) || 0;
      byType.set(key, agg);
    }
    const rows = [...byType.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue);
    // 월별 집계 (접수일 기준)
    const byMonth = new Map<string, { count: number; revenue: number }>();
    for (const o of active) {
      const month = (o.createdAt || '').slice(0, 7) || '기타';
      const agg = byMonth.get(month) || { count: 0, revenue: 0 };
      agg.count += 1;
      agg.revenue += Number(o.totalPrice) || 0;
      byMonth.set(month, agg);
    }
    const months = [...byMonth.entries()]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 6);
    return { totalRevenue, totalQty, totalCount, rows, months };
  }, [orders]);

  return (
    <div className='modal-overlay' onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className='modal panel'>
        <div className='modal-header'>
          <h2>📊 매출통계 상세</h2>
          <button className='btn icon' onClick={onClose}>
            ✕
          </button>
        </div>
        <p className='modal-hint'>취소 주문을 제외한 매출 통계입니다.</p>

        <div className='dashboard-summary' style={{ marginBottom: 16 }}>
          <div className='summary-card'>
            <span className='summary-label'>총 매출</span>
            <span className='summary-value'>{formatCurrency(stats.totalRevenue)}</span>
          </div>
          <div className='summary-card'>
            <span className='summary-label'>총 주문</span>
            <span className='summary-value'>{stats.totalCount}건</span>
          </div>
          <div className='summary-card'>
            <span className='summary-label'>총 수량</span>
            <span className='summary-value'>{stats.totalQty}</span>
          </div>
        </div>

        <div className='stats-section'>
          <div className='sms-section-title'>품목별 매출</div>
          {stats.rows.length === 0 ? (
            <div className='empty'>주문 데이터가 없습니다.</div>
          ) : (
            <ul className='simple-list'>
              {stats.rows.map((r) => (
                <li key={r.name}>
                  <div className='list-content'>{r.name}</div>
                  <div className='list-dates'>
                    <span className='tag'>{r.count}건</span>
                    <span className='tag'>수량 {r.qty}</span>
                    <span className='tag highlight'>{formatCurrency(r.revenue)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className='stats-section' style={{ marginTop: 16 }}>
          <div className='sms-section-title'>월별 매출 (최근 6개월)</div>
          {stats.months.length === 0 ? (
            <div className='empty'>주문 데이터가 없습니다.</div>
          ) : (
            <ul className='simple-list'>
              {stats.months.map((m) => (
                <li key={m.month}>
                  <div className='list-content'>{m.month}</div>
                  <div className='list-dates'>
                    <span className='tag'>{m.count}건</span>
                    <span className='tag highlight'>{formatCurrency(m.revenue)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className='modal-actions'>
          <div className='spacer' />
          <button className='btn' onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
