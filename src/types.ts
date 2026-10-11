export type OrderStatus = '접수' | '준비중' | '택배' | '현장수령' | '완료' | '취소' | '환불완료';
export type PickupType = '매장방문' | '배송';
export type PaymentStatus = '미납' | '부분납' | '완납';

export type Product = {
  id: string;
  name: string;
  unit: string;
  price: number;
};

export type Order = {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  productId?: string;
  cabbageType: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  totalPrice: number;
  depositAmount: number;
  pickup: PickupType;
  pickupDate: string;
  preparationDate?: string;
  address: string;
  addressDetail?: string;
  memo: string;
  status: OrderStatus;
  deposit: boolean;
  courier?: string;
  trackingNumber?: string;
  completionPhotos?: string[];
  reservationDate?: string;
  reservationTime?: string;
  statusMemo?: string;
  shared?: boolean;
  intakeId?: string;
  paid?: boolean;
  paidAt?: string;
  paidAmount?: number;
  paymentMethod?: string;
  virtualAccount?: {
    bank: string;
    accountNumber: string;
    customerName: string;
    dueDate: string;
  };
};

export type Customer = {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  address: string;
  addressDetail?: string;
  memo: string;
  arrivalDate?: string;
  quantity?: number;
  receiveMethod?: '방문' | '배송' | '택배';
};

export type GalleryItem = {
  id: string;
  image: string;
  note: string;
};

export type Material = {
  id: string;
  createdAt: string;
  date: string;
  name: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  vendor?: string;
  // 영수증 사진은 서버 receipts 테이블에 별도 저장, 자재에는 참조 ID만 보관
  // (구버전 호환용 receipt 인라인 필드는 마이그레이션 후 제거됨)
  receiptId?: string;
  receipt?: string;
  memo?: string;
};

export type Page =
  | 'dashboard'
  | 'orders'
  | 'customers'
  | 'admin'
  | 'gallery'
  | 'materials';
