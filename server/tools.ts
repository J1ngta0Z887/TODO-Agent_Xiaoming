import { z } from "zod";
import type { Task, TaskDetails, TaskPriority, TaskSize, TaskStore } from "./task-store.ts";

export interface ToolTask {
  id: string;
  title: string;
  done: boolean;
  dueAt: string | null;
  priority: TaskPriority | null;
  size: TaskSize | null;
}

/** 这次工具调用到底对清单做了什么，回复里的事实要跟它一致。 */
export type ToolAction = "created" | "exists" | "updated" | "deleted" | "listed" | "failed";

export interface ToolResult {
  ok: boolean;
  action: ToolAction;
  /** 给智能体转述给用户的话；事实以这里为准。 */
  message: string;
  tasks?: ToolTask[];
}

const priorities: TaskPriority[] = ["高", "中", "低"];
const sizes: TaskSize[] = ["小", "中", "大"];

function succeeded(
  action: Exclude<ToolAction, "failed">,
  message: string,
  tasks?: ToolTask[],
): ToolResult {
  return { ok: true, action, message, tasks };
}

function failed(message: string, tasks?: ToolTask[]): ToolResult {
  return { ok: false, action: "failed", message, tasks };
}

// ---------------------------------------------------------------- 日期

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function todayISO(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return todayISO(date);
}

