const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  buildTxId,
  buildId_,
  parseJsonArray,
  appendSystemRemark_,
  writeAuditLog_,
  insertLot_
} = require("./shared");
const { createInventoryMovementUnlocked_ } = require("../inventory-movement-core");

async function ensureProcessOrderTx_(procId, actor) {
  const id = String(procId || "").trim().toUpperCase();
  if (!id) return "";
  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("transaction_id").eq("process_order_id", id).maybeSingle();
  if (!po) return buildTxId();
  const existed = String(po.transaction_id || "").trim();
  if (existed) return existed;
  const next = buildTxId();
  await sb
    .from("process_order")
    .update({ transaction_id: next, updated_by: actor || "", updated_at: nowIso() })
    .eq("process_order_id", id);
  return next;
}

async function listInputsByOrder_(procId) {
  const sb = getSupabase();
  const { data } = await sb.from("process_order_input").select("*").eq("process_order_id", procId);
  return data || [];
}

async function listOutputsByOrder_(procId) {
  const sb = getSupabase();
  const { data } = await sb.from("process_order_output").select("*").eq("process_order_id", procId);
  return data || [];
}

async function findProcessOrderMovements_(procId) {
  const sb = getSupabase();
  const { data } = await sb
    .from("inventory_movement")
    .select("*")
    .eq("ref_type", "PROCESS_ORDER")
    .eq("ref_id", procId);
  return data || [];
}

async function listShipmentItemsByLotId_(lotId) {
  const sb = getSupabase();
  const { data } = await sb.from("shipment_item").select("*").eq("lot_id", lotId);
  return data || [];
}

async function listLotRelationsFromLotId_(lotId) {
  const sb = getSupabase();
  const { data } = await sb.from("lot_relation").select("*").eq("from_lot_id", lotId);
  return data || [];
}

async function createProcessOrderCmd(p) {
  const id = String(p.process_order_id || "").trim().toUpperCase();
  if (!id) return fail("process_order_id required");
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");

  const processType = String(p.process_type || "").trim().toUpperCase();
  if (!processType) return fail("process_type required");
  const supplierId = String(p.supplier_id || "").trim().toUpperCase();
  if (!supplierId) return fail("supplier_id required");

  const sb = getSupabase();
  const { data: existed } = await sb.from("process_order").select("process_order_id").eq("process_order_id", id).maybeSingle();
  if (existed) return fail("Process order already exists");

  const txId = String(p.transaction_id || "").trim() || buildTxId();
  const { error } = await sb.from("process_order").insert({
    process_order_id: id,
    process_type: processType,
    source_type: String(p.source_type || "").trim().toUpperCase(),
    supplier_id: supplierId,
    transaction_id: txId,
    parent_ref_type: String(p.parent_ref_type || "").trim().toUpperCase(),
    parent_ref_id: String(p.parent_ref_id || "").trim().toUpperCase(),
    planned_date: String(p.planned_date || "").trim() || null,
    status: "OPEN",
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: p.created_at || nowIso(),
    updated_by: "",
    updated_at: null
  });
  if (error) return fail(error.message || String(error));

  await writeAuditLog_("process_order", id, "CREATE_PROCESS_ORDER", actor, JSON.stringify({ process_order_id: id }));
  return ok({ message: "Created", process_order_id: id });
}

async function updateProcessOrderHeaderCmd(p) {
  const id = String(p.process_order_id || "").trim().toUpperCase();
  if (!id) return fail("process_order_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", id).maybeSingle();
  if (!po) return fail("Process order not found");
  const st = String(po.status || "").trim().toUpperCase();
  if (st === "CANCELLED") return fail("Process order is CANCELLED");
  if (st === "POSTED") return fail("Process order already POSTED");

  const { error } = await sb
    .from("process_order")
    .update({
      planned_date: String(p.planned_date || "").trim() || null,
      remark: String(p.remark || ""),
      updated_by: actor,
      updated_at: p.updated_at || nowIso()
    })
    .eq("process_order_id", id);
  if (error) return fail(error.message || String(error));
  return ok({ message: "Updated", process_order_id: id });
}

