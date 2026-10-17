import { createServerClient } from "@supabase/ssr";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssignmentInput, PersonInput, PersonPatch, TeamInput, TeamPatch } from "../src/db.js";

type VercelRequest = IncomingMessage & { body?: unknown };
type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(value: unknown): VercelResponse;
  redirect(status: number, url: string): void;
};

type Role = "owner" | "member";
type JsonObject = Record<string, unknown>;
type Team = {
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
type Person = {
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
type Assignment = {
  id: string;
  title: string;
  description: string;
  status: "unassigned" | "assigned" | "completed";
  teamId: string | null;
  assignedPersonId: string | null;
  requiredSkill: string;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function requestHeader(request: VercelRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function send(response: VercelResponse, status: number, value: unknown): void {
  response.status(status).setHeader("cache-control", "no-store")
    .setHeader("x-content-type-options", "nosniff")
    .json(value);
}

function cookiesFromHeader(header: string | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return [];
    try {
      return [{ name, value: decodeURIComponent(value) }];
    } catch {
      return [{ name, value }];
    }
  });
}

function supabaseForRequest(request: VercelRequest, response: VercelResponse) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  return createServerClient(url, key, {
    cookieOptions: {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    },
    cookies: {
      getAll: () => cookiesFromHeader(requestHeader(request, "cookie")),
      setAll: (cookiesToSet) => {
        response.setHeader("Set-Cookie", cookiesToSet.map(({ name, value, options }) => {
          const attributes = [
            `${name}=${encodeURIComponent(value)}`,
            `Path=${options.path ?? "/"}`,
            ...(options.maxAge === undefined ? [] : [`Max-Age=${options.maxAge}`]),
            ...(options.domain ? [`Domain=${options.domain}`] : []),
            ...(options.httpOnly ? ["HttpOnly"] : []),
            ...(options.secure ? ["Secure"] : []),
            ...(options.sameSite ? [`SameSite=${String(options.sameSite).replace(/^./, (letter) => letter.toUpperCase())}`] : [])
          ];
          return attributes.join("; ");
        }));
      }
    }
  });
}

function checkSameOrigin(request: VercelRequest): void {
  const origin = requestHeader(request, "origin");
  const host = requestHeader(request, "host");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new HttpError(403, "This request came from a different web address.");
    }
    if (originUrl.host.toLowerCase() !== host?.toLowerCase()) {
      throw new HttpError(403, "This request came from a different web address.");
    }
  }
  if (requestHeader(request, "sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "This request came from a different web address.");
  }
}

function objectBody(request: VercelRequest): JsonObject {
  const body: unknown = request.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      throw new HttpError(400, "Request body must be valid JSON.");
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) return body as JsonObject;
  throw new HttpError(400, "A JSON request body is required.");
}

function stringField(body: JsonObject, key: string, required = false, max = 160): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string.`);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > max) throw new HttpError(400, `${key} is required and must be ${max} characters or fewer.`);
  return trimmed;
}

function nullableStringField(body: JsonObject, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} must be a non-empty string or null.`);
  return value.trim();
}

