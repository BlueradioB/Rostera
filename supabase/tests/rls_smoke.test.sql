do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles', 'workspaces', 'workspace_members', 'teams', 'team_skills',
    'people', 'skills', 'person_skills', 'aspirations', 'assignments', 'invitations'
  ] loop
    if not coalesce((select relrowsecurity from pg_class where oid = to_regclass(format('public.%I', table_name))), false) then
      raise exception 'RLS is not enabled on public.%', table_name;
    end if;
    if has_table_privilege('anon', format('public.%I', table_name), 'select') then
      raise exception 'The anon role can read public.%', table_name;
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = table_name
        and cmd = 'SELECT' and roles @> array['authenticated']::name[]
    ) then
      raise exception 'Authenticated users have no read policy on public.%', table_name;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.workspace_members', 'insert')
    or has_table_privilege('authenticated', 'public.workspace_members', 'update')
    or has_table_privilege('authenticated', 'public.workspace_members', 'delete') then
    raise exception 'Authenticated users must not directly change workspace membership or roles';
  end if;

  if has_function_privilege('anon', 'public.create_workspace(text)', 'execute') then
    raise exception 'Anonymous users can create workspaces';
  end if;
  if has_function_privilege('anon', 'public.create_workspace_invitation(uuid)', 'execute') then
    raise exception 'Anonymous users can create invitations';
  end if;
end;
$$;
