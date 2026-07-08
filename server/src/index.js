require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { dispatch } = require("./handlers");

const PORT = Number(process.env.PORT || 1314);

const app = express();
app.use(
  cors({
    origin: true,
    credentials: false
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

async function handleRequest(req, res) {
  const params = { ...req.query, ...req.body };
  try {
    const result = await dispatch(params.action, params);
    res.status(200).json(result);
  } catch (err) {
    console.error("[erp-api]", err);
    res.status(500).json({
      success: false,
      env: String(process.env.ERP_ENV_NAME || "DEV"),
      error_code: "ERR_INTERNAL",
      errors: [String(err && err.message ? err.message : err)]
    });
  }
}

app.get("/exec", handleRequest);
app.post("/exec", handleRequest);
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    erp_version: "4.2",
    env: process.env.ERP_ENV_NAME || "DEV"
  });
});

app.listen(PORT, () => {
  console.log(`ERP Supabase API http://127.0.0.1:${PORT}/exec`);
  console.log(`env=${process.env.ERP_ENV_NAME || "DEV"}`);
});