function stringArrayField(body: JsonObject, key: string, maxItems = 30): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${key} must be an array of up to ${maxItems} strings.`);
  }
  const values = value.map((item) => (item as string).trim()).filter(Boolean);
  if (values.some((item) => item.length > 100)) throw new HttpError(400, `${key} values must be 100 characters or fewer.`);
  return [...new Set(values)];
}

function numberField(body: JsonObject, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function personInput(body: JsonObject): PersonInput {
  const name = stringField(body, "name", true, 100)!;
  const role = stringField(body, "role", true, 100)!;
  const teamId = stringField(body, "teamId", true, 80)!;
  const fantasyRole = stringField(body, "fantasyRole", false, 100);
  if (fantasyRole === "") throw new HttpError(400, "fantasyRole cannot be empty.");
  return {
    name,
    role,
    teamId,
    ...(fantasyRole === undefined ? {} : { fantasyRole }),
    ...(numberField(body, "bloomRating", 1, 5) === undefined ? {} : { bloomRating: numberField(body, "bloomRating", 1, 5)! }),
    ...(stringArrayField(body, "skills") === undefined ? {} : { skills: stringArrayField(body, "skills")! }),
    ...(stringArrayField(body, "aspirations") === undefined ? {} : { aspirations: stringArrayField(body, "aspirations")! }),
    ...(stringField(body, "assignment", false, 160) === undefined ? {} : { assignment: stringField(body, "assignment", false, 160)! })
  };
}

function personPatch(body: JsonObject): PersonPatch {
  const patch: PersonPatch = {};
  const name = stringField(body, "name", false, 100);
  const role = stringField(body, "role", false, 100);
  const teamId = stringField(body, "teamId", false, 80);
  const fantasyRole = stringField(body, "fantasyRole", false, 100);
  const bloomRating = numberField(body, "bloomRating", 1, 5);
  const skills = stringArrayField(body, "skills");
  const aspirations = stringArrayField(body, "aspirations");
  if ([name, role, teamId, fantasyRole].some((value) => value === "")) {
    throw new HttpError(400, "Person names, roles, and teamId cannot be empty.");
  }
  if (name !== undefined) patch.name = name;
  if (role !== undefined) patch.role = role;
  if (teamId !== undefined) patch.teamId = teamId;
  if (fantasyRole !== undefined) patch.fantasyRole = fantasyRole;
  if (bloomRating !== undefined) patch.bloomRating = bloomRating;
  if (skills !== undefined) patch.skills = skills;
  if (aspirations !== undefined) patch.aspirations = aspirations;
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Provide at least one person field to update.");
  return patch;
}

function teamInput(body: JsonObject): TeamInput {
  const name = stringField(body, "name", true, 100)!;
  const fantasyName = stringField(body, "fantasyName", true, 100)!;
  const color = stringField(body, "color", false, 24);
  if (color !== undefined && !["rose", "green", "blue"].includes(color)) throw new HttpError(400, "color must be rose, green, or blue.");
  return {
    name,
    fantasyName,
    ...(stringField(body, "description", false, 300) === undefined ? {} : { description: stringField(body, "description", false, 300)! }),
    ...(stringField(body, "fantasyDescription", false, 300) === undefined ? {} : { fantasyDescription: stringField(body, "fantasyDescription", false, 300)! }),
    ...(color === undefined ? {} : { color }),
    ...(stringArrayField(body, "requiredSkills") === undefined ? {} : { requiredSkills: stringArrayField(body, "requiredSkills")! })
  };
}

function teamPatch(body: JsonObject): TeamPatch {
  const patch: TeamPatch = {};
  const name = stringField(body, "name", false, 100);
  const fantasyName = stringField(body, "fantasyName", false, 100);
  const description = stringField(body, "description", false, 300);
  const fantasyDescription = stringField(body, "fantasyDescription", false, 300);
  const color = stringField(body, "color", false, 24);
  const requiredSkills = stringArrayField(body, "requiredSkills");
  if ([name, fantasyName].some((value) => value === "")) throw new HttpError(400, "Team names cannot be empty.");
  if (color !== undefined && !["rose", "green", "blue"].includes(color)) throw new HttpError(400, "color must be rose, green, or blue.");
  if (name !== undefined) patch.name = name;
  if (fantasyName !== undefined) patch.fantasyName = fantasyName;
  if (description !== undefined) patch.description = description;
  if (fantasyDescription !== undefined) patch.fantasyDescription = fantasyDescription;
  if (color !== undefined) patch.color = color;
  if (requiredSkills !== undefined) patch.requiredSkills = requiredSkills;
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Provide at least one team field to update.");
  return patch;
}

function assignmentInput(body: JsonObject): AssignmentInput {
  const input: AssignmentInput = { title: stringField(body, "title", true, 160)! };
  const description = stringField(body, "description", false, 500);
  const requiredSkill = stringField(body, "requiredSkill", false, 100);
  const teamId = nullableStringField(body, "teamId");
  const assignedPersonId = nullableStringField(body, "assignedPersonId");
  if (description !== undefined) input.description = description;
  if (requiredSkill !== undefined) input.requiredSkill = requiredSkill;
  if (teamId !== undefined) input.teamId = teamId;
  if (assignedPersonId !== undefined) input.assignedPersonId = assignedPersonId;
  return input;
}

type AssignmentPatch = Partial<AssignmentInput> & { status?: Assignment["status"] };
function assignmentPatch(body: JsonObject): AssignmentPatch {
  const patch: AssignmentPatch = {};
  const title = stringField(body, "title", false, 160);
  const description = stringField(body, "description", false, 500);
  const requiredSkill = stringField(body, "requiredSkill", false, 100);
  const teamId = nullableStringField(body, "teamId");
  const assignedPersonId = nullableStringField(body, "assignedPersonId");
  if (title === "") throw new HttpError(400, "title cannot be empty.");
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (requiredSkill !== undefined) patch.requiredSkill = requiredSkill;
  if (teamId !== undefined) patch.teamId = teamId;
  if (assignedPersonId !== undefined) patch.assignedPersonId = assignedPersonId;
  if (body.status !== undefined) {
    if (body.status !== "unassigned" && body.status !== "assigned" && body.status !== "completed") {
      throw new HttpError(400, "status must be unassigned, assigned, or completed.");
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Provide at least one assignment field to update.");
  return patch;
}

function resultError(error: { message: string; code?: string; status?: number }): never {
  const status = error.status && error.status >= 400 && error.status < 500
    ? error.status
    : error.code === "PGRST116" ? 404 : error.code === "23503" ? 400 : 500;
  throw new HttpError(status, status === 500 ? "The database request failed." : error.message);
}

async function query<T>(request: PromiseLike<{ data: T; error: { message: string; code?: string; status?: number } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await request;
  if (error) resultError(error);
  if (data === null || data === undefined) throw new HttpError(500, "The database returned no result.");
  return data as NonNullable<T>;
}

async function requireSession(supabase: ReturnType<typeof supabaseForRequest>, request: VercelRequest) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Sign in to access this workspace.");
  const user = data.user;
  const memberships = await query(supabase.from("workspace_members").select("workspace_id, role").eq("user_id", user.id));
  const workspaceIds = memberships.map((entry) => entry.workspace_id);
  const [workspaces, profile] = await Promise.all([
    workspaceIds.length
      ? query(supabase.from("workspaces").select("id, name").in("id", workspaceIds))
      : Promise.resolve([]),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
  ]);
  if (profile.error) resultError(profile.error);
  const availableWorkspaces = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    role: memberships.find((entry) => entry.workspace_id === workspace.id)?.role as Role
  }));
  const requestedWorkspace = requestHeader(request, "x-workspace-id");
  const workspace = availableWorkspaces.find((entry) => entry.id === requestedWorkspace) ?? availableWorkspaces[0];
  if (!workspace) throw new HttpError(403, "Your account does not belong to a workspace.");
  return {
    user: { id: user.id, name: profile.data?.full_name ?? String(user.user_metadata.full_name ?? ""), email: user.email ?? "" },
    workspace,
    role: workspace.role,
    workspaces: availableWorkspaces
  };
}

async function requireOwner(role: Role): Promise<void> {
  if (role !== "owner") throw new HttpError(403, "Only workspace owners can change roster and work data.");
}

async function loadWorkspaceData(supabase: ReturnType<typeof supabaseForRequest>, workspaceId: string) {
  const [teamRows, teamSkillRows, personRows, skillRows, personSkillRows, aspirationRows, assignmentRows] = await Promise.all([
    query(supabase.from("teams").select("*").eq("workspace_id", workspaceId).order("name")),
    query(supabase.from("team_skills").select("team_id, name").eq("workspace_id", workspaceId)),
    query(supabase.from("people").select("*").eq("workspace_id", workspaceId).order("name")),
    query(supabase.from("skills").select("id, name").eq("workspace_id", workspaceId)),
    query(supabase.from("person_skills").select("person_id, skill_id").eq("workspace_id", workspaceId)),
    query(supabase.from("aspirations").select("person_id, name, status").eq("workspace_id", workspaceId)),
    query(supabase.from("assignments").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }))
  ]);

  const skillsById = new Map(skillRows.map((skill) => [skill.id, skill.name]));
  const skillNamesByPerson = new Map<string, string[]>();
  for (const link of personSkillRows) {
    const name = skillsById.get(link.skill_id);
    if (name) skillNamesByPerson.set(link.person_id, [...(skillNamesByPerson.get(link.person_id) ?? []), name]);
  }
  const aspirationsByPerson = new Map<string, string[]>();
  for (const aspiration of aspirationRows) {
    if (aspiration.status !== "bloomed") {
      aspirationsByPerson.set(aspiration.person_id, [...(aspirationsByPerson.get(aspiration.person_id) ?? []), aspiration.name]);
    }
  }
  const people: Person[] = personRows.map((person) => {
    const assignment = assignmentRows.find((row) => row.status === "assigned" && row.assigned_person_id === person.id);
    return {
      id: person.id,
      name: person.name,
      role: person.role,
      fantasyRole: person.fantasy_role,
      teamId: person.team_id,
      bloomRating: person.bloom_rating,
      skills: (skillNamesByPerson.get(person.id) ?? []).sort((a, b) => a.localeCompare(b)),
      aspirations: aspirationsByPerson.get(person.id) ?? [],
      currentAssignment: assignment ? { id: assignment.id, title: assignment.title } : null
    };
  });
  const teams: Team[] = teamRows.map((team) => {
    const requiredSkills = teamSkillRows.filter((skill) => skill.team_id === team.id).map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
    const memberIds = new Set(people.filter((person) => person.teamId === team.id).map((person) => person.id));
    const availableSkills = new Set(personSkillRows.filter((link) => memberIds.has(link.person_id))
      .map((link) => skillsById.get(link.skill_id)?.toLocaleLowerCase()).filter((skill): skill is string => Boolean(skill)));
    const missingSkills = requiredSkills.filter((skill) => !availableSkills.has(skill.toLocaleLowerCase()));
    return {
      id: team.id,
      name: team.name,
      fantasyName: team.fantasy_name,
      description: team.description,
      fantasyDescription: team.fantasy_description,
      color: team.color,
      requiredSkills,
      missingSkills,
      members: memberIds.size,
      skillCoverage: requiredSkills.length ? Math.round((requiredSkills.length - missingSkills.length) / requiredSkills.length * 100) : 0
    };
  });
  const assignments: Assignment[] = assignmentRows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    teamId: row.team_id,
    assignedPersonId: row.assigned_person_id,
    requiredSkill: row.required_skill
  }));
  return { teams, people, assignments, aspirationRows };
}

async function savePersonSkills(
  supabase: ReturnType<typeof supabaseForRequest>,
  workspaceId: string,
  personId: string,
  names: string[]
): Promise<void> {
  const normalized = [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()];
  let skillRows = normalized.length
    ? await query(supabase.from("skills").select("id, name").eq("workspace_id", workspaceId))
    : [];
  const known = new Set(skillRows.map((skill) => skill.name.toLocaleLowerCase()));
  const missing = normalized.filter((name) => !known.has(name.toLocaleLowerCase()));
  if (missing.length) {
    const created = await query(supabase.from("skills").insert(missing.map((name) => ({ workspace_id: workspaceId, name }))).select("id, name"));
    skillRows = [...skillRows, ...created];
  }
  await query(supabase.from("person_skills").delete().eq("workspace_id", workspaceId).eq("person_id", personId).select("person_id"));
  if (skillRows.length) {
    await query(supabase.from("person_skills").insert(skillRows.map((skill) => ({
      workspace_id: workspaceId, person_id: personId, skill_id: skill.id
    }))).select("person_id"));
  }
}

async function saveAspirations(
  supabase: ReturnType<typeof supabaseForRequest>,
  workspaceId: string,
  personId: string,
  names: string[]
): Promise<void> {
  await query(supabase.from("aspirations").delete().eq("workspace_id", workspaceId).eq("person_id", personId).select("id"));
  if (names.length) {
    await query(supabase.from("aspirations").insert(names.map((name) => ({
      workspace_id: workspaceId, person_id: personId, name, status: "budding"
    }))).select("id"));
  }
}

async function dashboard(supabase: ReturnType<typeof supabaseForRequest>, workspaceId: string) {
  const data = await loadWorkspaceData(supabase, workspaceId);
  const { teams, people, assignments } = data;
  const unassigned = assignments.filter((assignment) => assignment.status === "unassigned");
  const activeLoad = new Map<string, number>();
  assignments.filter((assignment) => assignment.status === "assigned" && assignment.assignedPersonId)
    .forEach((assignment) => activeLoad.set(assignment.assignedPersonId!, (activeLoad.get(assignment.assignedPersonId!) ?? 0) + 1));
  const suggestions = unassigned.map((assignment) => {
    const assignmentTeam = teams.find((team) => team.id === assignment.teamId);
    const candidates = people.map((person) => {
      const skillMatches = assignment.requiredSkill
        ? person.skills.filter((skill) => skill.toLocaleLowerCase() === assignment.requiredSkill.toLocaleLowerCase())
        : [];
      const relatedSkills = assignment.requiredSkill ? [] : (assignmentTeam?.requiredSkills ?? [])
        .filter((required) => person.skills.some((skill) => skill.toLocaleLowerCase() === required.toLocaleLowerCase()));
      const matchesTeam = Boolean(assignment.teamId && person.teamId === assignment.teamId);
      const load = activeLoad.get(person.id) ?? 0;
      const score = skillMatches.length * 100 + relatedSkills.length * 20 + (matchesTeam ? 25 : 0) + person.bloomRating * 4 - load * 12;
      const reasons = [
        ...skillMatches.map((skill) => `Strength in ${skill}`),
        ...relatedSkills.slice(0, 1).map((skill) => `Strength in ${skill}`),
        ...(assignment.requiredSkill && !skillMatches.length ? [`No recorded ${assignment.requiredSkill} match`] : []),
        ...(matchesTeam ? ["On the requested team"] : []),
        ...(load === 0 ? ["Available for new work"] : [`${load} active ${load === 1 ? "assignment" : "assignments"}`])
      ];
      return { person, score, reason: reasons.join(" · ") || "No matching skills recorded yet" };
    }).sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name));
    return { ...assignment, suggestedPeople: candidates.slice(0, 3).map(({ person, reason }) => ({ id: person.id, name: person.name, reason })) };
  });
  const requiredSkillCount = teams.reduce((total, team) => total + team.requiredSkills.length, 0);
  const skillGaps = teams.reduce((total, team) => total + team.missingSkills.length, 0);
  const activeAspirations = data.aspirationRows.filter((aspiration) => aspiration.status !== "bloomed");
  return {
    teams,
    people,
    assignments: suggestions,
    stats: {
      people: people.length,
      teams: teams.length,
      readyToGrow: new Set(activeAspirations.map((aspiration) => aspiration.person_id)).size,
      growthAreas: activeAspirations.length,
      unassignedAssignments: unassigned.length,
      assignedAssignments: assignments.filter((assignment) => assignment.status === "assigned").length,
      completedAssignments: assignments.filter((assignment) => assignment.status === "completed").length,
      skillGaps,
      skillCoverage: requiredSkillCount ? Math.round((requiredSkillCount - skillGaps) / requiredSkillCount * 100) : 0
    }
  };
}

function publicOrigin(request: VercelRequest): string {
  if (process.env.ROSTERA_PUBLIC_URL) return new URL(process.env.ROSTERA_PUBLIC_URL).origin;
  const vercelHost = process.env.VERCEL_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const host = vercelHost ?? requestHeader(request, "host");
  if (!host) throw new HttpError(400, "The request host is unavailable.");
  return `https://${host}`;
}

