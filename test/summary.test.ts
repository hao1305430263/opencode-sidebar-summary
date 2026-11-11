import assert from "node:assert/strict"
import {
  MAX_PROMPT_INPUT,
  buildSummaryPrompt,
  cleanModelSentence,
  collectSummaries,
  hashText,
  takeRecent,
  toOneLine,
} from "../summary.ts"
import type { SummaryItem } from "../summary.ts"

// 1. Markdown-heavy user input collapses to one readable sentence.
const user = toOneLine(
  "## 目标\n请把 `src/tui.tsx` 里的所有内容都检查一遍。\n\n然后告诉我哪里有问题！", // two sentences
)
assert.equal(user, "目标 请把 src/tui.tsx 里的所有内容都检查一遍。")

// 2. Long English reasoning is clamped with an ellipsis and stays on one line.
const long = toOneLine(
  "First I should inspect the plugin loader because the sidebar slot may not accept TSX files. Then I will run a typecheck.",
  32,
)
assert.ok(long.length <= 32, `expected <= 32 chars, got ${long.length}: ${long}`)
assert.ok(long.endsWith("…"), `expected ellipsis: ${long}`)
assert.ok(!long.includes("\n"))

// 3. Version numbers and decimals are not treated as sentence ends.
assert.equal(toOneLine("升级到 v2.2.7 后一切正常。"), "升级到 v2.2.7 后一切正常。")

// 4. collectSummaries reads user text, completed reasoning, and completed replies.
const messages = [
  { id: "m1", type: "user", text: "帮我加一个侧边栏摘要。" },
  {
    id: "m2",
    type: "assistant",
    time: { created: 1, completed: 2 },
    content: [
      { type: "reasoning", text: "I need to find the sidebar slot. It lives in the TUI plugin API." },
      { type: "text", text: "已经找到 sidebar.content 槽位了。" },
      { type: "tool", name: "read", id: "t1", state: { status: "completed" } },
    ],
  },
  { id: "m3", type: "system", text: "ignored" },
  // Still streaming: no completed timestamp yet.
  {
    id: "m4",
    type: "assistant",
    content: [{ type: "reasoning", text: "streaming tail" }],
  },
]

const items = collectSummaries(messages, { maxChars: 40 })
assert.deepEqual(
  items.map((item) => item.kind),
  ["user", "think", "reply"],
)
assert.equal(items[0]!.fallback, "帮我加一个侧边栏摘要。")
assert.equal(items[1]!.fallback, "I need to find the sidebar slot.")
assert.equal(items[2]!.fallback, "已经找到 sidebar.content 槽位了。")
assert.equal(new Set(items.map((item) => item.key)).size, items.length)
assert.ok(items[0]!.key.startsWith("user:m1:"))

// Streaming assistant content is excluded by default but can be included.
assert.equal(collectSummaries(messages).filter((item) => item.key.includes("m4")).length, 0)
assert.equal(
  collectSummaries(messages, { includeIncomplete: true }).filter((item) => item.key.includes("m4")).length,
  1,
)

// 5. The kinds option keeps only the requested categories.
const onlyUser = collectSummaries(messages, { kinds: ["user"] })
assert.deepEqual(onlyUser.map((item) => item.kind), ["user"])

// 6. takeRecent keeps the newest items and reports how many were hidden.
const all: SummaryItem[] = Array.from({ length: 20 }, (_, index) => ({
  key: `user:k${index}:${hashText(String(index))}`,
  kind: "user" as const,
  raw: `第 ${index + 1} 条`,
  fallback: `第 ${index + 1} 条`,
}))
const recent = takeRecent(all, 5)
assert.equal(recent.hidden, 15)
assert.deepEqual(
  recent.list.map((item) => item.fallback),
  ["第 16 条", "第 17 条", "第 18 条", "第 19 条", "第 20 条"],
)
assert.equal(takeRecent(all, 0).hidden, 0)
assert.equal(takeRecent(all, 0).list.length, 20)

// 7. The prompt names the kind and caps very long input.
const prompt = buildSummaryPrompt(items[1]!)
assert.ok(prompt.includes("模型的思考过程"))
assert.ok(prompt.includes(items[1]!.raw))
assert.ok(prompt.includes("只输出这一句话"))
const giant: SummaryItem = { key: "big", kind: "reply", raw: "字".repeat(MAX_PROMPT_INPUT + 500), fallback: "字" }
const giantPrompt = buildSummaryPrompt(giant)
assert.ok(giantPrompt.length < MAX_PROMPT_INPUT + 300)
assert.ok(giantPrompt.endsWith("…"))

// 8. Model output is normalized to one clean Chinese line.
assert.equal(cleanModelSentence('“侧边栏用 DeepSeek 总结每条内容。”'), "侧边栏用 DeepSeek 总结每条内容。")
assert.equal(cleanModelSentence("摘要：用户要求改用 DeepSeek 生成一句话。\n多余内容"), "用户要求改用 DeepSeek 生成一句话。")
assert.equal(cleanModelSentence("- 1. 已改为 DeepSeek 一句话摘要！后面不要"), "已改为 DeepSeek 一句话摘要！")
assert.equal(cleanModelSentence("   "), "")
assert.ok(Array.from(cleanModelSentence("很".repeat(200), 30)).length <= 30)
assert.ok(cleanModelSentence("很".repeat(200), 30).endsWith("…"))

// 9. Hashes are stable and change with the text.
assert.equal(hashText("abc"), hashText("abc"))
assert.notEqual(hashText("abc"), hashText("abd"))

console.log("summary.test.ts: all assertions passed")
console.log("user  ->", items[0]!.fallback)
console.log("think ->", items[1]!.fallback)
console.log("reply ->", items[2]!.fallback)
console.log("hidden ->", recent.hidden)
console.log("clean ->", cleanModelSentence("摘要：“侧边栏将用 DeepSeek 低推理模式逐条生成中文摘要。”"))
