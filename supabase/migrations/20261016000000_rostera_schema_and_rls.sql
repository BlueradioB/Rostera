create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 100),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members(user_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  fantasy_name text not null check (char_length(trim(fantasy_name)) between 1 and 100),
  description text not null default '',
  fantasy_description text not null default '',
  color text not null default 'rose' check (color in ('rose', 'green', 'blue')),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.team_skills (
  workspace_id uuid not null,
  team_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 100),
  primary key (team_id, name),
  foreign key (workspace_id, team_id) references public.teams(workspace_id, id) on delete cascade
);

create unique index team_skills_name_lower_idx on public.team_skills(team_id, lower(name));

create table public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  role text not null check (char_length(trim(role)) between 1 and 100),
  fantasy_role text not null default '',
  team_id uuid not null,
  bloom_rating integer not null default 1 check (bloom_rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, team_id) references public.teams(workspace_id, id) on delete restrict
);

create index people_workspace_team_idx on public.people(workspace_id, team_id);

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  unique (workspace_id, id)
);

create unique index skills_workspace_name_lower_idx on public.skills(workspace_id, lower(name));

create table public.person_skills (
  workspace_id uuid not null,
  person_id uuid not null,
  skill_id uuid not null,
  primary key (person_id, skill_id),
  foreign key (workspace_id, person_id) references public.people(workspace_id, id) on delete cascade,
  foreign key (workspace_id, skill_id) references public.skills(workspace_id, id) on delete cascade
);

create table public.aspirations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  person_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 100),
  status text not null default 'budding' check (status in ('budding', 'growing', 'bloomed')),
  created_at timestamptz not null default now(),
  unique (person_id, name),
  foreign key (workspace_id, person_id) references public.people(workspace_id, id) on delete cascade
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text not null default '',
  status text not null default 'unassigned' check (status in ('unassigned', 'assigned', 'completed')),
  team_id uuid,
  assigned_person_id uuid,
  required_skill text not null default '',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, team_id) references public.teams(workspace_id, id) on delete set null (team_id),
  foreign key (workspace_id, assigned_person_id) references public.people(workspace_id, id) on delete set null (assigned_person_id),
  check ((status != 'assigned') or assigned_person_id is not null)
);

create index assignments_workspace_status_idx on public.assignments(workspace_id, status);
create index assignments_assigned_person_idx on public.assignments(workspace_id, assigned_person_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index invitations_workspace_active_idx on public.invitations(workspace_id, expires_at)
  where accepted_at is null;

create function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = (select auth.uid())
  );
$$;

create function public.is_workspace_owner(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = (select auth.uid()) and role = 'owner'
  );
$$;

create function public.create_default_teams(target_workspace_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  product_team_id uuid := gen_random_uuid();
  engineering_team_id uuid := gen_random_uuid();
  customer_team_id uuid := gen_random_uuid();
begin
  insert into public.teams (id, workspace_id, name, fantasy_name, description, fantasy_description, color)
  values
    (product_team_id, target_workspace_id, 'Product & Design', 'The Roseguard', 'Product, UX, and research', 'Scouts, wardens, and tacticians', 'rose'),
    (engineering_team_id, target_workspace_id, 'Engineering', 'The Ironbloom Company', 'Platform and applications', 'Artificers and spellblades', 'green'),
    (customer_team_id, target_workspace_id, 'Customer Experience', 'The Hearthwardens', 'Success and operations', 'Healers and guides', 'blue');

  insert into public.team_skills (workspace_id, team_id, name)
  values
    (target_workspace_id, product_team_id, 'Product strategy'),
    (target_workspace_id, product_team_id, 'UX research'),
    (target_workspace_id, product_team_id, 'Prototyping'),
    (target_workspace_id, engineering_team_id, 'Frontend'),
    (target_workspace_id, engineering_team_id, 'Systems'),
    (target_workspace_id, engineering_team_id, 'Accessibility'),
    (target_workspace_id, customer_team_id, 'Enablement'),
    (target_workspace_id, customer_team_id, 'Analytics'),
    (target_workspace_id, customer_team_id, 'Advocacy');
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
  invite_token text := new.raw_user_meta_data ->> 'invitation_token';
  invite_workspace_id uuid;
  invite_id uuid;
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 100));

  if invite_token is not null and invite_token != '' then
    select id, workspace_id into invite_id, invite_workspace_id
    from public.invitations
    where token_hash = encode(extensions.digest(convert_to(invite_token, 'UTF8'), 'sha256'), 'hex')
      and accepted_at is null and expires_at > now()
    for update;
    if invite_id is null then
      raise exception 'Invitation is invalid or expired';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role)
    values (invite_workspace_id, new.id, 'member');
    update public.invitations set accepted_by = new.id, accepted_at = now() where id = invite_id;
  else
    new_workspace_id := gen_random_uuid();
    insert into public.workspaces (id, name, created_by)
    values (new_workspace_id,
      coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'workspace_name'), 100), ''), 'My workspace'),
      new.id);
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new_workspace_id, new.id, 'owner');
    perform public.create_default_teams(new_workspace_id);
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.create_workspace(workspace_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace public.workspaces;
  actor_id uuid := (select auth.uid());
begin
  if actor_id is null then raise exception 'Authentication required'; end if;
  if char_length(trim(workspace_name)) not between 1 and 100 then raise exception 'Workspace name must be 1 to 100 characters'; end if;
  insert into public.workspaces (name, created_by) values (trim(workspace_name), actor_id) returning * into new_workspace;
  insert into public.workspace_members (workspace_id, user_id, role) values (new_workspace.id, actor_id, 'owner');
  perform public.create_default_teams(new_workspace.id);
  return new_workspace;
end;
$$;

create function public.create_workspace_invitation(target_workspace_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_token text := encode(extensions.gen_random_bytes(32), 'hex');
  expiration timestamptz := now() + interval '7 days';
begin
  if not public.is_workspace_owner(target_workspace_id) then
    raise exception 'Only workspace owners can create invitations';
  end if;
  insert into public.invitations (workspace_id, token_hash, created_by, expires_at)
  values (target_workspace_id,
    encode(extensions.digest(convert_to(invitation_token, 'UTF8'), 'sha256'), 'hex'),
    (select auth.uid()), expiration);
  return query select invitation_token, expiration;
end;
$$;

create function public.redeem_workspace_invitation(invitation_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  invite public.invitations;
begin
  if actor_id is null then raise exception 'Authentication required'; end if;
  select * into invite from public.invitations
  where token_hash = encode(extensions.digest(convert_to(invitation_token, 'UTF8'), 'sha256'), 'hex')
    and accepted_at is null and expires_at > now()
  for update;
  if invite.id is null then raise exception 'Invitation is invalid, expired, or already used'; end if;
  if exists (select 1 from public.workspace_members where workspace_id = invite.workspace_id and user_id = actor_id) then
    raise exception 'You already belong to this workspace';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, actor_id, 'member');
  update public.invitations set accepted_by = actor_id, accepted_at = now() where id = invite.id;
  return invite.workspace_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.teams enable row level security;
alter table public.team_skills enable row level security;
alter table public.people enable row level security;
alter table public.skills enable row level security;
alter table public.person_skills enable row level security;
alter table public.aspirations enable row level security;
alter table public.assignments enable row level security;
alter table public.invitations enable row level security;

create policy profiles_select_self on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy workspaces_select_member on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));
create policy workspaces_update_owner on public.workspaces for update to authenticated
  using (public.is_workspace_owner(id)) with check (public.is_workspace_owner(id));

