# 餐飲業整合型 ERP 系統 — RESTful API 規格文件

* **文件版本**：`v1.1.0`

* **API 基礎路徑**：`/api/v1`

* **適用資料庫架構**：PostgreSQL (`create_table.sql` v1.1)

* **資料交換格式**：`application/json; charset=utf-8`

## 1. 全域設計規範

### 1.1 身份驗證與權限控管（Auth & RBAC）

* **Token 驗證**：所有請求均須於 HTTP Header 帶入 JWT Token：

```
Authorization: Bearer <access_token>

```

* **角色權限驗證**：後端中介層（Middleware）依據登入帳號（`users.role_id`）關聯的 `role_permissions` 與 `permissions.code` 驗證操作權限。若權限不足，統一回傳 `403 Forbidden`。

### 1.2 資料型別與格式約定

* **日期與時間**：統一採用 ISO 8601 含時區格式（例如 `2026-11-20T14:30:00+08:00`），對應資料庫 `TIMESTAMPTZ`；純日期欄位（如 `work_date`、`order_date`）採用 `YYYY-MM-DD`。

* **數值與金額**：金額欄位（`NUMERIC(10, 2)`）與原物料數量（`NUMERIC(12, 3)`）於 JSON 中以字串傳遞（例如 `"365.00"`、`"500.000"`），避免不同語言的浮點數精度差異。金額與數量計算統一由後端進行精確四捨五入與小數位校驗。

* **分頁參數**：所有列表查詢端點皆支援標準 Query Parameters：

  * `page`（預設 `1`）：頁碼

  * `page_size`（預設 `20`，上限 `100`）：每頁筆數

### 1.3 統一回應格式（Response Envelope）

**成功回應範例（`200 OK` / `201 Created`）**

```
{
  "success": true,
  "message": "操作成功",
  "data": {},
  "meta": {
    "page": 1,
    "page_size": 20,
    "total": 120
  }
}

```

**錯誤回應範例（`4xx` / `5xx`）**

```
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "原物料「鮮奶」庫存不足，無法完成結帳扣庫",
    "details": {
      "material_id": 5,
      "required_qty": "0.600",
      "current_stock": "0.250"
    }
  }
}

```

### 1.4 常見狀態碼與業務錯誤碼

| HTTP 狀態碼 | 業務錯誤代碼 (`error.code`) | 說明與觸發情境 | 
| ----- | ----- | ----- | 
| `400` | `VALIDATION_ERROR` | 請求參數格式錯誤，或違反資料庫約束（如結束時間早於開始時間） | 
| `401` | `UNAUTHORIZED` | 未提供 Token、Token 過期或帳號已停用（`is_active = false`） | 
| `403` | `FORBIDDEN` | 當前角色不具備執行該 API 所需的 `permission.code` | 
| `404` | `RESOURCE_NOT_FOUND` | 查詢的資源 ID 不存在 | 
| `409` | `DUPLICATE_RESOURCE` | 違反唯一性約束（如 `username`、`emp_no`、`order_no` 重複） | 
| `409` | `IDEMPOTENCY_KEY_REUSED` | 相同的冪等識別搭配了不同的請求內容 | 
| `409` | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 相同的冪等識別已有請求正在處理中 | 
| `422` | `INSUFFICIENT_STOCK` | 銷售扣庫或領料時，原物料 `current_stock` 不足（觸發 `current_stock >= 0` 保護） | 
| `422` | `INVALID_STATUS_TRANSITION` | 狀態流轉不合法（如對「已取消」或「已完成」的訂單重複執行取消，或對「已驗收」的採購單重複驗收） | 

### 1.5 交易冪等與伺服器計算規則

