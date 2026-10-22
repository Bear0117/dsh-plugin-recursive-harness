# `dsh-plugin-recursive-harness` 查重報告（D8）與簡要威脅模型

## 1. D8 生態系查重報告（與既有 dsh 自我演進插件之對照）

在啟動實作前，我們檢視了 `awesome-dsh-plugin.com` 插件目錄與 GitHub 社群中與「自我演進、記憶提煉、技能演化」相關之三個現有專案，確認本專案之核心設計（Harness² 雙層遞迴 `Propose → Probe → Compose` + 同算力 `Best-of-k` 閘門 G1）無現成可重用實作：

| 插件名稱 | 維護者 | 核心機制 | 與 `dsh-plugin-recursive-harness` 之關鍵差異 |
| :--- | :--- | :--- | :--- |
| **`dsh-continual-evolve`** | `ZK-Andy` | 從既有會話軌跡（Session Trajectory）事後提煉 Prompt Notes、Memories、Skills 與 Subagent 規格，並透過基準測試分數決定保留或回退。 | 屬於「單軌事後提煉（Post-hoc Extraction）」，未實作同一任務下 `General` 與 `Domain` 雙軸候選之隔離對比探針（Contrastive Probing）、`Compose` 合併重跑驗證，亦未做同算力 `Best-of-k` 對照（Gate G1）。 |
| **`dsh-evolution-lab`** | `JayDong9130` | 將重複經驗轉為隔離候選 `SKILL.md`，以 Canary 程序測試單一 Markdown 技能之表現並自動晉升或回退。 | 演進空間僅限於單一 `SKILL.md`，不涵蓋多元件協同演進（`systemprompt.md`、`guardrails.md`、`tool_guidance.md`、`LongTermMEMORY.md` 與 `skills + scripts` 之 `Compose`），也沒有跨任務結構化經驗庫（`INDEX.md` + `EXPERIENCE.md` + 時間序快照）。 |
| **`dsh-self-improved`** | `madage` | 採 L0～L3 四層記憶管線（原始對話擷取 → 記憶抽取 → 場景分群 → 畫像召回與技能合成），依賴 SQLite FTS5 與 `jieba` 中文斷詞。 | 重度依賴原生擴充與外部斷詞套件，核心為對話記憶檢索（Memory Recall），而非以執行證據與客觀契約檢查驅動之 `Propose → Probe → Compose` 迴圈。 |

---

## 2. 簡要威脅模型（Threat Model）與安全控制

雙層遞迴演進系統允許 Improvement Harness 修改 Agent 的系統提示詞、工具指引與技能腳本，若缺乏硬性邊界，可能發生「護欄自宮」、「獎勵駭客（Reward Hacking）」、「遞迴風暴」或「經驗庫投毒」。本插件於程式碼層級（[`src/security.js`](../src/security.js)、[`src/probe-runner.js`](../src/probe-runner.js)、[`src/ppc.js`](../src/ppc.js)）強制實施以下六道防線：

### 2.1 鎖定表面保護（Locked Surfaces）
- **威脅**：Proposer 或 Composer 嘗試修改全域安全規則、權限政策插件、評測器或保留測試集（Held-out Tasks）以偽造高分。
- **控制**：[`validatePathAgainstLockedSurfaces()`](../src/security.js) 硬性鎖定 `AGENTS.md`、`.dsh/`、`.git/`，再加上設定 `lockedSurfaces` 列出的專案路徑。任何觸碰上述路徑之提案或腳本在進入 Probe 前即直接拒絕並記錄違規。

### 2.2 禁止權限提升、Prompt Injection 與列印紅線
- **威脅**：候選提示詞或技能腳本寫入「給予完全權限」、「忽略先前所有規則」、「關閉護欄」、「執行 `icacls` / `chmod 777`」，或觸碰專案自己列在 `protectedPatterns` 裡的紅線（例如生產系統代號、列印指令）。
- **控制**：[`validateCandidateContent()`](../src/security.js) 對所有候選 Markdown 與 `scripts/*` 進行靜態規則掃描，凡命中權限提升、ACL 變更、Prompt Injection，或設定 `protectedPatterns` 裡的任何樣式者一律攔截（拋出 `HARNESS_SECURITY_VIOLATION`）。

### 2.3 探針遞迴自觸發防護（`apply-only` 模式）
- **威脅**：探針子行程（`dsh --profile headless`）在載入本插件時若再次觸發演進，將形成無限指數級フォーク炸彈（Fork Bomb）。
- **控制**：[`ProbeRunner.prepareIsolatedEnvironment()`](../src/probe-runner.js) 在隔離 `DSH_HOME/profiles/headless/cordis.patch.yml` 中強制設定 `mode: apply-only`。在 [`apply()`](../src/index.js) 中，`apply-only` 模式僅註冊 `systemPrompt.section` 與 `skills`，不掛載協調器、不監聽演進事件、不註冊 `/harness` 指令，從結構上杜絕遞迴自觸發。

### 2.4 獎勵駭客防護（三層證據比較器）
- **威脅**：候選方案輸出格式漂亮或步數極少，騙過語言模型裁判（LLM Judge），但實際上違反任務客觀契約（如總計不合、漏檢異常構件）。
- **控制**：[`Comparator.evaluateRecord()`](../src/ppc.js) 強制將「第 1 層：客觀契約檢查（`objectiveCheck`）」列為最高優先權。未通過客觀檢查之候選，其綜合分數上限鎖死且 `compareAgainstBaseline()` 一律拒絕採用，模型偏好永遠無法推翻客觀契約失敗。

### 2.5 跨任務經驗庫投毒與時間序洩漏防護
- **威脅**：錯誤的演進經驗被寫入經驗庫後持續誤導後續任務；或評測時後續任務偷看未來任務之經驗。
- **控制**：
  1. [`ExperienceLibrary.listEntries()`](../src/experience.js) 支援嚴格時間序快照（`maxSequenceIndex`），任務 `#i` 僅能檢索時序索引 `< i` 之既有條目。
  2. 同一事件（`sourceEventId`）具備冪等去重，重播不會重複寫入。
  3. 提供 [`retractEntry()`](../src/experience.js) 與 [`deprecateEntry()`](../src/experience.js)，一經撤回或淘汰即從預設檢索中排除。

### 2.6 機敏資訊與內網 IP 遮罩
- **威脅**：執行軌跡中之 API Key、Bearer Token 或內網 IP 位址被寫入 `EXPERIENCE.md` 或評測報告而外流。
- **控制**：[`redactSensitiveText()`](../src/security.js) 於寫入經驗庫與報告前自動將私網 IPv4（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）、`sk-...` 金鑰與 `Bearer` Token 替換為 `<REDACTED_*>`。
