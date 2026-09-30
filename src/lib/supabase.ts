import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://supabase-api-prod.verdent.ai/p/p28b4ee9422002e8e2eab',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2Mzk5ODg0LCJpYXQiOjE3OTA3ODA2ODQsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwMjhiNGVlOTQyMjAwMmU4ZTJlYWIiLCJyb2xlIjoiYW5vbiJ9.FvTYA2GT_FDPi_G7uE5A2Tp_7aTkxBEtik_fwWa0nIg',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
