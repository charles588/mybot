const express = require('express');
const cors = require('cors');
const path = require('path');
const tradeRoutes = require('./routes/tradeRoutes');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/trade', tradeRoutes);
app.use('/api', tradeRoutes); 

// Root route
app.get('/', (_req, res) => res.json({ ok: true }));

module.exports = app;