* 所有可能建立或變更交易資料的 `POST` / `PATCH` 端點，客戶端都必須傳送 `Idempotency-Key` Header。適用端點至少包括建立訂單、補登付款、庫存異動、採購驗收與訂單取消。
* 後端以「登入帳號、HTTP 方法、路徑、`Idempotency-Key`」建立冪等識別，並保存 request body 的 SHA-256 `request_hash`。相同識別搭配相同 request hash 必須回傳第一次執行的結果，不得重複寫入付款或庫存流水；相同識別搭配不同 request hash 必須回傳 `409 IDEMPOTENCY_KEY_REUSED`。
* 冪等紀錄先建立為 `PROCESSING`；若相同識別已有請求處理中，回傳 `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`。業務 transaction 成功後更新為 `COMPLETED` 並保存 HTTP status 與 response body；失敗後更新為 `FAILED`，是否允許相同 key 重試必須由後端明確定義。
* `FAILED` 僅在可重試的暫時性錯誤（例如 deadlock、暫時性資料庫連線失敗）時允許以相同的 `Idempotency-Key` 與相同 `request_hash` 重試；驗證錯誤、權限錯誤、庫存不足與非法狀態等不可重試錯誤，必須保留原始錯誤結果。
* `idempotency_keys` 僅保存 API 請求與回應的冪等資訊；`inventory_transactions` 僅保存實際庫存異動，不直接保存 `Idempotency-Key`。
* `subtotal`、`total_amount`、訂單明細 `unit_price`、`subtotal`、庫存 `after_qty` 與採購單 `total_amount` 均由後端依資料庫內容計算，客戶端提供的計算結果不得直接採用。
* 所有庫存異動必須在同一個資料庫交易中鎖定 `materials` 資料列、更新 `current_stock` 並寫入 `inventory_transactions`；任何一步失敗都必須完整回滾。

## 2. 模組一：使用者與權限管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `POST` | `/auth/login` | *(公開)* | 帳號密碼登入，取得 Token 與權限清單 | `users`, `roles`, `permissions` | 
| `GET` | `/auth/me` | *(已登入)* | 取得當前登入帳號與關聯員工資料 | `users`, `employees` | 
| `GET` | `/roles` | `role:read` | 查詢所有角色列表 | `roles` | 
| `POST` | `/roles` | `role:write` | 新增角色 | `roles` | 
| `PUT` | `/roles/{id}/permissions` | `role:write` | 設定角色權限（覆寫 `role_permissions`） | `role_permissions` | 
| `GET` | `/users` | `user:read` | 查詢系統帳號列表（可依角色、啟用狀態篩選） | `users`, `employees`, `roles` | 
| `POST` | `/users` | `user:write` | 建立新系統帳號並指派角色 | `users` | 
| `PATCH` | `/users/{id}` | `user:write` | 修改帳號角色、重設密碼或切換 `is_active` 啟用狀態 | `users` | 

### 重點端點規格：`POST /api/v1/auth/login`

**Request Body**

```
{
  "username": "manager01",
  "password": "Password123!"
}

```

**Response (`200 OK`)**

```
{
  "success": true,
  "message": "登入成功",
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "token_type": "Bearer",
    "expires_in": 28800,
    "user": {
      "id": 2,
      "username": "manager01",
      "role": {
        "id": 2,
        "name": "店長"
      },
      "employee": {
        "id": 2,
        "emp_no": "EMP002",
        "name": "林小美",
        "job_title": "門市店長"
      },
      "permissions": [
        "order:read",
        "order:create",
        "order:payment",
        "order:status",
        "order:cancel",
        "inventory:read",
        "inventory:write",
        "po:write",
        "report:read"
      ]
    }
  }
}

```

## 3. 模組二：菜單與商品管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `GET` | `/categories` | `menu:read` | 查詢菜單分類（依 `sort_order` 升冪排序） | `categories` | 
| `POST` | `/categories` | `menu:write` | 新增菜單分類 | `categories` | 
| `PUT` | `/categories/{id}` | `menu:write` | 修改分類名稱或排序 | `categories` | 
| `DELETE` | `/categories/{id}` | `menu:write` | 刪除分類（若分類下仍有餐點則阻擋） | `categories` | 
| `GET` | `/menu-items` | `menu:read` | 查詢餐點列表（含套餐內容與適用客製化群組） | `menu_items`, `combo_items` | 
| `POST` | `/menu-items` | `menu:write` | 新增單點餐點或套餐組合（`is_combo = true`） | `menu_items`, `combo_items` | 
| `PUT` | `/menu-items/{id}` | `menu:write` | 更新餐點基本資料、價格、照片或套餐內容 | `menu_items`, `combo_items` | 
| `PATCH` | `/menu-items/{id}/status` | `menu:write` | 快速切換販售狀態（`上架` / `停售` / `下架`） | `menu_items` | 
| `PUT` | `/menu-items/{id}/recipes` | `menu:write` | 設定餐點 BOM 原物料消耗配方 | `menu_item_recipes` | 
| `GET` | `/customization-groups` | `menu:read` | 查詢所有客製化群組與其選項 | `customization_groups`, `customization_options` | 
| `POST` | `/customization-groups` | `menu:write` | 建立客製化群組及選項（可綁定加料扣庫 `material_id`） | `customization_groups`, `customization_options` | 
| `PUT` | `/menu-items/{id}/customization-groups` | `menu:write` | 綁定餐點適用的客製化群組列表 | `menu_item_customization_groups` | 

