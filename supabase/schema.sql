-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: everything is created only if it doesn't exist yet.

-- Tasks and courses are stored as the same JSON objects the app keeps locally,
-- so adding a field in the app never needs a database change.
-- `updated_at` is when the item was last edited (set by the app, used to pick the newer edit);
-- `synced_at` is when the server last received it (set here).
-- Deleted items are kept with `deleted = true` so other devices learn about the delete.
create table if not exists public.tasks (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null,
  deleted    boolean not null default false,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.courses (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null,
  deleted    boolean not null default false,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create or replace function public.touch_synced_at()
returns trigger language plpgsql as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_synced_at on public.tasks;
create trigger tasks_synced_at before insert or update on public.tasks
  for each row execute function public.touch_synced_at();

drop trigger if exists courses_synced_at on public.courses;
create trigger courses_synced_at before insert or update on public.courses
  for each row execute function public.touch_synced_at();

-- Each signed-in user can only see and change their own rows
alter table public.tasks enable row level security;
alter table public.courses enable row level security;

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own courses" on public.courses;
create policy "own courses" on public.courses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Lets other open devices hear about changes straight away
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'courses') then
    alter publication supabase_realtime add table public.courses;
  end if;
end;
$$;

-- Private bucket for PDFs. Files go in a folder named after the user's id,
-- e.g. "<user id>/1730000000000:problem", and only that user can reach them.
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;

drop policy if exists "own pdfs" on storage.objects;
create policy "own pdfs" on storage.objects for all to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
