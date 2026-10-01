CREATE OR REPLACE FUNCTION public.kv_bridge(p_op text, p_key text, p_value jsonb DEFAULT NULL, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_md5 text := '499bc00a85f08c1f2ef8bc1250269eba';
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR md5(p_token) <> v_md5 THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF p_key IS NULL OR length(p_key) = 0 OR length(p_key) > 100 THEN
    RETURN jsonb_build_object('error', 'invalid key');
  END IF;
  IF p_op = 'get' THEN
    SELECT value INTO v_result FROM public.app_kv WHERE key = p_key;
    RETURN jsonb_build_object('ok', true, 'v', v_result);
  ELSIF p_op = 'set' THEN
    IF p_value IS NULL THEN
      RETURN jsonb_build_object('error', 'value required');
    END IF;
    INSERT INTO public.app_kv (key, value, updated_at) VALUES (p_key, p_value, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    RETURN jsonb_build_object('ok', true);
  ELSE
    RETURN jsonb_build_object('error', 'unknown op');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.kv_bridge(text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kv_bridge(text, text, jsonb, text) TO anon;