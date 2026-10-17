import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { createBackup } from "./backup.js";
import { AuthStore, createDatabase, RosterStore, type AssignmentInput, type PersonInput, type PersonPatch, type TeamInput, type TeamPatch } from "./db.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, moduleDirectory.endsWith(`${sep}dist${sep}src`) ? "../.." : "..");
const dataDirectory = resolve(projectRoot, "data");
const defaultDatabase = resolve(dataDirectory, "rostera.sqlite");
const maximumBodySize = 1024 * 1024;
const sessionCookie = "rostera_session";
const rateLimits = new Map<string, { count: number; resetAt: number }>();

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function requestToken(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`));
  return cookie?.slice(sessionCookie.length + 1);
}

function writeSessionCookie(response: ServerResponse, token: string, maxAge: number): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("set-cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function checkSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, "This request came from a different web address. Open Rostera from its server URL and try again.");
    }
    if (originHost.toLowerCase() !== request.headers.host?.toLowerCase()) {
      throw new HttpError(403, "This request came from a different web address. Open Rostera from its server URL and try again.");
    }
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "This request came from a different web address. Open Rostera from its server URL and try again.");
  }
}

function enforceRateLimit(request: IncomingMessage, action: string, limit: number): void {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (entry.resetAt <= now) rateLimits.delete(key);
  }
  const key = `${request.socket.remoteAddress ?? "unknown"}:${action}`;
  const entry = rateLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (entry.count >= limit) throw new HttpError(429, "Too many attempts. Please try again later.");
  entry.count += 1;
}

function requireOwner(role: "owner" | "member"): void {
  if (role !== "owner") throw new HttpError(403, "Only workspace owners can change roster and work data.");
}

function publicOrigin(request: IncomingMessage): string {
  const configuredOrigin = process.env.ROSTERA_PUBLIC_URL;
  if (configuredOrigin) {
    const parsed = new URL(configuredOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== configuredOrigin.replace(/\/$/, "")) {
      throw new Error("ROSTERA_PUBLIC_URL must be an http(s) origin without a path.");
    }
    return parsed.origin;
  }
  const deployedHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (deployedHost) return `https://${deployedHost}`;
  const host = request.headers.host;
  if (!host) throw new HttpError(400, "The request host is unavailable.");
  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
  return `${protocol}://${host}`;
}

function passwordField(body: Record<string, unknown>): string {
  const password = body.password;
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new HttpError(400, "password must be between 12 and 256 characters.");
  }
  return password;
}

function emailField(body: Record<string, unknown>): string {
  const email = stringField(body, "email", true, 254)!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "email must be a valid email address.");
  return email;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBodySize) throw new HttpError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, "A JSON request body is required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, required = false, maximumLength = 160): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${key} is required.`);
  if (trimmed.length > maximumLength) throw new HttpError(400, `${key} must be ${maximumLength} characters or fewer.`);
  return trimmed;
}

function nullableStringField(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} must be a non-empty string or null.`);
  return value.trim();
}

function stringArrayField(body: Record<string, unknown>, key: string, maximumItems = 30): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${key} must be an array of up to ${maximumItems} strings.`);
  }
  const values = value.map((item) => (item as string).trim()).filter(Boolean);
  if (values.some((item) => item.length > 100)) throw new HttpError(400, `${key} values must be 100 characters or fewer.`);
  return [...new Set(values)];
}

function ratingField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new HttpError(400, `${key} must be a whole number from 1 to 5.`);
  }
  return value;
}

function personInput(body: Record<string, unknown>): PersonInput {
  const name = stringField(body, "name", true, 100)!;
  const role = stringField(body, "role", true, 100)!;
  const teamId = stringField(body, "teamId", true, 80)!;
  const fantasyRole = stringField(body, "fantasyRole", false, 100);
  const bloomRating = ratingField(body, "bloomRating");
  const skills = stringArrayField(body, "skills");
  const aspirations = stringArrayField(body, "aspirations");
  if ([name, role, teamId, fantasyRole].some((value) => value === "")) {
    throw new HttpError(400, "Person names, roles, and teamId cannot be empty.");
  }
  const assignment = stringField(body, "assignment", false, 160);
  return {
    name, role, teamId,
    ...(fantasyRole === undefined ? {} : { fantasyRole }),
    ...(bloomRating === undefined ? {} : { bloomRating }),
    ...(skills === undefined ? {} : { skills }),
    ...(aspirations === undefined ? {} : { aspirations }),
    ...(assignment === undefined ? {} : { assignment })
  };
}

