/**
 * Turns conversation items into one-line highlights for the sidebar.
 * This module has no TUI dependencies so it can be tested on its own.
 *
 * `fallback` is the local, heuristic one-liner shown immediately.
 * `raw` is the original text sent to the DeepSeek model for a real summary.
 */

export type SummaryKind = "user" | "think" | "reply"

export interface SummaryItem {
  /** Stable cache key for this item (includes a hash of its text). */
  readonly key: string
  readonly kind: SummaryKind
  readonly raw: string
  readonly fallback: string
}

export const DEFAULT_MAX_CHARS = 60
export const DEFAULT_LIMIT = 20
export const MAX_PROMPT_INPUT = 4000

type PartLike = {
  readonly type: string
  readonly text?: string
}

type MessageLike = {
  readonly id?: string
  readonly type: string
  readonly text?: string
  readonly content?: readonly PartLike[]
  /** Assistant messages only finish streaming when this is set. */
  readonly time?: {
    readonly created?: number
    readonly completed?: number
  }
}

const KIND_HINTS: Record<SummaryKind, string> = {
  user: "用户输入",
  think: "模型的思考过程",
  reply: "模型的回复",
}

function stripMarkup(text: string): string {
  return text
    // Fenced code blocks carry little meaning in a one-line recap.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Keep the human-readable part of inline code, images, and links.
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Markdown block markers at the start of a line.
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    // Emphasis markers.
    .replace(/[*_~]{1,3}/g, "")
}

function firstSentence(text: string): string {
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if ("。！？!?".includes(character)) return text.slice(0, index + 1)
    // Only treat a period as a sentence end when whitespace or the end follows,
    // so versions, file names, and decimals survive.
    if (character === ".") {
      const next = text[index + 1]
      if (next === undefined || /\s/.test(next)) return text.slice(0, index + 1)
    }
  }
  return text
}

function clamp(text: string, maxChars: number): string {
  const characters = Array.from(text)
  if (characters.length <= maxChars) return text
  const cut = characters.slice(0, Math.max(1, maxChars - 1)).join("")
  const lastSpace = cut.lastIndexOf(" ")
  const head = lastSpace > Math.floor(cut.length * 0.6) ? cut.slice(0, lastSpace) : cut
  return `${head.trimEnd()}…`
}

/** Collapses any text into a single sentence no longer than `maxChars`. */
export function toOneLine(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  const normalized = stripMarkup(text).replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return clamp(firstSentence(normalized), Math.max(8, maxChars))
}

/** FNV-1a, 32-bit. Only used to invalidate cache entries when text changes. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function normalizeRaw(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

/** Extracts the sidebar highlights for a whole session, oldest first. */
export function collectSummaries(
  messages: readonly MessageLike[],
  options: {
    readonly maxChars?: number
    readonly kinds?: readonly SummaryKind[]
    /** Include assistant content that is still streaming. Defaults to false. */
    readonly includeIncomplete?: boolean
  } = {},
): SummaryItem[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const kinds = options.kinds ?? (["user", "think", "reply"] as const)
  const wanted = new Set<SummaryKind>(kinds)
  const items: SummaryItem[] = []

  const push = (kind: SummaryKind, identity: string, raw: string | undefined) => {
    if (!wanted.has(kind)) return
    const text = normalizeRaw(raw ?? "")
    if (!text) return
    const fallback = toOneLine(text, maxChars)
    if (!fallback) return
    items.push({ key: `${kind}:${identity}:${hashText(text)}`, kind, raw: text, fallback })
  }

  messages.forEach((message, messageIndex) => {
    const messageID = message.id ?? `message-${messageIndex}`
    if (message.type === "user") {
      push("user", messageID, message.text)
      return
    }
    if (message.type !== "assistant") return
    // Reasoning and reply text grow while streaming; wait for the turn to end
    // so the summary is generated from the final text.
    if (!options.includeIncomplete && message.time?.completed === undefined) return
    let index = 0
    for (const part of message.content ?? []) {
      const partIndex = index++
      if (part.type === "reasoning") push("think", `${messageID}#${partIndex}`, part.text)
      else if (part.type === "text") push("reply", `${messageID}#${partIndex}`, part.text)
    }
  })

  return items
}

/** Keeps only the most recent `limit` items. A non-positive limit keeps all. */
export function takeRecent(
  items: readonly SummaryItem[],
  limit: number,
): { readonly list: SummaryItem[]; readonly hidden: number } {
  if (limit <= 0 || items.length <= limit) return { list: [...items], hidden: 0 }
  return { list: items.slice(items.length - limit), hidden: items.length - limit }
}

/** The instruction sent to DeepSeek for one item. */
export function buildSummaryPrompt(item: SummaryItem, maxChars = DEFAULT_MAX_CHARS): string {
  const input = item.raw.length > MAX_PROMPT_INPUT ? `${item.raw.slice(0, MAX_PROMPT_INPUT)}…` : item.raw
  const limit = Math.min(maxChars, 45)
  return [
    `把下面这段${KIND_HINTS[item.kind]}压缩成一句通顺、具体的中文摘要。`,
    `要求：只输出这一句话，不要引号、前缀、编号或解释；不超过 ${limit} 个汉字；保留关键对象和动作。`,
    "",
    input,
  ].join("\n")
}

/** Normalizes whatever the model returned into exactly one clean line. */
export function cleanModelSentence(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  let value = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  value = value
    .replace(/^(?:[-*+]\s+|\d+[.)]\s*)+/, "")
    .replace(/^(?:摘要|总结|一句话摘要)\s*[:：]\s*/, "")
    .replace(/^["'“”‘’「」『』]+/, "")
    .replace(/["'“”‘’「」『』]+$/, "")
    .trim()
  if (!value) return ""
  return clamp(firstSentence(value), Math.max(8, maxChars))
}
