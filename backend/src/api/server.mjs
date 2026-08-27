// Minimal test backend: config API (scanner pulls), ingest API (scanner pushes),
// query API (slices for the harness/copilot). Thin by design — business logic
// lives in the DB schema and the loader; this is an HTTP wrapper around them.
//
//   node backend/src/api/server.mjs          # PORT=8080 by default
//
// Auth: set API_KEY to require an X-API-Key header on every request; leave it
// unset for open local testing.
import express from 'express';
import { pool } from '../db.mjs';
import configRoutes from './routes/config.mjs';
import ingestRoutes from './routes/ingest.mjs';
import queryRoutes from './routes/query.mjs';

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  const required = process.env.API_KEY;
  if (required && req.get('X-API-Key') !== required) {
    return res.status(401).json({ error: 'missing or invalid X-API-Key' });
  }
  next();
});

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use('/api', configRoutes);
app.use('/api', ingestRoutes);
app.use('/api', queryRoutes);

app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`backend listening on :${port}`));
