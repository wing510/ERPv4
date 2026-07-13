import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function loadDotEnvFile_(envPath) {
  if (!fs.existsSync(envPath)) throw new Error("missing " + envPath);
  fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const s = String(line || "").trim();
      if (!s || s.startsWith("#")) return;
      const eq = s.indexOf("=");
      if (eq <= 0) return;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!k) return;
      if (process.env[k] === undefined) process.env[k] = v;
    });
}

loadDotEnvFile_(path.resolve("server/.env"));
if (String(process.env.ERP_ENV_NAME || "").toUpperCase() === "PROD") {
  console.error("NO-GO: refuse SQL deploy when ERP_ENV_NAME=PROD");
  process.exit(2);
}

const sqlFile = path.resolve(process.argv[2] || "server/sql/v4.3.8_月結帳本交易Phase3Slice2.sql");
const psql = "D:\\pgsql\\17\\bin\\psql.exe";
const host = process.env.BACKUP_DB_HOST;
const user = process.env.BACKUP_DB_USER;
const password = process.env.BACKUP_DB_PASSWORD;
if (!host || !user || !password) {
  console.error("Missing BACKUP_DB_* in server/.env");
  process.exit(2);
}

const res = spawnSync(
  psql,
  ["-h", host, "-p", "5432", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", sqlFile],
  { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
);

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status === 0 ? 0 : res.status || 1);