### 重點端點規格：`POST /api/v1/menu-items`（建立套餐範例）

**Request Body**

```
{
  "category_id": 1,
  "name": "經典超值雙人套餐",
  "price": "399.00",
  "image_url": "https://cdn.example.com/menu/combo-01.jpg",
  "is_combo": true,
  "status": "上架",
  "combo_items": [
    { "included_item_id": 10, "quantity": 2 },
    { "included_item_id": 25, "quantity": 2 }
  ]
}

```

### 重點端點規格：`PUT /api/v1/menu-items/{id}/recipes`（設定 BOM 配方）

**Request Body**

```
{
  "recipes": [
    { "material_id": 1, "quantity": "300.000" },
    { "material_id": 2, "quantity": "100.000" },
    { "material_id": 8, "quantity": "1.000" }
  ]
}

```

## 4. 模組三：訂單與銷售管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `POST` | `/orders` | `order:create` *(必須登入)* | 建立訂單、計算金額、寫入付款並執行 `銷售扣庫` | `orders`, `order_items`, `order_item_customizations`, `payments`, `inventory_transactions` | 
| `GET` | `/orders` | `order:read` | 多條件查詢訂單（`start_date`、`end_date`、`status`、`order_type`、`table_no`） | `orders` | 
| `GET` | `/orders/{id}` | `order:read` | 查詢單筆訂單完整明細、客製選項與付款紀錄 | `orders`, `order_items`, `order_item_customizations`, `payments` | 
| `PATCH` | `/orders/{id}/status` | `order:status`；目標為 `已取消` 時另需 `order:cancel` | 更新狀態（`待處理` → `製作中` → `已完成` / `已取消`）；取消時自動執行 `取消回補` | `orders`, `materials`, `inventory_transactions` | 
| `POST` | `/orders/{id}/payments` | `order:payment` | 補登或新增付款紀錄（支援後結帳與多元混合支付拆帳） | `payments` | 

### `POST /api/v1/orders/{id}/payments` 付款規則

* 必須傳送 `Idempotency-Key` Header；同一個冪等識別不得重複建立付款紀錄。
* `amount` 使用字串傳遞，例如 `"365.00"`；後端必須以資料庫中的訂單金額與既有付款紀錄重新計算可付款餘額。
* 已取消訂單不得新增付款；累計付款金額不得超過訂單 `total_amount`。
* 退款不透過本端點處理，應使用獨立的退款流程，並保留原始付款紀錄。
* 必須先在同一個資料庫 transaction 中使用 `SELECT status, total_amount FROM orders WHERE id = $1 FOR UPDATE` 鎖定訂單，再查詢既有付款總額、驗證付款餘額，最後寫入新的 `payments` 紀錄。

### 重點端點規格：`POST /api/v1/orders`（建立訂單與銷售扣庫）

**Request Body**

```
{
  "order_type": "內用",
  "table_no": "A05",
  "discount_amount": "20.00",
  "service_fee": "35.00",
  "items": [
    {
      "menu_item_id": 12,
      "quantity": 2,
      "customization_option_ids": [3, 8]
    }
  ],
  "payments": [
    {
      "payment_method": "行動支付",
      "amount": "365.00"
    }
  ]
}

```

**Request Header**

```http
Idempotency-Key: order-20261120-0001
```

**後端資料庫交易（Transaction）執行邏輯**：

1. 驗證餐點狀態皆為 `上架`，確認每個客製化選項屬於該餐點綁定的客製化群組，驗證必選群組、重複選項與 `max_selections`；套餐只能展開合法的套餐內容。

2. 依據資料庫中的 `menu_items.price` 與 `customization_options.extra_price` 重新計算 `subtotal` 與 `total_amount`（`subtotal - discount_amount + service_fee`）。拒絕負數折扣、負數服務費，以及付款總額超過訂單應付金額；若不是後結帳訂單，付款總額必須等於應付金額。

3. 寫入 `orders`、`order_items`、`order_item_customizations`；以資料庫價格建立訂單價格快照。若有傳入 `payments` 則同步寫入付款明細。

4. 彙整原物料消耗總量：

   * 一般單點：讀取 `menu_item_recipes.quantity * item.quantity`。

   * 套餐（`is_combo = true`）：展開 `combo_items` 內含單品後計算對應配方消耗量。

   * 加料客製：讀取 `customization_options.consume_qty * item.quantity`（若 `material_id` 不為空）。

