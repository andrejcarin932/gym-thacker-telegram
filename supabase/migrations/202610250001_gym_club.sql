create extension if not exists pgcrypto;

create table if not exists public.profiles (
  telegram_id bigint primary key,
  telegram_username text,
  telegram_first_name text,
  nickname text not null default '',
  age smallint check (age between 14 and 99),
  weight_kg numeric(5,1) check (weight_kg between 30 and 300),
  training_experience text not null default '' check (char_length(training_experience) <= 80),
  category text check (category in ('men', 'women', 'open') or category is null),
  hide_personal_stats boolean not null default true,
  theme text not null default 'red' check (theme in ('red', 'blue', 'purple', 'light')),
  program jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 48),
  invite_code_hash text not null unique,
  owner_telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  singleton boolean not null default true unique check (singleton),
  created_at timestamptz not null default now()
);

create table if not exists public.club_members (
  club_id uuid not null references public.clubs(id) on delete cascade,
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (club_id, telegram_id)
);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  requester_id bigint not null references public.profiles(telegram_id) on delete cascade,
  recipient_id bigint not null references public.profiles(telegram_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> recipient_id),
  unique (club_id, requester_id, recipient_id)
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  author_id bigint not null references public.profiles(telegram_id) on delete cascade,
  caption text not null default '' check (char_length(caption) <= 360),
  media_path text,
  media_kind text check (media_kind in ('image', 'video') or media_kind is null),
  workout jsonb,
  created_at timestamptz not null default now(),
  check (char_length(caption) > 0 or media_path is not null)
);

create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, telegram_id)
);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id bigint not null references public.profiles(telegram_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 180),
  created_at timestamptz not null default now()
);

create table if not exists public.workouts (
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  client_id text not null,
  workout_date timestamptz not null,
  exercises jsonb not null default '[]'::jsonb,
  program_context jsonb,
  updated_at timestamptz not null default now(),
  primary key (telegram_id, client_id)
);

create index if not exists posts_club_created_idx on public.posts(club_id, created_at desc);
create index if not exists comments_post_created_idx on public.post_comments(post_id, created_at asc);
create index if not exists friend_requests_inbox_idx on public.friend_requests(club_id, recipient_id, status);
create index if not exists workouts_user_date_idx on public.workouts(telegram_id, workout_date desc);

alter table public.profiles enable row level security;
alter table public.clubs enable row level security;
alter table public.club_members enable row level security;
alter table public.friend_requests enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
alter table public.workouts enable row level security;

revoke all on public.profiles, public.clubs, public.club_members, public.friend_requests, public.posts, public.post_likes, public.post_comments, public.workouts from anon, authenticated;

do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('club-media', 'club-media', false, 26214400, array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm']::text[])
  on conflict (id) do update set public = false, file_size_limit = 26214400, allowed_mime_types = excluded.allowed_mime_types;
end $$;