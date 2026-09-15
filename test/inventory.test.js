const test = require("node:test");
const assert = require("node:assert/strict");
const { rm, writeFile } = require("fs/promises");
const path = require("path");
const os = require("os");

const DB_FILE = path.join(os.tmpdir(), `rubbing-test-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;

const { server } = require("../server.js");

let baseUrl;

const emptyDb = {
  rubbings: [],
  damages: [],
  batches: [],
  materials: [],
  materialBatches: [],
  requisitions: [],
  settlements: [],
  materialLedger: []
};

async function resetDb() {
  await writeFile(DB_FILE, JSON.stringify(emptyDb, null, 2));
}

async function api(method, url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

async function makeStartedBatch() {
  const rubbing = await api("POST", "/rubbings", { code: uid("TP"), source: "测试碑刻", paperSize: "40x60cm" });
  const damage = await api("POST", `/rubbings/${rubbing.body.data.id}/damages`, {
    position: "左上角",
    type: "虫蛀孔",
    beforePhotoUrl: "https://example.local/b.jpg"
  });
  const batch = await api("POST", "/batches", { name: uid("批次"), damageIds: [damage.body.data.id] });
  const started = await api("POST", `/batches/${batch.body.data.id}/start`);
  assert.equal(started.status, 200);
  return started.body.data.id;
}

async function makeMaterialWithInbound(quantity, unitPrice, expiresAt) {
  const material = await api("POST", "/materials", { name: uid("材料"), unit: "张" });
  const inbound = await api("POST", `/materials/${material.body.data.id}/inbounds`, {
    quantity,
    unitPrice,
    expiresAt: expiresAt || daysFromNow(30)
  });
  assert.equal(inbound.status, 201);
  return { materialId: material.body.data.id, batchId: inbound.body.data.id };
}

async function assertLedgerConsistent(materialId) {
  const material = await api("GET", `/materials/${materialId}`);
  const ledger = await api("GET", `/materials/${materialId}/ledger`);
  const ledgerSum = ledger.body.data.reduce((sum, entry) => sum + entry.quantity, 0);
  assert.equal(material.body.data.totalRemaining, Math.round((ledgerSum + Number.EPSILON) * 100) / 100,
    "总库存必须与明细累计一致");
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(DB_FILE, { force: true });
});

test("原接口行为不变：拓片-缺损-批次-完工闭环", async () => {
  await resetDb();
  const health = await api("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const rubbing = await api("POST", "/rubbings", { code: "TP-测-001", source: "残页", paperSize: "42x68cm" });
  assert.equal(rubbing.status, 201);

  const damage = await api("POST", `/rubbings/${rubbing.body.data.id}/damages`, {
    position: "下边缘",
    type: "撕裂",
    beforePhotoUrl: "https://example.local/b1.jpg"
  });
  assert.equal(damage.status, 201);
  assert.equal(damage.body.data.status, "pending");

  const listed = await api("GET", "/damages?status=pending&type=撕裂");
  assert.equal(listed.body.data.length, 1);

  const patched = await api("PATCH", `/damages/${damage.body.data.id}`, { repairNote: "已托裱" });
  assert.equal(patched.body.data.repairNote, "已托裱");

  const batch = await api("POST", "/batches", { name: "九月小批", damageIds: [damage.body.data.id] });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.data.status, "open");
  assert.equal(batch.body.data.pending, 1);

  const completed = await api("POST", `/batches/${batch.body.data.id}/complete`, {
    defaultAfterPhotoUrl: "https://example.local/a1.jpg"
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.status, "completed");
  assert.equal(completed.body.data.repaired, 1);
});

test("入库按批次记录数量、效期、单价，总库存与明细一致", async () => {
  await resetDb();
  const material = await api("POST", "/materials", { name: "仿古宣纸", unit: "张" });
  assert.equal(material.status, 201);
  const materialId = material.body.data.id;

  const in1 = await api("POST", `/materials/${materialId}/inbounds`, {
    quantity: 5, unitPrice: 2.5, expiresAt: daysFromNow(10), note: "第一批"
  });
  assert.equal(in1.status, 201);
  const in2 = await api("POST", `/materials/${materialId}/inbounds`, {
    quantity: 10, unitPrice: 3, expiresAt: daysFromNow(20)
  });
  assert.equal(in2.status, 201);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 15);
  assert.equal(view.body.data.batches.length, 2);
  assert.equal(view.body.data.batches[0].id, in1.body.data.id, "批次按效期升序排列");
  assert.equal(view.body.data.batches[0].unitPrice, 2.5);

  const badInbound = await api("POST", `/materials/${materialId}/inbounds`, { quantity: -1, unitPrice: 1, expiresAt: daysFromNow(1) });
  assert.equal(badInbound.status, 400);

  await assertLedgerConsistent(materialId);
});

test("批次开工后才可领用材料", async () => {
  await resetDb();
  const { materialId } = await makeMaterialWithInbound(10, 2);
  const rubbing = await api("POST", "/rubbings", { code: uid("TP"), source: "残页", paperSize: "40x60cm" });
  const damage = await api("POST", `/rubbings/${rubbing.body.data.id}/damages`, {
    position: "左上", type: "虫蛀孔", beforePhotoUrl: "https://example.local/b.jpg"
  });
  const batch = await api("POST", "/batches", { name: uid("批次"), damageIds: [damage.body.data.id] });

  const rejected = await api("POST", `/batches/${batch.body.data.id}/requisitions`, {
    requestId: uid("req"), materialId, quantity: 2
  });
  assert.equal(rejected.status, 409);

  await api("POST", `/batches/${batch.body.data.id}/start`);
  const ok = await api("POST", `/batches/${batch.body.data.id}/requisitions`, {
    requestId: uid("req"), materialId, quantity: 2
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.items[0].quantity, 2);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 8);
});

test("跨批次扣减：先到期先出，金额按各批次单价分别累计", async () => {
  await resetDb();
  const material = await api("POST", "/materials", { name: "补纸", unit: "张" });
  const materialId = material.body.data.id;
  const early = await api("POST", `/materials/${materialId}/inbounds`, { quantity: 5, unitPrice: 2, expiresAt: daysFromNow(10) });
  const late = await api("POST", `/materials/${materialId}/inbounds`, { quantity: 10, unitPrice: 3, expiresAt: daysFromNow(20) });
  const batchId = await makeStartedBatch();

  const res = await api("POST", `/batches/${batchId}/requisitions`, {
    requestId: uid("req"), materialId, quantity: 7
  });
  assert.equal(res.status, 201);
  const lines = res.body.data.items[0].lines;
  assert.deepEqual(
    lines.map((line) => ({ materialBatchId: line.materialBatchId, quantity: line.quantity, amount: line.amount })),
    [
      { materialBatchId: early.body.data.id, quantity: 5, amount: 10 },
      { materialBatchId: late.body.data.id, quantity: 2, amount: 6 }
    ]
  );

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.batches[0].remaining, 0);
  assert.equal(view.body.data.batches[1].remaining, 8);
  await assertLedgerConsistent(materialId);
});

test("过期批次不可领用，库存不足整单拒绝且不产生部分扣减", async () => {
  await resetDb();
  const material = await api("POST", "/materials", { name: "浆糊", unit: "瓶" });
  const materialId = material.body.data.id;
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 100, unitPrice: 1, expiresAt: daysFromNow(-1) });
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 3, unitPrice: 1, expiresAt: daysFromNow(10) });
  const batchId = await makeStartedBatch();

  const rejected = await api("POST", `/batches/${batchId}/requisitions`, {
    requestId: uid("req"), materialId, quantity: 5
  });
  assert.equal(rejected.status, 409);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 103, "过期批次库存保留但不可用");
  assert.equal(view.body.data.availableRemaining, 3);
  const ledger = await api("GET", `/materials/${materialId}/ledger`);
  assert.equal(ledger.body.data.filter((entry) => entry.type === "requisition").length, 0, "拒绝后不产生领用明细");
});

test("多材料整单：任一材料不足则整单拒绝", async () => {
  await resetDb();
  const m1 = await makeMaterialWithInbound(5, 2);
  const m2 = await makeMaterialWithInbound(1, 3);
  const batchId = await makeStartedBatch();

  const res = await api("POST", `/batches/${batchId}/requisitions`, {
    requestId: uid("req"),
    items: [
      { materialId: m1.materialId, quantity: 3 },
      { materialId: m2.materialId, quantity: 5 }
    ]
  });
  assert.equal(res.status, 409);

  const v1 = await api("GET", `/materials/${m1.materialId}`);
  const v2 = await api("GET", `/materials/${m2.materialId}`);
  assert.equal(v1.body.data.totalRemaining, 5, "m1不得被部分扣减");
  assert.equal(v2.body.data.totalRemaining, 1);
});

test("同一领用请求重复提交只生效一次", async () => {
  await resetDb();
  const { materialId } = await makeMaterialWithInbound(10, 2);
  const batchId = await makeStartedBatch();
  const requestId = uid("req");
  const payload = { requestId, materialId, quantity: 4 };

  const first = await api("POST", `/batches/${batchId}/requisitions`, payload);
  assert.equal(first.status, 201);
  const second = await api("POST", `/batches/${batchId}/requisitions`, payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.data.id, first.body.data.id);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 6, "只扣减一次");

  const conflict = await api("POST", `/batches/${batchId}/requisitions`, { requestId, materialId, quantity: 5 });
  assert.equal(conflict.status, 409, "相同requestId内容不一致应拒绝");
});

test("并发领用不得超卖", async () => {
  await resetDb();
  const { materialId } = await makeMaterialWithInbound(10, 2);
  const batchId = await makeStartedBatch();

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      api("POST", `/batches/${batchId}/requisitions`, { requestId: uid("req"), materialId, quantity: 1 })
    )
  );
  const succeeded = results.filter((res) => res.status === 201);
  const rejected = results.filter((res) => res.status === 409);
  assert.equal(succeeded.length, 10);
  assert.equal(rejected.length, 10);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 0, "不得超卖为负库存");
  await assertLedgerConsistent(materialId);
});

test("完工结算：结余退回并恢复库存，金额按批次单价累计", async () => {
  await resetDb();
  const { materialId } = await makeMaterialWithInbound(10, 2);
  const batchId = await makeStartedBatch();
  await api("POST", `/batches/${batchId}/requisitions`, { requestId: uid("req"), materialId, quantity: 10 });

  const notFound = await api("GET", `/batches/${batchId}/settlement`);
  assert.equal(notFound.status, 404);

  const settled = await api("POST", `/batches/${batchId}/settle`, { usage: [{ materialId, quantity: 7 }] });
  assert.equal(settled.status, 201);
  const item = settled.body.data.items[0];
  assert.equal(item.issued, 10);
  assert.equal(item.used, 7);
  assert.equal(item.returned, 3);
  assert.equal(item.amount, 14);
  assert.equal(settled.body.data.totalAmount, 14);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 3, "结余退回恢复库存");

  const ledger = await api("GET", `/materials/${materialId}/ledger?type=return`);
  assert.equal(ledger.body.data.length, 1);
  assert.equal(ledger.body.data[0].quantity, 3);

  const reqs = await api("GET", `/batches/${batchId}/requisitions`);
  assert.equal(reqs.body.data[0].status, "settled");

  const consumption = await api("GET", `/materials/${materialId}/consumption`);
  assert.equal(consumption.body.data.consumed, 7);
  assert.equal(consumption.body.data.amount, 14);
  assert.equal(consumption.body.data.returned, 3);

  const again = await api("POST", `/batches/${batchId}/settle`, { usage: [{ materialId, quantity: 7 }] });
  assert.equal(again.status, 409, "重复结算应拒绝");

  await assertLedgerConsistent(materialId);
});

test("完工结算：超领需补领，按补领批次单价累计", async () => {
  await resetDb();
  const material = await api("POST", "/materials", { name: "绫绢", unit: "米" });
  const materialId = material.body.data.id;
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 5, unitPrice: 2, expiresAt: daysFromNow(10) });
  const late = await api("POST", `/materials/${materialId}/inbounds`, { quantity: 5, unitPrice: 3, expiresAt: daysFromNow(20) });
  const batchId = await makeStartedBatch();
  await api("POST", `/batches/${batchId}/requisitions`, { requestId: uid("req"), materialId, quantity: 5 });

  const settled = await api("POST", `/batches/${batchId}/settle`, { usage: [{ materialId, quantity: 8 }] });
  assert.equal(settled.status, 201);
  const item = settled.body.data.items[0];
  assert.equal(item.issued, 5);
  assert.equal(item.used, 8);
  assert.equal(item.supplementary, 3);
  assert.equal(item.amount, 19, "5*2 + 3*3");

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.batches[1].remaining, 2);
  assert.equal(view.body.data.batches[1].id, late.body.data.id);

  const reqs = await api("GET", `/batches/${batchId}/requisitions`);
  assert.equal(reqs.body.data.filter((req) => req.kind === "supplementary").length, 1, "补领生成补充领用单");
  await assertLedgerConsistent(materialId);
});

test("结算失败回滚：超领补领库存不足时全部不落库", async () => {
  await resetDb();
  const { materialId } = await makeMaterialWithInbound(5, 2);
  const batchId = await makeStartedBatch();
  await api("POST", `/batches/${batchId}/requisitions`, { requestId: uid("req"), materialId, quantity: 5 });

  const ledgerBefore = await api("GET", `/materials/${materialId}/ledger`);
  const failed = await api("POST", `/batches/${batchId}/settle`, { usage: [{ materialId, quantity: 8 }] });
  assert.equal(failed.status, 409);

  const view = await api("GET", `/materials/${materialId}`);
  assert.equal(view.body.data.totalRemaining, 0, "库存保持领用后的状态，不产生额外扣减");
  const ledgerAfter = await api("GET", `/materials/${materialId}/ledger`);
  assert.equal(ledgerAfter.body.data.length, ledgerBefore.body.data.length, "不产生任何新明细");
  const reqs = await api("GET", `/batches/${batchId}/requisitions`);
  assert.equal(reqs.body.data[0].status, "issued", "领用单保持未结算状态");
  const settlement = await api("GET", `/batches/${batchId}/settlement`);
  assert.equal(settlement.status, 404, "不生成结算单");

  const retry = await api("POST", `/batches/${batchId}/settle`, { usage: [{ materialId, quantity: 5 }] });
  assert.equal(retry.status, 201, "修正用量后可重新结算");
  assert.equal(retry.body.data.totalAmount, 10);
  await assertLedgerConsistent(materialId);
});

test("盘点记明细且总库存与明细累计一致", async () => {
  await resetDb();
  const { materialId, batchId } = await makeMaterialWithInbound(10, 2);

  const take = await api("POST", `/materials/${materialId}/stocktake`, {
    batches: [{ materialBatchId: batchId, remaining: 8 }],
    note: "月末盘点"
  });
  assert.equal(take.status, 200);
  assert.deepEqual(take.body.data.adjustments, [{ materialBatchId: batchId, before: 10, after: 8, delta: -2 }]);

  const ledger = await api("GET", `/materials/${materialId}/ledger?type=stocktake`);
  assert.equal(ledger.body.data.length, 1);
  assert.equal(ledger.body.data[0].quantity, -2);
  await assertLedgerConsistent(materialId);

  const missing = await api("POST", `/materials/${materialId}/stocktake`, {
    batches: [{ materialBatchId: "mbatch_none", remaining: 1 }]
  });
  assert.equal(missing.status, 404);
});

test("可按材料查询临期批次", async () => {
  await resetDb();
  const material = await api("POST", "/materials", { name: "颜料", unit: "盒" });
  const materialId = material.body.data.id;
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 2, unitPrice: 5, expiresAt: daysFromNow(5) });
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 3, unitPrice: 5, expiresAt: daysFromNow(40) });
  await api("POST", `/materials/${materialId}/inbounds`, { quantity: 4, unitPrice: 5, expiresAt: daysFromNow(-2) });

  const expiring = await api("GET", `/materials/${materialId}/expiring?days=30`);
  assert.equal(expiring.body.data.length, 1, "只含未过期且30天内到期的批次");
  assert.equal(expiring.body.data[0].remaining, 2);
  assert.ok(expiring.body.data[0].daysUntilExpiry <= 30);

  const all = await api("GET", `/materials/${materialId}/expiring?days=60`);
  assert.equal(all.body.data.length, 2);
});
