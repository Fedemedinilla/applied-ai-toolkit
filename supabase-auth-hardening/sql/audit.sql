-- Read-only audit of the public schema against rules 1 to 5 of 0001_conventions.sql.
-- Returns one row per violation; an empty result means the schema follows them. It changes
-- nothing, so it can run in the Supabase SQL editor or with psql against any project.
--
-- Rules 2, 3 and 5 are this folder's strict profile: authenticated never writes and never executes,
-- and every table has a comment. An app that grants authenticated an INSERT behind a policy, or an
-- RPC, gets rows here that break no rule of its own. Delete the branches it does not follow, or
-- filter their rows by object name.
--
-- Rule 4's revoke from service_role is checked only on trigger functions, which nobody may execute.
-- Any other function may be granted back to service_role or supabase_auth_admin, as
-- reserve_otp_attempt and before_user_created_hook are, so a grant to those roles is not reported.
--
-- MAINTAIN (VACUUM, ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED VIEW, LOCK TABLE) exists from
-- PostgreSQL 17, and Supabase's default grant all includes it there. It is checked only on 17 and later, so the query also runs on 16.
--
-- The checks cover every object in public, not only the ones in this folder: a table added later
-- without RLS, a function left executable by anon, or a view that reads past RLS for authenticated
-- (rule 1 applied to what the view exposes) shows up here even if nobody wrote a test for it.

with
relations as (
  select c.oid, c.relname::text as name, c.relkind
  from pg_catalog.pg_class as c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
-- has_table_privilege rejects 'MAINTAIN' before 17, so it is only asked inside the CASE.
maintain as (
  select r.oid, g.role
  from relations as r
  cross join (values ('anon'), ('authenticated'), ('service_role')) as g (role)
  where r.relkind <> 'S'
    and case when pg_catalog.current_setting('server_version_num')::int >= 170000
             then pg_catalog.has_table_privilege(g.role, r.oid, 'MAINTAIN')
             else false end
),
functions as (
  select p.oid, p.oid::regprocedure::text as name, p.prokind, p.prorettype, p.prosecdef, p.proconfig
  from pg_catalog.pg_proc as p
  where p.pronamespace = 'public'::regnamespace
    -- Functions that belong to an installed extension follow the extension's own rules.
    and not exists (
      select 1 from pg_catalog.pg_depend as d
      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
)
select 'table without row level security' as violation, r.name as object
from relations as r
join pg_catalog.pg_class as c on c.oid = r.oid
where r.relkind in ('r', 'p') and not c.relrowsecurity

union all
select 'anon has a privilege', r.name
from relations as r
where pg_catalog.has_any_column_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
   or (r.relkind <> 'S' and pg_catalog.has_table_privilege('anon', r.oid, 'DELETE, TRUNCATE, TRIGGER'))
   or (r.relkind = 'S' and pg_catalog.has_sequence_privilege('anon', r.oid, 'USAGE, SELECT, UPDATE'))
   or exists (select 1 from maintain as m where m.oid = r.oid and m.role = 'anon')

union all
select 'authenticated can write', r.name
from relations as r
where pg_catalog.has_any_column_privilege('authenticated', r.oid, 'INSERT, UPDATE, REFERENCES')
   or (r.relkind <> 'S' and pg_catalog.has_table_privilege('authenticated', r.oid, 'DELETE, TRUNCATE, TRIGGER'))
   or (r.relkind = 'S' and pg_catalog.has_sequence_privilege('authenticated', r.oid, 'USAGE, UPDATE'))
   or exists (select 1 from maintain as m where m.oid = r.oid and m.role = 'authenticated')

union all
select 'service_role has TRUNCATE, REFERENCES, TRIGGER or MAINTAIN', r.name
from relations as r
where r.relkind in ('r', 'p', 'v', 'm', 'f')
  and (pg_catalog.has_any_column_privilege('service_role', r.oid, 'REFERENCES')
       or pg_catalog.has_table_privilege('service_role', r.oid, 'TRUNCATE, TRIGGER')
       or exists (select 1 from maintain as m where m.oid = r.oid and m.role = 'service_role'))

union all
select 'anon or authenticated can execute', f.name
from functions as f
where pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
   or pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')

union all
-- Rule 4: a trigger function runs as a trigger and is granted to nobody. anon and authenticated are
-- already reported above. Other functions may be granted back to service_role or
-- supabase_auth_admin when the server or Auth calls them, so this check is not made for them.
select 'trigger function executable by service_role or supabase_auth_admin', f.name
from functions as f
where f.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
  and (pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('supabase_auth_admin', f.oid, 'EXECUTE'))

union all
-- Only functions and procedures: Postgres refuses SET on an aggregate or a window function, so a
-- row for one could never be cleared.
select 'function without an empty search_path', f.name
from functions as f
where f.prokind in ('f', 'p')
  and not coalesce(f.proconfig @> array['search_path=""'], false)

union all
-- A view runs as its owner unless it sets security_invoker, and a materialized view has no RLS at
-- all, so either one readable by authenticated can show every row of a table whose RLS would hide
-- them. anon is already reported above. Postgres keeps the option as written, so every spelling of
-- true counts.
select 'view readable by authenticated that bypasses RLS', r.name
from relations as r
join pg_catalog.pg_class as c on c.oid = r.oid
where r.relkind in ('v', 'm')
  and pg_catalog.has_any_column_privilege('authenticated', r.oid, 'SELECT')
  and (r.relkind = 'm'
       or not exists (
         select 1 from pg_catalog.pg_options_to_table(c.reloptions) as o
         where o.option_name = 'security_invoker'
           and pg_catalog.lower(o.option_value) in ('t', 'tr', 'tru', 'true', 'y', 'ye', 'yes', 'on', '1')
       ))

union all
select 'table without a comment', r.name
from relations as r
where r.relkind in ('r', 'p') and pg_catalog.obj_description(r.oid, 'pg_class') is null

order by 1, 2;
