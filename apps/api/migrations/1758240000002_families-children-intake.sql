-- Up Migration

CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users (id),
  guardian_name_enc bytea NOT NULL,
  phone_enc bytea NOT NULL,
  zip text NOT NULL REFERENCES zip_centroids (zip),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  name_enc bytea NOT NULL,
  birth_month_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id)
);

CREATE INDEX children_family_id_idx ON children (family_id);

CREATE TABLE intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families (id),
  child_id uuid NOT NULL,
  payer_id uuid NOT NULL REFERENCES payers (id),
  discipline text NOT NULL,
  child_age_months integer NOT NULL CHECK (child_age_months >= 0),
  language text NOT NULL DEFAULT 'en',
  preferred_windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(preferred_windows) = 'array'),
  max_distance_km integer NOT NULL CHECK (max_distance_km > 0),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'waitlisted', 'withdrawn', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (child_id, family_id) REFERENCES children (id, family_id)
);

CREATE INDEX intake_requests_family_id_idx ON intake_requests (family_id);
CREATE INDEX intake_requests_status_idx ON intake_requests (status);

-- Down Migration

DROP TABLE intake_requests;
DROP TABLE children;
DROP TABLE families;
