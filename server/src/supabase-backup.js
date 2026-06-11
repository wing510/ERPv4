const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ok, fail } = require("./response");

function projectRefFromSupabaseUrl(url) {
  const m = String(url || "").match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : "";
}

const PG_BIN_CANDIDATES_ = [
  "D:\\pgsql\\17\\bin",
  "D:\\pgsql\\16\\bin",
  "C:\\pgsql\\17\\bin",
  "C:\\pgsql\\16\\bin"
];

function findPgDumpPath() {
  const preferred = String(process.env.PG_DUMP_PATH || "").trim();
  if (preferred && fs.existsSync(preferred)) return preferred;
  for (const dir of PG_BIN_CANDIDATES_) {
    const p = path.join(dir, "pg_dump.exe");
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function findPgRestorePath() {
  const preferred = String(process.env.PG_RESTORE_PATH || "").trim();
  if (preferred && fs.existsSync(preferred)) return preferred;
  const dump = findPgDumpPath();
  if (dump) {
    const restore = path.join(path.dirname(dump), "pg_restore.exe");
    if (fs.existsSync(restore)) return restore;
  }
  for (const dir of PG_BIN_CANDIDATES_) {
    const p = path.join(dir, "pg_restore.exe");
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function getBackupOutDir_() {
  return String(process.env.BACKUP_OUT_DIR || "D:\\ERP-Backup\\supabase").trim();
}

function backupStamp_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function backupFileName_(kind) {
  const stamp = backupStamp_();
  if (String(kind || "").toLowerCase() === "manual") {
    return "erp_supabase_manual_" + stamp + ".dump";
  }
  return "erp_supabase_" + stamp + ".dump";
}

function classifyBackupKind_(fileName) {
  const n = String(fileName || "").toLowerCase();
  if (n.includes("_manual_")) return "manual";
  return "scheduled";
}

function formatLocalTime_(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function listSupabaseBackups(limit) {
  const outDir = getBackupOutDir_();
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));

  if (!fs.existsSync(outDir)) {
    return ok({ data: [], out_dir: outDir, source: "supabase" });
  }

  let files = [];
  try {
    files = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && /^erp_supabase_.*\.dump$/i.test(ent.name))
      .map((ent) => {
        const full = path.join(outDir, ent.name);
        let st = null;
        try {
          st = fs.statSync(full);
        } catch (_e) {}
        const sizeBytes = st && st.size ? st.size : 0;
        const mtime = st && st.mtime ? st.mtime : null;
        const kind = classifyBackupKind_(ent.name);
        return {
          file_name: ent.name,
          size_bytes: sizeBytes,
          size_mb: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
          modified_at: mtime ? mtime.toISOString() : "",
          display_time: formatLocalTime_(mtime),
          backup_kind: kind
        };
      })
      .filter((row) => row.size_bytes >= 1024)
      .sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)))
      .slice(0, max);
  } catch (err) {
    return fail(err.message || String(err), "ERR_BACKUP_LIST_FAILED");
  }

  return ok({ data: files, out_dir: outDir, source: "supabase" });
}

function runPgDump_(cfg) {
  return new Promise((resolve, reject) => {
    const args = [
      "-h",
      cfg.host,
      "-p",
      String(cfg.port),
      "-U",
      cfg.user,
      "-d",
      cfg.dbName,
      "-Fc",
      "-f",
      cfg.outFile
    ];
    const child = spawn(cfg.pgDump, args, {
      env: { ...process.env, PGPASSWORD: cfg.password },
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "pg_dump exit " + code));
    });
  });
}

function getBackupDbConfig_() {
  const host = String(process.env.BACKUP_DB_HOST || "").trim();
  const user =
    String(process.env.BACKUP_DB_USER || "").trim() ||
    (() => {
      const ref = projectRefFromSupabaseUrl(process.env.SUPABASE_URL);
      return ref ? "postgres." + ref : "";
    })();
  const password = String(process.env.BACKUP_DB_PASSWORD || "").trim();
  const port = Number(process.env.BACKUP_DB_PORT || 5432) || 5432;
  const dbName = String(process.env.BACKUP_DB_NAME || "postgres").trim() || "postgres";
  return { host, user, password, port, dbName };
}

function resolveBackupFilePath_(fileName) {
  const base = path.resolve(getBackupOutDir_());
  const safe = path.basename(String(fileName || "").trim());
  if (!/^erp_supabase_.*\.dump$/i.test(safe)) return null;
  const full = path.resolve(path.join(base, safe));
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(full)) return null;
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(full).size;
  } catch (_e) {}
  if (sizeBytes < 1024) return null;
  return full;
}