async function route(request: VercelRequest, response: VercelResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `https://${requestHeader(request, "host") ?? "localhost"}`);
  const path = url.pathname;
  if (path === "/api/health" && method === "GET") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (method !== "GET" && method !== "HEAD") checkSameOrigin(request);
  const supabase = supabaseForRequest(request, response);

  if (path === "/api/auth/me" && method === "GET") {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      send(response, 200, { user: null });
      return;
    }
    const session = await requireSession(supabase, request);
    send(response, 200, session);
    return;
  }
  if (path === "/api/auth/register" && method === "POST") {
    const body = objectBody(request);
    const name = stringField(body, "name", true, 100)!;
    const email = stringField(body, "email", true, 254)!;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "email must be a valid email address.");
    const password = stringField(body, "password", true, 256)!;
    if (password.length < 12) throw new HttpError(400, "password must be at least 12 characters.");
    const invitationToken = stringField(body, "invitationToken", false, 200);
    const workspaceName = stringField(body, "workspaceName", !invitationToken, 100);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          ...(invitationToken ? { invitation_token: invitationToken } : { workspace_name: workspaceName })
        },
        emailRedirectTo: `${publicOrigin(request)}/api/auth/callback`
      }
    });
    if (error) throw new HttpError(error.status ?? 400, error.message);
    send(response, 201, { user: data.user, session: Boolean(data.session), verificationRequired: !data.session });
    return;
  }
  if (path === "/api/auth/login" && method === "POST") {
    const body = objectBody(request);
    const email = stringField(body, "email", true, 254)!;
    const password = stringField(body, "password", true, 256)!;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new HttpError(401, "Email or password is incorrect.");
    send(response, 200, { user: data.user });
    return;
  }
  if (path === "/api/auth/logout" && method === "POST") {
    await supabase.auth.signOut();
    send(response, 200, { loggedOut: true });
    return;
  }
  if (path === "/api/auth/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) throw new HttpError(400, "The email confirmation code is missing.");
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw new HttpError(400, error.message);
    response.redirect(303, "/");
    return;
  }

  const session = await requireSession(supabase, request);
  const workspaceId = session.workspace.id;
  if (path === "/api/workspaces" && method === "GET") {
    send(response, 200, { workspaces: session.workspaces });
    return;
  }
  if (path === "/api/workspaces" && method === "POST") {
    const name = stringField(objectBody(request), "name", true, 100)!;
    const workspace = await query(supabase.rpc("create_workspace", { workspace_name: name }));
    send(response, 201, { workspace: { id: workspace.id, name: workspace.name, role: "owner" } });
    return;
  }
  if (path === "/api/workspaces/switch" && method === "POST") {
    const targetId = stringField(objectBody(request), "workspaceId", true, 80)!;
    const workspace = session.workspaces.find((entry) => entry.id === targetId);
    if (!workspace) throw new HttpError(404, "Workspace not found.");
    send(response, 200, { workspaceId: targetId });
    return;
  }
  if (path === "/api/workspaces/current" && method === "PATCH") {
    if (session.role !== "owner") throw new HttpError(403, "Only workspace owners can rename this workspace.");
    const name = stringField(objectBody(request), "name", true, 100)!;
    const workspace = await query(supabase.from("workspaces").update({ name }).eq("id", workspaceId).select("id, name").single());
    send(response, 200, { workspace: { ...workspace, role: session.role } });
    return;
  }
  if (path === "/api/invitations" && method === "GET") {
    if (session.role !== "owner") throw new HttpError(403, "Only workspace owners can view invitations.");
    const invitations = await query(supabase.from("invitations").select("workspace_id, created_by, expires_at, created_at")
      .eq("workspace_id", workspaceId).is("accepted_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }));
    send(response, 200, { invitations: invitations.map((item) => ({
      workspaceId: item.workspace_id, createdBy: item.created_by, expiresAt: item.expires_at, createdAt: item.created_at
    })) });
    return;
  }
  if (path === "/api/invitations" && method === "POST") {
    if (session.role !== "owner") throw new HttpError(403, "Only workspace owners can create invitations.");
    const result = await query(supabase.rpc("create_workspace_invitation", { target_workspace_id: workspaceId }));
    const invitation = Array.isArray(result) ? result[0] : result;
    send(response, 201, {
      invitation: { workspaceId, createdBy: session.user.id, expiresAt: invitation.expires_at, createdAt: new Date().toISOString() },
      url: `${publicOrigin(request)}/?invite=${encodeURIComponent(invitation.token)}`
    });
    return;
  }
  if (path === "/api/invitations/redeem" && method === "POST") {
    const token = stringField(objectBody(request), "token", true, 200)!;
    const redeemedWorkspaceId = await query(supabase.rpc("redeem_workspace_invitation", { invitation_token: token }));
    send(response, 200, { workspaceId: redeemedWorkspaceId });
    return;
  }

  if (path === "/api/dashboard" && method === "GET") {
    send(response, 200, await dashboard(supabase, workspaceId));
    return;
  }

  if (path === "/api/teams" && method === "GET") {
    const data = await loadWorkspaceData(supabase, workspaceId);
    send(response, 200, { teams: data.teams });
    return;
  }
  if (path === "/api/teams" && method === "POST") {
    await requireOwner(session.role);
    const input = teamInput(objectBody(request));
    const row = await query(supabase.from("teams").insert({
      workspace_id: workspaceId, name: input.name, fantasy_name: input.fantasyName,
      description: input.description ?? "", fantasy_description: input.fantasyDescription ?? "", color: input.color ?? "rose"
    }).select("id").single());
    if (input.requiredSkills?.length) {
      await query(supabase.from("team_skills").insert(input.requiredSkills.map((name) => ({
        workspace_id: workspaceId, team_id: row.id, name
      }))).select("team_id"));
    }
    const team = (await loadWorkspaceData(supabase, workspaceId)).teams.find((item) => item.id === row.id);
    send(response, 201, { team });
    return;
  }
  const teamMatch = path.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch) {
    const id = decodeURIComponent(teamMatch[1]!);
    if (method === "GET") {
      const team = (await loadWorkspaceData(supabase, workspaceId)).teams.find((item) => item.id === id);
      if (!team) throw new HttpError(404, "Team not found.");
      send(response, 200, { team });
      return;
    }
    if (method === "PATCH") {
      await requireOwner(session.role);
      const patch = teamPatch(objectBody(request));
      const values: JsonObject = {};
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.fantasyName !== undefined) values.fantasy_name = patch.fantasyName;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.fantasyDescription !== undefined) values.fantasy_description = patch.fantasyDescription;
      if (patch.color !== undefined) values.color = patch.color;
      if (Object.keys(values).length) await query(supabase.from("teams").update(values).eq("workspace_id", workspaceId).eq("id", id).select("id"));
      if (patch.requiredSkills !== undefined) {
        await query(supabase.from("team_skills").delete().eq("workspace_id", workspaceId).eq("team_id", id).select("team_id"));
        if (patch.requiredSkills.length) {
          await query(supabase.from("team_skills").insert(patch.requiredSkills.map((name) => ({ workspace_id: workspaceId, team_id: id, name }))).select("team_id"));
        }
      }
      const team = (await loadWorkspaceData(supabase, workspaceId)).teams.find((item) => item.id === id);
      if (!team) throw new HttpError(404, "Team not found.");
      send(response, 200, { team });
      return;
    }
    if (method === "DELETE") {
      await requireOwner(session.role);
      const deleted = await query(supabase.from("teams").delete().eq("workspace_id", workspaceId).eq("id", id).select("id"));
      if (!deleted.length) throw new HttpError(404, "Team not found.");
      response.status(204).end();
      return;
    }
  }

  if (path === "/api/people" && method === "GET") {
    const teamId = url.searchParams.get("teamId");
    const search = url.searchParams.get("q")?.trim().toLocaleLowerCase();
    let people = (await loadWorkspaceData(supabase, workspaceId)).people;
    if (teamId && teamId !== "all") people = people.filter((person) => person.teamId === teamId);
    if (search) people = people.filter((person) => person.name.toLocaleLowerCase().includes(search) || person.role.toLocaleLowerCase().includes(search));
    send(response, 200, { people });
    return;
  }
  if (path === "/api/people" && method === "POST") {
    await requireOwner(session.role);
    const input = personInput(objectBody(request));
    const row = await query(supabase.from("people").insert({
      workspace_id: workspaceId,
      name: input.name,
      role: input.role,
      fantasy_role: input.fantasyRole ?? input.role,
      team_id: input.teamId,
      bloom_rating: input.bloomRating ?? 1
    }).select("id").single());
    await savePersonSkills(supabase, workspaceId, row.id, input.skills ?? []);
    await saveAspirations(supabase, workspaceId, row.id, input.aspirations ?? []);
    if (input.assignment?.trim()) {
      await query(supabase.from("assignments").insert({
        workspace_id: workspaceId, title: input.assignment.trim(), status: "assigned",
        team_id: input.teamId, assigned_person_id: row.id
      }).select("id"));
    }
    const person = (await loadWorkspaceData(supabase, workspaceId)).people.find((item) => item.id === row.id);
    send(response, 201, { person });
    return;
  }
  const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
  if (personMatch) {
    const id = decodeURIComponent(personMatch[1]!);
    if (method === "GET") {
      const person = (await loadWorkspaceData(supabase, workspaceId)).people.find((item) => item.id === id);
      if (!person) throw new HttpError(404, "Person not found.");
      send(response, 200, { person });
      return;
    }
    if (method === "PATCH") {
      await requireOwner(session.role);
      const patch = personPatch(objectBody(request));
      const values: JsonObject = {};
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.role !== undefined) values.role = patch.role;
      if (patch.fantasyRole !== undefined) values.fantasy_role = patch.fantasyRole;
      if (patch.teamId !== undefined) values.team_id = patch.teamId;
      if (patch.bloomRating !== undefined) values.bloom_rating = patch.bloomRating;
      if (Object.keys(values).length) {
        const updated = await query(supabase.from("people").update(values).eq("workspace_id", workspaceId).eq("id", id).select("id"));
        if (!updated.length) throw new HttpError(404, "Person not found.");
      }
      if (patch.skills !== undefined) await savePersonSkills(supabase, workspaceId, id, patch.skills);
      if (patch.aspirations !== undefined) await saveAspirations(supabase, workspaceId, id, patch.aspirations);
      const person = (await loadWorkspaceData(supabase, workspaceId)).people.find((item) => item.id === id);
      if (!person) throw new HttpError(404, "Person not found.");
      send(response, 200, { person });
      return;
    }
    if (method === "DELETE") {
      await requireOwner(session.role);
      await query(supabase.from("assignments").update({ assigned_person_id: null, status: "unassigned" })
        .eq("workspace_id", workspaceId).eq("assigned_person_id", id).eq("status", "assigned").select("id"));
      const deleted = await query(supabase.from("people").delete().eq("workspace_id", workspaceId).eq("id", id).select("id"));
      if (!deleted.length) throw new HttpError(404, "Person not found.");
      response.status(204).end();
      return;
    }
  }

  if (path === "/api/assignments" && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !["unassigned", "assigned", "completed"].includes(status)) throw new HttpError(400, "Invalid assignment status.");
    const assignments = (await loadWorkspaceData(supabase, workspaceId)).assignments
      .filter((assignment) => !status || assignment.status === status);
    send(response, 200, { assignments });
    return;
  }
  if (path === "/api/assignments" && method === "POST") {
    await requireOwner(session.role);
    const input = assignmentInput(objectBody(request));
    const assignedPersonId = input.assignedPersonId ?? null;
    const row = await query(supabase.from("assignments").insert({
      workspace_id: workspaceId, title: input.title, description: input.description ?? "",
      team_id: input.teamId ?? null, assigned_person_id: assignedPersonId,
      required_skill: input.requiredSkill ?? "", status: assignedPersonId ? "assigned" : "unassigned"
    }).select("id").single());
    const assignment = (await loadWorkspaceData(supabase, workspaceId)).assignments.find((item) => item.id === row.id);
    send(response, 201, { assignment });
    return;
  }
  const assignmentMatch = path.match(/^\/api\/assignments\/([^/]+)$/);
  if (assignmentMatch) {
    const id = decodeURIComponent(assignmentMatch[1]!);
    if (method === "PATCH") {
      await requireOwner(session.role);
      const patch = assignmentPatch(objectBody(request));
      const existing = (await loadWorkspaceData(supabase, workspaceId)).assignments.find((item) => item.id === id);
      if (!existing) throw new HttpError(404, "Assignment not found.");
      const assignedPersonId = patch.assignedPersonId === undefined ? existing.assignedPersonId : patch.assignedPersonId;
      const status = patch.status ?? (assignedPersonId ? "assigned" : "unassigned");
      if (status === "assigned" && !assignedPersonId) throw new HttpError(400, "An assigned person is required to mark work as assigned.");
      const values: JsonObject = {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.requiredSkill === undefined ? {} : { required_skill: patch.requiredSkill }),
        ...(patch.teamId === undefined ? {} : { team_id: patch.teamId }),
        assigned_person_id: status === "unassigned" ? null : assignedPersonId,
        status
      };
      const updated = await query(supabase.from("assignments").update(values).eq("workspace_id", workspaceId).eq("id", id).select("id"));
      if (!updated.length) throw new HttpError(404, "Assignment not found.");
      const assignment = (await loadWorkspaceData(supabase, workspaceId)).assignments.find((item) => item.id === id);
      send(response, 200, { assignment });
      return;
    }
    if (method === "DELETE") {
      await requireOwner(session.role);
      const deleted = await query(supabase.from("assignments").delete().eq("workspace_id", workspaceId).eq("id", id).select("id"));
      if (!deleted.length) throw new HttpError(404, "Assignment not found.");
      response.status(204).end();
      return;
    }
  }
  throw new HttpError(404, "API endpoint not found.");
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  try {
    await route(request, response);
  } catch (error) {
    if (response.headersSent) return;
    if (error instanceof HttpError) {
      send(response, error.status, { error: error.message });
      return;
    }
    console.error("Vercel API request failed:", error);
    send(response, 500, { error: "An unexpected server error occurred." });
  }
}
