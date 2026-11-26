import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);
export type Task = z.infer<typeof storedTask>;

export type TaskPriority = "高" | "中" | "低";
export type TaskSize = "小" | "中" | "大";

// 可选字段。磁盘上的任务仍然按宽松对象解析，旧数据里已有的其他字段会原样保留。
export interface TaskDetails {
  dueAt?: string | null;
  priority?: TaskPriority | null;
  size?: TaskSize | null;
}

type TaskChanges = Partial<Pick<Task, "title" | "done">> & TaskDetails;

export interface TaskStore {
  list(): Task[];
  create(title: string, details?: TaskDetails): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

// 只保留真正给出的字段：undefined 表示「这次不改」，null 表示「清空」。
function given<T extends object>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    const raw = readFileSync(filename, "utf8");
    try {
      return taskList.parse(JSON.parse(raw));
    } catch (error) {
      // 文件坏了（手改过、磁盘写坏）不能让整个服务跟着瘫掉：先留一份原始内容，
      // 再从空清单继续。备份失败也照样往下走，不然读一次就抛一次。
      let backup = "（备份失败）";
      try {
        backup = `${filename}.corrupt-${Date.now()}`;
        renameSync(filename, backup);
      } catch {
        backup = "（备份失败）";
      }
      console.error(`任务清单读不出来，已备份到 ${backup}：`, error);
      return [];
    }
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, details = {}) {
      const task = { id: randomUUID(), title, done: false, ...given(details) };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, given(changes));
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
