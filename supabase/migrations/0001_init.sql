-- SpinSight schema (used from Phase 6). Run in the Supabase SQL editor.
-- Raw per-frame measurements are stored as gzipped JSON in Storage (bucket: spin-frames)
-- so the relational tables stay small; `frames_path` points at that object.

create table if not exists calibrations (
  id text primary key,
  created_at timestamptz not null default now(),
  wheel_type text not null check (wheel_type in ('european','american')),
  frame_width int not null,
  frame_height int not null,
  data jsonb not null            -- full WheelCalibration object
);

create table if not exists spins (
  id uuid primary key default gen_random_uuid(),
  recorded_at timestamptz not null default now(),
  calibration_id text references calibrations(id),
  wheel_type text not null check (wheel_type in ('european','american')),
  wheel_direction smallint not null check (wheel_direction in (-1,1)),
  ball_direction smallint not null check (ball_direction in (-1,1)),
  initial_ball_angle double precision,
  initial_rotor_angle double precision,
  initial_ball_velocity double precision,
  initial_rotor_velocity double precision,
  estimated_ball_acceleration double precision,
  estimated_rotor_acceleration double precision,
  predicted_pocket smallint,
  actual_pocket smallint,          -- -1 = "00"
  prediction_timestamp double precision,  -- ms on the spin's monotonic clock
  tracking_quality real,
  model_version text not null,
  frames_path text,                -- storage object with raw FrameMeasurement[]
  is_synthetic boolean not null default false
);

create index if not exists spins_recorded_at_idx on spins (recorded_at);

-- Single-user app: the server uses the service role; block anonymous access.
alter table calibrations enable row level security;
alter table spins enable row level security;
