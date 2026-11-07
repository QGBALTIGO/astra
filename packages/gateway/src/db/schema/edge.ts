/**
 * IoT/Edge schema.
 *
 * Restores the active device, command and telemetry tables from the historical
 * 010_edge_delegation.sql migration. The squashed schema had omitted them,
 * causing GET /api/v1/edge to return HTTP 500 on fresh installations.
 *
 * CREATE TABLE/INDEX IF NOT EXISTS makes this safe for existing installations;
 * do not modify or drop any existing user data.
 */
export const EDGE_TABLES_SQL = `
-- Registered IoT devices
CREATE TABLE IF NOT EXISTS edge_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  name VARCHAR(200) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('raspberry-pi', 'esp32', 'arduino', 'custom')),
  protocol VARCHAR(20) NOT NULL DEFAULT 'mqtt' CHECK (protocol IN ('mqtt', 'websocket', 'http-poll')),
  sensors JSONB NOT NULL DEFAULT '[]',
  actuators JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(10) NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'error')),
  last_seen TIMESTAMPTZ,
  firmware_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Commands sent to devices
CREATE TABLE IF NOT EXISTS edge_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES edge_devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT 'default',
  command_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'acknowledged', 'completed', 'failed', 'timeout')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Device sensor readings
CREATE TABLE IF NOT EXISTS edge_telemetry (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES edge_devices(id) ON DELETE CASCADE,
  sensor_id TEXT NOT NULL,
  value JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export const EDGE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_edge_devices_user ON edge_devices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_devices_status ON edge_devices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_edge_commands_device ON edge_commands(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_telemetry_device_sensor
  ON edge_telemetry(device_id, sensor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_telemetry_time ON edge_telemetry(recorded_at DESC);
`;
