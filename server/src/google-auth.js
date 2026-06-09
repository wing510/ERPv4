const { getSupabase } = require("./supabase");

function allowedGoogleAudiences_() {
  const raw = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID_PROD,
    process.env.GOOGLE_CLIENT_ID_LOCAL
  ];
  const out = new Set();
  raw.forEach((x) => {
    String(x || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((id) => out.add(id));
  });
  return out;
}

async function verifyGoogleIdToken_(idToken) {
  const url =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(String(idToken || ""));
  const resp = await fetch(url);
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch (_e) {
    return null;
  }
}

async function getActiveUserByEmail_(emailLower) {
  const em = String(emailLower || "")
    .trim()
    .toLowerCase();
  if (!em) return null;

  const sb = getSupabase();
  const { data, error } = await sb.from("erp_user").select("*").ilike("email", em);
  if (error) throw error;

  const rows = data || [];
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    const e = String(u.email || "")
      .trim()
      .toLowerCase();
    if (e !== em) continue;
    const st = String(u.status || "ACTIVE")
      .trim()
      .toUpperCase();
    if (st !== "ACTIVE") return null;
    return u;
  }
  return null;
}

module.exports = {
  allowedGoogleAudiences_,
  verifyGoogleIdToken_,
  getActiveUserByEmail_
};
