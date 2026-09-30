-- Helper to detect admin role from Supabase Auth user_metadata
CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT coalesce(
    (current_setting('request.jwt.claims', true)::json->'user_metadata'->>'role') = 'admin',
    false
  );
$$;

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  unit text NOT NULL,
  price integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  address text,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  cabbage_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  unit text NOT NULL,
  price_per_unit integer NOT NULL DEFAULT 0,
  total_price integer NOT NULL DEFAULT 0,
  deposit_amount integer NOT NULL DEFAULT 0,
  pickup text NOT NULL,
  pickup_date text,
  preparation_date text,
  address text,
  memo text,
  status text NOT NULL DEFAULT '접수',
  deposit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select_authenticated ON public.products;
DROP POLICY IF EXISTS products_write_admin ON public.products;
DROP POLICY IF EXISTS customers_select_authenticated ON public.customers;
DROP POLICY IF EXISTS customers_insert_authenticated ON public.customers;
DROP POLICY IF EXISTS customers_write_admin ON public.customers;
DROP POLICY IF EXISTS customers_delete_admin ON public.customers;
DROP POLICY IF EXISTS orders_select_authenticated ON public.orders;
DROP POLICY IF EXISTS orders_insert_authenticated ON public.orders;
DROP POLICY IF EXISTS orders_write_admin ON public.orders;
DROP POLICY IF EXISTS orders_delete_admin ON public.orders;

-- Products
CREATE POLICY products_select_authenticated ON public.products
  FOR SELECT TO authenticated USING (true);
CREATE POLICY products_write_admin ON public.products
  FOR ALL TO authenticated USING (is_app_admin()) WITH CHECK (is_app_admin());

-- Customers
CREATE POLICY customers_select_authenticated ON public.customers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY customers_insert_authenticated ON public.customers
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY customers_write_admin ON public.customers
  FOR UPDATE TO authenticated USING (is_app_admin()) WITH CHECK (is_app_admin());
CREATE POLICY customers_delete_admin ON public.customers
  FOR DELETE TO authenticated USING (is_app_admin());

-- Orders
CREATE POLICY orders_select_authenticated ON public.orders
  FOR SELECT TO authenticated USING (true);
CREATE POLICY orders_insert_authenticated ON public.orders
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY orders_write_admin ON public.orders
  FOR UPDATE TO authenticated USING (is_app_admin()) WITH CHECK (is_app_admin());
CREATE POLICY orders_delete_admin ON public.orders
  FOR DELETE TO authenticated USING (is_app_admin());