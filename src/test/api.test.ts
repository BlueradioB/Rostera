import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createBackup } from "../backup.js";
import { AuthStore, createDatabase, RosterStore } from "../db.js";
import { createAppServer } from "../server.js";

const servers: ReturnType<typeof createAppServer>[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];
const cookies = new Map<string, string>();
const registeredEmails = new Map<string, string>();
let nextEmail = 0;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  databases.splice(0).forEach((database) => database.close());
  cookies.clear();
  registeredEmails.clear();
});

async function startApp() {
  const database = createDatabase();
  const server = createAppServer(new RosterStore(database), new AuthStore(database));
  databases.push(database);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  nextEmail += 1;
  const email = `owner-${nextEmail}@example.test`;
  registeredEmails.set(baseUrl, email);
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Test Owner",
      email,
      password: "strong-test-password",
      workspaceName: "Test Workspace"
    })
  });
  assert.equal(registration.status, 201);
  cookies.set(baseUrl, registration.headers.get("set-cookie")!.split(";")[0]!);
  return baseUrl;
}

async function jsonRequest(baseUrl: string, path: string, method = "GET", body?: unknown) {
  const request: RequestInit = { method };
  const cookie = cookies.get(baseUrl);
  if (cookie) request.headers = { cookie };
  if (body !== undefined) {
    request.headers = { ...request.headers, "content-type": "application/json" };
    request.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, request);
  return {
    response,
    payload: response.status === 204 ? {} : await response.json() as Record<string, any>
  };
}

