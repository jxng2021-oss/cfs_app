CREATE TABLE topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  position int NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  published_at timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (module_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
);
CREATE INDEX topics_module_status_position ON topics(module_id, status, position);

CREATE TABLE materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
  type text NOT NULL CHECK (type IN ('TEXT', 'LINK')),
  text_body text CHECK (length(text_body) BETWEEN 1 AND 20000),
  external_url text CHECK (length(external_url) <= 2048 AND external_url LIKE 'https://%'),
  position int NOT NULL CHECK (position > 0),
  is_required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  published_at timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (topic_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
  CHECK ((type = 'TEXT' AND text_body IS NOT NULL AND external_url IS NULL) OR
    (type = 'LINK' AND external_url IS NOT NULL AND text_body IS NULL))
);
CREATE INDEX materials_topic_status_position ON materials(topic_id, status, position);

CREATE TABLE material_completions (
  student_id uuid NOT NULL REFERENCES users(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (student_id, material_id)
);
CREATE INDEX material_completions_material ON material_completions(material_id);
