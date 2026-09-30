// 서버 전용 KV 브리지: Express 서버가 app_kv 테이블을 안전하게 읽고 쓰기 위한 프록시.
// 브라우저에서 직접 호출할 수 없도록 KV_BRIDGE_TOKEN 헤더를 요구하고,
// app_kv 테이블은 RLS로 잠겨 있어 서비스 롤(이 함수 남)만 접근 가능합니다.
const TOKEN = Deno.env.get('KV_BRIDGE_TOKEN') || '';
const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-kv-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!TOKEN || req.headers.get('x-kv-token') !== TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'edge function supabase env missing' }, 500);
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const body = await req.json();
    const { op, key, value } = body || {};
    if (typeof key !== 'string' || !key) return json({ error: 'key required' }, 400);

    if (op === 'get') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_kv?key=eq.${encodeURIComponent(key)}&select=value`,
        { headers }
      );
      if (!res.ok) return json({ error: `get failed: HTTP ${res.status}` }, 502);
      const rows = await res.json();
      return json({ value: Array.isArray(rows) && rows[0] ? rows[0].value : null });
    }

    if (op === 'set') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/app_kv`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) return json({ error: `set failed: HTTP ${res.status}` }, 502);
      return json({ ok: true });
    }

    return json({ error: 'unknown op' }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
