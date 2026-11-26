-- Student Admissions: replaces the former learning-management schema.
-- Impact: learning data (modules, content, assessments, grades, files) has no admissions equivalent and is removed.
-- User accounts, sessions and login limits are kept. Former LECTURER accounts become OFFICER and STUDENT accounts become VIEWER.
-- Activity entries that referred to removed learning records are deleted; user-account history is kept.

ALTER TABLE audit_events DROP COLUMN IF EXISTS module_id;
DROP TABLE IF EXISTS
  module_group_members, module_groups, assessment_resources, assignment_submissions, grade_revisions, grades,
  quiz_answers, quiz_attempts, quiz_options, quiz_questions, quiz_settings, assignment_settings, release_rules,
  analytics_settings, material_completions, materials, topics, assessments, announcements, idempotency_records,
  upload_limits, files, enrolments, modules
  CASCADE;

-- Roles -----------------------------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = CASE role WHEN 'LECTURER' THEN 'OFFICER' WHEN 'STUDENT' THEN 'VIEWER' ELSE role END;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'OFFICER', 'VIEWER'));

-- Activity log (adapted from audit_events) ---------------------------------------------------------------
DELETE FROM audit_events WHERE entity_type <> 'USER';
ALTER TABLE audit_events ALTER COLUMN entity_id DROP NOT NULL;
ALTER TABLE audit_events ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500);
CREATE INDEX audit_events_time ON audit_events(occurred_at DESC, id);
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_type ON audit_events(event_type, occurred_at DESC);

-- The activity log is append-only.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Activity records are read-only';
END $$;
CREATE TRIGGER audit_events_read_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Programmes ---------------------------------------------------------------------------------------------
CREATE TABLE programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  faculty text NOT NULL CHECK (length(faculty) BETWEEN 1 AND 120),
  qualification_type text NOT NULL CHECK (qualification_type IN ('CERTIFICATE', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  duration_months int NOT NULL CHECK (duration_months BETWEEN 1 AND 120),
  admission_requirements text NOT NULL DEFAULT '' CHECK (length(admission_requirements) <= 4000),
  minimum_qualification text NOT NULL CHECK (minimum_qualification IN ('SECONDARY', 'PRE_UNIVERSITY', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE')),
  minimum_gpa numeric(3,2) CHECK (minimum_gpa BETWEEN 0 AND 4),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX programmes_faculty ON programmes(faculty);
CREATE INDEX programmes_status ON programmes(status);

-- Admission intakes --------------------------------------------------------------------------------------
CREATE TABLE admission_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES programmes(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  academic_year text NOT NULL CHECK (academic_year ~ '^[0-9]{4}/[0-9]{4}$'),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  commences_on date NOT NULL,
  capacity int NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'UPCOMING' CHECK (status IN ('UPCOMING', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED')),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (closes_at > opens_at),
  UNIQUE (programme_id, name),
  UNIQUE (id, programme_id)
);
CREATE INDEX admission_intakes_programme ON admission_intakes(programme_id, opens_at);
CREATE INDEX admission_intakes_status ON admission_intakes(status, closes_at);
CREATE INDEX admission_intakes_year ON admission_intakes(academic_year);

-- Applicants ---------------------------------------------------------------------------------------------
CREATE SEQUENCE applicant_number_seq START 1001;
CREATE TABLE applicants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_number text NOT NULL UNIQUE DEFAULT ('APL-' || lpad(nextval('applicant_number_seq')::text, 6, '0')),
  first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  email text NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9 ()-]{7,20}$'),
  date_of_birth date NOT NULL,
  nationality text NOT NULL CHECK (length(nationality) BETWEEN 1 AND 60),
  address text NOT NULL CHECK (length(address) BETWEEN 1 AND 300),
  previous_institution text NOT NULL CHECK (length(previous_institution) BETWEEN 1 AND 160),
  highest_qualification text NOT NULL CHECK (highest_qualification IN ('SECONDARY', 'PRE_UNIVERSITY', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE')),
  gpa numeric(3,2) CHECK (gpa BETWEEN 0 AND 4),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_HOLD', 'ARCHIVED')),
  remarks text NOT NULL DEFAULT '' CHECK (length(remarks) <= 4000),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX applicants_name ON applicants(last_name, first_name);
CREATE INDEX applicants_status ON applicants(status);
CREATE INDEX applicants_nationality ON applicants(nationality);
CREATE INDEX applicants_qualification ON applicants(highest_qualification);
CREATE INDEX applicants_created ON applicants(created_at DESC);

-- Applications -------------------------------------------------------------------------------------------
CREATE SEQUENCE application_number_seq START 1;
CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^[A-Z]{2,6}-([0-9]{4}-)?[0-9]{6,}$'),
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  programme_id uuid NOT NULL REFERENCES programmes(id),
  intake_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED', 'OFFER_ISSUED',
    'OFFER_ACCEPTED', 'OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED')),
  decision text CHECK (decision IN ('OFFERED', 'WAITLISTED', 'REJECTED')),
  reviewer_id uuid REFERENCES users(id),
  submitted_at timestamptz,
  decided_at timestamptz,
  offer_response_deadline date,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (intake_id, programme_id) REFERENCES admission_intakes(id, programme_id),
  CHECK (status IN ('DRAFT', 'WITHDRAWN') OR submitted_at IS NOT NULL),
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);
-- One live application per applicant per intake; a withdrawn application does not block a new one.
CREATE UNIQUE INDEX applications_one_per_intake ON applications(applicant_id, intake_id) WHERE status <> 'WITHDRAWN';
CREATE INDEX applications_status ON applications(status, updated_at DESC);
CREATE INDEX applications_programme ON applications(programme_id, status);
CREATE INDEX applications_intake ON applications(intake_id, status);
CREATE INDEX applications_applicant ON applications(applicant_id);
CREATE INDEX applications_reviewer ON applications(reviewer_id) WHERE reviewer_id IS NOT NULL;
CREATE INDEX applications_submitted ON applications(submitted_at);

CREATE TABLE application_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_status_history_application ON application_status_history(application_id, occurred_at);
CREATE INDEX application_status_history_status ON application_status_history(to_status, occurred_at DESC);

CREATE TABLE application_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  author_id uuid REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_notes_application ON application_notes(application_id, created_at DESC);

-- System settings ----------------------------------------------------------------------------------------
CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES users(id)
);
