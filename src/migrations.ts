import type { DatabaseSync } from "node:sqlite";

type Migration = {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial-roster",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          fantasy_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          fantasy_description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'rose',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS team_skills (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          PRIMARY KEY (team_id, name)
        );
        CREATE TABLE IF NOT EXISTS people (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          fantasy_role TEXT NOT NULL,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
          bloom_rating INTEGER NOT NULL DEFAULT 1 CHECK (bloom_rating BETWEEN 1 AND 5),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS person_skills (
          person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          PRIMARY KEY (person_id, skill_id)
        );
        CREATE TABLE IF NOT EXISTS aspirations (
          id TEXT PRIMARY KEY,
          person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'budding' CHECK (status IN ('budding', 'growing', 'bloomed')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (person_id, name)
        );
        CREATE TABLE IF NOT EXISTS assignments (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('unassigned', 'assigned', 'completed')),
          team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
          assigned_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
          required_skill TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_people_team ON people(team_id);
        CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);
        CREATE INDEX IF NOT EXISTS idx_assignments_person ON assignments(assigned_person_id);
      `);
    }
  },
  {
    version: 2,
    name: "workspaces-and-auth",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS invitations (
          token_hash TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          accepted_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      ensureColumn(db, "teams", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
      ensureColumn(db, "team_skills", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
      ensureColumn(db, "people", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
      ensureColumn(db, "assignments", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
      db.prepare("INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)")
        .run("workspace-default", "Northstar Studio");
      const defaultWorkspace = "workspace-default";
      for (const table of ["teams", "team_skills", "people", "assignments"]) {
        db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(defaultWorkspace);
      }
      db.exec(`
        UPDATE team_skills
        SET workspace_id = (SELECT workspace_id FROM teams WHERE teams.id = team_skills.team_id);
        CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id, accepted_at);
        CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_people_workspace ON people(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_assignments_workspace ON assignments(workspace_id);
      `);
    }
  }
];

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const current = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  const currentVersion = current.version ?? 0;
  for (const migration of migrations.filter((entry) => entry.version > currentVersion)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(migration.version, migration.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
