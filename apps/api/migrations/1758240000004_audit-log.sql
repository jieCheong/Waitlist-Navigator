-- Up Migration

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid,
  actor_user_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, id);
CREATE INDEX audit_log_clinic_idx ON audit_log (clinic_id, id);

REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- Down Migration

DROP TABLE audit_log;
