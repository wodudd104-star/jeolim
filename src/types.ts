export type OrderStatus = '접수' | '준비중' | '완료' | '취소';
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
  memo: string;
  status: OrderStatus;
  deposit: boolean;
};

export type Customer = {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  address: string;
  memo: string;
};

export type Page = 'dashboard' | 'orders' | 'customers' | 'admin';
