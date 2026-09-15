const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  materials: [],
  materialBatches: [],
  requisitions: [],
  settlements: [],
  materialLedger: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/start",
  "POST /batches/:id/complete",
  "GET /batches/:id/requisitions",
  "POST /batches/:id/requisitions",
  "POST /batches/:id/settle",
  "GET /batches/:id/settlement",
  "GET /materials",
  "POST /materials",
  "GET /materials/:id",
  "POST /materials/:id/inbounds",
  "GET /materials/:id/ledger",
  "GET /materials/:id/consumption",
  "GET /materials/:id/expiring?days=",
  "POST /materials/:id/stocktake"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.materials = db.materials || [];
  db.materialBatches = db.materialBatches || [];
  db.requisitions = db.requisitions || [];
  db.settlements = db.settlements || [];
  db.materialLedger = db.materialLedger || [];
  return db;
}

async function writeDb(data) {
  // 先写临时文件再原子重命名，避免并发GET读到写了一半的文件
  const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2));
  await rename(tmpFile, DB_FILE);
}

// 所有非GET请求串行执行，保证“读-改-写”不被并发打断，领用不会超卖
let mutationChain = Promise.resolve();
function withLock(task) {
  const result = mutationChain.then(() => task());
  mutationChain = result.catch(() => {});
  return result;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertPositiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(400, `${field}必须是大于0的数字`);
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function findMaterial(db, materialId) {
  const material = db.materials.find((item) => item.id === materialId);
  if (!material) fail(404, "材料不存在");
  return material;
}

function findRepairBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) fail(404, "修补批次不存在");
  return batch;
}

function isExpired(materialBatch, now) {
  return new Date(materialBatch.expiresAt).getTime() <= now;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function materialView(db, material, now = Date.now()) {
  const batches = db.materialBatches
    .filter((item) => item.materialId === material.id)
    .map((item) => ({ ...item, expired: isExpired(item, now) }))
    .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
  const totalRemaining = round2(batches.reduce((sum, item) => sum + item.remaining, 0));
  const availableRemaining = round2(
    batches.filter((item) => !item.expired).reduce((sum, item) => sum + item.remaining, 0)
  );
  return { ...material, batches, totalRemaining, availableRemaining };
}

function addLedger(db, entry) {
  const record = {
    id: makeId("ledger"),
    materialId: entry.materialId,
    materialBatchId: entry.materialBatchId,
    type: entry.type,
    quantity: entry.quantity,
    refType: entry.refType || null,
    refId: entry.refId || null,
    note: entry.note || "",
    createdAt: new Date().toISOString()
  };
  db.materialLedger.push(record);
  return record;
}

// 先到期先出（FEFO）：只使用未过期且有余量的入库批次，库存不足返回null（整单拒绝，不做部分扣减）
function planAllocation(db, materialId, quantity, now) {
  const candidates = db.materialBatches
    .filter((item) => item.materialId === materialId && item.remaining > 0 && !isExpired(item, now))
    .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt) || a.createdAt.localeCompare(b.createdAt));
  const available = candidates.reduce((sum, item) => sum + item.remaining, 0);
  if (available < quantity) return null;
  const lines = [];
  let need = quantity;
  for (const batch of candidates) {
    if (need <= 0) break;
    const take = round2(Math.min(batch.remaining, need));
    lines.push({ materialBatchId: batch.id, quantity: take, unitPrice: batch.unitPrice, amount: round2(take * batch.unitPrice) });
    need = round2(need - take);
  }
  return lines;
}

function applyLines(db, lines, sign, type, refType, refId, note) {
  for (const line of lines) {
    const batch = db.materialBatches.find((item) => item.id === line.materialBatchId);
    batch.remaining = round2(batch.remaining + sign * line.quantity);
    addLedger(db, {
      materialId: batch.materialId,
      materialBatchId: batch.id,
      type,
      quantity: sign * line.quantity,
      refType,
      refId,
      note
    });
  }
}

function normalizeRequisitionItems(db, body) {
  let items;
  if (Array.isArray(body.items)) {
    items = body.items;
  } else if (body.materialId !== undefined) {
    items = [{ materialId: body.materialId, quantity: body.quantity }];
  } else {
    fail(400, "缺少字段：items");
  }
  if (!items.length) fail(400, "items必须是非空数组");
  // 先按材料归并求和，同一材料重复多行时以合计量校验和扣减，避免超卖为负库存
  const merged = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") fail(400, "items元素必须是对象");
    findMaterial(db, item.materialId);
    assertPositiveNumber(item.quantity, "quantity");
    merged.set(item.materialId, round2((merged.get(item.materialId) || 0) + item.quantity));
  }
  return [...merged.entries()].map(([materialId, quantity]) => ({ materialId, quantity }));
}

