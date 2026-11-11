import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_CHARS,
  buildSummaryPrompt,
  cleanModelSentence,
  collectSummaries,
  takeRecent,
  type SummaryItem,
  type SummaryKind,
} from "./summary"

/**
 * Sidebar recap. Every user prompt, assistant reply, and thinking block is
 * summarized into one Chinese sentence by DeepSeek and color-coded by kind.
 *
 *   user  -> info color     你
 *   think -> warning color  思
 *   reply -> base color     答
 *
 * Summaries are generated through the connected OpenCode server's one-shot
 * `generate.text` route, using the DeepSeek provider configured in OpenCode.
 * The local heuristic one-liner is shown immediately and replaced by the model
 * summary when it arrives. Results are cached on disk, so each item is only
 * summarized once.
 *
 * Options (cli.json object form):
 *   limit        number   recent items to keep (0 = all, default 20)
 *   chars        number   max characters per summary (default 60)
 *   height       number   scroll viewport rows (default 20)
 *   kinds        array    which kinds to include, e.g. ["user", "think"]
 *   providerID   string   default "magpie-lan"
 *   modelID      string   default "workbuddy/deepseek-v4.1-flash"
 *   variant      string   reasoning effort, default "low"; use "none" to disable
 *   concurrency  number   parallel summary requests (default 2)
 *   timeoutMs    number   per-request timeout (default 20000)
 */
export default Plugin.define({
  id: "local.sidebar-summary",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <SidebarSummary sessionID={input.sessionID} />,
    })
  },
})

const TAGS: Record<SummaryKind, string> = {
  user: "你",
  think: "思",
  reply: "答",
}

const KIND_ORDER: readonly SummaryKind[] = ["user", "think", "reply"]
const RETRY_AFTER_MS = 60_000

type CacheEntry = {
  readonly text: string
  readonly at: number
}

type CacheState = {
  entries: Record<string, CacheEntry>
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function readKinds(value: unknown): readonly SummaryKind[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kinds = value.filter((entry): entry is SummaryKind =>
    typeof entry === "string" && KIND_ORDER.includes(entry as SummaryKind),
  )
  return kinds.length > 0 ? kinds : undefined
}

function SidebarSummary(props: { readonly sessionID: string }) {
  const context = usePlugin()
  const limit = readNumber(context.options.limit, DEFAULT_LIMIT)
  const chars = readNumber(context.options.chars, DEFAULT_MAX_CHARS)
  const height = Math.max(3, readNumber(context.options.height, 20))
  const kinds = readKinds(context.options.kinds)
  const concurrency = Math.max(1, readNumber(context.options.concurrency, 2))
  const timeoutMs = Math.max(1_000, readNumber(context.options.timeoutMs, 20_000))
  const providerID = readString(context.options.providerID, "magpie-lan")
  const modelID = readString(
    context.options.modelID ?? context.options.model,
    "workbuddy/deepseek-v4.1-flash",
  )
  const variant = readString(context.options.variant, "low")
  const model = { providerID, id: modelID, ...(variant ? { variant } : {}) }

  const [cache, updateCache] = context.storage.store<CacheState>("summary-cache", {
    initial: { entries: {} },
  })
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const failures = new Map<string, number>()

  const items = createMemo(() =>
    collectSummaries(context.data.session.message.list(props.sessionID) ?? [], {
      maxChars: chars,
      kinds,
    }),
  )

  const visible = createMemo(() => takeRecent(items(), limit))

  const request = async (item: SummaryItem) => {
    setPending((previous) => new Set(previous).add(item.key))
    try {
      const result = await context.client.generate.text(
        { prompt: buildSummaryPrompt(item, chars), model },
        { signal: AbortSignal.timeout(timeoutMs) },
      )
      const text = cleanModelSentence(result.text, chars)
      if (!text) throw new Error("empty summary")
      failures.delete(item.key)
      await updateCache((draft) => {
        draft.entries[item.key] = { text, at: Date.now() }
        const keys = Object.keys(draft.entries)
        const overflow = keys.length - 300
        if (overflow > 0) {
          keys
            .toSorted((left, right) => draft.entries[left]!.at - draft.entries[right]!.at)
            .slice(0, overflow)
            .forEach((key) => delete draft.entries[key])
        }
      })
    } catch {
      // Keep the local fallback and retry later instead of hammering the API.
      failures.set(item.key, Date.now())
    } finally {
      setPending((previous) => {
        const next = new Set(previous)
        next.delete(item.key)
        return next
      })
    }
  }

  createEffect(() => {
    const entries = cache.entries
    const busy = pending()
    const free = concurrency - busy.size
    if (free <= 0) return
    const now = Date.now()
    let started = 0
    // Newest first: what just happened is the most useful to summarize.
    for (const item of [...visible().list].reverse()) {
      if (started >= free) break
      if (entries[item.key] || busy.has(item.key)) continue
      const failedAt = failures.get(item.key)
      if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) continue
      started++
      void request(item)
    }
  })

  const counts = createMemo(() => {
    const totals: Record<SummaryKind, number> = { user: 0, think: 0, reply: 0 }
    for (const item of items()) totals[item.kind]++
    return totals
  })

  const color = (kind: SummaryKind) => {
    if (kind === "user") return context.theme.text.feedback.info.base
    if (kind === "think") return context.theme.text.feedback.warning.base
    return context.theme.text.base
  }

  const textFor = (item: SummaryItem) => cache.entries[item.key]?.text ?? item.fallback

  const header = () =>
    KIND_ORDER.filter((kind) => counts()[kind] > 0)
      .map((kind) => `${TAGS[kind]}${counts()[kind]}`)
      .join(" ")

  return (
    <Show when={items().length > 0}>
      <box flexDirection="column" gap={0}>
        <text fg={context.theme.text.muted}>
          <b>摘要</b> {header()}
        </text>
        <scrollbox
          height={height}
          scrollY
          scrollX={false}
          stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={{ showArrows: true }}
        >
          <For each={visible().list}>
            {(item: SummaryItem) => (
              <box
                flexDirection="row"
                flexShrink={0}
                border={["left"]}
                borderColor={color(item.kind)}
              >
                <text width={3} fg={color(item.kind)}>
                  <b>{TAGS[item.kind]}</b>
                </text>
                <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="char" fg={color(item.kind)}>
                  {textFor(item)}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <text fg={context.theme.text.faint}>
          滚轮上下滚动 · 最新在下
          {visible().hidden > 0 ? ` · 上方还有更早 ${visible().hidden} 条` : ""}
        </text>
      </box>
    </Show>
  )
}
