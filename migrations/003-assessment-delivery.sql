CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('MATERIAL', 'SUBMISSION')),
  storage_key uuid NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 200),
  extension text NOT NULL,
  detected_content_type text NOT NULL,
  size_bytes int NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('STAGED', 'ATTACHED', 'DELETING')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  attached_at timestamptz,
  CHECK (status <> 'STAGED' OR (expires_at IS NOT NULL AND attached_at IS NULL)),
  CHECK (status <> 'ATTACHED' OR (expires_at IS NULL AND attached_at IS NOT NULL))
);
CREATE INDEX files_status_expiry ON files(status, expires_at);
CREATE INDEX files_owner_staged ON files(owner_id, expires_at) WHERE status = 'STAGED';
CREATE TABLE upload_limits (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  uploads integer NOT NULL CHECK (uploads >= 0),
  window_ends_at timestamptz NOT NULL
);

ALTER TABLE materials ADD COLUMN file_id uuid UNIQUE REFERENCES files(id);
ALTER TABLE materials DROP CONSTRAINT materials_type_check;
ALTER TABLE materials ADD CONSTRAINT materials_type_check CHECK (type IN ('TEXT', 'LINK', 'FILE'));
DO $$
DECLARE payload_check text;
BEGIN
  SELECT conname INTO STRICT payload_check
  FROM pg_constraint
  WHERE conrelid = 'materials'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%text_body IS NOT NULL%';
  EXECUTE format('ALTER TABLE materials DROP CONSTRAINT %I', payload_check);
END $$;
ALTER TABLE materials ADD CONSTRAINT materials_payload_check CHECK (
  (type = 'TEXT' AND text_body IS NOT NULL AND external_url IS NULL AND file_id IS NULL) OR
  (type = 'LINK' AND external_url IS NOT NULL AND text_body IS NULL AND file_id IS NULL) OR
  (type = 'FILE' AND file_id IS NOT NULL AND external_url IS NULL AND text_body IS NULL)
);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id),
  topic_id uuid REFERENCES topics(id),
  type text NOT NULL CHECK (type IN ('ASSIGNMENT', 'QUIZ')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  open_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  close_at timestamptz,
  max_points numeric(7,2) NOT NULL CHECK (max_points BETWEEN 0 AND 1000),
  weight_pct numeric(5,2) NOT NULL CHECK (weight_pct BETWEEN 0 AND 100),
  published_at timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (open_at < due_at AND (close_at IS NULL OR close_at >= due_at)),
  CHECK (type <> 'QUIZ' OR (close_at IS NOT NULL AND close_at = due_at)),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
  CHECK (max_points > 0 OR (type = 'QUIZ' AND status = 'DRAFT'))
);
CREATE INDEX assessments_module_status_due ON assessments(module_id, status, due_at);
CREATE INDEX assessments_topic ON assessments(topic_id);
CREATE TABLE assignment_settings (
  assessment_id uuid PRIMARY KEY REFERENCES assessments(id) ON DELETE CASCADE,
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 20000),
  allow_late_submission boolean NOT NULL,
  max_submissions int NOT NULL CHECK (max_submissions BETWEEN 1 AND 5),
  allowed_extensions text[] NOT NULL CHECK (cardinality(allowed_extensions) BETWEEN 1 AND 10 AND allowed_extensions <@ ARRAY['pdf','docx','pptx','xlsx','txt','md','png','jpg','jpeg','zip']),
  max_file_mib int NOT NULL CHECK (max_file_mib BETWEEN 1 AND 20)
);
CREATE TABLE quiz_settings (
  assessment_id uuid PRIMARY KEY REFERENCES assessments(id) ON DELETE CASCADE,
  instructions text NOT NULL CHECK (length(instructions) <= 20000),
  time_limit_minutes int CHECK (time_limit_minutes BETWEEN 1 AND 180),
  max_attempts int NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  shuffle_questions boolean NOT NULL,
  shuffle_options boolean NOT NULL,
  result_release text NOT NULL CHECK (result_release IN ('IMMEDIATE', 'MANUAL')),
  show_answer_review boolean NOT NULL
);
CREATE TABLE quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 2000),
  points int NOT NULL CHECK (points BETWEEN 1 AND 20),
  position int NOT NULL CHECK (position BETWEEN 1 AND 50),
  explanation text NOT NULL DEFAULT '' CHECK (length(explanation) <= 2000),
  correct_option_id uuid,
  UNIQUE (assessment_id, position)
);
CREATE TABLE quiz_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  position int NOT NULL CHECK (position BETWEEN 1 AND 6),
  UNIQUE (question_id, label),
  UNIQUE (question_id, position),
  UNIQUE (question_id, id)
);
ALTER TABLE quiz_questions ADD FOREIGN KEY (id, correct_option_id) REFERENCES quiz_options(question_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  student_id uuid NOT NULL REFERENCES users(id),
  file_id uuid NOT NULL UNIQUE REFERENCES files(id),
  version_number int NOT NULL CHECK (version_number BETWEEN 1 AND 5),
  submitted_at timestamptz NOT NULL,
  is_late boolean NOT NULL,
  UNIQUE (assessment_id, student_id, version_number)
);
CREATE TABLE idempotency_records (
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL,
  request_key text NOT NULL,
  request_fingerprint text NOT NULL,
  resource_id uuid NOT NULL REFERENCES assignment_submissions(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, operation, request_key)
);
CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  student_id uuid NOT NULL REFERENCES users(id),
  attempt_number int NOT NULL CHECK (attempt_number BETWEEN 1 AND 5),
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT')),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > started_at),
  finished_at timestamptz,
  processed_at timestamptz,
  points numeric(7,2),
  max_points numeric(7,2) NOT NULL CHECK (max_points BETWEEN 0.01 AND 1000),
  presentation jsonb NOT NULL CHECK (jsonb_typeof(presentation) = 'array'),
  UNIQUE (assessment_id, student_id, attempt_number),
  CHECK (points BETWEEN 0 AND max_points),
  CHECK ((status = 'IN_PROGRESS' AND finished_at IS NULL AND points IS NULL AND processed_at IS NULL)
      OR (status <> 'IN_PROGRESS' AND finished_at IS NOT NULL AND points IS NOT NULL AND processed_at IS NOT NULL))
);
CREATE UNIQUE INDEX quiz_one_live_attempt ON quiz_attempts(assessment_id, student_id) WHERE status = 'IN_PROGRESS';
CREATE INDEX attempts_status_expiry ON quiz_attempts(status, expires_at);
CREATE INDEX attempts_student_status ON quiz_attempts(student_id, status);
CREATE TABLE quiz_answers (
  attempt_id uuid NOT NULL REFERENCES quiz_attempts(id),
  question_id uuid NOT NULL REFERENCES quiz_questions(id),
  selected_option_id uuid,
  revision int NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (attempt_id, question_id),
  FOREIGN KEY (question_id, selected_option_id) REFERENCES quiz_options(question_id, id)
);

