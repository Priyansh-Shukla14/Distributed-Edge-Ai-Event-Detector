const express = require('express');
const { getStats } = require('../controllers/statsController');

const router = express.Router();

// GET  /api/stats – aggregated dashboard metrics
router.get('/', getStats);

module.exports = router;
