const { createClient } = require("@supabase/supabase-js");

let client = null;

function getSupabase() {
  if (client) return client;
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

module.exports = { getSupabase };
