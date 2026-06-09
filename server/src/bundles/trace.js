const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");

function normalizeTxId_(tx) {
  return String(tx || "").trim().toUpperCase();
}

async function buildAvailableQtyMap_(sb) {
  const map = {};
  const { data: balRows, error: balErr } = await sb.from("lot_balance").select("lot_id, available_qty");
  if (balErr) throw balErr;

  if (balRows && balRows.length > 0) {
    balRows.forEach((r) => {
      const id = String(r.lot_id || "").trim().toUpperCase();
      if (id) map[id] = Number(r.available_qty || 0);
    });
    return map;
  }

  const { data: movRows, error: movErr } = await sb.from("inventory_movement").select("lot_id, qty");
  if (movErr) throw movErr;
  (movRows || []).forEach((r) => {
    const id = String(r.lot_id || "").trim().toUpperCase();
    if (!id) return;
    const q = Number(r.qty || 0);
    if (Number.isNaN(q)) return;
    map[id] = (map[id] || 0) + q;
  });
  return map;
}

async function listByTx_(sb, table, txId, limit) {
  const { data, error } = await sb
    .from(table)
    .select("*")
    .eq("transaction_id", txId)
    .limit(limit);
  if (error) throw error;
  return data || [];
}

const TX_TRACE_TABLES = [
  "sales_order",
  "sales_order_item",
  "shipment",
  "shipment_item",
  "goods_receipt",
  "goods_receipt_item",
  "import_receipt",
  "import_receipt_item",
  "process_order",
  "process_order_input",
  "process_order_output",
  "inventory_movement",
  "lot_relation"
];

async function traceTransactionBundle(p) {
  const txId = normalizeTxId_(p && p.transaction_id);
  if (!txId) return fail("transaction_id required");

  const limit = Math.max(1, Number(p && p.limit) || 2000);
  const sb = getSupabase();
  const out = { transaction_id: txId };

  for (let i = 0; i < TX_TRACE_TABLES.length; i++) {
    const table = TX_TRACE_TABLES[i];
    try {
      out[table] = await listByTx_(sb, table, txId, limit);
    } catch (err) {
      return fail(err.message || String(err));
    }
  }

  return ok({ data: out, source: "supabase" });
}

async function traceLotBundle(p) {
  const root = String((p && p.lot_id) || "")
    .trim()
    .toUpperCase();
  const MAX = Math.max(1, Math.min(500, Number((p && p.max_lots) || 150) || 150));
  if (!root) return fail("lot_id required");

  const sb = getSupabase();

  const { data: relRows, error: relErr } = await sb.from("lot_relation").select("*");
  if (relErr) return fail(relErr.message || String(relErr));

  const childrenByFrom = {};
  const parentsByTo = {};
  const relData = relRows || [];

  relData.forEach((relObj, idx) => {
    const fromId = String(relObj.from_lot_id || "")
      .trim()
      .toUpperCase();
    const toId = String(relObj.to_lot_id || "")
      .trim()
      .toUpperCase();
    if (!fromId || !toId) return;
    if (!childrenByFrom[fromId]) childrenByFrom[fromId] = [];
    if (!parentsByTo[toId]) parentsByTo[toId] = [];
    childrenByFrom[fromId].push(idx);
    parentsByTo[toId].push(idx);
  });

  const visited = {};
  const q = [root];
  const visitOrder = [];
  const outRelations = [];
  const outRelationKey = {};

  while (q.length && visitOrder.length < MAX) {
    const cur = q.shift();
    if (!cur || visited[cur]) continue;
    visited[cur] = true;
    visitOrder.push(cur);

    const relIdxs = ([]).concat(parentsByTo[cur] || [], childrenByFrom[cur] || []);
    for (let k = 0; k < relIdxs.length; k++) {
      const ri = relIdxs[k];
      const relObj = relData[ri];
      const fromId = String(relObj.from_lot_id || "")
        .trim()
        .toUpperCase();
      const toId = String(relObj.to_lot_id || "")
        .trim()
        .toUpperCase();

      const key =
        String(relObj.relation_id || "") +
        "|" +
        fromId +
        "|" +
        toId +
        "|" +
        String(relObj.ref_type || "") +
        "|" +
        String(relObj.ref_id || "");
      if (!outRelationKey[key]) {
        outRelationKey[key] = true;
        outRelations.push(relObj);
      }
      if (fromId && !visited[fromId]) q.push(fromId);
      if (toId && !visited[toId]) q.push(toId);
    }
  }
  const truncated = q.length > 0;

  const { data: shipRows, error: shipErr } = await sb.from("shipment_item").select("*");
  if (shipErr) return fail(shipErr.message || String(shipErr));

  const outShipItems = (shipRows || []).filter((row) => {
    const lotId = String(row.lot_id || "")
      .trim()
      .toUpperCase();
    return lotId && visited[lotId];
  });

  let fullAvail;
  try {
    fullAvail = await buildAvailableQtyMap_(sb);
  } catch (err) {
    return fail(err.message || String(err));
  }

  const availMap = {};
  Object.keys(visited).forEach((lotId) => {
    if (Object.prototype.hasOwnProperty.call(fullAvail, lotId)) {
      availMap[lotId] = Number(fullAvail[lotId] || 0);
    }
  });

  return ok({
    data: {
      lot_id: root,
      max_lots: MAX,
      lots: visitOrder,
      truncated: !!truncated,
      relations: outRelations,
      shipment_items: outShipItems,
      avail_by_lot_id: availMap
    },
    source: "supabase"
  });
}

module.exports = { traceLotBundle, traceTransactionBundle };