5. 依 `material_id` 排序後使用 `SELECT ... FOR UPDATE` 鎖定對應 `materials` 資料列，確認扣除後庫存不小於零，再更新 `current_stock`，同時寫入 `transaction_type = '銷售扣庫'`、`order_id`、負數 `change_qty` 與實際計算出的 `after_qty` 的 `inventory_transactions` 紀錄。業務 transaction 成功後更新 `idempotency_keys` 為 `COMPLETED` 並保存回應；任何步驟失敗都必須回滾。

### 重點端點規格：`PATCH /api/v1/orders/{id}/status`（狀態流轉與取消回補交易）

**Request Body**

```
{
  "status": "已取消"
}

```

**Request Header**

```http
Idempotency-Key: cancel-order-1042
```

**後端資料庫交易（Transaction）執行邏輯（當目標狀態為 `已取消` 時）**：

1. **列級鎖定與防呆校驗**：使用 `SELECT status FROM orders WHERE id = $1 FOR UPDATE` 鎖定該筆訂單，確認目前狀態允許變更為 `已取消`（若原狀態已為 `已取消` 或 `已完成`，回傳 `422 INVALID_STATUS_TRANSITION`，避免重複連點導致庫存重複回補）。

2. **更新訂單狀態**：將 `orders.status` 更新為 `'已取消'`；目標為 `已取消` 時必須同時具備 `order:cancel` 權限。

3. **溯源查詢原始扣庫紀錄**：查詢 `inventory_transactions` 中 `order_id = $1 AND transaction_type = '銷售扣庫'` 的所有紀錄，並確認該訂單尚未存在對應的 `取消回補` 紀錄；取得該訂單當初實際扣除的原物料清單與數量（確保即使配方日後修改，回補數量仍與當初扣庫完全一致）。

4. **執行庫存回補**：依 `material_id` 排序後使用 `SELECT ... FOR UPDATE` 鎖定對應 `materials` 資料列，將 `ABS(change_qty)` 加回 `current_stock`，並新增一筆 `transaction_type = '取消回補'`、關聯 `order_id`、`change_qty > 0` 且填入實際 `after_qty` 的 `inventory_transactions` 流水紀錄。訂單狀態、庫存與流水紀錄必須在同一個資料庫交易中完成。

**Response (`200 OK`)**

```
{
  "success": true,
  "message": "訂單已取消，相關原物料庫存已完成取消回補",
  "data": {
    "id": 1042,
    "order_no": "ORD202611200042",
    "status": "已取消",
    "restocked_items_count": 3
  }
}

```

## 5. 模組四：庫存管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `GET` | `/materials` | `inventory:read` | 查詢原物料列表（支援依 `category` 食材/飲料/包材篩選） | `materials` | 
| `POST` | `/materials` | `inventory:write` | 新增原物料主檔與安全存量警戒值 | `materials` | 
| `PUT` | `/materials/{id}` | `inventory:write` | 更新物料名稱、單位或 `safety_stock` 安全存量 | `materials` | 
| `GET` | `/materials/low-stock` | `inventory:read` | 查詢低庫存預警清單（`current_stock <= safety_stock`） | `materials` | 
| `POST` | `/inventory/adjustments` | `inventory:write` | 執行手動庫存異動（僅限 `領料`、`耗損`、`調整`） | `materials`, `inventory_transactions` | 
| `GET` | `/inventory/transactions` | `inventory:read` | 查詢庫存異動流水紀錄（支援依物料、類型、關聯單號、日期查詢） | `inventory_transactions` | 

### 重點端點規格：`POST /api/v1/inventory/adjustments`

**Request Body**

```
{
  "material_id": 2,
  "transaction_type": "耗損",
  "change_qty": "-500.000"
}

```

**Request Header**

```http
Idempotency-Key: inventory-adjustment-20261120-0001
```