async function updateProcessOrderInputRemark(p) {
  const inputId = String(p.process_input_id || "").trim();
  if (!inputId) return fail("process_input_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: row } = await sb.from("process_order_input").select("*").eq("process_input_id", inputId).maybeSingle();
  if (!row) return fail("Process input not found");
  const { data: po } = await sb.from("process_order").select("status").eq("process_order_id", row.process_order_id).maybeSingle();
  if (!po) return fail("Process order not found");
  if (String(po.status || "").trim().toUpperCase() === "CANCELLED") return fail("Process order is CANCELLED");

  const { error } = await sb
    .from("process_order_input")
    .update({ remark: String(p.remark || ""), updated_by: actor, updated_at: p.updated_at || nowIso() })
    .eq("process_input_id", inputId);
  if (error) return fail(error.message || String(error));
  return ok({ message: "Updated" });
}

async function updateProcessOrderOutputRemark(p) {
  const outputId = String(p.process_output_id || "").trim();
  if (!outputId) return fail("process_output_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: row } = await sb.from("process_order_output").select("*").eq("process_output_id", outputId).maybeSingle();
  if (!row) return fail("Process output not found");
  const { data: po } = await sb.from("process_order").select("status").eq("process_order_id", row.process_order_id).maybeSingle();
  if (!po) return fail("Process order not found");
  if (String(po.status || "").trim().toUpperCase() === "CANCELLED") return fail("Process order is CANCELLED");

  const { error } = await sb
    .from("process_order_output")
    .update({ remark: String(p.remark || ""), updated_by: actor, updated_at: p.updated_at || nowIso() })
    .eq("process_output_id", outputId);
  if (error) return fail(error.message || String(error));
  return ok({ message: "Updated" });
}

async function issueProcessOrderBundle(p) {
  const processOrderId = String(p.process_order_id || "").trim().toUpperCase();
  if (!processOrderId) return fail("process_order_id required");
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", processOrderId).maybeSingle();
  if (!po) return fail("Process order not found");
  const st = String(po.status || "").toUpperCase();
  if (st === "CANCELLED") return fail("Process order is CANCELLED");
  if (st === "POSTED") return fail("Process order already POSTED");

  const inputsPack = parseJsonArray(p.inputs_json, "inputs_json");
  if (inputsPack.err) return fail(inputsPack.err);
  const inputs = inputsPack.data;
  if (!inputs.length) return fail("inputs required");

  const existedInputs = await listInputsByOrder_(processOrderId);
  const expected = Number(p.expected_existed_inputs_count || 0);
  if (Number.isNaN(expected)) return fail("expected_existed_inputs_count invalid");
  if (existedInputs.length !== expected) return fail("Inputs changed. Please reload and try again");

  const txId = (await ensureProcessOrderTx_(processOrderId, actor)) || buildTxId();
  const existedCount = existedInputs.length;

  for (let i = 0; i < inputs.length; i++) {
    const it = inputs[i] || {};
    const lotId = String(it.lot_id || "").trim().toUpperCase();
    if (!lotId) return fail("lot_id required (inputs[" + i + "])");
    const issueQty = Number(it.issue_qty || 0);
    if (!(issueQty > 0)) return fail("issue_qty must be > 0 (inputs[" + i + "])");
    const unit = String(it.unit || "").trim();
    if (!unit) return fail("unit required (inputs[" + i + "])");

    const seq = existedCount + i + 1;
    const inputId = "PIN-" + processOrderId + "-" + String(seq).padStart(3, "0");

    const { error: pinErr } = await sb.from("process_order_input").insert({
      process_input_id: inputId,
      process_order_id: processOrderId,
      lot_id: lotId,
      product_id: String(it.product_id || "").trim().toUpperCase(),
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: processOrderId,
      issue_qty: issueQty,
      unit: unit,
      remark: String(it.remark || ""),
      created_by: actor,
      created_at: nowIso(),
      updated_by: "",
      updated_at: null
    });
    if (pinErr) return fail(pinErr.message || String(pinErr));

    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: buildId_("MV"),
      movement_type: "PROCESS_OUT",
      lot_id: lotId,
      product_id: String(it.product_id || "").trim().toUpperCase(),
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: processOrderId,
      qty: -Math.abs(issueQty),
      unit: unit,
      ref_type: "PROCESS_ORDER",
      ref_id: processOrderId,
      remark: "",
      created_by: actor,
      created_at: nowIso(),
      system_remark: "Process OUT: " + processOrderId + " (" + inputId + ")"
    });
    if (mvRes && mvRes.success === false) return mvRes;
  }

  const { error: stErr } = await sb
    .from("process_order")
    .update({ status: "OPEN", updated_by: actor, updated_at: nowIso() })
    .eq("process_order_id", processOrderId);
  if (stErr) return fail(stErr.message || String(stErr));

  await writeAuditLog_("process_order", processOrderId, "BUNDLE_ISSUE_PROCESS_ORDER", actor, JSON.stringify({ process_order_id: processOrderId }));
  return ok({ message: "ISSUED", process_order_id: processOrderId });
}

