// Task Set v0：一般結構化軟體工程任務（A 組），切分為 dev（開發調校集）與 heldout（保留驗收集），每題內建確定性客觀檢查器（objectiveCheck）。
// 領域專屬任務（例如特定 CAD/BIM 系統）請放在自己的任務檔並以相同結構傳給 CLI 或 RecursiveHarnessService.start()。

/**
 * 嘗試從模型最終輸出解析 JSON 物件
 * @param {string} rawText
 * @returns {any | null}
 */
export function extractJsonFromOutput(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 將物件以鍵名排序後序列化（用於忽略鍵順序之結構比對）
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const TASK_SET_V0 = [
  // ==========================================
  // A 組（General Tasks）— Dev Split
  // ==========================================
  {
    taskId: 'gen-dev-01',
    split: 'dev',
    domain: 'general',
    taskTypes: ['config-migration', 'json-contract'],
    keywords: ['config', 'services', 'routes', 'subtotal', 'json'],
    executionMode: 'Standard-Sandbox',
    title: '服務路由設定正規化與加總不變量驗算',
    prompt:
      '請讀取工作區中的 legacy-services.json。只取 enabled 為 true 的服務，依 port 由小到大排序。輸出一個 JSON 物件，欄位：totalServices（所有服務數，含停用）、enabledCount（啟用服務數）、disabledCount（停用服務數）、routes（字串陣列，每個元素是 "path:port"，例如 "/v1/auth:8082"，依 port 由小到大排列）、portSum（啟用服務的 port 總和）。最後只輸出這個 JSON。',
    workspaceFiles: {
      'legacy-services.json': JSON.stringify(
        {
          services: [
            { name: 'auth-api', port: 8082, enabled: true, path: '/v1/auth' },
            { name: 'legacy-soap', port: 8099, enabled: false, path: '/soap' },
            { name: 'gateway', port: 8080, enabled: true, path: '/v1/gw' },
            { name: 'metrics', port: 9090, enabled: true, path: '/metrics' },
          ],
        },
        null,
        2,
      ),
    },
    expected: {
      totalServices: 4,
      enabledCount: 3,
      disabledCount: 1,
      routes: ['/v1/gw:8080', '/v1/auth:8082', '/metrics:9090'],
      portSum: 25252,
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.totalServices === task.expected.totalServices) matched += 1;
      else details.push(`totalServices 應為 ${task.expected.totalServices}，實得 ${data.totalServices}`);

      if (data.enabledCount === task.expected.enabledCount) matched += 1;
      else details.push(`enabledCount 應為 ${task.expected.enabledCount}，實得 ${data.enabledCount}`);

      if (data.disabledCount === task.expected.disabledCount) matched += 1;
      else details.push(`disabledCount 應為 ${task.expected.disabledCount}，實得 ${data.disabledCount}`);

      if (JSON.stringify(data.routes) === JSON.stringify(task.expected.routes)) matched += 1;
      else details.push('routes 排序或格式不符契約');

      if (data.portSum === task.expected.portSum) matched += 1;
      else details.push(`portSum 加總不變量應為 ${task.expected.portSum}，實得 ${data.portSum}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-02',
    split: 'dev',
    domain: 'general',
    taskTypes: ['log-triage', 'aggregation'],
    keywords: ['logs', 'error-rate', 'fingerprint', 'aggregation'],
    executionMode: 'Standard-Sandbox',
    title: '伺服器日誌異常分群與錯誤率精確計算',
    prompt:
      '請分析工作區 server.log，每行格式是「時間 方法 路徑 狀態碼 訊息」。先排除路徑為 /healthz 的健康檢查紀錄，再以剩下的紀錄計算並輸出一個 JSON 物件：validRequests（排除後的紀錄數）、errorCount（狀態碼 500 以上的紀錄數）、errorCountsByCode（物件，鍵是錯誤紀錄最後一欄的錯誤碼例如 ERR_DB_LOCK，值是次數）、errorRatePct（errorCount ÷ validRequests × 100，四捨五入到小數點後兩位的數字，例如 50 或 33.33）。最後只輸出這個 JSON。',
    workspaceFiles: {
      'server.log': [
        '2026-10-01T10:00:01Z GET /healthz 200 OK',
        '2026-10-01T10:00:02Z POST /api/orders 500 ERR_DB_LOCK',
        '2026-10-01T10:00:03Z GET /api/orders 200 OK',
        '2026-10-01T10:00:04Z POST /api/orders 500 ERR_DB_LOCK',
        '2026-10-01T10:00:05Z POST /api/pay 502 ERR_UPSTREAM_TIMEOUT',
        '2026-10-01T10:00:06Z GET /healthz 200 OK',
        '2026-10-01T10:00:07Z GET /api/items 200 OK',
        '2026-10-01T10:00:08Z GET /api/profile 200 OK',
      ].join('\n'),
    },
    expected: {
      validRequests: 6,
      errorCount: 3,
      errorCountsByCode: {
        ERR_DB_LOCK: 2,
        ERR_UPSTREAM_TIMEOUT: 1,
      },
      errorRatePct: 50.0,
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 4;

      if (data.validRequests === task.expected.validRequests) matched += 1;
      else details.push(`validRequests 應排除 /healthz 為 ${task.expected.validRequests}，實得 ${data.validRequests}`);

      if (data.errorCount === task.expected.errorCount) matched += 1;
      else details.push(`errorCount 應為 ${task.expected.errorCount}，實得 ${data.errorCount}`);

      if (
        data.errorCountsByCode?.ERR_DB_LOCK === 2 &&
        data.errorCountsByCode?.ERR_UPSTREAM_TIMEOUT === 1
      ) {
        matched += 1;
      } else {
        details.push('errorCountsByCode 分組計數不正確');
      }

      if (Number(data.errorRatePct) === task.expected.errorRatePct) matched += 1;
      else details.push(`errorRatePct 應為 ${task.expected.errorRatePct}，實得 ${data.errorRatePct}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-03',
    split: 'dev',
    domain: 'general',
    taskTypes: ['dag-verification', 'json-contract'],
    keywords: ['dag', 'topological', 'dependencies', 'build-order'],
    executionMode: 'Standard-Sandbox',
    title: '套件相依拓撲排序與循環相依檢測',
    prompt:
      '請讀取 packages-dag.json：packages 物件的鍵是套件名，值是它依賴的套件清單。輸出一個 JSON 物件：hasCycle（布林，是否存在循環相依）、leafPackages（沒有任何依賴的套件名，依字母序排列的字串陣列）、buildOrder（字串陣列，拓撲建置順序：每一輪從「所有依賴都已排入」的套件中選字母序最小的一個排入，重複到排完；若有循環則給空陣列）。最後只輸出這個 JSON。',
    workspaceFiles: {
      'packages-dag.json': JSON.stringify(
        {
          packages: {
            'core-types': [],
            'logger': ['core-types'],
            'storage': ['core-types', 'logger'],
            'cli': ['storage', 'logger'],
          },
        },
        null,
        2,
      ),
    },
    expected: {
      hasCycle: false,
      leafPackages: ['core-types'],
      buildOrder: ['core-types', 'logger', 'storage', 'cli'],
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 3;

      if (data.hasCycle === false) matched += 1;
      else details.push('hasCycle 應為 false');

      if (JSON.stringify(data.leafPackages) === JSON.stringify(task.expected.leafPackages)) {
        matched += 1;
      } else {
        details.push('leafPackages 清單不正確');
      }

      if (JSON.stringify(data.buildOrder) === JSON.stringify(task.expected.buildOrder)) {
        matched += 1;
      } else {
        details.push(`buildOrder 應為 ${JSON.stringify(task.expected.buildOrder)}，實得 ${JSON.stringify(data.buildOrder)}`);
      }

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-04',
    split: 'dev',
    domain: 'general',
    taskTypes: ['csv-aggregation', 'json-contract'],
    keywords: ['csv', 'report', 'group-by', 'rounding', 'revenue'],
    executionMode: 'Standard-Sandbox',
    title: 'CSV 訂單報表依區域彙總與折扣後營收精確計算',
    prompt: [
      '請讀取工作區 orders.csv 與 regions.csv，產生區域營收報表並輸出 JSON。規則：',
      '1. 只計入 status 為 paid 的訂單；cancelled、pending、refunded 一律排除。',
      '2. 每筆訂單金額 = qty × unit_price × (1 − discount_pct / 100)，逐筆計算時「不要」四捨五入；各區域與總計先加總後，再四捨五入至小數點後兩位。',
      '3. 區域名稱請用 regions.csv 的 region_name（不是 region_code）；沒有任何計入訂單的區域不要出現在 byRegion。',
      '輸出欄位：paidOrders（計入筆數）、excludedOrders（排除筆數）、byRegion（陣列，每項為 { region, orders, revenue }，依 revenue 由大到小排序，相同則依 region 字母序）、grandTotal（所有計入訂單金額總和，小數兩位）、topProduct（計入訂單中總數量 qty 最高的 product，相同則取字母序最小者）。',
    ].join('\n'),
    workspaceFiles: {
      'orders.csv': [
        'order_id,region_code,product,qty,unit_price,discount_pct,status',
        '1001,TW,keyboard,2,45.50,0,paid',
        '1002,TW,mouse,3,19.99,15,paid',
        '1003,JP,monitor,1,230.00,10,paid',
        '1004,JP,keyboard,1,45.50,0,cancelled',
        '1005,US,mouse,5,19.99,0,paid',
        '1006,US,monitor,2,230.00,5,pending',
        '1007,TW,headset,1,89.90,20,paid',
        '1008,JP,mouse,4,19.99,15,paid',
        '1009,US,keyboard,3,45.50,10,paid',
        '1010,SG,headset,1,89.90,14,paid',
        '1011,SG,mouse,1,19.99,0,refunded',
        '1012,TW,monitor,1,230.00,25,paid',
        '1013,JP,headset,3,89.90,10,paid',
        '1014,US,headset,1,89.90,0,cancelled',
        '1015,SG,keyboard,2,45.50,5,paid',
        '1016,TW,mouse,6,19.99,0,paid',
        '1017,JP,keyboard,2,45.50,10,paid',
        '1018,US,monitor,1,230.00,15,paid',
        '1019,SG,monitor,1,230.00,0,pending',
        '1020,JP,mouse,2,19.99,0,paid',
        '1021,SG,headset,1,89.90,14,paid',
        '',
      ].join('\n'),
      'regions.csv': [
        'region_code,region_name',
        'TW,Taiwan',
        'JP,Japan',
        'US,United States',
        'SG,Singapore',
        'DE,Germany',
        'FR,France',
        'AU,Australia',
        'KR,South Korea',
        'BR,Brazil',
        'CA,Canada',
        '',
      ].join('\n'),
    },
    expected: {
      paidOrders: 16,
      excludedOrders: 5,
      byRegion: [
        { region: 'Japan', orders: 5, revenue: 639.58 },
        { region: 'Taiwan', orders: 5, revenue: 506.33 },
        { region: 'United States', orders: 3, revenue: 418.3 },
        { region: 'Singapore', orders: 3, revenue: 241.08 },
      ],
      grandTotal: 1805.29,
      topProduct: 'mouse',
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.paidOrders === task.expected.paidOrders) matched += 1;
      else details.push(`paidOrders 應為 ${task.expected.paidOrders}，實得 ${data.paidOrders}`);

      if (data.excludedOrders === task.expected.excludedOrders) matched += 1;
      else details.push(`excludedOrders 應為 ${task.expected.excludedOrders}，實得 ${data.excludedOrders}`);

      if (canonicalJson(data.byRegion) === canonicalJson(task.expected.byRegion)) matched += 1;
      else details.push(`byRegion 應為 ${JSON.stringify(task.expected.byRegion)}，實得 ${JSON.stringify(data.byRegion)}`);

      if (Number(data.grandTotal) === task.expected.grandTotal) matched += 1;
      else details.push(`grandTotal 應為 ${task.expected.grandTotal}（先加總再四捨五入），實得 ${data.grandTotal}`);

      if (data.topProduct === task.expected.topProduct) matched += 1;
      else details.push(`topProduct 應為 ${task.expected.topProduct}，實得 ${data.topProduct}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-05',
    split: 'dev',
    domain: 'general',
    taskTypes: ['config-merge', 'json-contract'],
    keywords: ['ini', 'env', 'override', 'precedence', 'config'],
    executionMode: 'Standard-Sandbox',
    title: 'INI / .env / JSON 三層設定合併與覆寫優先序解析',
    prompt: [
      '請讀取工作區 defaults.ini、.env 與 overrides.json，合併為最終生效設定並輸出 JSON。優先序由低到高：defaults.ini < .env < overrides.json。規則：',
      '1. defaults.ini 為標準 INI：[section] 區段，key = value，以 ; 或 # 開頭的行為註解。鍵名統一為「section.key」小寫。',
      '2. .env 只採用前綴為 APP_ 的變數，格式 APP_<SECTION>__<KEY>=value（雙底線分隔區段與鍵，轉成小寫 section.key）；允許行首有 export；值若被單引號或雙引號包住須去除引號；其他變數（無 APP_ 前綴）、空行與 # 註解一律忽略。',
      '3. overrides.json 為 { section: { key: value } } 巢狀物件；數字與布林值轉成字串（例如 7070 → "7070"、false → "false"）。',
      '4. 所有生效值一律輸出為字串。',
      '輸出欄位：totalKeys（生效鍵數）、effectiveConfig（物件，鍵為 section.key，值為字串）、overriddenKeys（存在於 defaults.ini 且最終值與 defaults.ini 不同的鍵，字母序排列）、newKeys（defaults.ini 沒有、由較高優先序來源新增的鍵，字母序排列）、sourceCounts（物件 { ini, env, json }，各來源最終「提供生效值」的鍵數；來源定義為最後一個提供該鍵的來源，即使其值與較低優先序相同）。',
    ].join('\n'),
    workspaceFiles: {
      'defaults.ini': [
        '; 預設設定（最低優先序）',
        '[server]',
        'host = 0.0.0.0',
        'port = 8080',
        'workers = 2',
        '',
        '[database]',
        'url = postgres://localhost:5432/app',
        'pool_size = 5',
        '# ssl 預設關閉',
        'ssl = false',
        '',
        '[features]',
        'beta = off',
        'dark_mode = on',
        'max_upload_mb = 10',
        '',
      ].join('\n'),
      '.env': [
        '# 部署環境變數（中優先序）',
        'APP_SERVER__PORT=9090',
        'APP_SERVER__WORKERS="4"',
        "APP_DATABASE__SSL='true'",
        'APP_FEATURES__BETA=on',
        'APP_LOGGING__LEVEL=debug',
        'NODE_ENV=production',
        'DATABASE_URL=postgres://ignored:5432/x',
        'export APP_FEATURES__MAX_UPLOAD_MB=25',
        '',
        'APP_SERVER__HOST=0.0.0.0',
        '',
      ].join('\n'),
      'overrides.json': JSON.stringify(
        {
          server: { port: 7070 },
          features: { beta: 'off', telemetry: false },
          cache: { ttl_seconds: 300 },
        },
        null,
        2,
      ),
    },
    expected: {
      totalKeys: 12,
      effectiveConfig: {
        'cache.ttl_seconds': '300',
        'database.pool_size': '5',
        'database.ssl': 'true',
        'database.url': 'postgres://localhost:5432/app',
        'features.beta': 'off',
        'features.dark_mode': 'on',
        'features.max_upload_mb': '25',
        'features.telemetry': 'false',
        'logging.level': 'debug',
        'server.host': '0.0.0.0',
        'server.port': '7070',
        'server.workers': '4',
      },
      overriddenKeys: ['database.ssl', 'features.max_upload_mb', 'server.port', 'server.workers'],
      newKeys: ['cache.ttl_seconds', 'features.telemetry', 'logging.level'],
      sourceCounts: { ini: 3, env: 5, json: 4 },
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.totalKeys === task.expected.totalKeys) matched += 1;
      else details.push(`totalKeys 應為 ${task.expected.totalKeys}，實得 ${data.totalKeys}`);

      if (canonicalJson(data.effectiveConfig) === canonicalJson(task.expected.effectiveConfig)) matched += 1;
      else details.push(`effectiveConfig 應為 ${canonicalJson(task.expected.effectiveConfig)}，實得 ${canonicalJson(data.effectiveConfig)}`);

      if (JSON.stringify(data.overriddenKeys) === JSON.stringify(task.expected.overriddenKeys)) matched += 1;
      else details.push(`overriddenKeys 應為 ${JSON.stringify(task.expected.overriddenKeys)}，實得 ${JSON.stringify(data.overriddenKeys)}`);

      if (JSON.stringify(data.newKeys) === JSON.stringify(task.expected.newKeys)) matched += 1;
      else details.push(`newKeys 應為 ${JSON.stringify(task.expected.newKeys)}，實得 ${JSON.stringify(data.newKeys)}`);

      if (canonicalJson(data.sourceCounts) === canonicalJson(task.expected.sourceCounts)) matched += 1;
      else details.push(`sourceCounts 應為 ${canonicalJson(task.expected.sourceCounts)}，實得 ${canonicalJson(data.sourceCounts)}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-06',
    split: 'dev',
    domain: 'general',
    taskTypes: ['interval-merge', 'json-contract'],
    keywords: ['iso8601', 'timezone', 'interval', 'merge', 'maintenance'],
    executionMode: 'Standard-Sandbox',
    title: '跨時區維護時段合併與總時長計算',
    prompt: [
      '請讀取工作區 windows-team-a.json 與 windows-team-b.json（皆為維護時段陣列，start / end 為 ISO 8601，可能帶有不同時區偏移），合併所有重疊或首尾相接的時段並輸出 JSON。規則：',
      '1. 只計入 status 為 scheduled 的時段，其餘狀態一律排除。',
      '2. 先將所有時間換算為 UTC 再比較；兩時段若有重疊，或前一段的 end 恰等於後一段的 start（首尾相接），都要合併為一段。',
      '3. 輸出時間格式統一為 UTC 的 YYYY-MM-DDTHH:MM:SSZ。',
      '輸出欄位：activeWindows（計入的原始時段數）、mergedCount（合併後段數）、mergedWindows（陣列，每項 { start, end }，依 start 由早到晚排序）、totalMinutes（合併後各段時長分鐘數總和，整數）、longestMinutes（合併後最長一段的分鐘數，整數）。',
    ].join('\n'),
    workspaceFiles: {
      'windows-team-a.json': JSON.stringify(
        [
          { id: 'A1', start: '2026-11-02T01:00:00Z', end: '2026-11-02T02:30:00Z', status: 'scheduled', owner: 'team-a' },
          { id: 'A2', start: '2026-11-02T10:00:00+08:00', end: '2026-11-02T11:00:00+08:00', status: 'scheduled', owner: 'team-a' },
          { id: 'A3', start: '2026-11-02T05:00:00Z', end: '2026-11-02T06:00:00Z', status: 'cancelled', owner: 'team-a' },
          { id: 'A4', start: '2026-11-03T00:00:00Z', end: '2026-11-03T01:00:00Z', status: 'scheduled', owner: 'team-a' },
          { id: 'A5', start: '2026-11-02T22:00:00-05:00', end: '2026-11-02T23:30:00-05:00', status: 'scheduled', owner: 'team-a' },
        ],
        null,
        2,
      ),
      'windows-team-b.json': JSON.stringify(
        [
          { id: 'B1', start: '2026-11-02T03:00:00Z', end: '2026-11-02T03:45:00Z', status: 'scheduled', owner: 'team-b' },
          { id: 'B2', start: '2026-11-02T20:00:00Z', end: '2026-11-02T21:00:00Z', status: 'scheduled', owner: 'team-b' },
          { id: 'B3', start: '2026-11-03T09:00:00+09:00', end: '2026-11-03T10:00:00+09:00', status: 'scheduled', owner: 'team-b' },
          { id: 'B4', start: '2026-11-03T04:30:00Z', end: '2026-11-03T05:00:00Z', status: 'scheduled', owner: 'team-b' },
          { id: 'B5', start: '2026-11-02T12:00:00Z', end: '2026-11-02T13:00:00Z', status: 'draft', owner: 'team-b' },
        ],
        null,
        2,
      ),
    },
    expected: {
      activeWindows: 8,
      mergedCount: 4,
      mergedWindows: [
        { start: '2026-11-02T01:00:00Z', end: '2026-11-02T03:45:00Z' },
        { start: '2026-11-02T20:00:00Z', end: '2026-11-02T21:00:00Z' },
        { start: '2026-11-03T00:00:00Z', end: '2026-11-03T01:00:00Z' },
        { start: '2026-11-03T03:00:00Z', end: '2026-11-03T05:00:00Z' },
      ],
      totalMinutes: 405,
      longestMinutes: 165,
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.activeWindows === task.expected.activeWindows) matched += 1;
      else details.push(`activeWindows 應為 ${task.expected.activeWindows}（僅 scheduled），實得 ${data.activeWindows}`);

      if (data.mergedCount === task.expected.mergedCount) matched += 1;
      else details.push(`mergedCount 應為 ${task.expected.mergedCount}，實得 ${data.mergedCount}`);

      if (canonicalJson(data.mergedWindows) === canonicalJson(task.expected.mergedWindows)) matched += 1;
      else details.push(`mergedWindows 應為 ${JSON.stringify(task.expected.mergedWindows)}，實得 ${JSON.stringify(data.mergedWindows)}`);

      if (data.totalMinutes === task.expected.totalMinutes) matched += 1;
      else details.push(`totalMinutes 應為 ${task.expected.totalMinutes}，實得 ${data.totalMinutes}`);

      if (data.longestMinutes === task.expected.longestMinutes) matched += 1;
      else details.push(`longestMinutes 應為 ${task.expected.longestMinutes}，實得 ${data.longestMinutes}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-dev-07',
    split: 'dev',
    domain: 'general',
    taskTypes: ['code-scan', 'aggregation'],
    keywords: ['todo', 'fixme', 'scan', 'multi-file', 'ignore'],
    executionMode: 'Standard-Sandbox',
    title: '多檔案 TODO / FIXME 標記掃描與負責人統計',
    prompt: [
      '請掃描工作區內所有檔案（.scanignore 本身除外）的 TODO / FIXME 標記並輸出 JSON 統計。規則：',
      '1. .scanignore 每行一個路徑前綴（# 開頭為註解），以該前綴開頭的檔案路徑一律不掃描。',
      '2. 標記定義：大小寫敏感的 TODO 或 FIXME，其後必須「緊接」(負責人) 或冒號 :；例如 TODO(alice): 與 FIXME: 都算，但 todo(eve)、TODOS、TODO (x) 都不算。每個符合的出現各算一個標記。',
      '3. 沒有 (負責人) 的標記，負責人記為 unassigned。',
      '4. 檔案路徑一律使用相對於工作區的正斜線路徑（例如 src/app.js）。',
      '輸出欄位：scannedFiles（實際掃描的檔案路徑陣列，字母序）、totalMarkers（標記總數）、byTag（物件 { TODO, FIXME }）、byOwner（陣列，每項 { owner, count }，依 count 由大到小、相同則依 owner 字母序）、byFile（物件，鍵為檔案路徑、值為該檔標記數，僅列出至少有一個標記的檔案）。',
    ].join('\n'),
    workspaceFiles: {
      '.scanignore': [
        '# 每行一個路徑前綴，以該前綴開頭的檔案路徑不掃描',
        '# 建置輸出',
        'dist/',
        '# 已淘汰的舊程式碼',
        'src/legacy/',
        '',
        '# 草稿文件',
        'docs/drafts/',
        '',
        '# 本檔案本身不需列出',
        '',
      ].join('\n'),
      'src/app.js': [
        "import process from 'node:process';",
        '',
        '// TODO(alice): 加入設定檔驗證',
        'export function main() {',
        '  const todoList = [];',
        '  // FIXME(bob): 啟動時可能重複初始化',
        '  const cfg = load();',
        '  /* TODO: 錯誤處理尚未實作 */',
        '  // NOTE: TODOS 不是標記，TODO (frank) 也不是',
        '  if (!cfg) return todoList;',
        '  return todoList.concat(Object.keys(cfg));',
        '}',
        '',
        '// FIXME: 路徑在 Windows 上未正規化',
        'function load() {',
        '  // TODO(carol): 支援 YAML 格式',
        '  // todo(eve): 小寫不算標記',
        '  return { path: process.cwd() };',
        '}',
        '',
        '// TODO(alice): 補上單元測試',
        '',
      ].join('\n'),
      'src/legacy/old.js': [
        '// 此檔案位於 .scanignore 的 src/legacy/ 之下，所有標記都不應被計入',
        '// TODO(zed): 移除 CommonJS 匯出',
        "const fs = require('fs');",
        '',
        '// FIXME(zed): 同步讀檔會阻塞事件迴圈',
        'function readConfig(p) {',
        "  return JSON.parse(fs.readFileSync(p, 'utf8'));",
        '}',
        '',
        '// TODO: 改用 ESM 後刪除此檔',
        'module.exports = { readConfig };',
        '',
      ].join('\n'),
      'docs/notes.md': [
        '# 專案筆記',
        '',
        '## 待辦',
        '',
        '- TODO(bob): 更新 README 安裝章節',
        '- 待辦事項（todo）清單見 issue tracker',
        '- FIXME(alice): 圖片連結失效',
        '',
        '## 備註',
        '',
        '- 本檔案的標記與程式碼中的標記一視同仁。',
        '- 行內出現的 `TODOS` 或 `TODO (x)` 不符合標記格式。',
        '',
      ].join('\n'),
    },
    expected: {
      scannedFiles: ['docs/notes.md', 'src/app.js'],
      totalMarkers: 8,
      byTag: { TODO: 5, FIXME: 3 },
      byOwner: [
        { owner: 'alice', count: 3 },
        { owner: 'bob', count: 2 },
        { owner: 'unassigned', count: 2 },
        { owner: 'carol', count: 1 },
      ],
      byFile: { 'docs/notes.md': 2, 'src/app.js': 6 },
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (JSON.stringify(data.scannedFiles) === JSON.stringify(task.expected.scannedFiles)) matched += 1;
      else details.push(`scannedFiles 應為 ${JSON.stringify(task.expected.scannedFiles)}，實得 ${JSON.stringify(data.scannedFiles)}`);

      if (data.totalMarkers === task.expected.totalMarkers) matched += 1;
      else details.push(`totalMarkers 應為 ${task.expected.totalMarkers}，實得 ${data.totalMarkers}`);

      if (canonicalJson(data.byTag) === canonicalJson(task.expected.byTag)) matched += 1;
      else details.push(`byTag 應為 ${canonicalJson(task.expected.byTag)}，實得 ${canonicalJson(data.byTag)}`);

      if (canonicalJson(data.byOwner) === canonicalJson(task.expected.byOwner)) matched += 1;
      else details.push(`byOwner 應為 ${JSON.stringify(task.expected.byOwner)}，實得 ${JSON.stringify(data.byOwner)}`);

      if (canonicalJson(data.byFile) === canonicalJson(task.expected.byFile)) matched += 1;
      else details.push(`byFile 應為 ${canonicalJson(task.expected.byFile)}，實得 ${canonicalJson(data.byFile)}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  // ==========================================
  // A 組（General Tasks）— Held-Out Split
  // ==========================================
  {
    taskId: 'gen-hold-01',
    split: 'heldout',
    domain: 'general',
    taskTypes: ['manifest-audit', 'json-contract'],
    keywords: ['release', 'checksum', 'audit', 'subtotal'],
    executionMode: 'Standard-Sandbox',
    title: '發行產物清單雜湊稽核與位元組總計驗算',
    prompt:
      '請讀取 release-manifest.json，對 files 裡每個檔案比對 expectedSha256 與 actualSha256。輸出一個 JSON 物件：totalFiles（檔案總數）、verifiedCount（兩者相同的檔案數）、corruptedFiles（不相同的檔案 name，依字母序排列的字串陣列）、verifiedTotalBytes（只加總驗證相同的檔案的 bytes）。最後只輸出這個 JSON。',
    workspaceFiles: {
      'release-manifest.json': JSON.stringify(
        {
          files: [
            { name: 'bundle.js', bytes: 1200, expectedSha256: 'aaa111', actualSha256: 'aaa111' },
            { name: 'worker.js', bytes: 800, expectedSha256: 'bbb222', actualSha256: 'ccc999' },
            { name: 'schema.json', bytes: 450, expectedSha256: 'ddd444', actualSha256: 'ddd444' },
          ],
        },
        null,
        2,
      ),
    },
    expected: {
      totalFiles: 3,
      verifiedCount: 2,
      corruptedFiles: ['worker.js'],
      verifiedTotalBytes: 1650,
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 4;

      if (data.totalFiles === task.expected.totalFiles) matched += 1;
      else details.push('totalFiles 不正確');

      if (data.verifiedCount === task.expected.verifiedCount) matched += 1;
      else details.push('verifiedCount 不正確');

      if (JSON.stringify(data.corruptedFiles) === JSON.stringify(task.expected.corruptedFiles)) {
        matched += 1;
      } else {
        details.push('corruptedFiles 清單不正確');
      }

      if (data.verifiedTotalBytes === task.expected.verifiedTotalBytes) matched += 1;
      else details.push(`verifiedTotalBytes 應為 ${task.expected.verifiedTotalBytes}，實得 ${data.verifiedTotalBytes}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-hold-02',
    split: 'heldout',
    domain: 'general',
    taskTypes: ['schema-diff', 'aggregation'],
    keywords: ['schema', 'breaking-change', 'contract', 'totals'],
    executionMode: 'Standard-Sandbox',
    title: 'API 契約相容性比對與破壞性變更統計',
    prompt:
      '請讀取 api-schema-diff.json，fields 裡每個欄位有 name、v1Type、v2Type（null 代表 v2 已移除）、v1Required、v2Required。破壞性變更的定義：v2Type 與 v1Type 不同（包含被移除），或 v1Required 為 false 而 v2Required 為 true。輸出一個 JSON 物件：totalFieldsCompared（欄位總數）、breakingCount（破壞性欄位數）、breakingFields（破壞性欄位的 name，依字母序排列的字串陣列）、isBackwardCompatible（breakingCount 為 0 時 true，否則 false）。最後只輸出這個 JSON。',
    workspaceFiles: {
      'api-schema-diff.json': JSON.stringify(
        {
          fields: [
            { name: 'id', v1Type: 'string', v2Type: 'string', v1Required: true, v2Required: true },
            { name: 'amount', v1Type: 'number', v2Type: 'string', v1Required: true, v2Required: true },
            { name: 'legacyCode', v1Type: 'string', v2Type: null, v1Required: true, v2Required: false },
            { name: 'note', v1Type: 'string', v2Type: 'string', v1Required: false, v2Required: false },
          ],
        },
        null,
        2,
      ),
    },
    expected: {
      totalFieldsCompared: 4,
      breakingCount: 2,
      breakingFields: ['amount', 'legacyCode'],
      isBackwardCompatible: false,
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 4;

      if (data.totalFieldsCompared === task.expected.totalFieldsCompared) matched += 1;
      else details.push('totalFieldsCompared 不正確');

      if (data.breakingCount === task.expected.breakingCount) matched += 1;
      else details.push('breakingCount 不正確');

      if (JSON.stringify(data.breakingFields) === JSON.stringify(task.expected.breakingFields)) {
        matched += 1;
      } else {
        details.push('breakingFields 清單或排序不正確');
      }

      if (data.isBackwardCompatible === false) matched += 1;
      else details.push('isBackwardCompatible 應為 false');

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-hold-03',
    split: 'heldout',
    domain: 'general',
    taskTypes: ['semver-resolution', 'json-contract'],
    keywords: ['semver', 'dependencies', 'range', 'prerelease', 'registry'],
    executionMode: 'Standard-Sandbox',
    title: 'semver 相依範圍解析與預發布版本排除',
    prompt: [
      '請讀取工作區 registry.json（各套件可用版本清單）與 requirements.json（各套件需求範圍），為每個需求挑出「滿足範圍的最高版本」並輸出 JSON。規則：',
      '1. 版本比較以數值為準（1.10.0 > 1.9.2），不可用字串排序。',
      '2. 帶預發布標籤的版本（例如 2.0.0-beta.1、1.10.1-rc.1）一律不可被選用，也不計入任何「最高版本」判斷。',
      '3. 範圍語意：^X.Y.Z 表示 >=X.Y.Z 且主版號相同（主版號為 0 時，次版號須相同）；~X.Y.Z 表示 >=X.Y.Z 且主、次版號相同；以空白分隔的多個條件（例如 >=4.17.0 <5.0.0）須同時成立；純版本字串表示完全相等。',
      '4. 套件不在 registry 中，或沒有任何穩定版本滿足範圍，則視為無法解析。',
      '輸出欄位：resolvedCount（成功解析的套件數）、resolved（物件，鍵為套件名、值為選定版本字串）、unresolved（無法解析的套件名陣列，字母序）、prereleaseSkipped（所有「有需求」的套件在 registry 中帶預發布標籤的版本總數）、needsMajorUpgrade（已成功解析、且 registry 中存在主版號高於選定版本的穩定版本之套件名陣列，字母序）。',
    ].join('\n'),
    workspaceFiles: {
      'registry.json': JSON.stringify(
        {
          packages: {
            'left-pad': ['1.0.0', '1.1.0', '1.9.2', '1.10.0', '1.10.1-rc.1', '2.0.0-beta.1', '2.0.0'],
            chalk: ['4.0.0', '4.1.0', '4.1.2', '4.1.3-next.0', '4.2.0', '5.0.0'],
            lodash: ['3.10.1', '4.17.15', '4.17.21', '5.0.0-alpha.1'],
            moment: ['2.29.0', '2.29.1', '2.29.4'],
            'tiny-glob': ['0.2.9', '0.3.1', '0.3.5', '0.4.0'],
            yargs: ['17.7.2', '18.0.0'],
            'unused-lib': ['1.0.0', '1.0.1-beta.0'],
          },
        },
        null,
        2,
      ),
      'requirements.json': JSON.stringify(
        {
          dependencies: {
            'left-pad': '^1.2.0',
            chalk: '~4.1.0',
            lodash: '>=4.17.0 <5.0.0',
            moment: '2.29.1',
            'tiny-glob': '^0.3.0',
            'ghost-lib': '^1.0.0',
            yargs: '^16.0.0',
          },
        },
        null,
        2,
      ),
    },
    expected: {
      resolvedCount: 5,
      resolved: {
        chalk: '4.1.2',
        'left-pad': '1.10.0',
        lodash: '4.17.21',
        moment: '2.29.1',
        'tiny-glob': '0.3.5',
      },
      unresolved: ['ghost-lib', 'yargs'],
      prereleaseSkipped: 4,
      needsMajorUpgrade: ['chalk', 'left-pad'],
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.resolvedCount === task.expected.resolvedCount) matched += 1;
      else details.push(`resolvedCount 應為 ${task.expected.resolvedCount}，實得 ${data.resolvedCount}`);

      if (canonicalJson(data.resolved) === canonicalJson(task.expected.resolved)) matched += 1;
      else details.push(`resolved 應為 ${canonicalJson(task.expected.resolved)}，實得 ${canonicalJson(data.resolved)}`);

      if (JSON.stringify(data.unresolved) === JSON.stringify(task.expected.unresolved)) matched += 1;
      else details.push(`unresolved 應為 ${JSON.stringify(task.expected.unresolved)}，實得 ${JSON.stringify(data.unresolved)}`);

      if (data.prereleaseSkipped === task.expected.prereleaseSkipped) matched += 1;
      else details.push(`prereleaseSkipped 應為 ${task.expected.prereleaseSkipped}，實得 ${data.prereleaseSkipped}`);

      if (JSON.stringify(data.needsMajorUpgrade) === JSON.stringify(task.expected.needsMajorUpgrade)) matched += 1;
      else details.push(`needsMajorUpgrade 應為 ${JSON.stringify(task.expected.needsMajorUpgrade)}（預發布版不算穩定版），實得 ${JSON.stringify(data.needsMajorUpgrade)}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-hold-04',
    split: 'heldout',
    domain: 'general',
    taskTypes: ['schema-validation', 'json-contract'],
    keywords: ['schema', 'required', 'validation', 'error-path', 'records'],
    executionMode: 'Standard-Sandbox',
    title: 'JSON Schema 風格必填與型別驗證並列出錯誤路徑',
    prompt: [
      '請讀取工作區 schema.json（簡化版 JSON Schema，只會用到 type、required、properties、items）以及 records-batch1.json、records-batch2.json（兩個紀錄陣列），依序驗證每筆紀錄並輸出 JSON。規則：',
      '1. 紀錄索引為兩個檔案串接後的 0 起始索引（batch1 在前、batch2 在後）。',
      '2. required 內列出的欄位若「不存在」，錯誤代碼為 missing；欄位存在但型別不符（含值為 null）錯誤代碼為 type。非必填欄位不存在時不算錯誤。',
      '3. 型別規則：integer 須為整數數值（29.5 不是）；string 可為空字串；array 的每個元素都要檢查 items 的型別；object 須遞迴檢查其 required 與 properties。',
      '4. 錯誤路徑格式：records[索引].欄位.子欄位，陣列元素寫成 records[索引].tags[元素索引]。',
      '輸出欄位：totalRecords、validCount（零錯誤的紀錄數）、invalidRecordIndexes（有錯誤的紀錄索引陣列，遞增）、errors（陣列，每項 { path, code }，依 path 字串遞增排序）、errorCountByCode（物件 { missing, type }）。',
    ].join('\n'),
    workspaceFiles: {
      'schema.json': JSON.stringify(
        {
          type: 'object',
          required: ['id', 'name', 'email', 'address'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            email: { type: 'string' },
            age: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
            address: {
              type: 'object',
              required: ['city', 'zip'],
              properties: {
                city: { type: 'string' },
                zip: { type: 'string' },
                country: { type: 'string' },
              },
            },
          },
        },
        null,
        2,
      ),
      'records-batch1.json': JSON.stringify(
        [
          { id: 1, name: 'Ann', email: 'ann@example.io', age: 30, tags: ['vip', 'beta'], address: { city: 'Taipei', zip: '100' } },
          { id: 2, name: 'Ben', email: 'ben@example.io', address: { city: 'Osaka' } },
          { id: 3, name: 'Cid', email: null, age: 41, address: { city: 'Seoul', zip: '04524' } },
          { id: 4, name: 'Dee', email: 'dee@example.io', age: 29.5, tags: ['x', 7], address: { city: 'Tokyo', zip: '100-0001', country: 'JP' } },
        ],
        null,
        2,
      ),
      'records-batch2.json': JSON.stringify(
        [
          { id: 5, name: '', email: 'eve@example.io', age: 22, address: { city: 'Hanoi', zip: '10000' } },
          { id: 6, name: 'Fay', email: 'fay@example.io', tags: [], address: { city: 123, zip: '200' } },
          { id: 7, name: 'Gus', email: 'gus@example.io' },
          { id: '8', name: 'Hal', email: 'hal@example.io', age: 35, address: { city: 'Perth', zip: '6000', country: null } },
        ],
        null,
        2,
      ),
    },
    expected: {
      totalRecords: 8,
      validCount: 2,
      invalidRecordIndexes: [1, 2, 3, 5, 6, 7],
      errors: [
        { path: 'records[1].address.zip', code: 'missing' },
        { path: 'records[2].email', code: 'type' },
        { path: 'records[3].age', code: 'type' },
        { path: 'records[3].tags[1]', code: 'type' },
        { path: 'records[5].address.city', code: 'type' },
        { path: 'records[6].address', code: 'missing' },
        { path: 'records[7].address.country', code: 'type' },
        { path: 'records[7].id', code: 'type' },
      ],
      errorCountByCode: { missing: 2, type: 6 },
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 5;

      if (data.totalRecords === task.expected.totalRecords) matched += 1;
      else details.push(`totalRecords 應為 ${task.expected.totalRecords}，實得 ${data.totalRecords}`);

      if (data.validCount === task.expected.validCount) matched += 1;
      else details.push(`validCount 應為 ${task.expected.validCount}，實得 ${data.validCount}`);

      if (JSON.stringify(data.invalidRecordIndexes) === JSON.stringify(task.expected.invalidRecordIndexes)) matched += 1;
      else details.push(`invalidRecordIndexes 應為 ${JSON.stringify(task.expected.invalidRecordIndexes)}，實得 ${JSON.stringify(data.invalidRecordIndexes)}`);

      if (canonicalJson(data.errors) === canonicalJson(task.expected.errors)) matched += 1;
      else details.push(`errors 應為 ${JSON.stringify(task.expected.errors)}，實得 ${JSON.stringify(data.errors)}`);

      if (canonicalJson(data.errorCountByCode) === canonicalJson(task.expected.errorCountByCode)) matched += 1;
      else details.push(`errorCountByCode 應為 ${canonicalJson(task.expected.errorCountByCode)}，實得 ${canonicalJson(data.errorCountByCode)}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },

  {
    taskId: 'gen-hold-05',
    split: 'heldout',
    domain: 'general',
    taskTypes: ['state-machine-audit', 'log-triage'],
    keywords: ['state-machine', 'transitions', 'logs', 'orders', 'audit'],
    executionMode: 'Standard-Sandbox',
    title: '訂單狀態機日誌非法轉換偵測與最終狀態彙整',
    prompt: [
      '請讀取工作區 transitions.json（狀態機定義：initial 為初始狀態，transitions 為「來源狀態 → 可轉入狀態陣列」）以及 events-2026-10-01.log 與 events-2026-10-02.log（事件日誌，每行格式為「時間戳 訂單編號 狀態」，# 開頭為註解），偵測非法轉換並輸出 JSON。規則：',
      '1. 兩個日誌檔的事件必須合併後依時間戳由早到晚排序再處理（檔案內與檔案間都不保證有序）。',
      '2. 每張訂單的第一個事件必須是 initial 狀態，否則視為非法轉換，from 記為 "START"。',
      '3. 之後每個事件的狀態若不在「目前狀態」的可轉入陣列內（包含轉入與目前相同的狀態、或從終止狀態再轉出），即為非法轉換。',
      '4. 不論轉換是否合法，訂單的「目前狀態」一律更新為該事件的狀態（以日誌為準）。',
      '輸出欄位：totalEvents（有效事件行數）、orderCount（不同訂單數）、illegalCount、illegalTransitions（陣列，每項 { timestamp, orderId, from, to }，依 timestamp 遞增、相同則依 orderId 字母序；timestamp 原樣輸出）、finalStates（物件，鍵為訂單編號、值為最終狀態）、completedOrders（最終狀態為 delivered 的訂單編號陣列，字母序）。',
    ].join('\n'),
    workspaceFiles: {
      'transitions.json': JSON.stringify(
        {
          initial: 'created',
          transitions: {
            created: ['paid', 'cancelled'],
            paid: ['shipped', 'refunded'],
            shipped: ['delivered', 'returned'],
            delivered: ['returned'],
            cancelled: [],
            refunded: [],
            returned: [],
          },
        },
        null,
        2,
      ),
      'events-2026-10-01.log': [
        '# timestamp orderId state',
        '2026-10-01T09:00:00Z ORD-1 created',
        '2026-10-01T09:05:00Z ORD-2 created',
        '2026-10-01T09:10:00Z ORD-1 paid',
        '2026-10-01T09:20:00Z ORD-3 paid',
        '2026-10-01T09:30:00Z ORD-2 cancelled',
        '2026-10-01T09:40:00Z ORD-1 shipped',
        '2026-10-01T09:15:00Z ORD-4 created',
        '2026-10-01T09:50:00Z ORD-2 paid',
        '2026-10-01T10:00:00Z ORD-3 shipped',
        '2026-10-01T10:10:00Z ORD-4 paid',
        '',
      ].join('\n'),
      'events-2026-10-02.log': [
        '# timestamp orderId state',
        '2026-10-02T08:00:00Z ORD-1 delivered',
        '2026-10-02T08:05:00Z ORD-4 paid',
        '2026-10-02T08:10:00Z ORD-5 created',
        '2026-10-02T08:20:00Z ORD-3 delivered',
        '2026-10-02T08:30:00Z ORD-4 shipped',
        '2026-10-02T08:40:00Z ORD-5 shipped',
        '2026-10-02T08:50:00Z ORD-4 delivered',
        '2026-10-02T09:00:00Z ORD-1 returned',
        '# 以下為前一日延遲寫入的事件',
        '2026-10-01T23:30:00Z ORD-3 returned',
        '',
      ].join('\n'),
    },
    expected: {
      totalEvents: 19,
      orderCount: 5,
      illegalCount: 5,
      illegalTransitions: [
        { timestamp: '2026-10-01T09:20:00Z', orderId: 'ORD-3', from: 'START', to: 'paid' },
        { timestamp: '2026-10-01T09:50:00Z', orderId: 'ORD-2', from: 'cancelled', to: 'paid' },
        { timestamp: '2026-10-02T08:05:00Z', orderId: 'ORD-4', from: 'paid', to: 'paid' },
        { timestamp: '2026-10-02T08:20:00Z', orderId: 'ORD-3', from: 'returned', to: 'delivered' },
        { timestamp: '2026-10-02T08:40:00Z', orderId: 'ORD-5', from: 'created', to: 'shipped' },
      ],
      finalStates: {
        'ORD-1': 'returned',
        'ORD-2': 'paid',
        'ORD-3': 'delivered',
        'ORD-4': 'delivered',
        'ORD-5': 'shipped',
      },
      completedOrders: ['ORD-3', 'ORD-4'],
    },
    objectiveCheck(record, task) {
      const data = extractJsonFromOutput(record.finalOutput);
      if (!data) {
        return { passed: false, score: 0, details: ['輸出不是合法的 JSON 格式'] };
      }
      const details = [];
      let matched = 0;
      const totalChecks = 6;

      if (data.totalEvents === task.expected.totalEvents) matched += 1;
      else details.push(`totalEvents 應為 ${task.expected.totalEvents}，實得 ${data.totalEvents}`);

      if (data.orderCount === task.expected.orderCount) matched += 1;
      else details.push(`orderCount 應為 ${task.expected.orderCount}，實得 ${data.orderCount}`);

      if (data.illegalCount === task.expected.illegalCount) matched += 1;
      else details.push(`illegalCount 應為 ${task.expected.illegalCount}，實得 ${data.illegalCount}`);

      if (canonicalJson(data.illegalTransitions) === canonicalJson(task.expected.illegalTransitions)) matched += 1;
      else details.push(`illegalTransitions 應為 ${JSON.stringify(task.expected.illegalTransitions)}，實得 ${JSON.stringify(data.illegalTransitions)}`);

      if (canonicalJson(data.finalStates) === canonicalJson(task.expected.finalStates)) matched += 1;
      else details.push(`finalStates 應為 ${canonicalJson(task.expected.finalStates)}，實得 ${canonicalJson(data.finalStates)}`);

      if (JSON.stringify(data.completedOrders) === JSON.stringify(task.expected.completedOrders)) matched += 1;
      else details.push(`completedOrders 應為 ${JSON.stringify(task.expected.completedOrders)}，實得 ${JSON.stringify(data.completedOrders)}`);

      const score = Number((matched / totalChecks).toFixed(4));
      return {
        passed: matched === totalChecks,
        score,
        details,
      };
    },
  },
];

/**
 * 依據 split 篩選任務集
 * @param {'dev' | 'heldout' | 'all'} [split]
 */
export function getTasksBySplit(split = 'all') {
  if (split === 'all') return [...TASK_SET_V0];
  return TASK_SET_V0.filter((t) => t.split === split);
}
