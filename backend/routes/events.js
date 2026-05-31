const express = require('express');
const {
  getEvents,
  getEventById,
  resolveEvent,
  deleteOldEvents,
} = require('../controllers/eventsController');

const router = express.Router();

// ── Admin-key middleware for destructive operations ──────
function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    console.error('[Auth] ✖  ADMIN_API_KEY not set in .env');
    return res.status(500).json({ error: 'Server misconfiguration: admin key not set' });
  }

  const provided = req.headers['x-api-key'];

  if (!provided || provided !== adminKey) {
    return res.status(403).json({ error: 'Forbidden: invalid or missing x-api-key' });
  }

  next();
}

// ── Routes ──────────────────────────────────────────────

// GET  /api/events           – paginated, filterable list
router.get('/', getEvents);

// GET  /api/events/:id       – single event by UUID
router.get('/:id', getEventById);

// PATCH /api/events/:id/resolve – mark resolved
router.patch('/:id/resolve', resolveEvent);

// DELETE /api/events         – purge events older than 7 days (admin only)
router.delete('/', requireAdminKey, deleteOldEvents);

module.exports = router;