async function receiveProcessOutputBundle(p) {
  const processOrderId = String(p.process_order_id || "").trim().toUpperCase();
  if (!processOrderId) return fail("process_order_id required");
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", processOrderId).maybeSingle();
  if (!po) return fail("Process order not found");
  const st = String(po.status || "").toUpperCase();
  if (st === "CANCELLED") return fail("Process order is CANCELLED");
  if (st === "POSTED") return fail("Process order already POSTED");

  const outputsPack = parseJsonArray(p.outputs_json, "outputs_json");
  if (outputsPack.err) return fail(outputsPack.err);
  const outputs = outputsPack.data;
  if (!outputs.length) return fail("outputs required");

  const inputs = await listInputsByOrder_(processOrderId);
  if (!inputs.length) return fail("No inputs. Please issue process order first");

  const existedOutputs = await listOutputsByOrder_(processOrderId);
  const expected = Number(p.expected_existed_outputs_count || 0);
  if (Number.isNaN(expected)) return fail("expected_existed_outputs_count invalid");
  if (existedOutputs.length !== expected) return fail("Outputs changed. Please reload and try again");

  const nextStatus = String(p.next_status || "").trim().toUpperCase();
  if (nextStatus !== "OPEN" && nextStatus !== "POSTED") return fail("next_status invalid");

  let whId = String(p.warehouse_id || "").trim().toUpperCase();
  if (!whId) {
    const in0LotId = String(inputs[0].lot_id || "").trim().toUpperCase();
    const { data: in0Lot } = await sb.from("lot").select("warehouse_id").eq("lot_id", in0LotId).maybeSingle();
    whId = String((in0Lot && in0Lot.warehouse_id) || "MAIN").trim().toUpperCase() || "MAIN";
  } else {
    const { data: wh } = await sb.from("warehouse").select("status").eq("warehouse_id", whId).maybeSingle();
    if (!wh) return fail("Warehouse not found: " + whId);
    if (String(wh.status || "ACTIVE").trim().toUpperCase() !== "ACTIVE") {
      return fail("Warehouse is not ACTIVE: " + whId);
    }
  }

  const txId = (await ensureProcessOrderTx_(processOrderId, actor)) || buildTxId();
  const createdLots = [];

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i] || {};
    const productId = String(out.product_id || "").trim().toUpperCase();
    if (!productId) return fail("product_id required (outputs[" + i + "])");
    const qty = Number(out.receive_qty || 0);
    if (!(qty > 0)) return fail("receive_qty must be > 0 (outputs[" + i + "])");
    const unit = String(out.unit || "").trim();
    if (!unit) return fail("unit required (outputs[" + i + "])");

    const outSeq = existedOutputs.length + i + 1;
    const outLotId = buildId_("LOT");
    const outputId = "POUT-" + processOrderId + "-" + String(outSeq).padStart(3, "0");
    const ts = nowIso();

    const { error: lotErr } = await insertLot_({
      lot_id: outLotId,
      product_id: productId,
      warehouse_id: whId,
      source_type: "PROCESS",
      source_id: processOrderId,
      qty: qty,
      unit: unit,
      type: String(out.type || "WIP").trim().toUpperCase() || "WIP",
      status: "PENDING",
      inventory_status: "ACTIVE",
      received_date: ts.slice(0, 10),
      manufacture_date: null,
      expiry_date: null,
      remark: String(out.remark || ""),
      created_by: actor,
      created_at: ts,
      system_remark: "Process IN lot from " + processOrderId
    });
    if (lotErr) return fail(lotErr.message || String(lotErr));

    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: buildId_("MV"),
      movement_type: "PROCESS_IN",
      lot_id: outLotId,
      product_id: productId,
      warehouse_id: whId,
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: processOrderId,
      qty: Math.abs(qty),
      unit: unit,
      ref_type: "PROCESS_ORDER",
      ref_id: processOrderId,
      remark: "",
      created_by: actor,
      created_at: ts,
      system_remark: "Process IN: " + processOrderId
    });
    if (mvRes && mvRes.success === false) return mvRes;

    const { error: outErr } = await sb.from("process_order_output").insert({
      process_output_id: outputId,
      process_order_id: processOrderId,
      lot_id: outLotId,
      product_id: productId,
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: processOrderId,
      receive_qty: qty,
      unit: unit,
      loss_base_qty_after: out.loss_base_qty_after != null ? Number(out.loss_base_qty_after) : null,
      loss_base_unit: String(out.loss_base_unit || ""),
      status: "CREATED",
      remark: String(out.remark || ""),
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null
    });
    if (outErr) return fail(outErr.message || String(outErr));

    for (let k = 0; k < inputs.length; k++) {
      const it = inputs[k] || {};
      const relId = "REL-" + processOrderId + "-" + String(outSeq).padStart(3, "0") + "-" + String(k + 1).padStart(3, "0");
      const { error: relErr } = await sb.from("lot_relation").insert({
        relation_id: relId,
        relation_type: "INPUT",
        from_lot_id: String(it.lot_id || "").trim().toUpperCase(),
        to_lot_id: outLotId,
        qty: Number(it.issue_qty || 0),
        unit: String(it.unit || ""),
        ref_type: "PROCESS_ORDER",
        ref_id: processOrderId,
        transaction_id: txId,
        parent_ref_type: "PROCESS_ORDER",
        parent_ref_id: processOrderId,
        created_by: actor,
        created_at: ts,
        updated_by: "",
        updated_at: null
      });
      if (relErr) return fail(relErr.message || String(relErr));
    }

    createdLots.push(outLotId);
  }

  const { error: poErr } = await sb
    .from("process_order")
    .update({ status: nextStatus, updated_by: actor, updated_at: nowIso() })
    .eq("process_order_id", processOrderId);
  if (poErr) return fail(poErr.message || String(poErr));

  await writeAuditLog_(
    "process_order",
    processOrderId,
    "BUNDLE_RECEIVE_PROCESS_OUTPUT",
    actor,
    JSON.stringify({ process_order_id: processOrderId, created_lots: createdLots })
  );
  return ok({ message: "RECEIVED", process_order_id: processOrderId, created_lots: createdLots });
}

