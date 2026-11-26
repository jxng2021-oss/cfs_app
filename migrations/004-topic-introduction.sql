ALTER TABLE topics ADD COLUMN introduction text NOT NULL DEFAULT '' CHECK (length(introduction) <= 20000);
