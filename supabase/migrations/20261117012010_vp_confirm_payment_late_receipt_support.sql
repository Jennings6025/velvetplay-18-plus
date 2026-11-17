
CREATE OR REPLACE FUNCTION public.vp_confirm_payment(
  p_checkout_request_id text,
  p_mpesa_receipt text,
  p_result_description text,
  p_callback_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.vp_payments%rowtype;
  v_ledger_id uuid;
  v_balance_seconds bigint;
  v_idempotency_key text;
  v_existing_ledger public.vp_ledger%rowtype;
BEGIN
  SELECT * INTO v_payment
  FROM public.vp_payments
  WHERE checkout_request_id = p_checkout_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Save a late receipt without crediting an already-paid payment again.
  IF v_payment.status = 'paid' THEN
    UPDATE public.vp_payments
    SET mpesa_receipt = COALESCE(p_mpesa_receipt, mpesa_receipt),
        result_description = COALESCE(p_result_description, result_description),
        callback_payload = COALESCE(p_callback_payload, callback_payload)
    WHERE id = v_payment.id;

    SELECT balance_seconds INTO v_balance_seconds
    FROM public.vp_members
    WHERE id = v_payment.member_id;

    RETURN jsonb_build_object(
      'status', 'paid',
      'payment_id', v_payment.id,
      'balance_seconds', COALESCE(v_balance_seconds, 0),
      'duplicate', true
    );
  END IF;

  IF v_payment.status <> 'pending'
     OR v_payment.seconds_credited IS NULL
     OR v_payment.seconds_credited <= 0
     OR v_payment.member_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', v_payment.status,
      'payment_id', v_payment.id
    );
  END IF;

  v_idempotency_key := 'payment:' || v_payment.id::text;

  INSERT INTO public.vp_ledger (
    member_id,
    payment_id,
    entry_type,
    seconds_delta,
    idempotency_key,
    metadata
  ) VALUES (
    v_payment.member_id,
    v_payment.id,
    'payment_credit',
    v_payment.seconds_credited,
    v_idempotency_key,
    jsonb_build_object(
      'amount_kes', v_payment.amount_kes,
      'checkout_request_id', p_checkout_request_id
    )
  )
  ON CONFLICT (idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NOT NULL THEN
    UPDATE public.vp_members
    SET balance_seconds = balance_seconds + v_payment.seconds_credited,
        updated_at = now()
    WHERE id = v_payment.member_id
    RETURNING balance_seconds INTO v_balance_seconds;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment member does not exist';
    END IF;
  ELSE
    SELECT * INTO v_existing_ledger
    FROM public.vp_ledger
    WHERE idempotency_key = v_idempotency_key;

    IF NOT FOUND
       OR v_existing_ledger.member_id IS DISTINCT FROM v_payment.member_id
       OR v_existing_ledger.payment_id IS DISTINCT FROM v_payment.id
       OR v_existing_ledger.entry_type IS DISTINCT FROM 'payment_credit'
       OR v_existing_ledger.seconds_delta IS DISTINCT FROM v_payment.seconds_credited THEN
      RAISE EXCEPTION 'Payment idempotency key conflicts with a different ledger entry';
    END IF;

    SELECT balance_seconds INTO v_balance_seconds
    FROM public.vp_members
    WHERE id = v_payment.member_id;
  END IF;

  UPDATE public.vp_payments
  SET status = 'paid',
      mpesa_receipt = COALESCE(p_mpesa_receipt, mpesa_receipt),
      result_code = '0',
      result_description = COALESCE(p_result_description, 'Payment confirmed'),
      callback_payload = COALESCE(p_callback_payload, callback_payload),
      paid_at = COALESCE(paid_at, now())
  WHERE id = v_payment.id;

  RETURN jsonb_build_object(
    'status', 'paid',
    'payment_id', v_payment.id,
    'balance_seconds', COALESCE(v_balance_seconds, 0),
    'duplicate', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.vp_confirm_payment(text, text, text, jsonb)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.vp_confirm_payment(text, text, text, jsonb)
TO service_role;
