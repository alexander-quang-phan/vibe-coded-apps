// Vercel serverless entrypoint — wraps the same Express app that
// `npm start` runs as a long-lived server elsewhere. vercel.json rewrites
// every request here, and Express sees the original /api/* path.
import app from '../index.js';

export default app;
