-- ═══════════════════════════════════════════════════════════════
--  002_add_sensor_event_types.sql
--  Adds 'flood' and 'earthquake' to the event_type CHECK constraint
--  so sensor-triggered alerts can be stored in the events table.
-- ═══════════════════════════════════════════════════════════════

-- Drop the old constraint and recreate with the new types
ALTER TABLE events DROP CONSTRAINT IF EXISTS event_type_check;

ALTER TABLE events ADD CONSTRAINT event_type_check CHECK (
    event_type IN (
        'glass_break',
        'explosion',
        'vehicle_crash',
        'abnormal_industrial',
        'background_noise',
        -- New sensor-based event types
        'flood',
        'earthquake',
        -- Flask ML pipeline types
        'gunshots',
        'scream',
        'siren',
        'dog',
        'background'
    )
);
