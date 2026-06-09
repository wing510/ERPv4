function envName() {
  return String(process.env.ERP_ENV_NAME || "DEV").trim() || "DEV";
}

function ok(body) {
  return {
    success: true,
    env: envName(),
    erp_version: "4.1",
    backend: "supabase",
    ...body
  };
}

function fail(errors, code) {
  const errs = [].concat(errors).map((x) => String(x || ""));
  return {
    success: false,
    env: envName(),
    error_code: code || "",
    errors: errs
  };
}

function stubOk(extra) {
  return ok({
    data: [],
    source: "stub",
    ...extra
  });
}

module.exports = { ok, fail, stubOk, envName };
