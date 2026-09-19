-- Up Migration

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

CREATE TABLE zip_centroids (
  zip text PRIMARY KEY CHECK (zip ~ '^\d{5}$'),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL,
  city text NOT NULL,
  state text NOT NULL CHECK (char_length(state) = 2),
  zip text NOT NULL REFERENCES zip_centroids (zip),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO payers (name) VALUES ('Self-pay');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('family', 'coordinator', 'clinician', 'admin')),
  clinic_id uuid REFERENCES clinics (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_clinic CHECK (
    (role IN ('coordinator', 'clinician') AND clinic_id IS NOT NULL)
    OR (role IN ('family', 'admin') AND clinic_id IS NULL)
  )
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_token_family_id_idx ON refresh_tokens (token_family_id);

CREATE TABLE clinicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  user_id uuid REFERENCES users (id),
  full_name text NOT NULL,
  disciplines text[] NOT NULL CHECK (cardinality(disciplines) > 0),
  languages text[] NOT NULL CHECK (cardinality(languages) > 0),
  age_min_months integer NOT NULL CHECK (age_min_months >= 0),
  age_max_months integer NOT NULL,
  caseload_cap integer NOT NULL CHECK (caseload_cap > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinicians_age_range CHECK (age_max_months > age_min_months)
);

CREATE UNIQUE INDEX clinicians_user_id_key ON clinicians (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX clinicians_clinic_id_idx ON clinicians (clinic_id);

CREATE TABLE clinician_payers (
  clinician_id uuid NOT NULL REFERENCES clinicians (id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES payers (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinician_id, payer_id)
);

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinician_id uuid NOT NULL REFERENCES clinicians (id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  capacity smallint NOT NULL DEFAULT 1 CHECK (capacity = 1),
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_slots_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX availability_slots_clinician_id_idx ON availability_slots (clinician_id);

-- Down Migration

DROP TABLE availability_slots;
DROP TABLE clinician_payers;
DROP TABLE clinicians;
DROP TABLE refresh_tokens;
DROP TABLE users;
DROP TABLE payers;
DROP TABLE clinics;
DROP TABLE zip_centroids;

-- Roles are cluster-wide: revoke app_user's privileges in this database, never drop the role.
DROP OWNED BY app_user;
