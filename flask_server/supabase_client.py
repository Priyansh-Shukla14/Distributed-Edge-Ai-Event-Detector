"""
supabase_client.py — Supabase persistence layer for the Edge-AI server.

Initialises a Supabase client using service-role credentials from
environment variables and exposes two helpers:

    insert_event(payload)       → bool   (insert into `events`)
    upsert_node_status(node_id) → bool   (upsert into `node_status`)

Both functions are exception-safe — they log errors but never crash
the calling code.
"""

import logging
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client, Client

# ── Load .env file (if present) before reading env vars ───────
load_dotenv()

log = logging.getLogger("edge-ai")

# ── Supabase client singleton ─────────────────────────────────
_supabase: Client | None = None


def _get_client() -> Client:
    """
    Lazily initialise and return the Supabase client.
    Raises RuntimeError if credentials are missing.
    """
    global _supabase
    if _supabase is not None:
        return _supabase

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise RuntimeError(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. "
            "Copy .env.example → .env and fill in your credentials."
        )

    _supabase = create_client(url, key)
    log.info("[Supabase] ✔  Client initialised (%s)", url)
    return _supabase


# ═══════════════════════════════════════════════════════════════
#  Public helpers
# ═══════════════════════════════════════════════════════════════

def insert_event(payload: dict) -> bool:
    """
    Insert a high-confidence detection into the Supabase `events` table.

    Parameters
    ----------
    payload : dict
        Must contain: node_id, event_type, confidence,
        device_timestamp, route_path.

    Returns
    -------
    bool — True on success, False on error.
    """
    try:
        client = _get_client()

        record = {
            "node_id":          payload["node_id"],
            "event_type":       payload["event_type"],
            "confidence":       payload["confidence"],
            "device_timestamp": payload["device_timestamp"],
            "route_path":       payload["route_path"],
            "resolved":         False,
        }

        client.table("events").insert(record).execute()

        log.info(
            "[Supabase] ✔  Event stored: %s from %s (%.2f)",
            record["event_type"],
            record["node_id"],
            record["confidence"],
        )
        return True

    except Exception as exc:
        log.error("[Supabase] ✖  Event insert failed: %s", exc)
        return False


def upsert_node_status(node_id: str) -> bool:
    """
    Upsert the node's status to 'online' in the Supabase
    `node_status` table with the current timestamp.

    Returns
    -------
    bool — True on success, False on error.
    """
    try:
        client = _get_client()

        now = datetime.now(timezone.utc).isoformat()

        client.table("node_status").upsert(
            {
                "node_id":    node_id,
                "status":     "online",
                "last_seen":  now,
                "updated_at": now,
            },
            on_conflict="node_id",
        ).execute()

        log.debug("[Supabase] ✔  Node \"%s\" status → online", node_id)
        return True

    except Exception as exc:
        log.error("[Supabase] ✖  Node status upsert failed: %s", exc)
        return False
