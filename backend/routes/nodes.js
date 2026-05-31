const express = require('express');
const { getNodes } = require('../controllers/nodesController');
const { getEventsByNode } = require('../controllers/eventsController');

const router = express.Router();

// GET  /api/nodes                – all node statuses
router.get('/', getNodes);

// GET  /api/nodes/:node_id/events – last 20 events for a node
router.get('/:node_id/events', getEventsByNode);

module.exports = router;
