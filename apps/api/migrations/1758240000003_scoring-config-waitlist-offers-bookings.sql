-- Up Migration

CREATE TABLE scoring_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  version integer NOT NULL CHECK (version > 0),
  weights jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object'),
  is_active boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, version)
);

CREATE UNIQUE INDEX scoring_config_one_active_per_clinic
  ON scoring_config (clinic_id) WHERE is_active;

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  intake_request_id uuid NOT NULL REFERENCES intake_requests (id),
  urgency_level smallint NOT NULL DEFAULT 0 CHECK (urgency_level BETWEEN 0 AND 3),
  joined_at timestamptz NOT NULL DEFAULT now(),
  priority_score numeric,
  score_breakdown jsonb,
  scored_at timestamptz,
  reoffer_boost boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'offered', 'booked', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX waitlist_entries_live_request_key
  ON waitlist_entries (clinic_id, intake_request_id) WHERE status <> 'removed';
CREATE INDEX waitlist_entries_queue_idx ON waitlist_entries (clinic_id, status, joined_at);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id),
  slot_id uuid NOT NULL REFERENCES availability_slots (id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  waitlist_entry_id uuid NOT NULL REFERENCES waitlist_entries (id),
  scoring_config_id uuid NOT NULL REFERENCES scoring_config (id),
  fit_score numeric NOT NULL,
  priority_score numeric NOT NULL,
  score_breakdown jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, clinic_id, slot_id, week_start, waitlist_entry_id)
);

CREATE UNIQUE INDEX one_active_offer_per_slot
  ON offers (slot_id, week_start) WHERE status IN ('proposed', 'accepted');
CREATE UNIQUE INDEX one_proposed_offer_per_entry
  ON offers (waitlist_entry_id) WHERE status = 'proposed';
CREATE INDEX offers_expiry_idx ON offers (status, expires_at);
CREATE INDEX offers_waitlist_entry_id_idx ON offers (waitlist_entry_id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  waitlist_entry_id uuid NOT NULL,
  offer_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_slot_week_key UNIQUE (slot_id, week_start),
  CONSTRAINT bookings_waitlist_entry_key UNIQUE (waitlist_entry_id),
  CONSTRAINT bookings_match_offer
    FOREIGN KEY (offer_id, clinic_id, slot_id, week_start, waitlist_entry_id)
    REFERENCES offers (id, clinic_id, slot_id, week_start, waitlist_entry_id)
);

-- Down Migration

DROP TABLE bookings;
DROP TABLE offers;
DROP TABLE waitlist_entries;
DROP TABLE scoring_config;
