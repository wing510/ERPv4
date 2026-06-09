const crypto = require("crypto");

const SESSION_PREFIX = "erp_sess_";
/** @type {Map<string, object>} */
const sessions = new Map();

const MS_8H = 8 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;

function sessionDurationMs(remember) {
  const r =
    String(remember || "") === "1" ||
    String(remember || "").toLowerCase() === "true";
  return r ? MS_30D : MS_8H;
}

function newToken() {
  return crypto.randomBytes(28).toString("hex");
}

function createSession(userId, userName, role, remember, allowedModules) {
  const token = newToken();
  const rememberBool =
    String(remember || "") === "1" ||
    String(remember || "").toLowerCase() === "true";
  const exp = Date.now() + sessionDurationMs(remember);
  const rec = {
    user_id: String(userId || "").trim(),
    user_name: String(userName || ""),
    role: String(role || "").trim().toUpperCase(),
    allowed_modules: String(allowedModules || ""),
    remember: rememberBool,
    exp
  };
  sessions.set(SESSION_PREFIX + token, rec);
  return { token, exp, record: rec };
}

function readSessionValid(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const rec = sessions.get(SESSION_PREFIX + t);
  if (!rec || !rec.user_id) return null;
  if (Date.now() > Number(rec.exp || 0)) {
    sessions.delete(SESSION_PREFIX + t);
    return null;
  }
  return rec;
}

function touchSession(token) {
  const o = readSessionValid(token);
  if (!o) return null;
  o.exp = Date.now() + sessionDurationMs(o.remember ? "1" : "0");
  sessions.set(SESSION_PREFIX + String(token || "").trim(), o);
  return o;
}

function deleteSession(token) {
  const t = String(token || "").trim();
  if (t) sessions.delete(SESSION_PREFIX + t);
}

function formatExpIso(expMs) {
  const d = new Date(Number(expMs));
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

module.exports = {
  createSession,
  readSessionValid,
  touchSession,
  deleteSession,
  formatExpIso
};
