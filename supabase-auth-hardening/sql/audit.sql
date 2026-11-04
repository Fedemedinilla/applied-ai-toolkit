-- Read-only audit of the public schema against rules 1 to 5 of 0001_conventions.sql.
-- Returns one row per violation; an empty result means the schema follows them. It changes
-- nothing, so it can run in the Supabase SQL editor or with psql against any project.
--
-- Rules 2, 3 and 5 are this folder's strict profile: authenticated never writes and never executes,
-- and every table has a comment. An app that grants authenticated an INSERT behind a policy, or an
-- RPC, gets rows here that break no rule of its own. Delete the branches it does not follow, or
-- filter their rows by object name.
--
-- MAINTAIN (VACUUM, ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED VIEW, LOCK TABLE) exists from
-- PostgreSQL 17, and Supabase's default grant all includes it there. It is checked only on 17 and later, so the query also runs on 16.
--
-- The checks cover every object in public, not only the ones in this folder: a table added later
-- without RLS, or a function left executable by anon, shows up here even if nobody wrote a test
-- for it.

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
  select p.oid, p.oid::regprocedure::text as name, p.prosecdef, p.proconfig
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
select 'function without an empty search_path', f.name
from functions as f
where not coalesce(f.proconfig @> array['search_path=""'], false)

union all
select 'table without a comment', r.name
from relations as r
where r.relkind in ('r', 'p') and pg_catalog.obj_description(r.oid, 'pg_class') is null

order by 1, 2;
