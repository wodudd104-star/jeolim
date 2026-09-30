import { supabase } from './supabase';
import { Order, Customer, Product, OrderStatus, PickupType } from '../types';

type DbProduct = {
  id: string;
  name: string;
  unit: string;
  price: number;
  created_at: string;
};

type DbCustomer = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  memo: string | null;
  created_at: string;
};

type DbOrder = {
  id: string;
  name: string;
  phone: string | null;
  product_id: string | null;
  cabbage_type: string;
  quantity: number;
  unit: string;
  price_per_unit: number;
  total_price: number;
  deposit_amount: number;
  pickup: string;
  pickup_date: string | null;
  preparation_date: string | null;
  address: string | null;
  memo: string | null;
  status: string;
  deposit: boolean;
  created_at: string;
};

function toProduct(row: DbProduct): Product {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    price: row.price,
  };
}

function toCustomer(row: DbCustomer): Customer {
  return {
    id: row.id,
    createdAt: row.created_at,
    name: row.name,
    phone: row.phone || '',
    address: row.address || '',
    memo: row.memo || '',
  };
}

function toOrder(row: DbOrder): Order {
  return {
    id: row.id,
    createdAt: row.created_at,
    name: row.name,
    phone: row.phone || '',
    productId: row.product_id || undefined,
    cabbageType: row.cabbage_type,
    quantity: row.quantity,
    unit: row.unit,
    pricePerUnit: row.price_per_unit,
    totalPrice: row.total_price,
    depositAmount: row.deposit_amount,
    pickup: row.pickup as PickupType,
    pickupDate: row.pickup_date || '',
    preparationDate: row.preparation_date || undefined,
    address: row.address || '',
    memo: row.memo || '',
    status: row.status as OrderStatus,
    deposit: row.deposit,
  };
}

function fromOrder(order: Order): Omit<DbOrder, 'created_at'> {
  return {
    id: order.id,
    name: order.name,
    phone: order.phone || null,
    product_id: order.productId || null,
    cabbage_type: order.cabbageType,
    quantity: order.quantity,
    unit: order.unit,
    price_per_unit: order.pricePerUnit,
    total_price: order.totalPrice,
    deposit_amount: order.depositAmount,
    pickup: order.pickup,
    pickup_date: order.pickupDate || null,
    preparation_date: order.preparationDate || null,
    address: order.address || null,
    memo: order.memo || null,
    status: order.status,
    deposit: order.deposit,
  };
}

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(toProduct);
}

export async function upsertProduct(product: Product): Promise<void> {
  const { error } = await supabase.from('products').upsert({
    id: product.id,
    name: product.name,
    unit: product.unit,
    price: product.price,
  });
  if (error) throw new Error(error.message);
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function fetchCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase.from('customers').select('*').order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(toCustomer);
}

export async function insertCustomer(customer: Omit<Customer, 'id' | 'createdAt'>): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      name: customer.name,
      phone: customer.phone || null,
      address: customer.address || null,
      memo: customer.memo || null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return toCustomer(data);
}

export async function updateCustomer(id: string, customer: Omit<Customer, 'id' | 'createdAt'>): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({
      name: customer.name,
      phone: customer.phone || null,
      address: customer.address || null,
      memo: customer.memo || null,
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function fetchOrders(): Promise<Order[]> {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(toOrder);
}

export async function insertOrder(order: Omit<Order, 'id' | 'createdAt'>): Promise<Order> {
  const { data, error } = await supabase.from('orders').insert(fromOrder(order as Order)).select().single();
  if (error) throw new Error(error.message);
  return toOrder(data);
}

export async function updateOrder(id: string, order: Partial<Order>): Promise<void> {
  const patch: Partial<DbOrder> = {};
  if (order.name !== undefined) patch.name = order.name;
  if (order.phone !== undefined) patch.phone = order.phone || null;
  if (order.productId !== undefined) patch.product_id = order.productId || null;
  if (order.cabbageType !== undefined) patch.cabbage_type = order.cabbageType;
  if (order.quantity !== undefined) patch.quantity = order.quantity;
  if (order.unit !== undefined) patch.unit = order.unit;
  if (order.pricePerUnit !== undefined) patch.price_per_unit = order.pricePerUnit;
  if (order.totalPrice !== undefined) patch.total_price = order.totalPrice;
  if (order.depositAmount !== undefined) patch.deposit_amount = order.depositAmount;
  if (order.pickup !== undefined) patch.pickup = order.pickup;
  if (order.pickupDate !== undefined) patch.pickup_date = order.pickupDate || null;
  if (order.preparationDate !== undefined) patch.preparation_date = order.preparationDate || null;
  if (order.address !== undefined) patch.address = order.address || null;
  if (order.memo !== undefined) patch.memo = order.memo || null;
  if (order.status !== undefined) patch.status = order.status;
  if (order.deposit !== undefined) patch.deposit = order.deposit;

  const { error } = await supabase.from('orders').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteOrder(id: string): Promise<void> {
  const { error } = await supabase.from('orders').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