async function retractProcessIssueBundle(p) {
  const procId = String(p.process_order_id || "").trim().toUpperCase();
  if (!procId) return fail("process_order_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", procId).maybeSingle();
  if (!po) return fail("Process order not found");
  if (String(po.status || "").toUpperCase() === "CANCELLED") return fail("Process order is CANCELLED");

  const outputs = await listOutputsByOrder_(procId);
  const activeOutputs = outputs.filter((x) => String(x.status || "").toUpperCase() !== "CANCELLED");
  if (activeOutputs.length > 0) return fail("Cannot retract: outputs exist");

  const inputs = await listInputsByOrder_(procId);
  if (!inputs.length) return fail("No inputs to retract");

  const mvAll = await findProcessOrderMovements_(procId);
  const srcMv = mvAll.filter((m) => String(m.movement_type || "").toUpperCase() === "PROCESS_OUT");
  if (!srcMv.length) return fail("Missing PROCESS_OUT movements");

  const alreadyReversed = mvAll.some((m) => String(m.system_remark || m.remark || "").indexOf("REVERSAL(PROCESS_OUT)") >= 0);
  if (alreadyReversed) return fail("Already retracted");

  const issueAtByLot = {};
  srcMv.forEach((m) => {
    const lid = String(m.lot_id || "");
    const t = String(m.created_at || "");
    if (!lid || !t) return;
    if (!issueAtByLot[lid] || t < issueAtByLot[lid]) issueAtByLot[lid] = t;
  });

  const inputLotIds = [...new Set(inputs.map((x) => String(x.lot_id || "").trim().toUpperCase()).filter(Boolean))];
  for (let i = 0; i < inputLotIds.length; i++) {
    const lotId = inputLotIds[i];
    const usedShip = await listShipmentItemsByLotId_(lotId);
    if (usedShip.length > 0) return fail("Input lot used in shipment: " + lotId);
  }

  for (let i = 0; i < mvAll.length; i++) {
    const m = mvAll[i];
    const lotId = String(m.lot_id || "");
    if (inputLotIds.indexOf(lotId) === -1) continue;
    const issuedAt = issueAtByLot[lotId];
    const createdAt = String(m.created_at || "");
    if (!(issuedAt && createdAt && createdAt > issuedAt)) continue;
    const sameOrder = String(m.ref_type || "").toUpperCase() === "PROCESS_ORDER" && String(m.ref_id || "") === procId;
    const isReversal = String(m.system_remark || m.remark || "").indexOf("REVERSAL") >= 0;
    if (!sameOrder && !isReversal) return fail("Input lot has downstream movement: " + lotId);
  }

  const txId = (await ensureProcessOrderTx_(procId, actor)) || buildTxId();

  for (let i = 0; i < srcMv.length; i++) {
    const m = srcMv[i];
    const qty = Number(m.qty || 0);
    if (!qty) continue;
    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: buildId_("MV"),
      movement_type: "ADJUST",
      lot_id: m.lot_id || "",
      product_id: m.product_id || "",
      warehouse_id: m.warehouse_id || "",
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: procId,
      qty: -qty,
      unit: m.unit || "",
      ref_type: "PROCESS_ORDER",
      ref_id: procId,
      remark: "",
      created_by: actor,
      created_at: nowIso(),
      system_remark: "REVERSAL(PROCESS_OUT) of " + (m.movement_id || "") + " (" + procId + ")"
    });
    if (mvRes && mvRes.success === false) return mvRes;
  }

  for (let i = 0; i < inputs.length; i++) {
    const { error: delErr } = await sb.from("process_order_input").delete().eq("process_input_id", inputs[i].process_input_id);
    if (delErr) return fail(delErr.message || String(delErr));
  }

  const { error: stErr } = await sb
    .from("process_order")
    .update({ status: "OPEN", updated_by: actor, updated_at: nowIso() })
    .eq("process_order_id", procId);
  if (stErr) return fail(stErr.message || String(stErr));

  await writeAuditLog_("process_order", procId, "BUNDLE_RETRACT_PROCESS_ISSUE", actor, JSON.stringify({ process_order_id: procId }));
  return ok({ message: "RETRACTED", process_order_id: procId });
}

