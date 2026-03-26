"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const chatEvents = React.useMemo(
    () => events.filter(e => e.eventType === "user.message" || e.eventType === "assistant.message"),
    [events],
  );

  const stateEvents = React.useMemo(
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

  // If nothing selected, pick the first visible session for keyboard users
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

  const selected = React.useMemo(
    () => sessions.find(s => s.sessionId === selectedId) || null,
    [sessions, selectedId],
  );

  async function refreshSessions() {
    setError(null);
    performance.mark("api:sessions:start");
    const res = await fetch("/api/sessions", { cache: "no-store" });
    performance.mark("api:sessions:end");
    performance.measure("api:sessions", "api:sessions:start", "api:sessions:end");
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
          const msg = e instanceof Error ? e.message : "Failed to load sessions";
          setError(msg);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial history load when selection changes
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
        const nextSeq = evts.length ? evts[evts.length - 1]!.seq : 0;
        lastSeqRef.current = nextSeq;
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "Failed to load events";
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Live stream (status + events)
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
          if (typeof data.lastSeq === "number") {
            lastSeqRef.current = data.lastSeq;
          }
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
            const nextSeq = evts[evts.length - 1]!.seq;
            lastSeqRef.current = nextSeq;
          }
        }
      } catch {}
    });
    es.addEventListener("error", () => {
      // EventSource will retry; keep UI calm
    });
    return () => es.close();
  }, [selectedId]);

  async function createSession(model?: string) {
    setError(null);
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    if (!res.ok) throw new Error(`create_http_${res.status}`);
    const json = (await res.json()) as { sessionId: string };
    await refreshSessions();
    router.push(`/sessions?sid=${encodeURIComponent(json.sessionId)}`);
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
    router.push("/sessions");
  }

  async function sendMessage() {
    if (!selectedId) return;
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    setMessage("");
    try {
      // Optimistic UI: append a local user event without seq
      const optimisticSeq = lastSeqRef.current + 0.0001;
      setEvents(prev => [
        ...prev,
        {
          seq: optimisticSeq,
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
      const msg = e instanceof Error ? e.message : "Failed to send message";
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-background/95">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>AI Orchestration</span>
              <span className="h-[1px] flex-1 bg-border" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-3">
              <Link href="/" className="text-sm font-semibold">
                PilotSwarm
              </Link>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Durable Sessions Console
              </span>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 sm:mt-0">
            <Button variant="secondary" size="sm" onClick={() => refreshSessions()}>
              Refresh
            </Button>
            <CreateSessionButton onCreate={createSession} />
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[320px_1fr_360px]">
        <nav aria-label="Sessions" className="rounded-xl border border-border bg-background">
          <div className="border-b border-border px-3 py-2">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sessions (top-left)
            </div>
            <label className="sr-only" htmlFor="session-filter">
              Filter sessions
            </label>
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
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
                return;
              }
              e.preventDefault();
              const idx = filtered.findIndex(s => s.sessionId === selectedId);
              const nextIdx =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? filtered.length - 1
                    : e.key === "ArrowDown"
                      ? Math.min(filtered.length - 1, Math.max(0, idx) + 1)
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
                s.status === "running"
                  ? "●"
                  : s.status === "waiting" || s.status === "input_required"
                    ? "~"
                    : s.status === "completed"
                      ? "✓"
                      : s.status === "failed" || s.status === "error"
                        ? "!"
                        : "·";
              return (
                <li key={s.sessionId} className="py-1">
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left",
                      active
                        ? "border-foreground/30 bg-muted/40"
                        : "border-border hover:bg-muted/30",
                    )}
                    data-session-id={s.sessionId}
                    aria-current={active ? "page" : undefined}
                    onClick={() => router.push(`/sessions?sid=${encodeURIComponent(s.sessionId)}`)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "text-xs",
                              s.status === "running"
                                ? "text-blue-500"
                                : s.status === "waiting" || s.status === "input_required"
                                  ? "text-yellow-500"
                                  : s.status === "completed"
                                    ? "text-green-500"
                                    : s.status === "failed" || s.status === "error"
                                      ? "text-red-500"
                                      : "text-muted-foreground",
                            )}
                          >
                            {icon}
                          </span>
                          <div className="truncate text-sm font-medium">
                            {s.title || shortId(s.sessionId)}
                            {s.isSystem ? (
                              <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                System
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {s.model ?? "default"} · {s.iterations ?? 0} turns
                        </div>
                      </div>
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                    </div>
                    {s.waitReason ? (
                      <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {s.waitReason}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">
                No sessions match your search.
              </li>
            ) : null}
          </ul>
        </nav>

        <main className="min-h-[60dvh] rounded-xl border border-border bg-background">
          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Chat (bottom-left)
                </div>
                <div className="mt-1 truncate text-sm font-semibold">
                  {selected?.title || (selectedId ? shortId(selectedId) : "No session selected")}
                </div>
                <p className="text-xs text-muted-foreground">
                  {selectedId
                    ? `${selected?.model ?? "default"} · status: ${liveStatus ?? selected?.status ?? "unknown"}`
                    : "Pick a session from the left, or create a new one."}
                </p>
              </div>
              {selectedId ? (
                <div className="flex items-center gap-2">
                  <RenameButton
                    disabled={!!selected?.isSystem}
                    initialTitle={selected?.title ?? ""}
                    onRename={(t) => renameSession(selectedId, t)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => cancelSession(selectedId)}
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

          <div className="flex max-h-[calc(100dvh-320px)] flex-col gap-3 overflow-auto px-4 py-4">
            <div className="sr-only" aria-live="polite">
              {events.length ? `Loaded ${events.length} events.` : ""}
            </div>
            <div className="sr-only" aria-live="polite">
              {liveStatus ? `Session status: ${liveStatus}` : ""}
            </div>
            {error ? (
              <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
            {selectedId ? (
              chatEvents.length ? (
                chatEvents.map((e) => <EventRow key={`${e.seq}`} evt={e} />)
              ) : (
                <div className="text-sm text-muted-foreground">No messages yet.</div>
              )
            ) : (
              <div className="text-sm text-muted-foreground">
                Select a session to view its conversation.
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
            >
              <label className="sr-only" htmlFor="message">
                Message
              </label>
              <Input
                id="message"
                placeholder={selectedId ? "Send a message…" : "Select a session to send messages"}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!selectedId || sending}
              />
              <Button type="submit" disabled={!selectedId || sending || !message.trim()}>
                Send
              </Button>
            </form>
          </div>
        </main>

        <aside className="rounded-xl border border-border bg-background">
          <div className="border-b border-border px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Right Pane
            </div>
            <h2 className="mt-1 text-sm font-semibold">Session Details</h2>
          </div>
          <div className="space-y-3 px-4 py-4 text-sm">
            {selected ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-muted-foreground">Session</div>
                  <div className="col-span-2 font-mono text-xs">{selected.sessionId}</div>

                  <div className="text-muted-foreground">Model</div>
                  <div className="col-span-2">{selected.model ?? "default"}</div>

                  <div className="text-muted-foreground">Status</div>
                  <div className="col-span-2">
                    <Badge tone={statusTone(liveStatus ?? selected.status)}>
                      {liveStatus ?? selected.status}
                    </Badge>
                  </div>

                  <div className="text-muted-foreground">Turns</div>
                  <div className="col-span-2">{selected.iterations ?? 0}</div>
                </div>

                {selected.waitReason ? (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      Wait reason
                    </div>
                    <div className="mt-1 text-sm">{selected.waitReason}</div>
                  </div>
                ) : null}

                {selected.error ? (
                  <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-red-700 dark:text-red-300">
                    <div className="text-xs font-medium">Last error</div>
                    <div className="mt-1 text-sm">{selected.error}</div>
                  </div>
                ) : null}

                <a
                  href={`/api/sessions/${selected.sessionId}/dump`}
                  className="inline-flex text-sm font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                >
                  Download transcript (Markdown)
                </a>

                <div className="space-y-2 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Activity / State
                  </div>
                  <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
                    {stateEvents.length ? (
                      stateEvents.map((e) => <EventRow key={`${e.seq}`} evt={e} />)
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No state or tool events yet.
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                Select a session to see details and management actions.
              </p>
            )}
          </div>
        </aside>
      </div>

      <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-muted-foreground sm:px-6">
        <p>
          Local mode. This UI connects to your database via server-side API routes.
        </p>
      </footer>
    </div>
  );
}

function CreateSessionButton({ onCreate }: { onCreate: (model?: string) => Promise<void> }) {
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
        if (!cancelled) {
          if (isRecord(json)) {
            setModels({
              defaultModel: typeof json.defaultModel === "string" ? json.defaultModel : undefined,
              modelsByProvider: Array.isArray(json.modelsByProvider) ? json.modelsByProvider : [],
            });
            setSelectedModel(typeof json.defaultModel === "string" ? json.defaultModel : undefined);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New session</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>
            Choose a model (optional). This uses your configured providers.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading models…</p>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="model">
              Model
            </label>
            <select
              id="model"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              value={selectedModel ?? ""}
              onChange={(e) => setSelectedModel(e.target.value || undefined)}
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
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  await onCreate(selectedModel || undefined);
                  setOpen(false);
                }}
              >
                Create
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
        <Button variant="secondary" size="sm" disabled={disabled}>
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Keep it short — up to 60 characters.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="title">
            Title
          </label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                await onRename(title.trim());
                setOpen(false);
              }}
              disabled={!title.trim()}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteButton({ onDelete, disabled }: { onDelete: () => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="danger" size="sm" disabled={disabled}>
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete session</DialogTitle>
          <DialogDescription>
            This cancels the orchestration and removes the session from the catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await onDelete();
              setOpen(false);
            }}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EventRow({ evt }: { evt: CmsEvent }) {
  const t = new Date(evt.createdAt).toLocaleTimeString();

  if (evt.eventType === "user.message") {
    const content = getContentFromEventData(evt.data) ?? "";
    const clean = content.replace(/^\[SYSTEM: Running on host "[^"]*"\.\]\n\n/, "");
    return (
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">You</span> · {t}
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
          {clean}
        </div>
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
                <a
                  {...props}
                  className="underline underline-offset-4 hover:opacity-80"
                  target="_blank"
                  rel="noreferrer"
                />
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
                <pre
                  {...props}
                  className="mt-2 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs"
                />
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  if (evt.eventType === "tool.execution_start") {
    const d = isRecord(evt.data) ? evt.data : {};
    const toolName = typeof d.toolName === "string" ? d.toolName : typeof d.name === "string" ? d.name : "tool";
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <div className="text-xs text-muted-foreground">Tool call · {t}</div>
        <div className="font-mono text-xs">{toolName}</div>
      </div>
    );
  }

  if (evt.eventType === "tool.execution_complete") {
    const d = isRecord(evt.data) ? evt.data : {};
    const toolName = typeof d.toolName === "string" ? d.toolName : typeof d.name === "string" ? d.name : "tool";
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <div className="text-xs text-muted-foreground">Tool result · {t}</div>
        <div className="font-mono text-xs">{toolName}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3 text-sm">
      <div className="text-xs text-muted-foreground">{evt.eventType} · {t}</div>
    </div>
  );
}

