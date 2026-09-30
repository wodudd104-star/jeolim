import { createClient } from '@supabase/supabase-js';
import { createVerdentAuth } from '@verdent/auth-js';

export const supabase = createClient(
  (import.meta as any).env.VITE_SUPABASE_URL || window.location.origin,
  ((import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || 'verdent-baas-proxy',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export const auth = createVerdentAuth({
  supabase,
  oauth: {
    authorizeUrl: (import.meta as any).env.VITE_VERDENT_OAUTH_INITIATE_URL as string,
  },
});
