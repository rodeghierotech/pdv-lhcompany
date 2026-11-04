CREATE TABLE public.organization (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.organization_member (
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE public.audit_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  actor_id UUID NOT NULL REFERENCES auth.users(id),
  event_type TEXT NOT NULL CHECK (char_length(trim(event_type)) BETWEEN 1 AND 120),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_event_organization_occurred_at_idx
  ON public.audit_event (organization_id, occurred_at DESC);

CREATE FUNCTION public.assign_audit_event_occurred_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.occurred_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_audit_event_occurred_at
  BEFORE INSERT ON public.audit_event
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_audit_event_occurred_at();

ALTER TABLE public.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_member FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_event FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_organization_member(target_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_member
    WHERE organization_id = target_organization_id
      AND user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_organization_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_organization_member(UUID) TO authenticated;

CREATE POLICY "Members read their organization"
  ON public.organization
  FOR SELECT
  TO authenticated
  USING (public.is_organization_member(id));

CREATE POLICY "Members read their membership"
  ON public.organization_member
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Members read organization audit events"
  ON public.audit_event
  FOR SELECT
  TO authenticated
  USING (public.is_organization_member(organization_id));

CREATE POLICY "Members append their own audit events"
  ON public.audit_event
  FOR INSERT
  TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND public.is_organization_member(organization_id)
  );