function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T00:00:00`).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function isRealDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false;
  return todayISO(new Date(`${value}T00:00:00`)) === value;
}

/** 把模型给的日期换成 YYYY-MM-DD；识别不了返回 null。 */
export function normalizeDue(input: string, now = new Date()): string | null {
  const text = input.trim();
  const today = todayISO(now);
  if (text === "今天" || text === "today") return today;
  if (text === "明天" || text === "tomorrow") return shiftDays(today, 1);
  if (text === "后天") return shiftDays(today, 2);
  return isRealDate(text) ? text : null;
}

// ------------------------------------------------------------ 任务引用解析

const noise = /[\s，。、,.!！?？;；:：~～…"'“”‘’()（）【】[\]《》]/g;
const fillers = [
  "帮我",
  "麻烦",
  "请",
  "把",
  "将",
  "这条",
  "那条",
  "这个",
  "那个",
  "一下",
  "吧",
  "了",
  "呢",
  "啊",
  "呗",
  "嘛",
  "就",
];

function normalizeText(text: string): string {
  return text.toLowerCase().replace(noise, "");
}

// 「取快递这条删掉吧」→「取快递」：只在匹配时用，不写进清单标题。
function stripFillers(text: string): string {
  let out = text;
  for (let round = 0; round < 4; round += 1) {
    const before = out;
    for (const filler of fillers) {
      if (out.length > filler.length && out.startsWith(filler)) out = out.slice(filler.length);
      if (out.length > filler.length && out.endsWith(filler)) out = out.slice(0, -filler.length);
    }
    if (out === before) break;
  }
  return out;
}

function longestCommonLength(a: string, b: string): number {
  const width = b.length + 1;
  let previous = Array.from({ length: width }, () => 0);
  let current = Array.from({ length: width }, () => 0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : 0;
      if (current[j] > best) best = current[j];
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return best;
}

/** 公共子串占较短一方的比例：「牛奶」和「买牛奶」是 1，和「买菜」是 0.33。 */
function similarity(a: string, b: string): number {
  const shortest = Math.min(a.length, b.length);
  if (shortest === 0) return 0;
  return longestCommonLength(a, b) / shortest;
}

const similarityThreshold = 0.6;

export type Resolution =
  | { kind: "one"; task: Task }
  | { kind: "none" }
  | { kind: "many"; tasks: Task[] };

function pick(matches: Task[], preferPending: boolean): Resolution | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return { kind: "one", task: matches[0] };
  if (preferPending) {
    const pending = matches.filter((task) => !task.done);
    if (pending.length === 1) return { kind: "one", task: pending[0] };
  }
  return { kind: "many", tasks: matches };
}

/**
 * 把用户嘴里的一句话对到具体任务上。顺序：id → 标题完全相同 → 标题包含 →
 * 模糊相似。模糊这一步只认「像到一定程度」且唯一的匹配，宁可不认也不删错。
 */
export function resolveTask(
  tasks: Task[],
  reference: string,
  options: { preferPending?: boolean } = {},
): Resolution {
  const text = reference.trim();
  if (text === "") return { kind: "none" };

  const byId = tasks.find((task) => task.id === text);
  if (byId) return { kind: "one", task: byId };

  const needles = [normalizeText(text), normalizeText(stripFillers(text))].filter(
    (needle, index, all) => needle.length > 0 && all.indexOf(needle) === index,
  );

  for (const needle of needles) {
    const exact = tasks.filter((task) => normalizeText(task.title) === needle);
    const resolved = pick(exact, options.preferPending ?? false);
    if (resolved) return resolved;
  }

  for (const needle of needles) {
    const containing = tasks.filter((task) => normalizeText(task.title).includes(needle));
    const resolved = pick(containing, options.preferPending ?? false);
    if (resolved) return resolved;
  }

  const scored = tasks
    .map((task) => ({ task, score: similarity(needles[0] ?? "", normalizeText(task.title)) }))
    .filter((item) => item.score >= similarityThreshold);
  if (scored.length === 0) return { kind: "none" };

  const best = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === best).map((item) => item.task);
  return pick(top, options.preferPending ?? false) ?? { kind: "none" };
}

// ------------------------------------------------------------------ 展示

export function view(task: Task): ToolTask {
  const extra = task as Record<string, unknown>;
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    dueAt: typeof extra.dueAt === "string" ? extra.dueAt : null,
    priority: priorities.find((value) => value === extra.priority) ?? null,
    size: sizes.find((value) => value === extra.size) ?? null,
  };
}

function describe(task: ToolTask, now = new Date()): string {
  const parts: string[] = [];
  if (task.dueAt) {
    const gap = daysBetween(todayISO(now), task.dueAt);
    if (gap === 0) parts.push("今天到期");
    else if (gap === 1) parts.push("明天到期");
    else if (gap < 0) parts.push(`已过期 ${-gap} 天`);
    else parts.push(`${task.dueAt.slice(5).replace("-", " 月 ")} 日到期`);
  }
  if (task.priority) parts.push(`${task.priority}优先级`);
  if (task.size) parts.push(`${task.size}工作量`);
  return parts.length === 0 ? "" : `（${parts.join("，")}）`;
}

const priorityWeight: Record<TaskPriority, number> = { 高: 3, 中: 2, 低: 1 };

function comparePending(a: ToolTask, b: ToolTask): number {
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt < b.dueAt ? -1 : 1;
  }
  const weight =
    (priorityWeight[b.priority ?? "中"] ?? 2) - (priorityWeight[a.priority ?? "中"] ?? 2);
  return weight !== 0 ? weight : a.title.localeCompare(b.title, "zh");
}

/** 待办排在前面，已完成的压到最后：一眼能看出还剩什么。 */
export function formatTaskList(tasks: Task[], now = new Date()): string {
  if (tasks.length === 0) return "清单还是空的，一条任务都没有。";

  const items = tasks.map(view);
  const pending = items.filter((task) => !task.done).sort(comparePending);
  const done = items.filter((task) => task.done);

  const lines = [`一共 ${items.length} 条：待办 ${pending.length} 条，已完成 ${done.length} 条。`];
  for (const task of pending) lines.push(`○ ${task.title}${describe(task, now)}`);
  for (const task of done) lines.push(`✓ ${task.title}${describe(task, now)}`);
  return lines.join("\n");
}

// ------------------------------------------------------------- 工具参数

const titleSchema = z.string().trim().min(1).max(200);

const addTaskArgs = z.object({
  title: titleSchema,
  due: z.string().trim().nullish(),
  priority: z.enum(["高", "中", "低"]).nullish(),
  size: z.enum(["小", "中", "大"]).nullish(),
});

const updateTaskArgs = z.object({
  ref: z.string().trim().min(1),
  title: titleSchema.nullish(),
  done: z.boolean().nullish(),
  due: z.string().trim().nullish(),
  priority: z.enum(["高", "中", "低"]).nullish(),
  size: z.enum(["小", "中", "大"]).nullish(),
});

const deleteTaskArgs = z.object({ ref: z.string().trim().min(1) });

const listTasksArgs = z.object({
  status: z.enum(["全部", "待办", "已完成"]).nullish(),
  due: z.enum(["今天", "已过期"]).nullish(),
});

// ------------------------------------------------------------- 工具执行

function addTask(tasks: TaskStore, payload: unknown): ToolResult {
  const parsed = addTaskArgs.safeParse(payload);
  if (!parsed.success) return failed("新增任务需要 1 到 200 个字的标题。");

  const title = parsed.data.title.replace(/\s+/g, " ");
  const existing = tasks
    .list()
    .find((task) => !task.done && normalizeText(task.title) === normalizeText(title));
  if (existing) {
    return succeeded(
      "exists",
      `清单里已经有一条「${existing.title}」了，这次没有新增。如果你确实要再记一条一样的，跟我说一声。`,
      [view(existing)],
    );
  }

  let dueAt: string | undefined;
  if (parsed.data.due != null) {
    const due = normalizeDue(parsed.data.due);
    if (due === null) {
      return failed(
        `「${parsed.data.due}」这个日期我看不懂，请用 YYYY-MM-DD，或者「今天」「明天」。`,
      );
    }
    dueAt = due;
  }

  const details: TaskDetails = {
    dueAt,
    priority: parsed.data.priority ?? undefined,
    size: parsed.data.size ?? undefined,
  };
  const task = tasks.create(title, details);
  return succeeded("created", `新加了一条：${task.title}${describe(view(task))}。`, [view(task)]);
}

function updateTask(tasks: TaskStore, payload: unknown): ToolResult {
  const parsed = updateTaskArgs.safeParse(payload);
  if (!parsed.success) return failed("修改任务需要给出要改哪一条，以及改什么。");

  const { ref } = parsed.data;
  const resolved = resolveTask(tasks.list(), ref, { preferPending: parsed.data.done === true });

  if (resolved.kind === "none") {
    return failed(`清单里没有跟「${ref}」对得上的任务。`, tasks.list().map(view));
  }
  if (resolved.kind === "many") {
    const names = resolved.tasks.map((task) => `「${task.title}」`).join("、");
    return failed(
      `「${ref}」能对上好几条：${names}。请跟用户确认是哪一条。`,
      resolved.tasks.map(view),
    );
  }

  const target = resolved.task;
  const changes: TaskDetails & Partial<Pick<Task, "title" | "done">> = {};
  const notes: string[] = [];

  if (parsed.data.title != null) {
    changes.title = parsed.data.title.replace(/\s+/g, " ");
    notes.push(`改名为「${changes.title}」`);
  }
  if (parsed.data.done != null) {
    changes.done = parsed.data.done;
    notes.push(parsed.data.done ? "标记为已完成" : "改回待办");
  }
  if (parsed.data.due !== undefined) {
    if (parsed.data.due === null) {
      changes.dueAt = null;
      notes.push("清掉了到期日");
    } else {
      const due = normalizeDue(parsed.data.due);
      if (due === null) return failed(`「${parsed.data.due}」这个日期我看不懂。`);
      changes.dueAt = due;
      notes.push(`到期日设为 ${due}`);
    }
  }
  if (parsed.data.priority !== undefined) {
    changes.priority = parsed.data.priority;
    notes.push(
      parsed.data.priority === null ? "清掉了优先级" : `优先级设为${parsed.data.priority}`,
    );
  }
  if (parsed.data.size !== undefined) {
    changes.size = parsed.data.size;
    notes.push(parsed.data.size === null ? "清掉了工作量" : `工作量设为${parsed.data.size}`);
  }

  if (notes.length === 0) return failed("没有说清要改什么，请再确认一下。");

  const updated = tasks.update(target.id, changes);
  if (!updated) return failed(`「${target.title}」刚刚被删掉了，没能修改。`);

  return succeeded("updated", `已经改了「${updated.title}」：${notes.join("，")}。`, [
    view(updated),
  ]);
}

function deleteTask(tasks: TaskStore, payload: unknown): ToolResult {
  const parsed = deleteTaskArgs.safeParse(payload);
  if (!parsed.success) return failed("删除任务需要给出要删哪一条。");

  const { ref } = parsed.data;
  const resolved = resolveTask(tasks.list(), ref);

  if (resolved.kind === "none") {
    return failed(`清单里没有跟「${ref}」对得上的任务。`, tasks.list().map(view));
  }
  if (resolved.kind === "many") {
    const names = resolved.tasks.map((task) => `「${task.title}」`).join("、");
    return failed(
      `「${ref}」能对上好几条：${names}。请跟用户确认删哪一条，不要猜。`,
      resolved.tasks.map(view),
    );
  }

  const title = resolved.task.title;
  if (!tasks.remove(resolved.task.id)) return failed(`「${title}」刚刚已经被删掉了。`);
  return succeeded("deleted", `已经删掉「${title}」。`, tasks.list().map(view));
}

function listTasks(tasks: TaskStore, payload: unknown, now: Date): ToolResult {
  const parsed = listTasksArgs.safeParse(payload);
  if (!parsed.success) return failed("列清单的参数不认识。");

  const today = todayISO(now);
  let selected = tasks.list();

  if (parsed.data.status === "待办") selected = selected.filter((task) => !task.done);
  if (parsed.data.status === "已完成") selected = selected.filter((task) => task.done);
  if (parsed.data.due === "今天") {
    selected = selected.filter((task) => view(task).dueAt === today);
  }
  if (parsed.data.due === "已过期") {
    selected = selected.filter((task) => {
      const { dueAt, done } = view(task);
      return !done && dueAt !== null && dueAt < today;
    });
  }

  return succeeded("listed", formatTaskList(selected, now), selected.map(view));
}

export function runTool(
  tasks: TaskStore,
  name: string,
  rawArguments: string,
  now = new Date(),
): ToolResult {
  let payload: unknown;
  try {
    payload = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    return failed("工具参数不是有效的 JSON，请重新调用。");
  }

  switch (name) {
    case "add_task":
      return addTask(tasks, payload);
    case "update_task":
      return updateTask(tasks, payload);
    case "delete_task":
      return deleteTask(tasks, payload);
    case "list_tasks":
      return listTasks(tasks, payload, now);
    default:
      return failed(`没有叫「${name}」的工具。`);
  }
}

// ------------------------------------------------------- 给模型的工具定义

const dateProperty = {
  type: ["string", "null"],
  description: "到期日，YYYY-MM-DD；也接受「今天」「明天」「后天」。用户没提到期就不传。",
} as const;

const priorityProperty = {
  type: ["string", "null"],
  enum: ["高", "中", "低", null],
  description: "优先级。用户没提就不传。",
} as const;

const sizeProperty = {
  type: ["string", "null"],
  enum: ["小", "中", "大", null],
  description: "工作量。用户没提就不传。",
} as const;

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "add_task",
      description: "在清单里新增一条待办。用户说「记一下…」「提醒我…」「别忘了我还要…」时使用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "任务标题。用用户的原话，去掉「帮我」「记一下」「这条」这类词。",
          },
          due: dateProperty,
          priority: priorityProperty,
          size: sizeProperty,
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "修改已有任务：标记完成、改回待办、改名、改到期日、改优先级或工作量。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ref"],
        properties: {
          ref: {
            type: "string",
            description:
              "要改哪一条。填任务标题里的关键词，比如「牛奶」「取快递」。也可以直接用任务的 id。",
          },
          title: { type: ["string", "null"], description: "新标题。不改就不传。" },
          done: { type: ["boolean", "null"], description: "true 表示已完成，false 表示改回待办。" },
          due: dateProperty,
          priority: priorityProperty,
          size: sizeProperty,
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "从清单里删掉一条任务。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ref"],
        properties: {
          ref: {
            type: "string",
            description: "要删哪一条。填任务标题里的关键词，比如「牛奶」。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "按条件查看清单，比如只看待办、只看已过期。用户问「今天有哪些到期」时用 due=今天。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: ["string", "null"],
            enum: ["全部", "待办", "已完成", null],
            description: "只看哪一种状态，默认全部。",
          },
          due: {
            type: ["string", "null"],
            enum: ["今天", "已过期", null],
            description: "按到期日筛选。",
          },
        },
      },
    },
  },
];