function requisitionFingerprint(repairBatchId, items) {
  const normalized = [...items].sort((a, b) => a.materialId.localeCompare(b.materialId));
  return JSON.stringify({ repairBatchId, items: normalized });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const startMatch = pathname.match(/^\/batches\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const batch = findRepairBatch(db, startMatch[1]);
    if (batch.status !== "open") fail(409, "只有待开工（open）的批次才能开工");
    batch.status = "in_progress";
    batch.startedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  // ---------- 材料库存与领用结算 ----------

  if (req.method === "GET" && pathname === "/materials") {
    return send(res, 200, { data: db.materials.map((material) => materialView(db, material)) });
  }

  if (req.method === "POST" && pathname === "/materials") {
    const body = await parseBody(req);
    required(body, ["name"]);
    const material = {
      id: makeId("material"),
      name: body.name,
      unit: body.unit || "件",
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.materials.push(material);
    await writeDb(db);
    return send(res, 201, { data: materialView(db, material) });
  }

  const materialMatch = pathname.match(/^\/materials\/([^/]+)$/);
  if (materialMatch && req.method === "GET") {
    const material = findMaterial(db, materialMatch[1]);
    return send(res, 200, { data: materialView(db, material) });
  }

  const inboundMatch = pathname.match(/^\/materials\/([^/]+)\/inbounds$/);
  if (inboundMatch && req.method === "POST") {
    const material = findMaterial(db, inboundMatch[1]);
    const body = await parseBody(req);
    required(body, ["quantity", "unitPrice", "expiresAt"]);
    assertPositiveNumber(body.quantity, "quantity");
    if (typeof body.unitPrice !== "number" || !Number.isFinite(body.unitPrice) || body.unitPrice < 0) {
      fail(400, "unitPrice必须是不小于0的数字");
    }
    if (Number.isNaN(new Date(body.expiresAt).getTime())) fail(400, "expiresAt必须是合法日期");
    const materialBatch = {
      id: makeId("mbatch"),
      materialId: material.id,
      quantity: body.quantity,
      remaining: body.quantity,
      unitPrice: body.unitPrice,
      expiresAt: new Date(body.expiresAt).toISOString(),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.materialBatches.push(materialBatch);
    addLedger(db, {
      materialId: material.id,
      materialBatchId: materialBatch.id,
      type: "inbound",
      quantity: materialBatch.quantity,
      refType: "materialBatch",
      refId: materialBatch.id,
      note: body.note || "入库"
    });
    await writeDb(db);
    return send(res, 201, { data: materialBatch });
  }

  const ledgerMatch = pathname.match(/^\/materials\/([^/]+)\/ledger$/);
  if (ledgerMatch && req.method === "GET") {
    const material = findMaterial(db, ledgerMatch[1]);
    const type = url.searchParams.get("type");
    const data = db.materialLedger.filter(
      (entry) => entry.materialId === material.id && (!type || entry.type === type)
    );
    return send(res, 200, { data });
  }

  const consumptionMatch = pathname.match(/^\/materials\/([^/]+)\/consumption$/);
  if (consumptionMatch && req.method === "GET") {
    const material = findMaterial(db, consumptionMatch[1]);
    const issued = db.requisitions
      .flatMap((req) => req.items)
      .filter((item) => item.materialId === material.id)
      .reduce((sum, item) => sum + item.quantity, 0);
    const returned = db.materialLedger
      .filter((entry) => entry.materialId === material.id && entry.type === "return")
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const consumedLines = db.settlements
      .flatMap((settlement) => settlement.items)
      .filter((item) => item.materialId === material.id);
    const consumed = consumedLines.reduce((sum, item) => sum + item.used, 0);
    const amount = consumedLines.reduce((sum, item) => sum + item.amount, 0);
    return send(res, 200, {
      data: {
        materialId: material.id,
        issued: round2(issued),
        returned: round2(returned),
        consumed: round2(consumed),
        amount: round2(amount)
      }
    });
  }

  const expiringMatch = pathname.match(/^\/materials\/([^/]+)\/expiring$/);
  if (expiringMatch && req.method === "GET") {
    const material = findMaterial(db, expiringMatch[1]);
    const days = Number(url.searchParams.get("days") || 30);
    if (!Number.isFinite(days) || days < 0) fail(400, "days必须是不小于0的数字");
    const now = Date.now();
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const data = db.materialBatches
      .filter((item) => {
        if (item.materialId !== material.id || item.remaining <= 0) return false;
        const expiresAt = new Date(item.expiresAt).getTime();
        return expiresAt > now && expiresAt <= horizon;
      })
      .map((item) => ({
        ...item,
        daysUntilExpiry: Math.ceil((new Date(item.expiresAt).getTime() - now) / (24 * 60 * 60 * 1000))
      }))
      .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
    return send(res, 200, { data });
  }

  const stocktakeMatch = pathname.match(/^\/materials\/([^/]+)\/stocktake$/);
  if (stocktakeMatch && req.method === "POST") {
    const material = findMaterial(db, stocktakeMatch[1]);
    const body = await parseBody(req);
    required(body, ["batches"]);
    if (!Array.isArray(body.batches) || body.batches.length === 0) fail(400, "batches必须是非空数组");
    const adjustments = body.batches.map((item) => {
      const materialBatch = db.materialBatches.find(
        (entry) => entry.id === item.materialBatchId && entry.materialId === material.id
      );
      if (!materialBatch) fail(404, `入库批次不存在：${item.materialBatchId}`);
      if (typeof item.remaining !== "number" || !Number.isFinite(item.remaining) || item.remaining < 0) {
        fail(400, "remaining必须是不小于0的数字");
      }
      return { materialBatch, remaining: item.remaining };
    });
    const stocktakeId = makeId("stocktake");
    const results = [];
    for (const { materialBatch, remaining } of adjustments) {
      const delta = round2(remaining - materialBatch.remaining);
      if (delta === 0) continue;
      materialBatch.remaining = remaining;
      addLedger(db, {
        materialId: material.id,
        materialBatchId: materialBatch.id,
        type: "stocktake",
        quantity: delta,
        refType: "stocktake",
        refId: stocktakeId,
        note: body.note || "盘点调整"
      });
      results.push({ materialBatchId: materialBatch.id, before: round2(materialBatch.remaining - delta), after: remaining, delta });
    }
    await writeDb(db);
    return send(res, 200, { data: { id: stocktakeId, materialId: material.id, adjustments: results } });
  }

  const requisitionsMatch = pathname.match(/^\/batches\/([^/]+)\/requisitions$/);
  if (requisitionsMatch && req.method === "GET") {
    const batch = findRepairBatch(db, requisitionsMatch[1]);
    return send(res, 200, { data: db.requisitions.filter((item) => item.repairBatchId === batch.id) });
  }

  if (requisitionsMatch && req.method === "POST") {
    const batch = findRepairBatch(db, requisitionsMatch[1]);
    const body = await parseBody(req);
    required(body, ["requestId"]);
    const items = normalizeRequisitionItems(db, body);
    const fingerprint = requisitionFingerprint(batch.id, items);
    const existing = db.requisitions.find((item) => item.requestId === body.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, "requestId已存在且内容不一致");
      return send(res, 200, { data: existing, idempotent: true });
    }
    if (batch.status !== "in_progress") fail(409, "修补批次未开工或已完工，不能领用材料");
    const now = Date.now();
    // 先为整单所有行项计算扣减方案，任一材料不足则整单拒绝，不做部分扣减
    const planned = items.map((item) => {
      const lines = planAllocation(db, item.materialId, item.quantity, now);
      if (!lines) fail(409, `材料库存不足：${item.materialId}`);
      return { ...item, lines };
    });
    const requisition = {
      id: makeId("req"),
      requestId: body.requestId,
      repairBatchId: batch.id,
      kind: "normal",
      items: planned,
      fingerprint,
      status: "issued",
      createdAt: new Date().toISOString()
    };
    for (const item of planned) {
      applyLines(db, item.lines, -1, "requisition", "requisition", requisition.id, "领用出库");
    }
    db.requisitions.push(requisition);
    await writeDb(db);
    return send(res, 201, { data: requisition });
  }

  const settleMatch = pathname.match(/^\/batches\/([^/]+)\/settle$/);
  if (settleMatch && req.method === "POST") {
    const batch = findRepairBatch(db, settleMatch[1]);
    const body = await parseBody(req);
    if (batch.status === "open") fail(409, "修补批次未开工，不能结算");
    if (db.settlements.find((item) => item.repairBatchId === batch.id)) fail(409, "该批次已结算");
    const usageInput = Array.isArray(body.usage) ? body.usage : [];
    const usageMap = new Map();
    for (const entry of usageInput) {
      if (!entry || typeof entry !== "object") fail(400, "usage元素必须是对象");
      findMaterial(db, entry.materialId);
      if (typeof entry.quantity !== "number" || !Number.isFinite(entry.quantity) || entry.quantity < 0) {
        fail(400, "usage.quantity必须是不小于0的数字");
      }
      usageMap.set(entry.materialId, round2((usageMap.get(entry.materialId) || 0) + entry.quantity));
    }
    const issuedReqs = db.requisitions.filter((item) => item.repairBatchId === batch.id && item.status === "issued");
    const materialIds = new Set(usageMap.keys());
    for (const req of issuedReqs) for (const item of req.items) materialIds.add(item.materialId);

    // 先完整计算结算方案（补领/退回/消耗），任一材料补领不足则整体失败，不落库即回滚
    const now = Date.now();
    const planItems = [];
    for (const materialId of materialIds) {
      const issuedLines = issuedReqs.flatMap((req) =>
        req.items.filter((item) => item.materialId === materialId).flatMap((item) => item.lines)
      );
      const issuedQty = round2(issuedLines.reduce((sum, line) => sum + line.quantity, 0));
      const usedQty = round2(usageMap.get(materialId) || 0);
      let supplementaryLines = [];
      if (usedQty > issuedQty) {
        supplementaryLines = planAllocation(db, materialId, round2(usedQty - issuedQty), now);
        if (!supplementaryLines) fail(409, `超领补领库存不足：${materialId}`);
      }
      const allLines = [...issuedLines, ...supplementaryLines];
      const consumedLines = [];
      const returnedLines = [];
      let remainingUse = usedQty;
      for (const line of allLines) {
        if (remainingUse <= 0) {
          returnedLines.push(line);
          continue;
        }
        const take = round2(Math.min(line.quantity, remainingUse));
        consumedLines.push({ ...line, quantity: take, amount: round2(take * line.unitPrice) });
        remainingUse = round2(remainingUse - take);
        if (take < line.quantity) returnedLines.push({ ...line, quantity: round2(line.quantity - take) });
      }
      planItems.push({
        materialId,
        issued: issuedQty,
        used: usedQty,
        returned: round2(returnedLines.reduce((sum, line) => sum + line.quantity, 0)),
        supplementary: round2(supplementaryLines.reduce((sum, line) => sum + line.quantity, 0)),
        amount: round2(consumedLines.reduce((sum, line) => sum + line.amount, 0)),
        consumedLines,
        returnedLines,
        supplementaryLines
      });
    }

    const settlement = {
      id: makeId("settle"),
      repairBatchId: batch.id,
      items: planItems.map(({ supplementaryLines, ...item }) => item),
      totalAmount: round2(planItems.reduce((sum, item) => sum + item.amount, 0)),
      createdAt: new Date().toISOString()
    };
    for (const item of planItems) {
      if (item.supplementaryLines.length) {
        const supplementaryReq = {
          id: makeId("req"),
          requestId: `settle-${settlement.id}-${item.materialId}`,
          repairBatchId: batch.id,
          kind: "supplementary",
          items: [{ materialId: item.materialId, quantity: item.supplementary, lines: item.supplementaryLines }],
          fingerprint: "",
          status: "settled",
          createdAt: new Date().toISOString()
        };
        applyLines(db, item.supplementaryLines, -1, "requisition", "requisition", supplementaryReq.id, "超领补领");
        db.requisitions.push(supplementaryReq);
      }
      if (item.returnedLines.length) {
        applyLines(db, item.returnedLines, 1, "return", "settlement", settlement.id, "结余退回");
      }
    }
    for (const req of issuedReqs) {
      req.status = "settled";
      req.settledAt = settlement.createdAt;
    }
    db.settlements.push(settlement);
    await writeDb(db);
    return send(res, 201, { data: settlement });
  }

  const settlementMatch = pathname.match(/^\/batches\/([^/]+)\/settlement$/);
  if (settlementMatch && req.method === "GET") {
    const batch = findRepairBatch(db, settlementMatch[1]);
    const settlement = db.settlements.find((item) => item.repairBatchId === batch.id);
    if (!settlement) return send(res, 404, { error: "该批次尚未结算" });
    return send(res, 200, { data: settlement });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

async function handle(req, res) {
  if (req.method === "GET") return route(req, res);
  return withLock(() => route(req, res));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server };
