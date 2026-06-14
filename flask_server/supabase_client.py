"""
supabase_client.py — Supabase persistence layer for the Edge-AI server.

Uses the Supabase REST API directly via `requests` (eventlet-compatible)
instead of the supabase-py client (which uses httpx, incompatible with eventlet).

    insert_event(payload)       → bool
    upsert_node_status(node_id) → bool
"""

import logging
import os
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("edge-ai")

_URL = None
_HEADERS = None


def _get_headers():
    global _URL, _HEADERS
    if _HEADERS is not None:
        return _URL, _HEADERS

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env")

    _URL = url.rstrip("/")
    _HEADERS = {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }
    log.info("[Supabase] ✔  REST client ready (%s)", _URL)
    return _URL, _HEADERS


def insert_event(payload: dict) -> bool:
    try:
        url, headers = _get_headers()
        record = {
            "node_id":          payload["node_id"],
            "event_type":       payload["event_type"],
            "confidence":       payload["confidence"],
            "device_timestamp": payload["device_timestamp"],
            "route_path":       payload["route_path"],
            "resolved":         False,
        }
        r = requests.post(f"{url}/rest/v1/events", json=record, headers=headers, timeout=5)
        r.raise_for_status()
        log.info("[Supabase] ✔  Event stored: %s from %s (%.2f)",
                 record["event_type"], record["node_id"], record["confidence"])
        return True
    except Exception as exc:
        log.error("[Supabase] ✖  Event insert failed: %s", exc)
        return False


def upsert_node_status(node_id: str) -> bool:
    try:
        url, headers = _get_headers()
        now = datetime.now(timezone.utc).isoformat()
        record = {
            "node_id":    node_id,
            "status":     "online",
            "last_seen":  now,
            "updated_at": now,
        }
        r = requests.post(f"{url}/rest/v1/node_status", json=record, headers=headers, timeout=5)
        r.raise_for_status()
        log.info("[Supabase] ✔  Node \"%s\" → online", node_id)
        return True
    except Exception as exc:
        log.error("[Supabase] ✖  Node status upsert failed: %s", exc)
        return False
