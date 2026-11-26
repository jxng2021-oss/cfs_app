-- Classes: lecturer-defined groups within a module's roster. A student belongs to at most one group per module.
CREATE TABLE module_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (module_id, name),
  UNIQUE (id, module_id)
);
CREATE TABLE module_group_members (
  group_id uuid NOT NULL,
  module_id uuid NOT NULL,
  student_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (group_id, student_id),
  UNIQUE (module_id, student_id),
  FOREIGN KEY (group_id, module_id) REFERENCES module_groups(id, module_id) ON DELETE CASCADE,
  FOREIGN KEY (module_id, student_id) REFERENCES enrolments(module_id, student_id)
);

-- Assessment parts: a declaration students accept when submitting, and downloadable brief/template files.
ALTER TABLE assessments ADD COLUMN declaration text NOT NULL DEFAULT '' CHECK (length(declaration) <= 5000);
CREATE TABLE assessment_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  file_id uuid NOT NULL UNIQUE REFERENCES files(id),
  kind text NOT NULL CHECK (kind IN ('BRIEF', 'TEMPLATE', 'OTHER')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX assessment_resources_assessment ON assessment_resources(assessment_id, created_at);
ALTER TABLE assignment_submissions
  ADD COLUMN declaration_text text,
  ADD COLUMN declaration_accepted_at timestamptz,
  ADD CHECK ((declaration_text IS NULL) = (declaration_accepted_at IS NULL));