function personPatch(body: Record<string, unknown>): PersonPatch {
  const name = stringField(body, "name", false, 100);
  const role = stringField(body, "role", false, 100);
  const teamId = stringField(body, "teamId", false, 80);
  const fantasyRole = stringField(body, "fantasyRole", false, 100);
  const bloomRating = ratingField(body, "bloomRating");
  const skills = stringArrayField(body, "skills");
  const aspirations = stringArrayField(body, "aspirations");
  if ([name, role, teamId, fantasyRole].some((value) => value === "")) {
    throw new HttpError(400, "Person names, roles, and teamId cannot be empty.");
  }
  if ([name, role, teamId, fantasyRole, bloomRating, skills, aspirations].every((value) => value === undefined)) {
    throw new HttpError(400, "Provide at least one person field to update.");
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(fantasyRole === undefined ? {} : { fantasyRole }),
    ...(bloomRating === undefined ? {} : { bloomRating }),
    ...(skills === undefined ? {} : { skills }),
    ...(aspirations === undefined ? {} : { aspirations })
  };
}

function teamInput(body: Record<string, unknown>): TeamInput {
  const name = stringField(body, "name", true, 100)!;
  const fantasyName = stringField(body, "fantasyName", true, 100)!;
  const description = stringField(body, "description", false, 300);
  const fantasyDescription = stringField(body, "fantasyDescription", false, 300);
  const color = stringField(body, "color", false, 24);
  const requiredSkills = stringArrayField(body, "requiredSkills");
  if ([name, fantasyName].some((value) => value === "")) {
    throw new HttpError(400, "Team names cannot be empty.");
  }
  if (color !== undefined && !["rose", "green", "blue"].includes(color)) {
    throw new HttpError(400, "color must be rose, green, or blue.");
  }
  return {
    name,
    fantasyName,
    ...(description === undefined ? {} : { description }),
    ...(fantasyDescription === undefined ? {} : { fantasyDescription }),
    ...(color === undefined ? {} : { color }),
    ...(requiredSkills === undefined ? {} : { requiredSkills })
  };
}

function teamPatch(body: Record<string, unknown>): TeamPatch {
  const name = stringField(body, "name", false, 100);
  const fantasyName = stringField(body, "fantasyName", false, 100);
  const description = stringField(body, "description", false, 300);
  const fantasyDescription = stringField(body, "fantasyDescription", false, 300);
  const color = stringField(body, "color", false, 24);
  const requiredSkills = stringArrayField(body, "requiredSkills");
  if ([name, fantasyName].some((value) => value === "")) {
    throw new HttpError(400, "Team names cannot be empty.");
  }
  if (color !== undefined && !["rose", "green", "blue"].includes(color)) {
    throw new HttpError(400, "color must be rose, green, or blue.");
  }
  if ([name, fantasyName, description, fantasyDescription, color, requiredSkills].every((value) => value === undefined)) {
    throw new HttpError(400, "Provide at least one team field to update.");
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(fantasyName === undefined ? {} : { fantasyName }),
    ...(description === undefined ? {} : { description }),
    ...(fantasyDescription === undefined ? {} : { fantasyDescription }),
    ...(color === undefined ? {} : { color }),
    ...(requiredSkills === undefined ? {} : { requiredSkills })
  };
}

