-- ═══════════════════════════════════════════════════════════════
--  001_init.sql — Edge-AI Acoustic Event Detection Schema
--  Creates: events, node_status tables
--  Enables: RLS, Realtime, performance indexes
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Events Table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
    id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id           TEXT            NOT NULL,
    event_type        TEXT            NOT NULL
                      CONSTRAINT event_type_check CHECK (
                          event_type IN (
                              'glass_break',
                              'explosion',
                              'vehicle_crash',
                              'abnormal_industrial',
                              'background_noise'
                          )
                      ),
    confidence        NUMERIC(4,2)    NOT NULL
                      CONSTRAINT confidence_range CHECK (
                          confidence >= 0 AND confidence <= 1
                      ),
    device_timestamp  TEXT,
    route_path        TEXT[],          -- Dijkstra routing path as array of node IDs
    resolved          BOOLEAN         DEFAULT false,
    received_at       TIMESTAMPTZ     DEFAULT now()
);

COMMENT ON TABLE  events IS 'Acoustic events detected by ESP32 edge nodes';
COMMENT ON COLUMN events.route_path IS 'Ordered array of node IDs representing the adaptive Dijkstra routing path';
COMMENT ON COLUMN events.confidence IS 'ML model confidence score, range [0.00 – 1.00]';


-- ─── 2. Node Status Table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS node_status (
    node_id         TEXT            PRIMARY KEY,
    status          TEXT            NOT NULL DEFAULT 'offline'
                    CONSTRAINT node_status_check CHECK (
                        status IN ('online', 'offline', 'warning')
                    ),
    last_seen       TIMESTAMPTZ     DEFAULT now(),
    battery_level   INTEGER,
    location_label  TEXT,
    updated_at      TIMESTAMPTZ     DEFAULT now()
);

COMMENT ON TABLE node_status IS 'Current health and location of each ESP32 sensing node';


-- ═══════════════════════════════════════════════════════════════
--  3. Row Level Security
-- ═══════════════════════════════════════════════════════════════
--  RLS is enabled for defense-in-depth. The service role key
--  bypasses RLS by default in Supabase, but we add an explicit
--  policy so the intent is clear and auditable.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_status ENABLE ROW LEVEL SECURITY;

-- Service role: full access to events
CREATE POLICY "Service role full access on events"
    ON events
    FOR ALL
    USING  (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- Service role: full access to node_status
CREATE POLICY "Service role full access on node_status"
    ON node_status
    FOR ALL
    USING  (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- Anon (public dashboard): read-only access
CREATE POLICY "Anon read-only on events"
    ON events
    FOR SELECT
    USING (true);

CREATE POLICY "Anon read-only on node_status"
    ON node_status
    FOR SELECT
    USING (true);


-- ═══════════════════════════════════════════════════════════════
--  4. Supabase Realtime
-- ═══════════════════════════════════════════════════════════════
--  REPLICA IDENTITY FULL is required so that Supabase Realtime
--  broadcasts the complete row (including all columns) on
--  INSERT / UPDATE / DELETE — not just the primary key.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE events      REPLICA IDENTITY FULL;
ALTER TABLE node_status REPLICA IDENTITY FULL;

-- Add both tables to the Supabase Realtime publication
-- (required for postgres_changes subscriptions from the JS client)
ALTER PUBLICATION supabase_realtime ADD TABLE events;
ALTER PUBLICATION supabase_realtime ADD TABLE node_status;


-- ═══════════════════════════════════════════════════════════════
--  5. Performance Indexes
-- ═══════════════════════════════════════════════════════════════

-- Fast lookup of all events from a specific node
CREATE INDEX idx_events_node_id
    ON events (node_id);

-- Fast reverse-chronological listing (dashboard timeline)
CREATE INDEX idx_events_received_at_desc
    ON events (received_at DESC);
