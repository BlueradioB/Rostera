import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations.js";

export type ThemeNames = {
  name: string;
  fantasyName: string;
};

export type PersonInput = {
  name: string;
  role: string;
  fantasyRole?: string;
  teamId: string;
  bloomRating?: number;
  skills?: string[];
  aspirations?: string[];
  assignment?: string;
};

export type PersonPatch = Partial<Omit<PersonInput, "assignment">>;

export type TeamInput = {
  name: string;
  fantasyName: string;
  description?: string;
  fantasyDescription?: string;
  color?: string;
  requiredSkills?: string[];
};

export type TeamPatch = Partial<TeamInput>;

export type AssignmentInput = {
  title: string;
  description?: string;
  teamId?: string | null;
  assignedPersonId?: string | null;
  requiredSkill?: string;
};

export type Workspace = {
  id: string;
  name: string;
  role: "owner" | "member";
};

export type User = {
  id: string;
  name: string;
  email: string;
};

export type Session = {
  id: string;
  userId: string;
  workspaceId: string;
  expiresAt: string;
};

export type Invitation = {
  workspaceId: string;
  createdBy: string;
  expiresAt: string;
  createdAt: string;
};

export const DEFAULT_WORKSPACE_ID = "workspace-default";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type TeamRow = {
  id: string;
  name: string;
  fantasyName: string;
  description: string;
  fantasyDescription: string;
  color: string;
  requiredSkills: string[];
  missingSkills: string[];
  members: number;
  skillCoverage: number;
};

type PersonRow = {
  id: string;
  name: string;
  role: string;
  fantasyRole: string;
  teamId: string;
  bloomRating: number;
  skills: string[];
  aspirations: string[];
  currentAssignment: { id: string; title: string } | null;
};

type AssignmentRow = {
  id: string;
  title: string;
  description: string;
  status: "unassigned" | "assigned" | "completed";
  teamId: string | null;
  assignedPersonId: string | null;
  requiredSkill: string;
};

const initialTeams: Array<TeamInput & { id: string; color: string }> = [
  {
    id: "product",
    name: "Product & Design",
    fantasyName: "The Roseguard",
    description: "Product, UX, and research",
    fantasyDescription: "Scouts, wardens, and tacticians",
    color: "rose",
    requiredSkills: ["Product strategy", "UX research", "Prototyping"]
  },
  {
    id: "engineering",
    name: "Engineering",
    fantasyName: "The Ironbloom Company",
    description: "Platform and applications",
    fantasyDescription: "Artificers and spellblades",
    color: "green",
    requiredSkills: ["Frontend", "Systems", "Accessibility"]
  },
  {
    id: "customer",
    name: "Customer Experience",
    fantasyName: "The Hearthwardens",
    description: "Success and operations",
    fantasyDescription: "Healers and guides",
    color: "blue",
    requiredSkills: ["Enablement", "Analytics", "Advocacy"]
  }
];

export function createDatabase(filename = ":memory:"): DatabaseSync {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(resolve(filename), 0o600);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrateDatabase(db);
  const defaultWorkspace = DEFAULT_WORKSPACE_ID;
  for (const table of ["teams", "team_skills", "people", "assignments"]) {
    db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(defaultWorkspace);
  }
  db.exec(`
    UPDATE team_skills
    SET workspace_id = (SELECT workspace_id FROM teams WHERE teams.id = team_skills.team_id);
    CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_people_workspace ON people(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_workspace ON assignments(workspace_id);
  `);
  seedDatabase(db);
  return db;
}

