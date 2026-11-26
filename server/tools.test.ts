import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createJsonTaskStore } from "./task-store.ts";
import { formatTaskList, resolveTask, runTool, todayISO } from "./tools.ts";

const now = new Date("2026-11-26T10:00:00");
const today = todayISO(now);

async function emptyStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

function call(store: ReturnType<typeof createJsonTaskStore>, name: string, args: unknown) {
  return runTool(store, name, JSON.stringify(args), now);
}

test("把用户说的话对到任务上", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "买牛奶" });
  call(store, "add_task", { title: "取快递" });
  const tasks = store.list();

  const byKeyword = resolveTask(tasks, "牛奶");
  assert.equal(byKeyword.kind === "one" && byKeyword.task.title, "买牛奶");

  const byPhrase = resolveTask(tasks, "牛奶买好了");
  assert.equal(byPhrase.kind === "one" && byPhrase.task.title, "买牛奶");

  const withFiller = resolveTask(tasks, "取快递这条");
  assert.equal(withFiller.kind === "one" && withFiller.task.title, "取快递");

  assert.equal(resolveTask(tasks, "买菜").kind, "none");
});

test("一句话能对上不止一条时要求确认，不替用户选", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "取快递" });
  call(store, "add_task", { title: "寄快递" });

  const resolved = resolveTask(store.list(), "快递");
  assert.equal(resolved.kind, "many");
  assert.equal(resolved.kind === "many" && resolved.tasks.length, 2);

  const result = call(store, "delete_task", { ref: "快递" });
  assert.equal(result.ok, false);
  assert.match(result.message, /好几条/);
  assert.equal(store.list().length, 2);
});

test("按关键词标记完成，没点名的任务不受影响", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "买牛奶" });
  call(store, "add_task", { title: "取快递" });

  const result = call(store, "update_task", { ref: "牛奶", done: true });
  assert.equal(result.ok, true);
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(store.list().find((task) => task.title === "取快递")?.done, false);

  call(store, "update_task", { ref: "牛奶", done: false });
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.done, false);
});

test("同名的待办不重复添加", async (t) => {
  const store = await emptyStore(t);
  const first = call(store, "add_task", { title: "买牛奶" });
  const again = call(store, "add_task", { title: " 买 牛奶 " });

  assert.equal(first.ok, true);
  assert.match(again.message, /已经有一条/);
  assert.equal(store.list().length, 1);
});

test("到期日支持相对说法，并按今天筛出来", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "交周报", due: "今天" });
  call(store, "add_task", { title: "续签证", due: "明天" });
  call(store, "add_task", { title: "随便写写" });

  assert.equal(store.list().find((task) => task.title === "交周报")?.dueAt, today);

  const dueToday = call(store, "list_tasks", { due: "今天" });
  assert.equal(dueToday.ok, true);
  assert.equal(dueToday.tasks?.length, 1);
  assert.equal(dueToday.tasks?.[0]?.title, "交周报");

  assert.equal(call(store, "list_tasks", { due: "已过期" }).tasks?.length, 0);
});

test("看不懂的日期不会被存进去", async (t) => {
  const store = await emptyStore(t);
  const result = call(store, "add_task", { title: "体检", due: "下个世纪" });
  assert.equal(result.ok, false);
  assert.equal(store.list().length, 0);
});

test("清单把待办排在已完成前面", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "洗衣服" });
  call(store, "add_task", { title: "买牛奶", priority: "高" });
  call(store, "update_task", { ref: "洗衣服", done: true });

  const lines = formatTaskList(store.list(), now).split("\n");
  assert.match(lines[0] ?? "", /待办 1 条，已完成 1 条/);
  assert.equal(lines[1]?.startsWith("○ 买牛奶"), true);
  assert.equal(lines[2]?.startsWith("✓ 洗衣服"), true);
});

test("改任务时没说要改什么会拒绝执行", async (t) => {
  const store = await emptyStore(t);
  call(store, "add_task", { title: "买牛奶" });
  const result = call(store, "update_task", { ref: "牛奶" });
  assert.equal(result.ok, false);
  assert.equal(result.action, "failed");
  assert.equal(store.list()[0]?.done, false);
});

test("action 说清每次调用到底做了什么", async (t) => {
  const store = await emptyStore(t);

  assert.equal(call(store, "add_task", { title: "买牛奶" }).action, "created");
  assert.equal(call(store, "add_task", { title: "买牛奶" }).action, "exists");
  assert.equal(call(store, "update_task", { ref: "牛奶", done: true }).action, "updated");
  assert.equal(call(store, "list_tasks", {}).action, "listed");
  assert.equal(call(store, "delete_task", { ref: "牛奶" }).action, "deleted");
  assert.equal(call(store, "delete_task", { ref: "牛奶" }).action, "failed");
});