function assignmentInput(body: Record<string, unknown>): AssignmentInput {
  const title = stringField(body, "title", true, 160)!;
  const description = stringField(body, "description", false, 500);
  const requiredSkill = stringField(body, "requiredSkill", false, 100);
  const teamId = nullableStringField(body, "teamId");
  const assignedPersonId = nullableStringField(body, "assignedPersonId");
  return {
    title,
    ...(description === undefined ? {} : { description }),
    ...(requiredSkill === undefined ? {} : { requiredSkill }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(assignedPersonId === undefined ? {} : { assignedPersonId })
  };
}

function assignmentPatch(body: Record<string, unknown>): Partial<AssignmentInput> & { status?: "unassigned" | "assigned" | "completed" } {
  const result: Partial<AssignmentInput> & { status?: "unassigned" | "assigned" | "completed" } = {};
  const title = stringField(body, "title", false, 160);
  const description = stringField(body, "description", false, 500);
  const requiredSkill = stringField(body, "requiredSkill", false, 100);
  const teamId = nullableStringField(body, "teamId");
  const assignedPersonId = nullableStringField(body, "assignedPersonId");
  if (title === "") throw new HttpError(400, "title cannot be empty.");
  if (title !== undefined) result.title = title;
  if (description !== undefined) result.description = description;
  if (requiredSkill !== undefined) result.requiredSkill = requiredSkill;
  if (teamId !== undefined) result.teamId = teamId;
  if (assignedPersonId !== undefined) result.assignedPersonId = assignedPersonId;
  if (body.status !== undefined) {
    if (body.status !== "unassigned" && body.status !== "assigned" && body.status !== "completed") {
      throw new HttpError(400, "status must be unassigned, assigned, or completed.");
    }
    result.status = body.status;
  }
  if (Object.keys(result).length === 0) throw new HttpError(400, "Provide at least one assignment field to update.");
  return result;
}

function ensureTeamExists(store: RosterStore, teamId: string | null | undefined): void {
  if (teamId !== undefined && teamId !== null && !store.listTeams().some((team) => team.id === teamId)) {
    throw new HttpError(404, "Team not found.");
  }
}

function ensurePersonExists(store: RosterStore, personId: string | null | undefined): void {
  if (personId !== undefined && personId !== null && !store.person(personId)) {
    throw new HttpError(404, "Person not found.");
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid file path.");
  }
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const assetsDirectory = resolve(projectRoot, "assets");
  const filePath = requestedPath === "/index.html"
    ? resolve(projectRoot, "index.html")
    : requestedPath.startsWith("/assets/")
      ? resolve(projectRoot, `.${requestedPath}`)
      : "";
  if (!filePath || (filePath !== resolve(projectRoot, "index.html") &&
    !filePath.startsWith(`${assetsDirectory}${sep}`))) {
    throw new HttpError(404, "Not found.");
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new HttpError(404, "Not found.");
    throw error;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff"
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    response.on("error", reject);
    response.on("close", () => stream.destroy());
    stream.on("end", resolvePromise);
    stream.pipe(response);
  });
}

