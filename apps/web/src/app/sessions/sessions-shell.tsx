"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

type SessionView = {
  sessionId: string;
  title?: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  iterations?: number;
  parentSessionId?: string;
  isSystem?: boolean;
  model?: string;
  error?: string;
  waitReason?: string;
};

type CmsEvent = {
  seq: number;
  sessionId: string;
  eventType: string;
  data: unknown;
  createdAt: string;
};

function statusTone(status: string): React.ComponentProps<typeof Badge>["tone"] {
  switch (status) {
    case "running":
      return "blue";
    case "waiting":
    case "input_required":
      return "yellow";
    case "failed":
    case "error":
      return "red";
    case "completed":
      return "green";
    default:
      return "neutral";
  }
}

function shortId(id: string) {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getContentFromEventData(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const c = data.content;
  return typeof c === "string" ? c : null;
}

function getTokenUsageFromEvents(events: CmsEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events) {
    if (!isRecord(e.data)) continue;
    const usage = e.data.usage;
    if (!isRecord(usage)) continue;
    if (typeof usage.inputTokens === "number") inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === "number") outputTokens += usage.outputTokens;
    if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
    if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
  }
  return { inputTokens, outputTokens };
}

export function SessionsShell() {
  const router = useRouter();
  const sp = useSearchParams();
  const selectedId = sp.get("sid") || "";

  const [sessions, setSessions] = React.useState<SessionView[]>([]);
  const [filter, setFilter] = React.useState("");
  const [events, setEvents] = React.useState<CmsEvent[]>([]);
  const lastSeqRef = React.useRef(0);
  const [loading, setLoading] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const chatBottomRef = React.useRef<HTMLDivElement | null>(null);

  const chatEvents = React.useMemo(
    () => events.filter(e => e.eventType === "user.message" || e.eventType === "assistant.message"),
    [events],
  );

  const activityEvents = React.useMemo(
    () => events.filter(e => e.eventType !== "user.message" && e.eventType !== "assistant.message"),
    [events],
  );

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s =>
      `${s.title ?? ""} ${s.sessionId} ${s.model ?? ""}`.toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  const selected = React.useMemo(
    () => sessions.find(s => s.sessionId === selectedId) || null,
    [sessions, selectedId],
  );

  const childSessions = React.useMemo(
    () => sessions.filter(s => s.parentSessionId === selectedId),
    [sessions, selectedId],
  );

  const stats = React.useMemo(() => {
    const userSessions = sessions.filter(s => !s.isSystem);
    const running = userSessions.filter(s => s.status === "running").length;
    const totalTurns = userSessions.reduce((sum, s) => sum + (s.iterations ?? 0), 0);
    return { total: userSessions.length, running, totalTurns };
  }, [sessions]);

  const tokenUsage = React.useMemo(() => getTokenUsageFromEvents(events), [events]);

  React.useEffect(() => {
    if (selectedId || filtered.length === 0) return;
    router.replace(`/sessions?sid=${encodeURIComponent(filtered[0]!.sessionId)}`);
  }, [filtered, selectedId, router]);

  function focusActiveItem() {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-session-id="${CSS.escape(selectedId)}"]`,
    );
    el?.focus();
  }

  async function refreshSessions() {
    setError(null);
    const res = await fetch("/api/sessions", { cache: "no-store" });
    if (!res.ok) throw new Error(`sessions_http_${res.status}`);
    const json = (await res.json()) as { sessions: SessionView[] };
    setSessions(json.sessions ?? []);
  }

  async function loadEvents(sessionId: string, afterSeq?: number) {
    const url = new URL(`/api/sessions/${sessionId}/events`, window.location.origin);
    if (afterSeq) url.searchParams.set("afterSeq", String(afterSeq));
    url.searchParams.set("limit", "200");
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`events_http_${res.status}`);
    const json = (await res.json()) as { events: CmsEvent[] };
    return json.events ?? [];
  }

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await refreshSessions();
        if (!cancelled) setLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load sessions");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setEvents([]);
      setLiveStatus(null);
      lastSeqRef.current = 0;
      return;
    }
    (async () => {
      try {
        const evts = await loadEvents(selectedId, undefined);
        if (cancelled) return;
        setEvents(evts);
        lastSeqRef.current = evts.length ? evts[evts.length - 1]!.seq : 0;
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load events");
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  // Auto-scroll chat to bottom when new messages arrive
  React.useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatEvents.length]);

  React.useEffect(() => {
    if (!selectedId) return;
    const url = new URL(`/api/sessions/${selectedId}/stream`, window.location.origin);
    if (lastSeqRef.current) url.searchParams.set("afterSeq", String(lastSeqRef.current));
    const es = new EventSource(url.toString());

    es.addEventListener("init", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data)) {
          const status = data.status;
          if (isRecord(status) && isRecord(status.customStatus) && typeof status.customStatus.status === "string") {
            setLiveStatus(status.customStatus.status);
          }
          if (typeof data.lastSeq === "number") lastSeqRef.current = data.lastSeq;
        }
      } catch {}
    });

    es.addEventListener("status", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data) && isRecord(data.customStatus) && typeof data.customStatus.status === "string") {
          setLiveStatus(data.customStatus.status);
        }
      } catch {}
    });

    es.addEventListener("events", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data) && Array.isArray(data.events)) {
          const evts = data.events as CmsEvent[];
          if (evts.length > 0) {
            setEvents(prev => [...prev, ...evts]);
            lastSeqRef.current = evts[evts.length - 1]!.seq;
          }
        }
      } catch {}
    });

    es.addEventListener("error", () => {});
    return () => es.close();
  }, [selectedId]);

  async function createSession(model?: string, parentSessionId?: string) {
    setError(null);
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      }),
    });
    if (!res.ok) throw new Error(`create_http_${res.status}`);
    const json = (await res.json()) as { sessionId: string };
    await refreshSessions();
    return json.sessionId;
  }

  async function spawnAgent(task: string, model?: string) {
    const sessionId = await createSession(model, selectedId);
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: task }),
    });
    if (!res.ok) throw new Error(`spawn_message_http_${res.status}`);
    await refreshSessions();
  }

  async function renameSession(sessionId: string, title: string) {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`rename_http_${res.status}`);
    await refreshSessions();
  }

  async function cancelSession(sessionId: string) {
    const res = await fetch(`/api/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Cancelled from web UI" }),
    });
    if (!res.ok) throw new Error(`cancel_http_${res.status}`);
    await refreshSessions();
  }

  async function deleteSession(sessionId: string) {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Deleted from web UI" }),
    });
    if (!res.ok) throw new Error(`delete_http_${res.status}`);
    await refreshSessions();
    if (sessionId === selectedId) router.push("/sessions");
  }

  async function sendMessage() {
    if (!selectedId) return;
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    setMessage("");
    try {
      setEvents(prev => [
        ...prev,
        {
          seq: lastSeqRef.current + 0.0001,
          sessionId: selectedId,
          eventType: "user.message",
          data: { content: trimmed },
          createdAt: new Date().toISOString(),
        },
      ]);
      const res = await fetch(`/api/sessions/${selectedId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      });
      if (!res.ok) throw new Error(`send_http_${res.status}`);
      await refreshSessions();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-background/95">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm font-semibold">
              PilotSwarm
            </Link>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Sessions Console
            </span>
          </div>
          {/* Stats bar */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{stats.total}</span> sessions
            </span>
            <span>
              <span className={cn("font-semibold", stats.running > 0 ? "text-blue-500" : "text-foreground")}>
                {stats.running}
              </span> running
            </span>
            <span>
              <span className="font-semibold text-foreground">{stats.totalTurns}</span> total turns
            </span>
            {tokenUsage.inputTokens + tokenUsage.outputTokens > 0 && (
              <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">
                {((tokenUsage.inputTokens + tokenUsage.outputTokens) / 1000).toFixed(1)}k tokens
                (↑{(tokenUsage.inputTokens / 1000).toFixed(1)}k ↓{(tokenUsage.outputTokens / 1000).toFixed(1)}k)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refreshSessions()}>
              Refresh
            </Button>
            <CreateSessionButton onCreate={(model) => createSession(model).then((id) => router.push(`/sessions?sid=${encodeURIComponent(id)}`))} />
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[300px_1fr_340px]">
        {/* Left: sessions list */}
        <nav aria-label="Sessions" className="rounded-xl border border-border bg-background">
          <div className="border-b border-border px-3 py-2">
            <label className="sr-only" htmlFor="session-filter">Filter sessions</label>
            <Input
              id="session-filter"
              placeholder="Search sessions…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <ul
            ref={listRef}
            className="max-h-[calc(100dvh-180px)] overflow-auto p-2"
            role="list"
            onKeyDown={(e) => {
              if (!filtered.length) return;
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const idx = filtered.findIndex(s => s.sessionId === selectedId);
              const nextIdx =
                e.key === "Home" ? 0
                : e.key === "End" ? filtered.length - 1
                : e.key === "ArrowDown" ? Math.min(filtered.length - 1, Math.max(0, idx) + 1)
                : Math.max(0, (idx === -1 ? 0 : idx) - 1);
              const next = filtered[nextIdx];
              if (next) {
                router.push(`/sessions?sid=${encodeURIComponent(next.sessionId)}`);
                queueMicrotask(() => focusActiveItem());
              }
            }}
          >
            {loading ? (
              <li className="p-4 text-sm text-muted-foreground">Loading…</li>
            ) : null}
            {filtered.map((s) => {
              const active = s.sessionId === selectedId;
              const icon =
                s.status === "running" ? "●"
                : s.status === "waiting" || s.status === "input_required" ? "~"
                : s.status === "completed" ? "✓"
                : s.status === "failed" || s.status === "error" ? "!"
                : "·";
              const iconColor =
                s.status === "running" ? "text-blue-500"
                : s.status === "waiting" || s.status === "input_required" ? "text-yellow-500"
                : s.status === "completed" ? "text-green-500"
                : s.status === "failed" || s.status === "error" ? "text-red-500"
                : "text-muted-foreground";
              return (
                <li key={s.sessionId} className="py-0.5">
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      active ? "border-foreground/30 bg-muted/40" : "border-border hover:bg-muted/30",
                    )}
                    data-session-id={s.sessionId}
                    aria-current={active ? "page" : undefined}
                    onClick={() => router.push(`/sessions?sid=${encodeURIComponent(s.sessionId)}`)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span aria-hidden="true" className={cn("text-xs", iconColor)}>{icon}</span>
                          <span className="truncate text-sm font-medium">
                            {s.title || shortId(s.sessionId)}
                          </span>
                          {s.isSystem && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              sys
                            </span>
                          )}
                          {s.parentSessionId && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              child
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {s.model ?? "default"} · {s.iterations ?? 0} turns
                        </div>
                      </div>
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                    </div>
                    {s.waitReason ? (
                      <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{s.waitReason}</div>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {!loading && filtered.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">No sessions match your search.</li>
            ) : null}
          </ul>
        </nav>

        {/* Center: chat */}
        <main className="flex min-h-[60dvh] flex-col rounded-xl border border-border bg-background">
          {/* Chat header */}
          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {selected?.title || (selectedId ? shortId(selectedId) : "No session selected")}
                  </span>
                  {selected?.model && (
                    <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs font-mono text-muted-foreground">
                      {selected.model}
                    </span>
                  )}
                  {selectedId && (
                    <Badge tone={statusTone(liveStatus ?? selected?.status ?? "")}>
                      {liveStatus ?? selected?.status ?? "unknown"}
                    </Badge>
                  )}
                </div>
                {!selectedId && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Pick a session from the left, or create a new one.
                  </p>
                )}
              </div>
              {selectedId ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <SpawnAgentButton
                    parentSessionId={selectedId}
                    onSpawn={spawnAgent}
                  />
                  <RenameButton
                    disabled={!!selected?.isSystem}
                    initialTitle={selected?.title ?? ""}
                    onRename={(t) => renameSession(selectedId, t)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void cancelSession(selectedId)}
                    disabled={!!selected?.isSystem}
                  >
                    Cancel
                  </Button>
                  <DeleteButton
                    disabled={!!selected?.isSystem}
                    onDelete={() => deleteSession(selectedId)}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Chat messages */}
          <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-4">
            <div className="sr-only" aria-live="polite">
              {events.length ? `Loaded ${events.length} events.` : ""}
            </div>
            {error ? (
              <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
            {selectedId ? (
              chatEvents.length ? (
                chatEvents.map((e) => <ChatEventRow key={`${e.seq}`} evt={e} />)
              ) : (
                <div className="text-sm text-muted-foreground">No messages yet.</div>
              )
            ) : (
              <div className="text-sm text-muted-foreground">
                Select a session to view its conversation.
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border p-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => { e.preventDefault(); void sendMessage(); }}
            >
              <label className="sr-only" htmlFor="chat-message">Message</label>
              <Input
                id="chat-message"
                placeholder={selectedId ? "Send a message…" : "Select a session to send messages"}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!selectedId || sending}
              />
              <Button type="submit" disabled={!selectedId || sending || !message.trim()}>
                {sending ? "…" : "Send"}
              </Button>
            </form>
          </div>
        </main>

        {/* Right: tabbed panel */}
        <aside className="rounded-xl border border-border bg-background">
          {selected ? (
            <Tabs defaultValue="details" className="flex h-full flex-col">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="activity">
                  Activity
                  {activityEvents.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {activityEvents.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="agents">
                  Agents
                  {childSessions.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {childSessions.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* Details tab */}
              <TabsContent value="details" className="overflow-auto px-4 py-4">
                <div className="space-y-3 text-sm">
                  <dl className="grid grid-cols-3 gap-x-2 gap-y-2">
                    <dt className="text-muted-foreground">Session</dt>
                    <dd className="col-span-2 break-all font-mono text-xs">{selected.sessionId}</dd>

                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="col-span-2">{selected.model ?? "default"}</dd>

                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="col-span-2">
                      <Badge tone={statusTone(liveStatus ?? selected.status)}>
                        {liveStatus ?? selected.status}
                      </Badge>
                    </dd>

                    <dt className="text-muted-foreground">Turns</dt>
                    <dd className="col-span-2">{selected.iterations ?? 0}</dd>

                    {selected.parentSessionId && (
                      <>
                        <dt className="text-muted-foreground">Parent</dt>
                        <dd className="col-span-2">
                          <button
                            type="button"
                            className="font-mono text-xs underline underline-offset-2 hover:opacity-80"
                            onClick={() => router.push(`/sessions?sid=${encodeURIComponent(selected.parentSessionId!)}`)}
                          >
                            {shortId(selected.parentSessionId)}
                          </button>
                        </dd>
                      </>
                    )}
                  </dl>

                  {selected.waitReason ? (
                    <div className="rounded-lg border border-border bg-muted/30 p-3">
                      <div className="text-xs font-medium text-muted-foreground">Wait reason</div>
                      <div className="mt-1">{selected.waitReason}</div>
                    </div>
                  ) : null}

                  {selected.error ? (
                    <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-red-700 dark:text-red-300">
                      <div className="text-xs font-medium">Last error</div>
                      <div className="mt-1">{selected.error}</div>
                    </div>
                  ) : null}

                  {tokenUsage.inputTokens + tokenUsage.outputTokens > 0 && (
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <div className="mb-1.5 text-xs font-medium text-muted-foreground">Token usage (this session)</div>
                      <div className="flex gap-4 text-xs">
                        <span>↑ <span className="font-semibold text-foreground">{tokenUsage.inputTokens.toLocaleString()}</span> in</span>
                        <span>↓ <span className="font-semibold text-foreground">{tokenUsage.outputTokens.toLocaleString()}</span> out</span>
                        <span>= <span className="font-semibold text-foreground">{(tokenUsage.inputTokens + tokenUsage.outputTokens).toLocaleString()}</span> total</span>
                      </div>
                    </div>
                  )}

                  <a
                    href={`/api/sessions/${selected.sessionId}/dump`}
                    className="inline-flex text-xs font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                  >
                    Download transcript (Markdown)
                  </a>
                </div>
              </TabsContent>

              {/* Activity tab */}
              <TabsContent value="activity" className="overflow-auto px-4 py-4">
                <div className="space-y-2">
                  {activityEvents.length ? (
                    activityEvents.map((e) => <ActivityEventRow key={`${e.seq}`} evt={e} />)
                  ) : (
                    <p className="text-xs text-muted-foreground">No tool calls or state events yet.</p>
                  )}
                </div>
              </TabsContent>

              {/* Agents tab */}
              <TabsContent value="agents" className="overflow-auto px-4 py-4">
                <div className="space-y-2">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {childSessions.length} child agent{childSessions.length !== 1 ? "s" : ""}
                    </span>
                    <SpawnAgentButton parentSessionId={selectedId} onSpawn={spawnAgent} compact />
                  </div>
                  {childSessions.length ? (
                    childSessions.map((child) => (
                      <div
                        key={child.sessionId}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/10 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            className="w-full text-left"
                            onClick={() => router.push(`/sessions?sid=${encodeURIComponent(child.sessionId)}`)}
                          >
                            <div className="truncate text-sm font-medium">
                              {child.title || shortId(child.sessionId)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {child.model ?? "default"} · {child.iterations ?? 0} turns
                            </div>
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge tone={statusTone(child.status)}>{child.status}</Badge>
                          <DeleteButton
                            compact
                            disabled={child.isSystem}
                            onDelete={() => deleteSession(child.sessionId)}
                          />
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No child agents. Use "Spawn Agent" to create one.
                    </p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <p className="text-center text-sm text-muted-foreground">
                Select a session to see details and activity.
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-muted-foreground sm:px-6">
        Connected to Neon PostgreSQL via server-side API routes.
      </footer>
    </div>
  );
}

function CreateSessionButton({ onCreate }: { onCreate: (model?: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [models, setModels] = React.useState<{ defaultModel?: string; modelsByProvider: unknown[] } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const json: unknown = await res.json();
        if (!cancelled && isRecord(json)) {
          setModels({
            defaultModel: typeof json.defaultModel === "string" ? json.defaultModel : undefined,
            modelsByProvider: Array.isArray(json.modelsByProvider) ? json.modelsByProvider : [],
          });
          setSelectedModel(typeof json.defaultModel === "string" ? json.defaultModel : undefined);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New session</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>Choose a model for this session.</DialogDescription>
        </DialogHeader>
        <ModelSelect
          loading={loading}
          models={models}
          value={selectedModel}
          onChange={setSelectedModel}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => { onCreate(selectedModel || undefined); setOpen(false); }}>
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SpawnAgentButton({
  parentSessionId,
  onSpawn,
  compact,
}: {
  parentSessionId: string;
  onSpawn: (task: string, model?: string) => Promise<void>;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [task, setTask] = React.useState("");
  const [models, setModels] = React.useState<{ defaultModel?: string; modelsByProvider: unknown[] } | null>(null);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState<string | undefined>(undefined);
  const [spawning, setSpawning] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setModelsLoading(true);
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const json: unknown = await res.json();
        if (!cancelled && isRecord(json)) {
          setModels({
            defaultModel: typeof json.defaultModel === "string" ? json.defaultModel : undefined,
            modelsByProvider: Array.isArray(json.modelsByProvider) ? json.modelsByProvider : [],
          });
          setSelectedModel(typeof json.defaultModel === "string" ? json.defaultModel : undefined);
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {compact ? (
          <Button variant="secondary" size="sm">+ Spawn</Button>
        ) : (
          <Button variant="secondary" size="sm">Spawn Agent</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Spawn child agent</DialogTitle>
          <DialogDescription>
            Create a child agent session linked to{" "}
            <span className="font-mono text-xs">{shortId(parentSessionId)}</span>.
            Give it a task and it will start running immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="spawn-task">
              Task description
            </label>
            <textarea
              id="spawn-task"
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground"
              placeholder="Describe what this agent should do…"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="spawn-model">
              Model
            </label>
            <ModelSelect
              loading={modelsLoading}
              models={models}
              value={selectedModel}
              onChange={setSelectedModel}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!task.trim() || spawning}
            onClick={async () => {
              setSpawning(true);
              try {
                await onSpawn(task.trim(), selectedModel || undefined);
                setOpen(false);
                setTask("");
              } finally {
                setSpawning(false);
              }
            }}
          >
            {spawning ? "Spawning…" : "Spawn agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModelSelect({
  loading,
  models,
  value,
  onChange,
}: {
  loading: boolean;
  models: { defaultModel?: string; modelsByProvider: unknown[] } | null;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading models…</p>;
  return (
    <select
      className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">(default)</option>
      {(models?.modelsByProvider ?? []).flatMap((g) => {
        if (!isRecord(g) || !Array.isArray(g.models)) return [];
        return (g.models as unknown[]).flatMap((m) => {
          if (!isRecord(m) || typeof m.qualifiedName !== "string") return [];
          return (
            <option key={m.qualifiedName} value={m.qualifiedName}>
              {m.qualifiedName}
            </option>
          );
        });
      })}
    </select>
  );
}

function RenameButton({
  initialTitle,
  onRename,
  disabled,
}: {
  initialTitle: string;
  onRename: (title: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(initialTitle);
  React.useEffect(() => setTitle(initialTitle), [initialTitle]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled}>Rename</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Keep it short — up to 60 characters.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="rename-title">Title</label>
          <Input id="rename-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!title.trim()}
              onClick={async () => { await onRename(title.trim()); setOpen(false); }}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteButton({
  onDelete,
  disabled,
  compact,
}: {
  onDelete: () => Promise<void>;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {compact ? (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-red-600/10 hover:text-red-600 disabled:opacity-40"
            disabled={disabled}
            aria-label="Delete agent"
          >
            ✕
          </button>
        ) : (
          <Button variant="danger" size="sm" disabled={disabled}>Delete</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete session</DialogTitle>
          <DialogDescription>
            This cancels the orchestration and removes the session from the catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { await onDelete(); setOpen(false); }}>
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChatEventRow({ evt }: { evt: CmsEvent }) {
  const t = new Date(evt.createdAt).toLocaleTimeString();

  if (evt.eventType === "user.message") {
    const content = getContentFromEventData(evt.data) ?? "";
    const clean = content.replace(/^\[SYSTEM: Running on host "[^"]*"\.\]\n\n/, "");
    return (
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">You</span> · {t}
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{clean}</div>
      </div>
    );
  }

  if (evt.eventType === "assistant.message") {
    const content = getContentFromEventData(evt.data) ?? "";
    return (
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Assistant</span> · {t}
        </div>
        <div className="rounded-lg border border-border bg-background p-3 text-sm">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => (
                <a {...props} className="underline underline-offset-4 hover:opacity-80" target="_blank" rel="noreferrer" />
              ),
              code: (props) => {
                const isBlock = typeof props.className === "string" && props.className.includes("language-");
                return (
                  <code
                    {...props}
                    className={cn(
                      isBlock ? "font-mono text-xs" : "rounded bg-muted px-1.5 py-0.5 font-mono text-xs",
                      props.className,
                    )}
                  />
                );
              },
              pre: (props) => (
                <pre {...props} className="mt-2 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs" />
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  return null;
}

function ActivityEventRow({ evt }: { evt: CmsEvent }) {
  const t = new Date(evt.createdAt).toLocaleTimeString();
  const d = isRecord(evt.data) ? evt.data : {};

  if (evt.eventType === "tool.execution_start" || evt.eventType === "tool.execution_complete") {
    const toolName =
      typeof d.toolName === "string" ? d.toolName
      : typeof d.name === "string" ? d.name
      : "tool";
    const isStart = evt.eventType === "tool.execution_start";
    return (
      <div className="rounded-lg border border-border bg-muted/10 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-foreground">{toolName}</span>
          <span className="text-[10px] text-muted-foreground">{isStart ? "start" : "done"} · {t}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{evt.eventType}</span>
        <span className="text-[10px] text-muted-foreground">{t}</span>
      </div>
    </div>
  );
}