function runPgRestore_(cfg) {
  return new Promise((resolve, reject) => {
    const args = [
      "-h",
      cfg.host,
      "-p",
      String(cfg.port),
      "-U",
      cfg.user,
      "-d",
      cfg.dbName,
      "-n",
      "public",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      cfg.dumpFile
    ];
    const child = spawn(cfg.pgRestore, args, {
      env: { ...process.env, PGPASSWORD: cfg.password },
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const errText = stderr.trim();
      if (code === 0 || code === 1) {
        resolve({ exitCode: code, stderr: errText });
      } else {
        reject(new Error(errText || "pg_restore exit " + code));
      }
    });
  });
}

async function triggerSupabaseBackup(actor) {
  const { host, user, password, port, dbName } = getBackupDbConfig_();
  const outDir = getBackupOutDir_();

  if (!host || !user || !password) {
    return fail(
      "備份未設定：請在 server/.env 填寫 BACKUP_DB_HOST、BACKUP_DB_USER、BACKUP_DB_PASSWORD（Session pooler）",
      "ERR_BACKUP_NOT_CONFIGURED"
    );
  }

  const pgDump = findPgDumpPath();
  if (!pgDump) {
    return fail(
      "找不到 pg_dump：請安裝 PostgreSQL 17 或設定 PG_DUMP_PATH",
      "ERR_PG_DUMP_NOT_FOUND"
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, backupFileName_("manual"));

  try {
    await runPgDump_({
      pgDump,
      host,
      port,
      user,
      password,
      dbName,
      outFile
    });
  } catch (err) {
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch (_e) {}
    return fail(err.message || String(err), "ERR_BACKUP_FAILED");
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(outFile).size;
  } catch (_e) {}

  if (sizeBytes < 1024) {
    try {
      fs.unlinkSync(outFile);
    } catch (_e2) {}
    return fail("備份檔過小，請檢查 BACKUP_DB_* 連線設定", "ERR_BACKUP_TOO_SMALL");
  }

  const sizeMb = Math.round((sizeBytes / (1024 * 1024)) * 100) / 100;
  return ok({
    file_name: path.basename(outFile),
    out_dir: outDir,
    size_bytes: sizeBytes,
    size_mb: sizeMb,
    backup_kind: "manual",
    triggered_by: String(actor || "").trim(),
    source: "supabase"
  });
}

async function triggerSupabaseRestore(actor, fileName, confirmToken) {
  if (String(confirmToken || "").trim() !== "RESTORE") {
    return fail("還原需 confirm_token=RESTORE", "ERR_RESTORE_CONFIRM_REQUIRED");
  }

  const dumpPath = resolveBackupFilePath_(fileName);
  if (!dumpPath) {
    return fail("找不到或無效的備份檔：" + String(fileName || ""), "ERR_RESTORE_FILE_NOT_FOUND");
  }

  const { host, user, password, port, dbName } = getBackupDbConfig_();
  if (!host || !user || !password) {
    return fail(
      "還原未設定：請在 server/.env 填寫 BACKUP_DB_HOST、BACKUP_DB_USER、BACKUP_DB_PASSWORD",
      "ERR_BACKUP_NOT_CONFIGURED"
    );
  }

  const pgRestore = findPgRestorePath();
  if (!pgRestore) {
    return fail(
      "找不到 pg_restore：請安裝 PostgreSQL 17 或設定 PG_RESTORE_PATH",
      "ERR_PG_RESTORE_NOT_FOUND"
    );
  }

  let restoreResult;
  try {
    restoreResult = await runPgRestore_({
      pgRestore,
      host,
      port,
      user,
      password,
      dbName,
      dumpFile: dumpPath
    });
  } catch (err) {
    return fail(err.message || String(err), "ERR_RESTORE_FAILED");
  }

  const stderr = String(restoreResult.stderr || "");
  const warningLines = stderr
    ? stderr.split(/\r?\n/).filter((line) => /warning|errors ignored/i.test(line))
    : [];

  return ok({
    file_name: path.basename(dumpPath),
    out_dir: getBackupOutDir_(),
    restore_scope: "public",
    pg_restore_exit_code: restoreResult.exitCode,
    restore_warnings: stderr.slice(0, 4000),
    warning_summary: warningLines.slice(0, 5).join("\n"),
    restored_by: String(actor || "").trim(),
    source: "supabase",
    hint: "還原後請 Ctrl+F5 重整 ERP；若 Supabase 表編輯連結失效，請重啟 Node API 或重跑 v4.1.08 RPC"
  });
}

module.exports = { triggerSupabaseBackup, listSupabaseBackups, triggerSupabaseRestore };
