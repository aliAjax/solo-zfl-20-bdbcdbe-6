# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次，以及材料、入库批次、领用单、结算单和库存明细账。

## 启动

```bash
PORT=3020 node server.js   # 或 npm start
```

## 测试

```bash
npm test
```

测试覆盖：并发领用不超卖、重复提交幂等、跨批次FEFO扣减、超领补领结算、结算失败回滚、过期批次禁用、整单拒绝、盘点账实一致、原接口回归。

## 业务规则

- **入库**：材料按入库批次记录数量、效期（`expiresAt`）和单价（`unitPrice`）。
- **开工**：修补批次状态流转 `open → in_progress → completed`，只有开工后（`in_progress`）才能领用材料。
- **领用**：先到期先出（FEFO），跨批次自动扣减；过期批次不可领用；任一材料库存不足则整单拒绝，不产生部分扣减；同一 `requestId` 重复提交只生效一次（内容不一致返回409）。
- **结算**：完工按实际用量结算。实际用量超过领用量时自动按FEFO补领（补领不足则整单失败回滚，不产生任何扣减）；结余自动退回并恢复库存；金额按各入库批次单价分别累计。
- **明细账**：入库（inbound）、领用（requisition）、退回（return）、盘点（stocktake）全部记明细，任意时刻 `材料总库存 = 明细累计`。
- **并发**：所有写请求串行执行，并发领用不会超卖；库存写入采用临时文件+原子重命名。

## 接口一览

### 原有接口（行为不变）

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches` / `POST /batches` / `GET /batches/:id`
- `POST /batches/:id/complete`

### 修补批次开工与领用结算

- `POST /batches/:id/start` — 开工（`open → in_progress`），非 open 状态返回409
- `POST /batches/:id/requisitions` — 领用材料（须已开工）
- `GET /batches/:id/requisitions` — 查询批次领用单
- `POST /batches/:id/settle` — 完工结算（补领/退回/金额累计）
- `GET /batches/:id/settlement` — 查询批次结算单

### 材料与库存

- `GET /materials` / `POST /materials` — 材料列表（含总库存）/ 新建材料
- `GET /materials/:id` — 材料详情（含各入库批次余量、效期、是否过期）
- `POST /materials/:id/inbounds` — 入库（生成入库批次 + inbound明细）
- `GET /materials/:id/ledger?type=` — 库存明细账（type: inbound/requisition/return/stocktake）
- `GET /materials/:id/consumption` — 材料消耗（累计领用、退回、结算用量与金额）
- `GET /materials/:id/expiring?days=30` — 临期批次（未过期且N天内到期、有余量）
- `POST /materials/:id/stocktake` — 盘点（按批次校准库存，记stocktake明细）

## 接口详情

### 新建材料

```bash
curl -X POST http://127.0.0.1:3020/materials \
  -H 'Content-Type: application/json' \
  -d '{"name":"仿古宣纸","unit":"张"}'
```

### 入库

```bash
curl -X POST http://127.0.0.1:3020/materials/<materialId>/inbounds \
  -H 'Content-Type: application/json' \
  -d '{"quantity":50,"unitPrice":2.5,"expiresAt":"2026-12-31"}'
```

响应 `201`：入库批次含 `id / quantity / remaining / unitPrice / expiresAt`。

### 开工

```bash
curl -X POST http://127.0.0.1:3020/batches/<batchId>/start
```

### 领用（幂等 + FEFO + 整单拒绝）

```bash
# 单材料简写
curl -X POST http://127.0.0.1:3020/batches/<batchId>/requisitions \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-20260915-001","materialId":"<materialId>","quantity":7}'

# 多材料整单（任一不足则整单拒绝）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/requisitions \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-20260915-002","items":[{"materialId":"m1","quantity":3},{"materialId":"m2","quantity":2}]}'
```

- `requestId` 由调用方生成，重复提交返回首次结果（`200` + `idempotent: true`），库存只扣一次。
- 响应 `201` 的 `items[].lines` 为跨批次扣减明细：`materialBatchId / quantity / unitPrice / amount`。
- 批次未开工或已完工 → `409`；库存不足 → `409` 且无任何扣减。

### 完工结算

```bash
curl -X POST http://127.0.0.1:3020/batches/<batchId>/settle \
  -H 'Content-Type: application/json' \
  -d '{"usage":[{"materialId":"<materialId>","quantity":7}]}'
```

- `usage` 为各材料实际用量；未列出的已领材料按用量0处理（全额退回）。
- 实际用量 > 领用量：自动FEFO补领，生成 `kind=supplementary` 补充领用单；补领库存不足 → `409`，整单回滚。
- 实际用量 < 领用量：结余按领用批次退回，恢复库存。
- 响应 `201`：`items[]` 含 `issued / used / returned / supplementary / amount / consumedLines`，`totalAmount` 为按各批次单价累计的总金额。
- 同一批次只能结算一次，重复结算返回 `409`。

### 盘点

```bash
curl -X POST http://127.0.0.1:3020/materials/<materialId>/stocktake \
  -H 'Content-Type: application/json' \
  -d '{"batches":[{"materialBatchId":"<batchId>","remaining":48}],"note":"月末盘点"}'
```

按批次将库存校准为实盘数，差额记 `stocktake` 明细（正数为盘盈，负数为盘亏）。

## 闭环示例

```bash
# 原有流程：查待修缺损 → 组批
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 新增流程：开工 → 领料 → 完工 → 结算
curl -X POST http://127.0.0.1:3020/batches/<batchId>/start
curl -X POST http://127.0.0.1:3020/batches/<batchId>/requisitions \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-001","materialId":"<materialId>","quantity":10}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete
curl -X POST http://127.0.0.1:3020/batches/<batchId>/settle \
  -H 'Content-Type: application/json' \
  -d '{"usage":[{"materialId":"<materialId>","quantity":8}]}'
```
