// ───────────────────────────────────────────────────────────
//  Frontend Config — DO NOT commit this file!
//  Copy config.example.js → config.js and fill in your values.
// ───────────────────────────────────────────────────────────

const CONFIG = {
  // Supabase public credentials (anon key is safe for browser)
  SUPABASE_URL: 'https://your-project-id.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',

  // Backend REST API base URL
  API_BASE_URL: 'http://localhost:3000/api',

  // Flask inference server (Socket.IO for live detections)
  FLASK_SERVER_URL: 'http://localhost:5000',
};