async function voidProcessOutputBundle(p) {
  const procId = String(p.process_order_id || "").trim().toUpperCase();
  const outId = String(p.process_output_id || "").trim();
  if (!procId) return fail("process_order_id required");
  if (!outId) return fail("process_output_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", procId).maybeSingle();
  if (!po) return fail("Process order not found");
  if (String(po.status || "").toUpperCase() === "CANCELLED") return fail("Process order is CANCELLED");

  const outs = await listOutputsByOrder_(procId);
  const out = outs.find((x) => String(x.process_output_id || "") === outId) || null;
  if (!out) return fail("Output not found");
  if (String(out.status || "").toUpperCase() === "CANCELLED") return fail("Output already CANCELLED");

  const lotId = String(out.lot_id || "").trim().toUpperCase();
  const qty = Number(out.receive_qty || 0);
  if (!lotId) return fail("lot_id missing");
  if (!(qty > 0)) return fail("receive_qty invalid");

  if ((await listShipmentItemsByLotId_(lotId)).length > 0) return fail("Output lot used in shipment");
  const rels = await listLotRelationsFromLotId_(lotId);
  const badRel = rels.some((r) => {
    const same = String(r.ref_type || "").toUpperCase() === "PROCESS_ORDER" && String(r.ref_id || "") === procId;
    return !same;
  });
  if (badRel) return fail("Output lot used in lot_relation");

  const mvAll = await findProcessOrderMovements_(procId);
  const usedDownstream = mvAll.some((m) => {
    if (String(m.lot_id || "") !== lotId) return false;
    const sameOrder = String(m.ref_type || "").toUpperCase() === "PROCESS_ORDER" && String(m.ref_id || "") === procId;
    const isReversal = String(m.system_remark || m.remark || "").indexOf("REVERSAL") >= 0;
    return !sameOrder && !isReversal;
  });
  if (usedDownstream) return fail("Output lot has downstream movement");

  const already = mvAll.some((m) => String(m.system_remark || m.remark || "").indexOf("REVERSAL(PROCESS_IN) of " + outId) >= 0);
  if (already) return fail("Already voided");

  const { data: lot } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
  if (!lot) return fail("Lot not found: " + lotId);

  const txId = (await ensureProcessOrderTx_(procId, actor)) || buildTxId();
  const mvRes = await createInventoryMovementUnlocked_({
    movement_id: buildId_("MV"),
    movement_type: "ADJUST",
    lot_id: lotId,
    product_id: out.product_id || lot.product_id || "",
    warehouse_id: lot.warehouse_id || "",
    transaction_id: txId,
    parent_ref_type: "PROCESS_ORDER",
    parent_ref_id: procId,
    qty: -Math.abs(qty),
    unit: out.unit || lot.unit || "",
    ref_type: "PROCESS_ORDER",
    ref_id: procId,
    remark: "",
    created_by: actor,
    created_at: nowIso(),
    system_remark: "REVERSAL(PROCESS_IN) of " + outId + " (" + procId + ")"
  });
  if (mvRes && mvRes.success === false) return mvRes;

  const { error: outErr } = await sb
    .from("process_order_output")
    .update({
      status: "CANCELLED",
      system_remark: appendSystemRemark_(out.system_remark, "回收已作廢 " + nowIso() + " " + actor),
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("process_output_id", outId);
  if (outErr) return fail(outErr.message || String(outErr));

  const { error: lotErr } = await sb
    .from("lot")
    .update({
      inventory_status: "VOID",
      updated_by: actor,
      updated_at: nowIso(),
      system_remark: appendSystemRemark_(lot.system_remark, "回收作廢 " + nowIso() + " " + actor)
    })
    .eq("lot_id", lotId);
  if (lotErr) return fail(lotErr.message || String(lotErr));

  const { error: poErr } = await sb
    .from("process_order")
    .update({ status: "OPEN", updated_by: actor, updated_at: nowIso() })
    .eq("process_order_id", procId);
  if (poErr) return fail(poErr.message || String(poErr));

  await writeAuditLog_("process_order", procId, "BUNDLE_VOID_PROCESS_OUTPUT", actor, JSON.stringify({ process_order_id: procId, process_output_id: outId }));
  return ok({ message: "VOIDED", process_order_id: procId, process_output_id: outId });
}

async function cancelProcessOrderBundle(p) {
  const procId = String(p.process_order_id || "").trim().toUpperCase();
  if (!procId) return fail("process_order_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: po } = await sb.from("process_order").select("*").eq("process_order_id", procId).maybeSingle();
  if (!po) return fail("Process order not found");
  if (String(po.status || "").toUpperCase() === "CANCELLED") return fail("Process order already CANCELLED");

  const outputs = await listOutputsByOrder_(procId);
  const outputLots = outputs.map((x) => String(x.lot_id || "").trim().toUpperCase()).filter(Boolean);

  for (let i = 0; i < outputLots.length; i++) {
    const lotId = outputLots[i];
    if ((await listShipmentItemsByLotId_(lotId)).length > 0) return fail("Output lot used in shipment: " + lotId);
    const rels = await listLotRelationsFromLotId_(lotId);
    const badRel = rels.some((r) => {
      const same = String(r.ref_type || "").toUpperCase() === "PROCESS_ORDER" && String(r.ref_id || "") === procId;
      return !same;
    });
    if (badRel) return fail("Output lot used in lot_relation: " + lotId);
  }

  const mvAll = await findProcessOrderMovements_(procId);
  const reversed = mvAll.some((m) => String(m.system_remark || m.remark || "").indexOf("REVERSAL(") >= 0);
  if (reversed) return fail("Reversal already exists");

  const txId = (await ensureProcessOrderTx_(procId, actor)) || buildTxId();

  for (let i = 0; i < mvAll.length; i++) {
    const m = mvAll[i];
    const qty = Number(m.qty || 0);
    if (!qty) continue;
    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: buildId_("MV"),
      movement_type: "ADJUST",
      lot_id: m.lot_id || "",
      product_id: m.product_id || "",
      warehouse_id: m.warehouse_id || "",
      transaction_id: txId,
      parent_ref_type: "PROCESS_ORDER",
      parent_ref_id: procId,
      qty: -qty,
      unit: m.unit || "",
      ref_type: "PROCESS_ORDER",
      ref_id: procId,
      remark: "",
      created_by: actor,
      created_at: nowIso(),
      system_remark: "REVERSAL(" + (m.movement_type || "") + ") of " + (m.movement_id || "") + " (" + procId + ")"
    });
    if (mvRes && mvRes.success === false) return mvRes;
  }

  const { error: poErr } = await sb
    .from("process_order")
    .update({
      transaction_id: txId,
      status: "CANCELLED",
      updated_by: actor,
      updated_at: nowIso(),
      system_remark: appendSystemRemark_(po.system_remark, "已取消並回沖 " + nowIso() + " " + actor)
    })
    .eq("process_order_id", procId);
  if (poErr) return fail(poErr.message || String(poErr));

  await writeAuditLog_("process_order", procId, "BUNDLE_CANCEL_PROCESS_ORDER", actor, JSON.stringify({ process_order_id: procId }));
  return ok({ message: "CANCELLED", process_order_id: procId });
}

module.exports = {
  createProcessOrderCmd,
  updateProcessOrderHeaderCmd,
  updateProcessOrderInputRemark,
  updateProcessOrderOutputRemark,
  issueProcessOrderBundle,
  receiveProcessOutputBundle,
  retractProcessIssueBundle,
  voidProcessOutputBundle,
  cancelProcessOrderBundle
};