CREATE TABLE grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  student_id uuid NOT NULL REFERENCES users(id),
  points numeric(7,2) NOT NULL CHECK (points BETWEEN 0 AND 1000),
  feedback text NOT NULL DEFAULT '' CHECK (length(feedback) <= 5000),
  submission_id uuid REFERENCES assignment_submissions(id),
  attempt_id uuid REFERENCES quiz_attempts(id),
  published_revision_id uuid,
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  draft_updated_at timestamptz NOT NULL,
  UNIQUE (assessment_id, student_id),
  CHECK ((submission_id IS NULL) <> (attempt_id IS NULL))
);
CREATE TABLE grade_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_id uuid NOT NULL REFERENCES grades(id),
  revision_number int NOT NULL CHECK (revision_number > 0),
  points numeric(7,2) NOT NULL CHECK (points >= 0),
  max_points numeric(7,2) NOT NULL CHECK (max_points BETWEEN 0.01 AND 1000 AND max_points >= points),
  feedback text NOT NULL CHECK (length(feedback) <= 5000),
  submission_id uuid REFERENCES assignment_submissions(id),
  attempt_id uuid REFERENCES quiz_attempts(id),
  published_by uuid REFERENCES users(id),
  published_at timestamptz NOT NULL,
  UNIQUE (grade_id, revision_number),
  UNIQUE (grade_id, id),
  CHECK ((submission_id IS NULL) <> (attempt_id IS NULL))
);
ALTER TABLE grades ADD FOREIGN KEY (id, published_revision_id) REFERENCES grade_revisions(grade_id,id);

CREATE TABLE release_rules (
  target_topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('TOPIC_COMPLETE', 'QUIZ_SCORE_AT_LEAST')),
  source_topic_id uuid REFERENCES topics(id),
  source_assessment_id uuid REFERENCES assessments(id),
  threshold_pct numeric(5,2),
  PRIMARY KEY (target_topic_id, type),
  CHECK (
    (type = 'TOPIC_COMPLETE' AND source_topic_id IS NOT NULL AND source_assessment_id IS NULL AND threshold_pct IS NULL) OR
    (type = 'QUIZ_SCORE_AT_LEAST' AND source_topic_id IS NULL AND source_assessment_id IS NOT NULL AND threshold_pct > 0 AND threshold_pct <= 100 AND threshold_pct IS NOT NULL)
  )
);
CREATE INDEX release_rules_source_topic ON release_rules(source_topic_id);
CREATE INDEX release_rules_source_assessment ON release_rules(source_assessment_id);

CREATE TABLE analytics_settings (
  module_id uuid PRIMARY KEY REFERENCES modules(id),
  settings jsonb NOT NULL DEFAULT '{"missingAssignmentsEnabled":true,"missingAssignmentsThreshold":1,"lowQuizEnabled":true,"lowQuizThresholdPct":"50.00","lowQuizMinSamples":2,"lowGradeEnabled":true,"lowGradeThresholdPct":"50.00","lowGradeMinWeight":"20.00","lowProgressEnabled":false,"lowProgressThresholdPct":"50.00","lowProgressMinMaterials":3}',
  version int NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO analytics_settings (module_id) SELECT id FROM modules ON CONFLICT DO NOTHING;
CREATE FUNCTION init_module_analytics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analytics_settings (module_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER module_analytics_defaults AFTER INSERT ON modules FOR EACH ROW EXECUTE FUNCTION init_module_analytics();

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  is_pinned boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  published_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'DRAFT') = (published_at IS NULL)),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX announcements_module_status ON announcements(module_id, status);
