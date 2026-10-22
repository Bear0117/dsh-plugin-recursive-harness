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
      '請讀取工作區中的 legacy-services.json，將啟用中（enabled: true）的服務依 port 由小到大排序，輸出包含 totalServices, enabledCount, disabledCount, routes 陣列與 portSum 的 JSON 報告。',
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
      '請分析工作區 server.log，排除 /healthz 健康檢查紀錄後，計算有效請求數 validRequests、錯誤數 errorCount、依錯誤碼分組之 errorCountsByCode，以及錯誤率百分比 errorRatePct（四捨五入至小數點後兩位）。',
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
      '請讀取 packages-dag.json，驗證是否存在循環相依（hasCycle），並輸出字典序穩定之拓撲建置順序 buildOrder 與葉節點清單 leafPackages。',
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
      '請讀取 release-manifest.json，核對各檔案 expectedSha256 與 actualSha256，輸出 totalFiles, verifiedCount, corruptedFiles（依檔名排序）與 verifiedTotalBytes。',
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
      '請比對工作區 api-schema-diff.json 中之 v1 與 v2 欄位定義，輸出 totalFieldsCompared, breakingCount, breakingFields（依欄位名排序）與 isBackwardCompatible。',
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
];

/**
 * 依據 split 篩選任務集
 * @param {'dev' | 'heldout' | 'all'} [split]
 */
export function getTasksBySplit(split = 'all') {
  if (split === 'all') return [...TASK_SET_V0];
  return TASK_SET_V0.filter((t) => t.split === split);
}