create policy workspace_members_select_self on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy teams_select_member on public.teams for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy teams_insert_owner on public.teams for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy teams_update_owner on public.teams for update to authenticated
  using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy teams_delete_owner on public.teams for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy team_skills_select_member on public.team_skills for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy team_skills_insert_owner on public.team_skills for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy team_skills_delete_owner on public.team_skills for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy people_select_member on public.people for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy people_insert_owner on public.people for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy people_update_owner on public.people for update to authenticated
  using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy people_delete_owner on public.people for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy skills_select_member on public.skills for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy skills_insert_owner on public.skills for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy skills_delete_owner on public.skills for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy person_skills_select_member on public.person_skills for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy person_skills_insert_owner on public.person_skills for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy person_skills_delete_owner on public.person_skills for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy aspirations_select_member on public.aspirations for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy aspirations_insert_owner on public.aspirations for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy aspirations_update_owner on public.aspirations for update to authenticated
  using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy aspirations_delete_owner on public.aspirations for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy assignments_select_member on public.assignments for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy assignments_insert_owner on public.assignments for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));
create policy assignments_update_owner on public.assignments for update to authenticated
  using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy assignments_delete_owner on public.assignments for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

create policy invitations_select_owner on public.invitations for select to authenticated
  using (public.is_workspace_owner(workspace_id));

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.is_workspace_owner(uuid) from public, anon;
revoke all on function public.create_default_teams(uuid) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.create_workspace_invitation(uuid) from public, anon;
revoke all on function public.redeem_workspace_invitation(text) from public, anon;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.create_workspace_invitation(uuid) to authenticated;
grant execute on function public.redeem_workspace_invitation(text) to authenticated;

revoke all on table
  public.profiles, public.workspaces, public.workspace_members, public.teams, public.team_skills,
  public.people, public.skills, public.person_skills, public.aspirations, public.assignments, public.invitations
from anon, public;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select on public.workspace_members to authenticated;
grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select, delete on public.teams to authenticated;
grant insert (workspace_id, name, fantasy_name, description, fantasy_description, color) on public.teams to authenticated;
grant update (name, fantasy_name, description, fantasy_description, color) on public.teams to authenticated;
grant select, delete on public.team_skills to authenticated;
grant insert (workspace_id, team_id, name) on public.team_skills to authenticated;
grant select, delete on public.people to authenticated;
grant insert (workspace_id, name, role, fantasy_role, team_id, bloom_rating) on public.people to authenticated;
grant update (name, role, fantasy_role, team_id, bloom_rating) on public.people to authenticated;
grant select, delete on public.skills to authenticated;
grant insert (workspace_id, name) on public.skills to authenticated;
grant select, delete on public.person_skills to authenticated;
grant insert (workspace_id, person_id, skill_id) on public.person_skills to authenticated;
grant select, delete on public.aspirations to authenticated;
grant insert (workspace_id, person_id, name, status) on public.aspirations to authenticated;
grant update (name, status) on public.aspirations to authenticated;
grant select, delete on public.assignments to authenticated;
grant insert (workspace_id, title, description, status, team_id, assigned_person_id, required_skill) on public.assignments to authenticated;
grant update (title, description, status, team_id, assigned_person_id, required_skill) on public.assignments to authenticated;
grant select on public.invitations to authenticated;