test("serves the seeded dashboard and static app", async () => {
  const baseUrl = await startApp();
  const { response, payload } = await jsonRequest(baseUrl, "/api/dashboard");

  assert.equal(response.status, 200);
  assert.equal(payload.stats.people, 4);
  assert.equal(payload.stats.teams, 3);
  assert.equal(payload.people.length, 4);
  assert.equal(payload.assignments.length, 2);
  assert.equal(payload.stats.readyToGrow, 4);
  assert.equal(payload.stats.growthAreas, 4);
  assert.equal(payload.stats.unassignedAssignments, 2);
  assert.equal(payload.stats.assignedAssignments, 4);
  assert.equal(payload.stats.skillGaps, 1);
  assert.equal(payload.stats.skillCoverage, 89);
  assert.equal(payload.teams.find((team: { id: string }) => team.id === "product").members, 2);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Rostera/);
  const icon = await fetch(`${baseUrl}/assets/rostera-icon.png`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/png/);
  assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/data/rostera.sqlite`)).status, 404);
});

test("summarizes team skill gaps and ranks assignment suggestions by fit and workload", async () => {
  const baseUrl = await startApp();
  const teamResponse = await jsonRequest(baseUrl, "/api/teams", "POST", {
    name: "Research",
    fantasyName: "The Scribes",
    requiredSkills: ["Synthesis", "Analytics"]
  });
  const teamId = teamResponse.payload.team.id;
  const personResponse = await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "Casey Morgan",
    role: "Researcher",
    teamId,
    skills: ["Synthesis"]
  });
  const createdWork = await jsonRequest(baseUrl, "/api/assignments", "POST", {
    title: "Analyze research signals",
    teamId,
    requiredSkill: "Analytics"
  });

  let dashboard = (await jsonRequest(baseUrl, "/api/dashboard")).payload;
  let researchTeam = dashboard.teams.find((team: { id: string }) => team.id === teamId);
  assert.deepEqual(researchTeam.missingSkills, ["Analytics"]);
  assert.equal(researchTeam.skillCoverage, 50);
  assert.equal(dashboard.stats.skillGaps, 2);
  assert.equal(dashboard.stats.skillCoverage, 82);
  let recommendation = dashboard.assignments.find((item: { id: string }) => item.id === createdWork.payload.assignment.id).suggestedPeople[0];
  assert.equal(recommendation.id, personResponse.payload.person.id);
  assert.match(recommendation.reason, /No recorded Analytics match/);
  assert.match(recommendation.reason, /Available for new work/);

  const skilledPerson = await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "Morgan Ellis",
    role: "Data researcher",
    teamId,
    skills: ["Analytics"]
  });
  dashboard = (await jsonRequest(baseUrl, "/api/dashboard")).payload;
  researchTeam = dashboard.teams.find((team: { id: string }) => team.id === teamId);
  assert.deepEqual(researchTeam.missingSkills, []);
  assert.equal(researchTeam.skillCoverage, 100);
  recommendation = dashboard.assignments.find((item: { id: string }) => item.id === createdWork.payload.assignment.id).suggestedPeople[0];
  assert.equal(recommendation.id, skilledPerson.payload.person.id);
  assert.match(recommendation.reason, /Strength in Analytics/);
});

test("requires a session before exposing workspace roster data", async () => {
  const baseUrl = await startApp();
  const crossOrigin = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://untrusted.example"
    },
    body: JSON.stringify({
      name: "Blocked Account",
      email: "blocked@example.test",
      password: "strong-test-password",
      workspaceName: "Blocked Workspace"
    })
  });
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json() as { error: string }).error, /different web address/);

  cookies.delete(baseUrl);
  const response = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(response.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: registeredEmails.get(baseUrl), password: "strong-test-password" })
  });
  assert.equal(login.status, 200);
  cookies.set(baseUrl, login.headers.get("set-cookie")!.split(";")[0]!);
  const dashboard = await jsonRequest(baseUrl, "/api/dashboard");
  assert.equal(dashboard.response.status, 200);
  const logout = await jsonRequest(baseUrl, "/api/auth/logout", "POST", {});
  assert.equal(logout.response.status, 200);
  assert.equal((await jsonRequest(baseUrl, "/api/dashboard")).response.status, 401);
});

test("isolates workspaces and enforces owner-created single-use invitations", async () => {
  const baseUrl = await startApp();
  const ownerCookie = cookies.get(baseUrl)!;
  const createdWorkspace = await jsonRequest(baseUrl, "/api/workspaces", "POST", { name: "Second Garden" });
  assert.equal(createdWorkspace.response.status, 201);
  const secondWorkspaceId = createdWorkspace.payload.workspace.id;
  const emptyDashboard = await jsonRequest(baseUrl, "/api/dashboard");
  assert.equal(emptyDashboard.payload.stats.people, 0);
  assert.equal(emptyDashboard.payload.stats.teams, 3);

  const invited = await jsonRequest(baseUrl, "/api/invitations", "POST", {});
  assert.equal(invited.response.status, 201);
  assert.equal(new URL(invited.payload.url).origin, baseUrl);
  const inviteToken = new URL(invited.payload.url).searchParams.get("invite")!;
  const invitationRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Invited Member",
      email: "invitee@example.test",
      password: "another-strong-password",
      invitationToken: inviteToken
    })
  });
  assert.equal(invitationRegistration.status, 201);
  const memberCookie = invitationRegistration.headers.get("set-cookie")!.split(";")[0]!;
  cookies.set(baseUrl, memberCookie);
  const memberSession = await jsonRequest(baseUrl, "/api/auth/me");
  assert.equal(memberSession.payload.role, "member");
  assert.equal(memberSession.payload.workspace.id, secondWorkspaceId);
  assert.equal((await jsonRequest(baseUrl, "/api/dashboard")).payload.stats.people, 0);
  assert.equal((await jsonRequest(baseUrl, "/api/teams/product")).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, "/api/workspaces/switch", "POST", { workspaceId: "workspace-default" })).response.status, 404);

  const memberDashboard = await jsonRequest(baseUrl, "/api/dashboard");
  assert.equal(memberDashboard.response.status, 200);
  assert.equal((await jsonRequest(baseUrl, "/api/teams", "POST", {
    name: "Unauthorized",
    fantasyName: "Unauthorized"
  })).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/teams/product", "PATCH", { name: "Unauthorized" })).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/teams/product", "DELETE")).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "Unauthorized",
    role: "Member",
    teamId: "product"
  })).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/assignments", "POST", { title: "Unauthorized" })).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/assignments/unknown", "PATCH", { title: "Unauthorized" })).response.status, 403);
  assert.equal((await jsonRequest(baseUrl, "/api/assignments/unknown", "DELETE")).response.status, 403);

  const forbiddenInvite = await jsonRequest(baseUrl, "/api/invitations", "POST", {});
  assert.equal(forbiddenInvite.response.status, 403);

  const reusedInvite = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Another Member",
      email: "another@example.test",
      password: "yet-another-strong-password",
      invitationToken: inviteToken
    })
  });
  assert.equal(reusedInvite.status, 400);

  cookies.set(baseUrl, ownerCookie);
  const switchBack = await jsonRequest(baseUrl, "/api/workspaces/switch", "POST", { workspaceId: "workspace-default" });
  assert.equal(switchBack.response.status, 200);
  const originalDashboard = await jsonRequest(baseUrl, "/api/dashboard");
  assert.equal(originalDashboard.payload.stats.people, 4);
});

test("creates a person, persists skills and aspirations, and moves them between teams", async () => {
  const baseUrl = await startApp();
  const created = await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "Taylor Brooks",
    role: "Content designer",
    fantasyRole: "Lorekeeper",
    teamId: "product",
    bloomRating: 2,
    skills: ["Writing", "Facilitation"],
    aspirations: ["Product strategy", "Mentoring"],
    assignment: "Help center refresh"
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.payload.person.currentAssignment.title, "Help center refresh");
  assert.deepEqual(created.payload.person.skills, ["Facilitation", "Writing"]);
  assert.equal(created.payload.person.aspirations.length, 2);

  const moved = await jsonRequest(baseUrl, `/api/people/${created.payload.person.id}`, "PATCH", { teamId: "customer" });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.payload.person.teamId, "customer");

  const filtered = await jsonRequest(baseUrl, "/api/people?teamId=customer&q=taylor");
  assert.equal(filtered.payload.people.length, 1);
  assert.equal(filtered.payload.people[0].id, created.payload.person.id);

  const deleted = await jsonRequest(baseUrl, `/api/people/${created.payload.person.id}`, "DELETE");
  assert.equal(deleted.response.status, 204);
  const dashboard = await jsonRequest(baseUrl, "/api/dashboard");
  assert.equal(dashboard.payload.stats.people, 4);
  assert.ok(dashboard.payload.assignments.some((assignment: { title: string }) => assignment.title === "Help center refresh"));
});

test("creates, assigns, completes, and deletes unassigned work", async () => {
  const baseUrl = await startApp();
  const created = await jsonRequest(baseUrl, "/api/assignments", "POST", {
    title: "Write onboarding guide",
    description: "Create a guide for new customers.",
    teamId: "customer",
    requiredSkill: "Enablement"
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.assignment.status, "unassigned");

  const dashboard = await jsonRequest(baseUrl, "/api/dashboard");
  const assignment = dashboard.payload.assignments.find((item: { id: string }) => item.id === created.payload.assignment.id);
  assert.ok(assignment.suggestedPeople.some((person: { id: string }) => person.id === "sam-kim"));

  const assigned = await jsonRequest(baseUrl, `/api/assignments/${created.payload.assignment.id}`, "PATCH", { assignedPersonId: "sam-kim" });
  assert.equal(assigned.payload.assignment.status, "assigned");
  assert.equal(assigned.payload.assignment.assignedPersonId, "sam-kim");

  const reassigned = await jsonRequest(baseUrl, `/api/assignments/${created.payload.assignment.id}`, "PATCH", {
    assignedPersonId: "maya-chen",
    teamId: "product"
  });
  assert.equal(reassigned.payload.assignment.assignedPersonId, "maya-chen");
  assert.equal(reassigned.payload.assignment.teamId, "product");

  const completed = await jsonRequest(baseUrl, `/api/assignments/${created.payload.assignment.id}`, "PATCH", { status: "completed" });
  assert.equal(completed.payload.assignment.status, "completed");
  const deleted = await jsonRequest(baseUrl, `/api/assignments/${created.payload.assignment.id}`, "DELETE");
  assert.equal(deleted.response.status, 204);
});

test("validates request data and protects teams that still have members", async () => {
  const baseUrl = await startApp();
  const badPerson = await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "",
    role: "Designer",
    teamId: "missing",
    bloomRating: 9
  });
  assert.equal(badPerson.response.status, 400);

  const badTeam = await jsonRequest(baseUrl, "/api/people", "POST", {
    name: "Taylor",
    role: "Designer",
    teamId: "missing"
  });
  assert.equal(badTeam.response.status, 404);

  const deletion = await jsonRequest(baseUrl, "/api/teams/product", "DELETE");
  assert.equal(deletion.response.status, 409);
  const unchanged = await jsonRequest(baseUrl, "/api/teams/product");
  assert.equal(unchanged.response.status, 200);
});

test("creates and updates teams with skill requirements", async () => {
  const baseUrl = await startApp();
  const created = await jsonRequest(baseUrl, "/api/teams", "POST", {
    name: "Research",
    fantasyName: "The Scribes",
    requiredSkills: ["Synthesis", "Interviews"]
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.payload.team.requiredSkills, ["Interviews", "Synthesis"]);

  const updated = await jsonRequest(baseUrl, `/api/teams/${created.payload.team.id}`, "PATCH", {
    fantasyName: "The Lorekeepers",
    requiredSkills: ["Synthesis"]
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.team.fantasyName, "The Lorekeepers");
  assert.deepEqual(updated.payload.team.requiredSkills, ["Synthesis"]);
});

test("SQLite-backed people and skills survive a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "rostera-persistence-"));
  const filename = join(directory, "roster.sqlite");
  try {
    const firstDatabase = createDatabase(filename);
    const created = new RosterStore(firstDatabase).createPerson({
      name: "Persistent Person",
      role: "Researcher",
      teamId: "product",
      skills: ["Synthesis"]
    });

    test("creates restorable SQLite backups and prunes older snapshots", async () => {
      const directory = mkdtempSync(join(tmpdir(), "rostera-backups-"));
      const filename = join(directory, "roster.sqlite");
      const backupDirectory = join(directory, "backups");
      const database = createDatabase(filename);
      try {
        const created = new RosterStore(database).createPerson({
          name: "Backed Up Person",
          role: "Researcher",
          teamId: "product",
          skills: ["Synthesis"]
        });
        await createBackup(database, backupDirectory, 2, new Date("2026-10-16T12:00:00.000Z"));
        await createBackup(database, backupDirectory, 2, new Date("2026-10-17T12:00:00.000Z"));
        const latestBackup = await createBackup(database, backupDirectory, 2, new Date("2026-10-18T12:00:00.000Z"));
        const restoredDatabase = new DatabaseSync(latestBackup);
        try {
          const restoredPerson = new RosterStore(restoredDatabase).person(created.id);
          assert.equal(restoredPerson?.name, "Backed Up Person");
          assert.deepEqual(restoredPerson?.skills, ["Synthesis"]);
          assert.equal(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 2);
        } finally {
          restoredDatabase.close();
        }
        assert.equal(readdirSync(backupDirectory).length, 2);
      } finally {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test("migrates an existing single-workspace roster without losing records", () => {
      const directory = mkdtempSync(join(tmpdir(), "rostera-legacy-"));
      const filename = join(directory, "legacy.sqlite");
      try {
        const legacy = new DatabaseSync(filename);
        legacy.exec(`
          CREATE TABLE teams (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, fantasy_name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '', fantasy_description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'rose', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE team_skills (team_id TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL, PRIMARY KEY (team_id, name));
          CREATE TABLE people (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, fantasy_role TEXT NOT NULL,
            team_id TEXT NOT NULL REFERENCES teams(id), bloom_rating INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
          CREATE TABLE person_skills (person_id TEXT NOT NULL REFERENCES people(id), skill_id TEXT NOT NULL REFERENCES skills(id), PRIMARY KEY (person_id, skill_id));
          CREATE TABLE aspirations (
            id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'budding', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (person_id, name)
          );
          CREATE TABLE assignments (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL, team_id TEXT REFERENCES teams(id), assigned_person_id TEXT REFERENCES people(id),
            required_skill TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO teams (id, name, fantasy_name) VALUES ('legacy-team', 'Legacy Team', 'Roseguard');
          INSERT INTO team_skills (team_id, name) VALUES ('legacy-team', 'Research');
          INSERT INTO people (id, name, role, fantasy_role, team_id) VALUES ('legacy-person', 'Legacy Person', 'Researcher', 'Sage', 'legacy-team');
          INSERT INTO assignments (id, title, status, team_id) VALUES ('legacy-task', 'Legacy task', 'unassigned', 'legacy-team');
        `);
        legacy.close();

        const migrated = createDatabase(filename);
        const dashboard = new RosterStore(migrated).dashboard();
        assert.equal(dashboard.stats.people, 1);
        assert.equal(dashboard.stats.teams, 1);
        assert.equal(dashboard.people[0]!.id, "legacy-person");
        assert.deepEqual(dashboard.teams[0]!.requiredSkills, ["Research"]);
        assert.equal(dashboard.assignments[0]!.id, "legacy-task");
        assert.equal(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 2);
        migrated.close();
        const migratedAgain = createDatabase(filename);
        assert.equal(new RosterStore(migratedAgain).dashboard().stats.people, 1);
        migratedAgain.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
    firstDatabase.close();

    const reopenedDatabase = createDatabase(filename);
    const restored = new RosterStore(reopenedDatabase).person(created.id);
    assert.equal(restored?.name, "Persistent Person");
    assert.deepEqual(restored?.skills, ["Synthesis"]);
    reopenedDatabase.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