> **異動類型權限隔離說明**：
> 資料庫 `inventory_transactions.transaction_type` 共定義六種異動類型：**`進貨`、`領料`、`耗損`、`調整`、`銷售扣庫`、`取消回補`**。
>
> * **手動異動 API（本端點）**：僅允許傳入 **`領料`**、**`耗損`**、**`調整`**（`change_qty` 正數代表盤盈調增，負數代表領料、耗損或盤虧調減）。
>
> * **系統自動異動**：**`進貨`**（由採購驗收 API 寫入）、**`銷售扣庫`**（由建立訂單 API 寫入）與 **`取消回補`**（由訂單取消 API 寫入）皆由對應業務交易自動觸發，不允許透過手動異動端點直接寫入，以確保每筆系統異動皆綁定有效的 `order_id` 或 `purchase_order_id` 供稽核溯源。
>
> * **庫存一致性**：手動異動 API 必須先以 `SELECT ... FOR UPDATE` 鎖定 `materials`，驗證 `current_stock + change_qty >= 0`，再以同一個交易更新 `current_stock` 並寫入 `after_qty`；`after_qty` 不接受客戶端傳入。

## 6. 模組五：採購與供應商管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `GET` | `/suppliers` | `po:read` | 查詢供應商列表 | `suppliers` | 
| `POST` | `/suppliers` | `po:write` | 新增供應商資料與付款條件 | `suppliers` | 
| `PUT` | `/suppliers/{id}` | `po:write` | 更新供應商聯絡窗口、電話或統一編號 | `suppliers` | 
| `GET` | `/purchase-orders` | `po:read` | 查詢採購單列表（支援依供應商、狀態、採購日期篩選） | `purchase_orders`, `suppliers` | 
| `POST` | `/purchase-orders` | `po:write` | 建立新採購申請單（初始狀態為 `草稿`） | `purchase_orders`, `purchase_order_items` | 
| `PUT` | `/purchase-orders/{id}` | `po:write` | 修改 `草稿` 狀態的採購單明細與預計到貨日 | `purchase_orders`, `purchase_order_items` | 
| `PATCH` | `/purchase-orders/{id}/submit` | `po:write` | 確認下單（狀態由 `草稿` 變更為 `已下單`） | `purchase_orders` | 
| `POST` | `/purchase-orders/{id}/receive` | `po:receive` | 執行進貨驗收，累計驗收量並自動寫入 `進貨` 庫存異動 | `purchase_orders`, `purchase_order_items`, `materials`, `inventory_transactions` | 

### 重點端點規格：`POST /api/v1/purchase-orders/{id}/receive`（進貨驗收）

**Request Body**

```
{
  "items": [
    {
      "purchase_order_item_id": 15,
      "receive_qty": "10.000"
    },
    {
      "purchase_order_item_id": 16,
      "receive_qty": "5.000"
    }
  ]
}

```

**Request Header**

```http
Idempotency-Key: receive-po-15-20261120-0001
```

**後端交易處理邏輯**：

1. 使用 `SELECT ... FROM purchase_orders WHERE id = $1 FOR UPDATE` 鎖定採購單，驗證採購單狀態須為 `已下單` 或 `部分驗收`。

2. 鎖定本次驗收涉及的 `purchase_order_items`，拒絕重複的 `purchase_order_item_id`、非正數 `receive_qty`，並驗證累加後的 `received_qty <= ordered_qty`。

3. 依 `material_id` 排序鎖定對應 `materials`，增加 `current_stock`，並寫入 `transaction_type = '進貨'`、`purchase_order_id`、正數 `change_qty` 與實際 `after_qty` 的 `inventory_transactions` 紀錄。

4. 若所有明細皆已全數驗收，自動將採購單狀態更新為 `已驗收`，否則更新為 `部分驗收`。採購明細、庫存與流水紀錄必須在同一個資料庫交易中完成。

## 7. 模組六：員工與排班管理

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 功能說明 | 關聯資料表 | 
| ----- | ----- | ----- | ----- | ----- | 
| `GET` | `/employees` | `hr:read` | 查詢員工基本資料與職務列表 | `employees` | 
| `POST` | `/employees` | `hr:write` | 新增員工主檔（支援無系統帳號之人員建檔） | `employees` | 
| `PUT` | `/employees/{id}` | `hr:write` | 更新員工電話、職務（`job_title`）或在職狀態 | `employees` | 
| `GET` | `/shifts` | `schedule:read` | 查詢班別工作時段模板（早班/晚班） | `shifts` | 
| `POST` | `/shifts` | `schedule:write` | 新增班別時段模板 | `shifts` | 
| `GET` | `/schedules` | `schedule:read` | 依日期區間（`start_date`、`end_date`）查詢門市排班表 | `schedules`, `employees`, `shifts` | 
| `POST` | `/schedules` | `schedule:write` | 批次建立員工排班紀錄 | `schedules` | 
| `DELETE` | `/schedules/{id}` | `schedule:write` | 刪除排班（已關聯的考勤紀錄自動將 `schedule_id` 設為 `NULL`） | `schedules` | 
| `POST` | `/attendances/clock-in` | *(已登入)* | 上班打卡，自動比對當日班表判定 `正常` 或 `遲到` | `attendances`, `schedules` | 
| `POST` | `/attendances/clock-out` | *(已登入)* | 下班打卡，寫入 `clock_out` 並判定是否 `早退` 或 `加班` | `attendances` | 
| `GET` | `/leave-requests` | `hr:read` | 查詢請假申請紀錄（可依員工、審核狀態篩選） | `leave_requests` | 
| `POST` | `/leave-requests` | *(已登入)* | 提交新請假申請（狀態預設為 `待審核`） | `leave_requests` | 
| `PATCH` | `/leave-requests/{id}/review` | `hr:approve` | 主管簽核請假單（`已核准` / `已駁回`），寫入 `approver_id` | `leave_requests` | 

