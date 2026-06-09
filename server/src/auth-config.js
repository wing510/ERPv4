const crypto = require("crypto");

function sha256Hex(plain) {
  return crypto.createHash("sha256").update(String(plain || ""), "utf8").digest("hex");
}

function getSuperAdminUserId_() {
  return String(process.env.ERP_SUPER_ADMIN_USER_ID || "").trim();
}

function isSuperAdminUserId_(userId) {
  const want = getSuperAdminUserId_();
  if (!want) return false;
  return String(userId || "").trim().toLowerCase() === want.toLowerCase();
}

function verifySuperAdminPassword_(plainPw) {
  const want = String(
    process.env.ERP_SUPER_ADMIN_PASSWORD_SHA256_HEX ||
      process.env.ERP_ADMIN_PASSWORD_SHA256_HEX ||
      ""
  )
    .trim()
    .toLowerCase();
  if (!want) return false;
  return sha256Hex(plainPw).toLowerCase() === want;
}

module.exports = {
  sha256Hex,
  getSuperAdminUserId_,
  isSuperAdminUserId_,
  verifySuperAdminPassword_
};
