// 任務載入：內建任務 ID、或使用者自己的任務檔（.js/.mjs，export default 一個任務或 export const tasks 陣列）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TASK_SET_V0 } from '../tasks/task-set-v0.js';

/**
 * 驗證任務物件的最低要求
 * @param {any} task
 */
export function assertTaskShape(task, label = 'task') {
  if (!task || typeof task !== 'object') throw new Error(`${label} 不是物件`);
  if (typeof task.taskId !== 'string' || !task.taskId.trim()) throw new Error(`${label} 缺少 taskId`);
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`${label} 缺少 prompt`);
  if (task.objectiveCheck !== undefined && typeof task.objectiveCheck !== 'function') {
    throw new Error(`${label} 的 objectiveCheck 必須是函式`);
  }
  return task;
}

/**
 * 依 ID 或檔案路徑載入任務
 * @param {string} ref 內建任務 ID，或 .js/.mjs 檔路徑（可用 `檔案#taskId` 指定陣列中的某一題）
 * @param {{ cwd?: string, builtin?: any[] }} [options]
 */
export async function loadTask(ref, options = {}) {
  const builtin = options.builtin ?? TASK_SET_V0;
  const found = builtin.find((t) => t.taskId === ref);
  if (found) return found;

  const [filePart, idPart] = String(ref).split('#');
  const abs = path.resolve(options.cwd ?? process.cwd(), filePart);
  if (/\.(mjs|js)$/i.test(abs) && fs.existsSync(abs)) {
    const mod = await import(pathToFileURL(abs).href);
    const list = Array.isArray(mod.tasks) ? mod.tasks : Array.isArray(mod.default) ? mod.default : null;
    if (list) {
      const picked = idPart ? list.find((t) => t.taskId === idPart) : list[0];
      if (!picked) throw new Error(`任務檔 ${filePart} 裡找不到 taskId=${idPart}`);
      return assertTaskShape(picked, `${filePart}#${picked.taskId}`);
    }
    return assertTaskShape(mod.default, filePart);
  }
  throw new Error(`找不到任務：${ref}（內建任務：${builtin.map((t) => t.taskId).join(', ')}；或給一個 .mjs 任務檔路徑）`);
}

/** 內建任務 ID 清單 */
export function listBuiltinTaskIds() {
  return TASK_SET_V0.map((t) => t.taskId);
}