export function createAppServer(defaultStore: RosterStore, authStore: AuthStore) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const path = url.pathname;

      if (path === "/api/health" && method === "GET") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      const token = requestToken(request);
      if (path === "/api/auth/me" && method === "GET") {
        const session = authStore.session(token);
        sendJson(response, 200, session ? {
          user: session.user,
          workspace: session.workspace,
          role: session.role,
          workspaces: authStore.workspaces(session.userId)
        } : { user: null });
        return;
      }
      if (path === "/api/auth/register" && method === "POST") {
        checkSameOrigin(request);
        enforceRateLimit(request, "register", 20);
        const body = await readJson(request);
        const name = stringField(body, "name", true, 100)!;
        const email = emailField(body);
        const password = passwordField(body);
        const invitationToken = stringField(body, "invitationToken", false, 200);
        const workspaceName = stringField(body, "workspaceName", !invitationToken, 100);
        if (!invitationToken && !workspaceName) throw new HttpError(400, "workspaceName is required.");
        let created;
        try {
          created = authStore.register({ name, email, password, ...(workspaceName ? { workspaceName } : {}), ...(invitationToken ? { invitationToken } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Registration failed.";
          if (message.includes("already exists")) throw new HttpError(409, message);
          if (message.includes("invitation")) throw new HttpError(400, message);
          throw error;
        }
        writeSessionCookie(response, created.token, 14 * 24 * 60 * 60);
        sendJson(response, 201, { user: created.user, workspaceId: created.session.workspaceId });
        return;
      }
      if (path === "/api/auth/login" && method === "POST") {
        checkSameOrigin(request);
        enforceRateLimit(request, "login", 20);
        const body = await readJson(request);
        const email = emailField(body);
        const password = body.password;
        if (typeof password !== "string" || password.length > 256) throw new HttpError(400, "password is required.");
        const loggedIn = authStore.login(email, password);
        if (!loggedIn) throw new HttpError(401, "Email or password is incorrect.");
        writeSessionCookie(response, loggedIn.token, 14 * 24 * 60 * 60);
        sendJson(response, 200, { user: loggedIn.user });
        return;
      }
      if (path === "/api/auth/logout" && method === "POST") {
        checkSameOrigin(request);
        authStore.logout(token);
        writeSessionCookie(response, "", 0);
        sendJson(response, 200, { loggedOut: true });
        return;
      }
      if (path.startsWith("/api/")) {
        checkSameOrigin(request);
        const session = authStore.session(token);
        if (!session) throw new HttpError(401, "Sign in to access this workspace.");
        const store = defaultStore.forWorkspace(session.workspaceId);
        if (path === "/api/workspaces" && method === "GET") {
          sendJson(response, 200, { workspaces: authStore.workspaces(session.userId) });
          return;
        }
        if (path === "/api/workspaces" && method === "POST") {
          const name = stringField(await readJson(request), "name", true, 100)!;
          const workspace = authStore.createWorkspace(session.userId, name, token!);
          sendJson(response, 201, { workspace });
          return;
        }
        if (path === "/api/workspaces/switch" && method === "POST") {
          const workspaceId = stringField(await readJson(request), "workspaceId", true, 80)!;
          if (!authStore.switchWorkspace(session.userId, token!, workspaceId)) throw new HttpError(404, "Workspace not found.");
          sendJson(response, 200, { workspaceId });
          return;
        }
        if (path === "/api/workspaces/current" && method === "PATCH") {
          const name = stringField(await readJson(request), "name", true, 100)!;
          if (!authStore.renameWorkspace(session.userId, session.workspaceId, name)) throw new HttpError(403, "Only workspace owners can rename this workspace.");
          sendJson(response, 200, { workspace: { ...session.workspace, name } });
          return;
        }
        if (path === "/api/invitations" && method === "GET") {
          if (session.role !== "owner") throw new HttpError(403, "Only workspace owners can view invitations.");
          sendJson(response, 200, { invitations: authStore.invitations(session.workspaceId) });
          return;
        }
        if (path === "/api/invitations" && method === "POST") {
          if (session.role !== "owner") throw new HttpError(403, "Only workspace owners can create invitations.");
          const created = authStore.createInvitation(session.workspaceId, session.userId);
          sendJson(response, 201, {
            invitation: created.invitation,
            url: `${publicOrigin(request)}/?invite=${encodeURIComponent(created.token)}`
          });
          return;
        }
        if (path === "/api/invitations/redeem" && method === "POST") {
          const invitationToken = stringField(await readJson(request), "token", true, 200)!;
          try {
            const workspaceId = authStore.redeemInvitation(session.userId, token!, invitationToken);
            sendJson(response, 200, { workspaceId });
          } catch (error) {
            if (error instanceof Error && (error.message.includes("invitation") || error.message.includes("already belong"))) {
              throw new HttpError(400, error.message);
            }
            throw error;
          }
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") checkSameOrigin(request);
        if (path === "/api/dashboard" && method === "GET") {
          sendJson(response, 200, store.dashboard());
          return;
        }
      if (path === "/api/teams" && method === "GET") {
        sendJson(response, 200, { teams: store.listTeams() });
        return;
      }
      if (path === "/api/teams" && method === "POST") {
        requireOwner(session.role);
        const team = store.createTeam(teamInput(await readJson(request)));
        sendJson(response, 201, { team });
        return;
      }
      const teamMatch = path.match(/^\/api\/teams\/([^/]+)$/);
      if (teamMatch) {
        const id = decodeURIComponent(teamMatch[1]!);
        if (method === "GET") {
          const team = store.team(id);
          if (!team) throw new HttpError(404, "Team not found.");
          sendJson(response, 200, { team });
          return;
        }
        if (method === "PATCH") {
          requireOwner(session.role);
          const team = store.updateTeam(id, teamPatch(await readJson(request)));
          if (!team) throw new HttpError(404, "Team not found.");
          sendJson(response, 200, { team });
          return;
        }
        if (method === "DELETE") {
          requireOwner(session.role);
          if (!store.deleteTeam(id)) throw new HttpError(404, "Team not found.");
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (path === "/api/people" && method === "GET") {
        const teamId = url.searchParams.get("teamId") ?? undefined;
        ensureTeamExists(store, teamId);
        const query = url.searchParams.get("q")?.trim() || undefined;
        sendJson(response, 200, { people: store.listPeople({ ...(teamId ? { teamId } : {}), ...(query ? { query } : {}) }) });
        return;
      }
      if (path === "/api/people" && method === "POST") {
        requireOwner(session.role);
        const input = personInput(await readJson(request));
        ensureTeamExists(store, input.teamId);
        const person = store.createPerson(input);
        sendJson(response, 201, { person });
        return;
      }
      const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
      if (personMatch) {
        const id = decodeURIComponent(personMatch[1]!);
        if (method === "GET") {
          const person = store.person(id);
          if (!person) throw new HttpError(404, "Person not found.");
          sendJson(response, 200, { person });
          return;
        }
        if (method === "PATCH") {
          requireOwner(session.role);
          const patch = personPatch(await readJson(request));
          ensureTeamExists(store, patch.teamId);
          const person = store.updatePerson(id, patch);
          if (!person) throw new HttpError(404, "Person not found.");
          sendJson(response, 200, { person });
          return;
        }
        if (method === "DELETE") {
          requireOwner(session.role);
          if (!store.deletePerson(id)) throw new HttpError(404, "Person not found.");
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (path === "/api/assignments" && method === "GET") {
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !["unassigned", "assigned", "completed"].includes(status)) {
          throw new HttpError(400, "status must be unassigned, assigned, or completed.");
        }
        sendJson(response, 200, { assignments: store.listAssignments(status) });
        return;
      }
      if (path === "/api/assignments" && method === "POST") {
        requireOwner(session.role);
        const input = assignmentInput(await readJson(request));
        ensureTeamExists(store, input.teamId);
        ensurePersonExists(store, input.assignedPersonId);
        sendJson(response, 201, { assignment: store.createAssignment(input) });
        return;
      }
      const assignmentMatch = path.match(/^\/api\/assignments\/([^/]+)$/);
      if (assignmentMatch) {
        const id = decodeURIComponent(assignmentMatch[1]!);
        if (method === "PATCH") {
          requireOwner(session.role);
          const patch = assignmentPatch(await readJson(request));
          ensureTeamExists(store, patch.teamId);
          ensurePersonExists(store, patch.assignedPersonId);
          const existingAssignment = store.listAssignments().find((assignment) => assignment.id === id);
          if (!existingAssignment) throw new HttpError(404, "Assignment not found.");
          if (patch.status === "assigned" && (patch.assignedPersonId === null ||
            (patch.assignedPersonId === undefined && !existingAssignment.assignedPersonId))) {
            throw new HttpError(400, "An assigned person is required to mark work as assigned.");
          }
          const assignment = store.updateAssignment(id, patch);
          if (!assignment) throw new HttpError(404, "Assignment not found.");
          sendJson(response, 200, { assignment });
          return;
        }
        if (method === "DELETE") {
          requireOwner(session.role);
          if (!store.deleteAssignment(id)) throw new HttpError(404, "Assignment not found.");
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (path.startsWith("/api/")) throw new HttpError(404, "API endpoint not found.");
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      await serveStatic(path, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR") {
        sendJson(response, 409, { error: "The change conflicts with existing roster data." });
        return;
      }
      console.error("Request failed:", error);
      sendJson(response, 500, { error: "An unexpected server error occurred." });
    }
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  const databasePath = process.env.ROSTERA_DATABASE ?? defaultDatabase;
  const databaseDirectory = dirname(resolve(databasePath));
  if (databasePath !== ":memory:") await mkdir(databaseDirectory, { recursive: true });
  const database = createDatabase(databasePath);
  const server = createAppServer(new RosterStore(database), new AuthStore(database));
  const host = process.env.HOST ?? "127.0.0.1";
  const backupDirectory = resolve(process.env.ROSTERA_BACKUP_DIRECTORY ?? resolve(databaseDirectory, "backups"));
  const backupIntervalMs = Number(process.env.ROSTERA_BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(backupIntervalMs) || backupIntervalMs < 60_000) {
    throw new Error("ROSTERA_BACKUP_INTERVAL_MS must be an integer of at least 60000.");
  }
  server.listen(port, host, () => {
    console.log(`Rostera listening at http://${host}:${port}`);
  });
  const runBackup = () => createBackup(database, backupDirectory)
    .then((filename) => console.log(`Created database backup: ${filename}`))
    .catch((error: unknown) => console.error("Scheduled database backup failed:", error));
  void runBackup();
  const backupTimer = setInterval(runBackup, backupIntervalMs);
  backupTimer.unref();
  const shutdown = () => {
    clearInterval(backupTimer);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("Failed to start Rostera:", error);
    process.exitCode = 1;
  });
}
