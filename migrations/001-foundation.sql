CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(trim(email_normalized))),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role text NOT NULL CHECK (role IN ('ADMIN', 'LECTURER', 'STUDENT')),
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  csrf_token_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE login_limits (
  key text PRIMARY KEY,
  failures int NOT NULL CHECK (failures >= 0),
  window_ends_at timestamptz NOT NULL
);
CREATE INDEX login_limits_expiry ON login_limits(window_ends_at);

CREATE TABLE modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,24}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  term text NOT NULL CHECK (length(term) BETWEEN 1 AND 40),
  term_normalized text GENERATED ALWAYS AS (lower(trim(term))) STORED,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  lecturer_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  activated_at timestamptz,
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (code, term_normalized),
  CHECK ((status = 'DRAFT') = (activated_at IS NULL)),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX modules_lecturer_status ON modules(lecturer_id, status);

CREATE TABLE enrolments (
  module_id uuid NOT NULL REFERENCES modules(id),
  student_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  PRIMARY KEY (module_id, student_id),
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX enrolments_student_status ON enrolments(student_id, status);
CREATE INDEX enrolments_module_status ON enrolments(module_id, status);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  module_id uuid REFERENCES modules(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_module_time ON audit_events(module_id, occurred_at DESC);