## 8. 模組七：報表與營運分析

> 本模組直接透過前六大模組的資料表進行聚合統計（`JOIN` / `GROUP BY`），支援多條件日期與分類篩選，供前端繪製營運圖表。

### 端點總覽

| 方法 | 路徑 | 權限代碼 | 查詢參數 (`Query Params`) | 回傳統計指標 | 
| ----- | ----- | ----- | ----- | ----- | 
| `GET` | `/reports/sales` | `report:read` | `start_date`, `end_date`, `group_by` (`day`/`month`), `category_id` | 總營業額、有效訂單數、客單價、各支付方式佔比、熱銷餐點 TOP 10 | 
| `GET` | `/reports/inventory-usage` | `report:read` | `start_date`, `end_date`, `category` (`食材`/`飲料`/`包材`) | 淨銷售耗用量（`銷售扣庫` 扣除 `取消回補`）、實際耗損/領料量、採購進貨總金額、低庫存品項數 | 
| `GET` | `/reports/attendance` | `report:read` | `start_date`, `end_date`, `employee_id` | 各員工總出勤時數、正常/遲到/早退/加班次數統計、已核准請假總時數 | 

### 重點端點規格：`GET /api/v1/reports/sales`

**Response (`200 OK`)**

```
{
  "success": true,
  "message": "查詢成功",
  "data": {
    "summary": {
      "total_revenue": "128500.00",
      "completed_orders": 412,
      "average_order_value": "311.89"
    },
    "daily_trend": [
      { "date": "2026-11-19", "revenue": "62000.00", "orders": 198 },
      { "date": "2026-11-20", "revenue": "66500.00", "orders": 214 }
    ],
    "top_selling_items": [
      { "menu_item_id": 12, "name": "招牌珍珠鮮奶茶", "total_qty": 320, "total_sales": "22400.00" }
    ]
  }
}

```

## 9. 系統初始化權限代碼對照表（`permissions` 表 Seed 參考）

| 模組 (`module`) | 權限代碼 (`code`) | 權限名稱 (`name`) | 建議預設角色 | 
| ----- | ----- | ----- | ----- | 
| 使用者與權限 | `role:read` / `role:write` | 角色與權限檢視 / 設定 | 管理員 | 
| 使用者與權限 | `user:read` / `user:write` | 系統帳號檢視 / 新增與停用 | 管理員、店長 | 
| 菜單與商品 | `menu:read` / `menu:write` | 菜單與配方檢視 / 編輯 | 管理員、店長（櫃檯/廚房具 `menu:read`） | 
| 訂單與銷售 | `order:read` / `order:create` / `order:payment` / `order:status` / `order:cancel` | 訂單檢視 / 建立 / 付款 / 製作狀態更新 / 取消與庫存回補 | 管理員、店長、櫃檯；廚房僅具 `order:read` 與 `order:status` | 
| 庫存管理 | `inventory:read` / `inventory:write` | 庫存查詢 / 物料維護與盤點異動 | 管理員、店長 | 
| 採購與供應商 | `po:read` / `po:write` / `po:receive` | 採購查詢 / 開立採購單 / 進貨驗收 | 管理員、店長 | 
| 員工與排班 | `hr:read` / `hr:write` / `hr:approve` | 員工資料維護 / 請假簽核 | 管理員、店長 | 
| 員工與排班 | `schedule:read` / `schedule:write` | 班表查詢 / 排班維護 | 管理員、店長 | 
| 報表與分析 | `report:read` | 營運與財務報表檢視 | 管理員、店長 | 
