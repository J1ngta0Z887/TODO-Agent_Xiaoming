import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createJsonTaskStore } from "./task-store.ts";

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, "tasks.json") };
}

test("新建的任务换个实例还读得到", async (t) => {
  const { filename } = await workspace(t);
  const created = createJsonTaskStore(filename).create("买牛奶", { dueAt: "2026-12-01" });

  const reopened = createJsonTaskStore(filename).list();
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]?.id, created.id);
  assert.equal(reopened[0]?.title, "买牛奶");
  assert.equal(reopened[0]?.dueAt, "2026-12-01");
});

test("磁盘上的未知字段原样保留", async (t) => {
  const { filename } = await workspace(t);
  const original = [
    { id: "a", title: "买牛奶", done: false, priority: 1, owner: { name: "我" } },
    { id: "b", title: "取快递", done: true, note: "放门口" },
  ];
  await writeFile(filename, JSON.stringify(original), "utf8");

  const store = createJsonTaskStore(filename);
  store.update("a", { done: true });

  const saved = JSON.parse(await readFile(filename, "utf8"));
  assert.deepEqual(saved[0], { ...original[0], done: true });
  assert.deepEqual(saved[1], original[1]);
});

test("传 null 会清空字段，不传则保持不动", async (t) => {
  const { filename } = await workspace(t);
  const store = createJsonTaskStore(filename);
  const task = store.create("交周报", { dueAt: "2026-12-01", priority: "高", size: "小" });

  store.update(task.id, { priority: null });
  const afterPriority = createJsonTaskStore(filename).list()[0];
  assert.equal(afterPriority?.priority, null);
  assert.equal(afterPriority?.dueAt, "2026-12-01", "没动的字段不该被清掉");
  assert.equal(afterPriority?.size, "小");

  store.update(task.id, { dueAt: null, size: null });
  const cleared = createJsonTaskStore(filename).list()[0];
  assert.equal(cleared?.dueAt, null);
  assert.equal(cleared?.size, null);
});

test("清单文件坏了不能让服务瘫掉：留备份，从空清单继续", async (t) => {
  const { directory, filename } = await workspace(t);
  const broken = '{ "这不是": JSON';
  await writeFile(filename, broken, "utf8");

  const store = createJsonTaskStore(filename);
  assert.deepEqual(store.list(), [], "坏文件应当当成空清单，而不是抛错");

  const backups = (await readdir(directory)).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1, "应当留下一份备份");
  assert.equal(await readFile(join(directory, backups[0] as string), "utf8"), broken);

  store.create("买牛奶");
  assert.equal(createJsonTaskStore(filename).list().length, 1, "备份之后仍能正常写入");
});

test("改不存在的任务返回 undefined，删不存在的返回 false", async (t) => {
  const { filename } = await workspace(t);
  const store = createJsonTaskStore(filename);
  assert.equal(store.update("missing", { done: true }), undefined);
  assert.equal(store.remove("missing"), false);
});

test("连续写入十条不会互相覆盖", async (t) => {
  const { filename } = await workspace(t);
  const store = createJsonTaskStore(filename);
  for (let index = 0; index < 10; index += 1) store.create(`任务 ${index}`);

  const titles = createJsonTaskStore(filename)
    .list()
    .map((task) => task.title);
  assert.equal(titles.length, 10);
  assert.deepEqual(
    titles,
    Array.from({ length: 10 }, (_, index) => `任务 ${index}`),
  );
});

test("写完不留临时文件", async (t) => {
  const { directory, filename } = await workspace(t);
  createJsonTaskStore(filename).create("买牛奶");
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
