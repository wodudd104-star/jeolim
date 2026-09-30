import { createClient } from '@supabase/supabase-js';

const url = (import.meta as any).env.VITE_SUPABASE_URL as string;
const key = (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  console.warn('[Supabase] VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is missing.');
}

export const supabase = createClient(
  url || 'https://supabase-api-prod.verdent.ai/p/p28b4ee9422002e8e2eab',
  key || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2Mzk5ODg0LCJpYXQiOjE3OTA3ODA2ODQsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwMjhiNGVlOTQyMjAwMmU4ZTJlYWIiLCJyb2xlIjoiYW5vbiJ9.FvTYA2GT_FDPi_G7uE5A2Tp_7aTkxBEtik_fwWa0nIg',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