function seedDatabase(db: DatabaseSync): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM teams").get() as { count: number };
  if (count.count > 0) return;

  const addTeam = db.prepare(`
    INSERT INTO teams (id, workspace_id, name, fantasy_name, description, fantasy_description, color)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const addTeamSkill = db.prepare("INSERT INTO team_skills (team_id, workspace_id, name) VALUES (?, ?, ?)");
  for (const team of initialTeams) {
    addTeam.run(team.id, DEFAULT_WORKSPACE_ID, team.name, team.fantasyName, team.description ?? "", team.fantasyDescription ?? "", team.color);
    for (const skill of team.requiredSkills ?? []) addTeamSkill.run(team.id, DEFAULT_WORKSPACE_ID, skill);
  }

  const people: Array<PersonInput & { id: string; fantasyRole: string; bloomRating: number }> = [
    { id: "maya-chen", name: "Maya Chen", role: "Product designer", fantasyRole: "Roseguard scout", teamId: "product", bloomRating: 4, skills: ["Product strategy", "Prototyping", "Facilitation"], aspirations: ["Product strategy"], assignment: "Onboarding refresh" },
    { id: "jamie-rivera", name: "Jamie Rivera", role: "UX researcher", fantasyRole: "Guild researcher", teamId: "product", bloomRating: 4, skills: ["UX research", "Accessibility"], aspirations: ["Accessibility"], assignment: "User interviews" },
    { id: "jordan-lee", name: "Jordan Lee", role: "Frontend engineer", fantasyRole: "Runesmith", teamId: "engineering", bloomRating: 5, skills: ["Frontend", "Accessibility", "Systems"], aspirations: ["Systems design"], assignment: "Design systems" },
    { id: "sam-kim", name: "Sam Kim", role: "Customer advocate", fantasyRole: "Wayfinder", teamId: "customer", bloomRating: 3, skills: ["Enablement", "Research", "Advocacy"], aspirations: ["Analytics"], assignment: "Customer onboarding" }
  ];
  const addPerson = db.prepare(`
    INSERT INTO people (id, workspace_id, name, role, fantasy_role, team_id, bloom_rating)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findSkill = db.prepare("SELECT id FROM skills WHERE name = ?");
  const addSkill = db.prepare("INSERT INTO skills (id, name) VALUES (?, ?)");
  const linkSkill = db.prepare("INSERT INTO person_skills (person_id, skill_id) VALUES (?, ?)");
  const addAspiration = db.prepare("INSERT INTO aspirations (id, person_id, name) VALUES (?, ?, ?)");
  const addAssignment = db.prepare(`
    INSERT INTO assignments (id, workspace_id, title, description, status, team_id, assigned_person_id, required_skill)
    VALUES (?, ?, ?, ?, 'assigned', ?, ?, '')
  `);
  for (const person of people) {
    addPerson.run(person.id, DEFAULT_WORKSPACE_ID, person.name, person.role, person.fantasyRole, person.teamId, person.bloomRating);
    for (const skill of person.skills ?? []) {
      let skillRow = findSkill.get(skill) as { id: string } | undefined;
      if (!skillRow) {
        const id = randomUUID();
        addSkill.run(id, skill);
        skillRow = { id };
      }
      linkSkill.run(person.id, skillRow.id);
    }
    for (const aspiration of person.aspirations ?? []) addAspiration.run(randomUUID(), person.id, aspiration);
    if (person.assignment) {
      addAssignment.run(randomUUID(), DEFAULT_WORKSPACE_ID, person.assignment, "", person.teamId, person.id);
    }
  }

  const addUnassigned = db.prepare(`
    INSERT INTO assignments (id, workspace_id, title, description, status, team_id, required_skill)
    VALUES (?, ?, ?, ?, 'unassigned', ?, ?)
  `);
  addUnassigned.run(randomUUID(), DEFAULT_WORKSPACE_ID, "Mobile accessibility audit", "An upcoming review needs someone with accessibility experience.", "engineering", "Accessibility");
  addUnassigned.run(randomUUID(), DEFAULT_WORKSPACE_ID, "Research synthesis", "Help turn recent customer conversations into clear themes.", "customer", "Research");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function databaseTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function encodePassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, cost, saltHex, hashHex] = encoded.split("$");
  if (algorithm !== "scrypt" || cost !== "16384" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, { N: 16384, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  register(input: { name: string; email: string; password: string; workspaceName?: string; invitationToken?: string }): { user: User; session: Session; token: string } {
    const email = normalizedEmail(input.email);
    if (this.db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
      throw new Error("An account with this email already exists.");
    }
    const passwordHash = encodePassword(input.password);
    const userId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const invitationTokenHash = input.invitationToken ? hashToken(input.invitationToken) : undefined;
    const invite = invitationTokenHash
      ? this.db.prepare("SELECT workspace_id AS workspaceId, expires_at AS expiresAt, accepted_at AS acceptedAt FROM invitations WHERE token_hash = ?")
        .get(invitationTokenHash) as { workspaceId: string; expiresAt: string; acceptedAt: string | null } | undefined
      : undefined;
    if (invitationTokenHash && (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now())) {
      throw new Error("This invitation is invalid or has expired.");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let workspaceId: string;
      let role: "owner" | "member";
      if (invite && invitationTokenHash) {
        workspaceId = invite.workspaceId;
        role = "member";
        this.db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
          .run(userId, input.name.trim(), email, passwordHash);
        this.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)")
          .run(workspaceId, userId, role);
        const accepted = this.db.prepare(`
          UPDATE invitations SET accepted_by = ?, accepted_at = CURRENT_TIMESTAMP
          WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        `).run(userId, invitationTokenHash);
        if (accepted.changes !== 1) throw new Error("This invitation has already been used or has expired.");
      } else {
        const userCount = (this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
        workspaceId = userCount === 0 ? DEFAULT_WORKSPACE_ID : randomUUID();
        role = "owner";
        if (userCount === 0) {
          this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(input.workspaceName!.trim(), workspaceId);
        } else {
          this.db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(workspaceId, input.workspaceName!.trim());
          this.addStarterTeams(workspaceId);
        }
        this.db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
          .run(userId, input.name.trim(), email, passwordHash);
        this.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)")
          .run(workspaceId, userId, role);
      }
      const session = this.createSession(userId, workspaceId, token);
      this.db.exec("COMMIT");
      return { user: { id: userId, name: input.name.trim(), email }, session, token };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  login(emailInput: string, password: string): { user: User; session: Session; token: string } | undefined {
    const email = normalizedEmail(emailInput);
    const row = this.db.prepare(`
      SELECT u.id, u.name, u.email, u.password_hash AS passwordHash
      FROM users u WHERE u.email = ?
    `).get(email) as (User & { passwordHash: string }) | undefined;
    if (!row || !verifyPassword(password, row.passwordHash)) return undefined;
    const membership = this.db.prepare(`
      SELECT workspace_id AS workspaceId FROM workspace_members
      WHERE user_id = ? ORDER BY created_at, workspace_id LIMIT 1
    `).get(row.id) as { workspaceId: string } | undefined;
    if (!membership) return undefined;
    const token = randomBytes(32).toString("base64url");
    const session = this.createSession(row.id, membership.workspaceId, token);
    return { user: { id: row.id, name: row.name, email: row.email }, session, token };
  }

  session(token: string | undefined): (Session & { user: User; role: "owner" | "member"; workspace: { id: string; name: string } }) | undefined {
    if (!token) return undefined;
    const row = this.db.prepare(`
      SELECT s.user_id AS userId, s.workspace_id AS workspaceId, s.expires_at AS expiresAt,
        u.name AS userName, u.email, wm.role, w.name AS workspaceName
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = s.workspace_id
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
    `).get(hashToken(token)) as {
      userId: string;
      workspaceId: string;
      expiresAt: string;
      userName: string;
      email: string;
      role: "owner" | "member";
      workspaceName: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: hashToken(token),
      userId: row.userId,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      user: { id: row.userId, name: row.userName, email: row.email },
      role: row.role,
      workspace: { id: row.workspaceId, name: row.workspaceName }
    };
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  workspaces(userId: string): Workspace[] {
    return this.db.prepare(`
      SELECT w.id, w.name, wm.role FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ? ORDER BY w.created_at, w.name
    `).all(userId) as Workspace[];
  }

  switchWorkspace(userId: string, sessionToken: string, workspaceId: string): boolean {
    const membership = this.db.prepare("SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?").get(userId, workspaceId);
    if (!membership) return false;
    this.db.prepare("UPDATE sessions SET workspace_id = ? WHERE token_hash = ? AND user_id = ?")
      .run(workspaceId, hashToken(sessionToken), userId);
    return true;
  }

  createWorkspace(userId: string, name: string, sessionToken: string): Workspace {
    const workspace: Workspace = { id: randomUUID(), name, role: "owner" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(workspace.id, name);
      this.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspace.id, userId);
      this.addStarterTeams(workspace.id);
      this.db.prepare("UPDATE sessions SET workspace_id = ? WHERE token_hash = ? AND user_id = ?")
        .run(workspace.id, hashToken(sessionToken), userId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return workspace;
  }

  renameWorkspace(userId: string, workspaceId: string, name: string): boolean {
    return this.db.prepare(`
      UPDATE workspaces SET name = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND role = 'owner'
      )
    `).run(name, workspaceId, workspaceId, userId).changes === 1;
  }

  createInvitation(workspaceId: string, createdBy: string): { token: string; invitation: Invitation } {
    const role = this.db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, createdBy) as { role: string } | undefined;
    if (role?.role !== "owner") throw new Error("Only workspace owners can create invitations.");
    const token = randomBytes(32).toString("base64url");
    const id = hashToken(token);
    const expiresAt = databaseTimestamp(new Date(Date.now() + INVITATION_TTL_MS));
    this.db.prepare("INSERT INTO invitations (token_hash, workspace_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, workspaceId, createdBy, expiresAt);
    return {
      token,
      invitation: { workspaceId, createdBy, expiresAt, createdAt: new Date().toISOString() }
    };
  }

  invitations(workspaceId: string): Invitation[] {
    return this.db.prepare(`
      SELECT workspace_id AS workspaceId, created_by AS createdBy,
        expires_at AS expiresAt, created_at AS createdAt
      FROM invitations
      WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `).all(workspaceId) as Invitation[];
  }

  redeemInvitation(userId: string, sessionToken: string, token: string): string {
    const tokenHash = hashToken(token);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.db.prepare(`
        SELECT workspace_id AS workspaceId FROM invitations
        WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      `).get(tokenHash) as { workspaceId: string } | undefined;
      if (!invite) throw new Error("This invitation is invalid, expired, or already used.");
      if (this.db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
        .get(invite.workspaceId, userId)) {
        throw new Error("You already belong to this workspace.");
      }
      this.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')")
        .run(invite.workspaceId, userId);
      const accepted = this.db.prepare(`
        UPDATE invitations SET accepted_by = ?, accepted_at = CURRENT_TIMESTAMP
        WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      `).run(userId, tokenHash);
      if (accepted.changes !== 1) throw new Error("This invitation has already been used or has expired.");
      this.db.prepare("UPDATE sessions SET workspace_id = ? WHERE token_hash = ? AND user_id = ?")
        .run(invite.workspaceId, hashToken(sessionToken), userId);
      this.db.exec("COMMIT");
      return invite.workspaceId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSession(userId: string, workspaceId: string, token: string): Session {
    const expiresAt = databaseTimestamp(new Date(Date.now() + SESSION_TTL_MS));
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), userId, workspaceId, expiresAt);
    return { id: hashToken(token), userId, workspaceId, expiresAt };
  }

  private addStarterTeams(workspaceId: string): void {
    const addTeam = this.db.prepare(`
      INSERT INTO teams (id, workspace_id, name, fantasy_name, description, fantasy_description, color)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const addSkill = this.db.prepare("INSERT INTO team_skills (team_id, workspace_id, name) VALUES (?, ?, ?)");
    for (const template of initialTeams) {
      const id = randomUUID();
      addTeam.run(id, workspaceId, template.name, template.fantasyName, template.description ?? "", template.fantasyDescription ?? "", template.color);
      for (const skill of template.requiredSkills ?? []) addSkill.run(id, workspaceId, skill);
    }
  }
}

export class RosterStore {
  constructor(private readonly db: DatabaseSync, private readonly workspaceId = DEFAULT_WORKSPACE_ID) {}

  forWorkspace(workspaceId: string): RosterStore {
    return new RosterStore(this.db, workspaceId);
  }

  dashboard(): {
    teams: TeamRow[];
    people: PersonRow[];
    assignments: Array<AssignmentRow & { suggestedPeople: Array<{ id: string; name: string; reason: string }> }>;
    stats: {
      people: number;
      teams: number;
      readyToGrow: number;
      growthAreas: number;
      unassignedAssignments: number;
      assignedAssignments: number;
      completedAssignments: number;
      skillGaps: number;
      skillCoverage: number;
    };
  } {
    const teams = this.listTeams();
    const people = this.listPeople();
    const activeLoads = new Map((this.db.prepare(`
      SELECT assigned_person_id AS personId, COUNT(*) AS count
      FROM assignments
      WHERE workspace_id = ? AND status = 'assigned' AND assigned_person_id IS NOT NULL
      GROUP BY assigned_person_id
    `).all(this.workspaceId) as Array<{ personId: string; count: number }>).map((row) => [row.personId, row.count]));
    const assignments = this.listAssignments("unassigned").map((assignment) => {
      const assignmentTeam = teams.find((item) => item.id === assignment.teamId);
      const candidates = people.map((person) => {
        const skillMatches = person.skills.filter((skill) =>
          assignment.requiredSkill
            ? skill.toLowerCase() === assignment.requiredSkill.toLowerCase()
            : false
        );
        const relatedSkills = assignment.requiredSkill
          ? []
          : (assignmentTeam?.requiredSkills ?? []).filter((skill) =>
              person.skills.some((memberSkill) => memberSkill.toLowerCase() === skill.toLowerCase())
            );
        const matchesTeam = Boolean(assignment.teamId && person.teamId === assignment.teamId);
        const assignedWorkCount = activeLoads.get(person.id) ?? 0;
        const score = skillMatches.length * 100 + relatedSkills.length * 20
          + (matchesTeam ? 25 : 0) + person.bloomRating * 4 - assignedWorkCount * 12;
        const reasons = [
          ...skillMatches.map((skill) => `Strength in ${skill}`),
          ...relatedSkills.slice(0, 1).map((skill) => `Strength in ${skill}`),
          ...(assignment.requiredSkill && skillMatches.length === 0 ? [`No recorded ${assignment.requiredSkill} match`] : []),
          ...(matchesTeam ? ["On the requested team"] : []),
          ...(assignedWorkCount === 0 ? ["Available for new work"] : [`${assignedWorkCount} active ${assignedWorkCount === 1 ? "assignment" : "assignments"}`])
        ];
        return { person, score, reasons };
      }).sort((a, b) => b.score - a.score
        || a.person.name.localeCompare(b.person.name));
      return {
        ...assignment,
        suggestedPeople: candidates.slice(0, 3).map(({ person, reasons }) => ({
          id: person.id,
          name: person.name,
          reason: reasons.join(" · ") || "No matching skills recorded yet"
        }))
      };
    });
    const allAssignments = this.listAssignments();
    const growthStats = this.db.prepare(`
      SELECT COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN p.id END) AS people, COUNT(a.id) AS areas
      FROM people p LEFT JOIN aspirations a ON a.person_id = p.id AND a.status != 'bloomed'
      WHERE p.workspace_id = ?
    `).get(this.workspaceId) as { people: number; areas: number };
    const requiredSkillCount = teams.reduce((total, team) => total + team.requiredSkills.length, 0);
    const skillGaps = teams.reduce((total, team) => total + team.missingSkills.length, 0);
    return {
      teams,
      people,
      assignments,
      stats: {
        people: people.length,
        teams: teams.length,
        readyToGrow: growthStats.people,
        growthAreas: growthStats.areas,
        unassignedAssignments: allAssignments.filter((assignment) => assignment.status === "unassigned").length,
        assignedAssignments: allAssignments.filter((assignment) => assignment.status === "assigned").length,
        completedAssignments: allAssignments.filter((assignment) => assignment.status === "completed").length,
        skillGaps,
        skillCoverage: requiredSkillCount ? Math.round(((requiredSkillCount - skillGaps) / requiredSkillCount) * 100) : 0
      }
    };
  }

  listTeams(): TeamRow[] {
    const rows = this.db.prepare(`
      SELECT t.id, t.name, t.fantasy_name AS fantasyName, t.description,
        t.fantasy_description AS fantasyDescription, t.color,
        COUNT(DISTINCT p.id) AS members
      FROM teams t LEFT JOIN people p ON p.team_id = t.id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?
      GROUP BY t.id
      ORDER BY CASE t.id WHEN 'product' THEN 1 WHEN 'engineering' THEN 2 WHEN 'customer' THEN 3 ELSE 4 END, t.name
    `).all(this.workspaceId) as Array<Omit<TeamRow, "requiredSkills" | "missingSkills" | "skillCoverage">>;
    return rows.map((row) => {
      const requiredSkills = this.db.prepare("SELECT name FROM team_skills WHERE team_id = ? AND workspace_id = ? ORDER BY name").all(row.id, this.workspaceId) as Array<{ name: string }>;
      const coveredSkills = this.db.prepare(`
        SELECT DISTINCT ts.name AS name
        FROM team_skills ts
        JOIN skills s ON lower(s.name) = lower(ts.name)
        JOIN person_skills ps ON ps.skill_id = s.id
        JOIN people p ON p.id = ps.person_id AND p.team_id = ts.team_id
        WHERE ts.team_id = ? AND ts.workspace_id = ?
      `).all(row.id, this.workspaceId) as Array<{ name: string }>;
      const coveredNames = new Set(coveredSkills.map((skill) => skill.name.toLocaleLowerCase()));
      const missingSkills = requiredSkills.filter((skill) => !coveredNames.has(skill.name.toLocaleLowerCase())).map((skill) => skill.name);
      return {
        ...row,
        requiredSkills: requiredSkills.map((skill) => skill.name),
        missingSkills,
        skillCoverage: requiredSkills.length ? Math.round(((requiredSkills.length - missingSkills.length) / requiredSkills.length) * 100) : 0
      };
    });
  }

  team(id: string): TeamRow | undefined {
    return this.listTeams().find((team) => team.id === id);
  }

  listPeople(filters: { teamId?: string; query?: string } = {}): PersonRow[] {
    const where: string[] = ["p.workspace_id = ?"];
    const params: string[] = [this.workspaceId];
    if (filters.teamId) {
      where.push("p.team_id = ?");
      params.push(filters.teamId);
    }
    if (filters.query) {
      where.push("(lower(p.name) LIKE ? OR lower(p.role) LIKE ?)");
      const pattern = `%${filters.query.toLowerCase()}%`;
      params.push(pattern, pattern);
    }
    const rows = this.db.prepare(`
      SELECT p.id, p.name, p.role, p.fantasy_role AS fantasyRole, p.team_id AS teamId, p.bloom_rating AS bloomRating
      FROM people p WHERE ${where.join(" AND ")}
      ORDER BY p.name COLLATE NOCASE
    `).all(...params) as Array<Omit<PersonRow, "skills" | "aspirations" | "currentAssignment">>;
    return rows.map((person) => {
      const skills = this.db.prepare(`
        SELECT s.name FROM skills s
        JOIN person_skills ps ON ps.skill_id = s.id
        WHERE ps.person_id = ? ORDER BY s.name
      `).all(person.id) as Array<{ name: string }>;
      const aspirations = this.db.prepare(`
        SELECT name FROM aspirations WHERE person_id = ? AND status != 'bloomed' ORDER BY created_at
      `).all(person.id) as Array<{ name: string }>;
      const assignment = this.db.prepare(`
        SELECT id, title FROM assignments
        WHERE assigned_person_id = ? AND status = 'assigned'
        ORDER BY created_at DESC LIMIT 1
      `).get(person.id) as { id: string; title: string } | undefined;
      return {
        ...person,
        skills: skills.map((skill) => skill.name),
        aspirations: aspirations.map((aspiration) => aspiration.name),
        currentAssignment: assignment ?? null
      };
    });
  }

  person(id: string): PersonRow | undefined {
    return this.listPeople().find((person) => person.id === id);
  }

  createPerson(input: PersonInput): PersonRow {
    if (!this.teamExists(input.teamId)) throw new Error("Team not found in this workspace.");
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO people (id, workspace_id, name, role, fantasy_role, team_id, bloom_rating)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, this.workspaceId, input.name, input.role, input.fantasyRole ?? input.role, input.teamId, input.bloomRating ?? 1);
      this.replacePersonSkills(id, input.skills ?? []);
      this.replaceAspirations(id, input.aspirations ?? []);
      if (input.assignment?.trim()) {
        this.db.prepare(`
          INSERT INTO assignments (id, workspace_id, title, status, team_id, assigned_person_id)
          VALUES (?, ?, ?, 'assigned', ?, ?)
        `).run(randomUUID(), this.workspaceId, input.assignment.trim(), input.teamId, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.person(id)!;
  }

  updatePerson(id: string, patch: PersonPatch): PersonRow | undefined {
    if (!this.person(id)) return undefined;
    if (patch.teamId !== undefined && !this.teamExists(patch.teamId)) throw new Error("Team not found in this workspace.");
    this.db.exec("BEGIN");
    try {
      const fields: string[] = [];
      const values: Array<string | number> = [];
      const add = (column: string, value: string | number | undefined) => {
        if (value !== undefined) {
          fields.push(`${column} = ?`);
          values.push(value);
        }
      };
      add("name", patch.name);
      add("role", patch.role);
      add("fantasy_role", patch.fantasyRole);
      add("team_id", patch.teamId);
      add("bloom_rating", patch.bloomRating);
      if (fields.length) this.db.prepare(`UPDATE people SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...values, id, this.workspaceId);
      if (patch.skills !== undefined) this.replacePersonSkills(id, patch.skills);
      if (patch.aspirations !== undefined) this.replaceAspirations(id, patch.aspirations);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.person(id);
  }

  deletePerson(id: string): boolean {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE assignments
        SET assigned_person_id = NULL, status = 'unassigned'
        WHERE assigned_person_id = ? AND workspace_id = ? AND status = 'assigned'
      `).run(id, this.workspaceId);
      const deleted = this.db.prepare("DELETE FROM people WHERE id = ? AND workspace_id = ?").run(id, this.workspaceId).changes > 0;
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createTeam(input: TeamInput): TeamRow {
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO teams (id, workspace_id, name, fantasy_name, description, fantasy_description, color)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, this.workspaceId, input.name, input.fantasyName, input.description ?? "", input.fantasyDescription ?? "", input.color ?? "rose");
      for (const skill of input.requiredSkills ?? []) this.db.prepare("INSERT INTO team_skills (team_id, workspace_id, name) VALUES (?, ?, ?)").run(id, this.workspaceId, skill);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listTeams().find((team) => team.id === id)!;
  }

  updateTeam(id: string, patch: TeamPatch): TeamRow | undefined {
    if (!this.listTeams().some((team) => team.id === id)) return undefined;
    this.db.exec("BEGIN");
    try {
      const fields: string[] = [];
      const values: Array<string> = [];
      const add = (column: string, value: string | undefined) => {
        if (value !== undefined) {
          fields.push(`${column} = ?`);
          values.push(value);
        }
      };
      add("name", patch.name);
      add("fantasy_name", patch.fantasyName);
      add("description", patch.description);
      add("fantasy_description", patch.fantasyDescription);
      add("color", patch.color);
      if (fields.length) this.db.prepare(`UPDATE teams SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...values, id, this.workspaceId);
      if (patch.requiredSkills !== undefined) {
        this.db.prepare("DELETE FROM team_skills WHERE team_id = ? AND workspace_id = ?").run(id, this.workspaceId);
        const addSkill = this.db.prepare("INSERT INTO team_skills (team_id, workspace_id, name) VALUES (?, ?, ?)");
        for (const skill of patch.requiredSkills) {
          const name = skill.trim();
          if (name) addSkill.run(id, this.workspaceId, name);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listTeams().find((team) => team.id === id);
  }

  deleteTeam(id: string): boolean {
    return this.db.prepare("DELETE FROM teams WHERE id = ? AND workspace_id = ?").run(id, this.workspaceId).changes > 0;
  }

  listAssignments(status?: string): AssignmentRow[] {
    const rows = this.db.prepare(`
      SELECT id, title, description, status, team_id AS teamId,
        assigned_person_id AS assignedPersonId, required_skill AS requiredSkill
      FROM assignments WHERE workspace_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at DESC, title
    `).all(this.workspaceId, ...(status ? [status] : [])) as AssignmentRow[];
    return rows;
  }

  createAssignment(input: AssignmentInput): AssignmentRow {
    if (input.teamId && !this.teamExists(input.teamId)) throw new Error("Team not found in this workspace.");
    if (input.assignedPersonId && !this.person(input.assignedPersonId)) throw new Error("Person not found in this workspace.");
    const id = randomUUID();
    const assignedPersonId = input.assignedPersonId ?? null;
    const status = assignedPersonId ? "assigned" : "unassigned";
    this.db.prepare(`
      INSERT INTO assignments (id, workspace_id, title, description, status, team_id, assigned_person_id, required_skill)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.workspaceId, input.title, input.description ?? "", status, input.teamId ?? null, assignedPersonId, input.requiredSkill ?? "");
    return this.listAssignments().find((assignment) => assignment.id === id)!;
  }

  updateAssignment(id: string, patch: Partial<AssignmentInput> & { status?: AssignmentRow["status"] }): AssignmentRow | undefined {
    const existing = this.listAssignments().find((assignment) => assignment.id === id);
    if (!existing) return undefined;
    if (patch.teamId && !this.teamExists(patch.teamId)) throw new Error("Team not found in this workspace.");
    if (patch.assignedPersonId && !this.person(patch.assignedPersonId)) throw new Error("Person not found in this workspace.");
    const title = patch.title ?? existing.title;
    const description = patch.description ?? existing.description;
    const teamId = patch.teamId === undefined ? existing.teamId : patch.teamId;
    let assignedPersonId = patch.assignedPersonId === undefined ? existing.assignedPersonId : patch.assignedPersonId;
    const status = patch.status ?? (assignedPersonId ? "assigned" : "unassigned");
    if (status === "unassigned") assignedPersonId = null;
    this.db.prepare(`
      UPDATE assignments
      SET title = ?, description = ?, team_id = ?, assigned_person_id = ?, required_skill = ?, status = ?
      WHERE id = ? AND workspace_id = ?
    `).run(title, description, teamId, assignedPersonId, patch.requiredSkill ?? existing.requiredSkill, status, id, this.workspaceId);
    return this.listAssignments().find((assignment) => assignment.id === id);
  }

  deleteAssignment(id: string): boolean {
    return this.db.prepare("DELETE FROM assignments WHERE id = ? AND workspace_id = ?").run(id, this.workspaceId).changes > 0;
  }

  private teamExists(teamId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM teams WHERE id = ? AND workspace_id = ?").get(teamId, this.workspaceId));
  }

  private replacePersonSkills(personId: string, skills: string[]): void {
    this.db.prepare("DELETE FROM person_skills WHERE person_id = ?").run(personId);
    const findSkill = this.db.prepare("SELECT id FROM skills WHERE name = ?");
    const addSkill = this.db.prepare("INSERT INTO skills (id, name) VALUES (?, ?)");
    const linkSkill = this.db.prepare("INSERT INTO person_skills (person_id, skill_id) VALUES (?, ?)");
    for (const rawSkill of skills) {
      const name = rawSkill.trim();
      if (!name) continue;
      let skill = findSkill.get(name) as { id: string } | undefined;
      if (!skill) {
        const id = randomUUID();
        addSkill.run(id, name);
        skill = { id };
      }
      linkSkill.run(personId, skill.id);
    }
  }

  private replaceAspirations(personId: string, aspirations: string[]): void {
    this.db.prepare("DELETE FROM aspirations WHERE person_id = ?").run(personId);
    const insert = this.db.prepare("INSERT INTO aspirations (id, person_id, name) VALUES (?, ?, ?)");
    for (const rawAspiration of aspirations) {
      const name = rawAspiration.trim();
      if (name) insert.run(randomUUID(), personId, name);
    }
  }
}
