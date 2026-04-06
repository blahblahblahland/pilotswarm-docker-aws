"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

// ─── Types ────────────────────────────────────────────────────────────────────

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

type TokenCount = { input: number; output: number };

type RightTab = "activity" | "logs" | "files" | "details" | "stats";

type AgentStat = {
  sessionId: string;
  title: string | null;
  isSystem: boolean;
  state: string;
  inputTokens: number;
  outputTokens: number;
};

type StatsData = {
  agents: AgentStat[];
  totalInput: number;
  totalOutput: number;
  runningCount: number;
  cpuPercent: number | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusDot(status: string) {
  switch (status) {
    case "running": return "text-blue-400";
    case "waiting": case "input_required": return "text-yellow-400";
    case "completed": return "text-green-400";
    case "failed": case "error": return "text-red-400";
    default: return "text-zinc-600";
  }
}

function shortId(id: string) {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getContent(data: unknown): string | null {
  if (!isRecord(data)) return null;
  return typeof data.content === "string" ? data.content : null;
}

function extractTokens(events: CmsEvent[]): TokenCount {
  let input = 0, output = 0;
  for (const e of events) {
    if (!isRecord(e.data)) continue;
    const u = e.data.usage;
    if (!isRecord(u)) continue;
    if (typeof u.inputTokens === "number") input += u.inputTokens;
    if (typeof u.outputTokens === "number") output += u.outputTokens;
    if (typeof u.input_tokens === "number") input += u.input_tokens;
    if (typeof u.output_tokens === "number") output += u.output_tokens;
  }
  return { input, output };
}

function todayEvents(events: CmsEvent[]): CmsEvent[] {
  const today = new Date().toDateString();
  return events.filter(e => new Date(e.createdAt).toDateString() === today);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ─── Box Panel (TUI-style bordered box with label) ────────────────────────────

function BoxPanel({
  label,
  children,
  className,
  headerRight,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col overflow-hidden border border-zinc-800 rounded-sm", className)}>
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
        <span className="font-mono text-xs font-semibold tracking-wide text-zinc-400">{label}</span>
        {headerRight}
      </div>
      {children}
    </div>
  );
}

// ─── Panel Divider (resizable handle) ─────────────────────────────────────────

function PanelDivider({ onResize }: { onResize: (delta: number) => void }) {
  const dragging = React.useRef(false);
  const lastX = React.useRef(0);

  const onMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      lastX.current = e.clientX;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        onResize(delta);
      };
      const onUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onResize],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 flex-shrink-0 cursor-col-resize bg-zinc-800 hover:bg-zinc-600 active:bg-zinc-500 transition-colors"
    />
  );
}

// ─── Slash Command Menu ────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { command: "/new", description: "New session" },
  { command: "/model", description: "Switch model" },
  { command: "/info", description: "Show session details" },
  { command: "/done", description: "Cancel session" },
  { command: "/spawn", description: "Spawn child agent" },
  { command: "/help", description: "Show all commands" },
];

function SlashCommandMenu({ onSelect, onDismiss }: { onSelect: (cmd: string) => void; onDismiss: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded border border-zinc-700 bg-zinc-900 shadow-lg">
      {SLASH_COMMANDS.map(c => (
        <button
          key={c.command}
          type="button"
          onMouseDown={e => { e.preventDefault(); onSelect(c.command); }}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-zinc-800"
        >
          <span className="font-mono text-cyan-400">{c.command}</span>
          <span className="text-zinc-500">{c.description}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Agent Picker Modal ────────────────────────────────────────────────────────

function AgentPicker({
  availableModels,
  defaultModel,
  onStart,
  onCancel,
}: {
  availableModels: string[];
  defaultModel: string;
  onStart: (model: string) => void;
  onCancel: () => void;
}) {
  const [model, setModel] = React.useState(defaultModel);

  React.useEffect(() => setModel(defaultModel), [defaultModel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <h2 className="mb-1 text-base font-semibold text-zinc-100">New Session</h2>
        <p className="mb-5 text-xs text-zinc-500">Choose a model to get started.</p>

        <div className="mb-5">
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">Model</label>
          <select
            className="h-8 w-full rounded border border-zinc-700 bg-zinc-800 px-2 font-mono text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            <option value="">(default)</option>
            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onStart(model)}
            className="rounded border border-zinc-600 bg-zinc-700 px-4 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600"
          >
            Start Session
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inspector Tab Content ─────────────────────────────────────────────────────

function LogsTab({ events }: { events: CmsEvent[] }) {
  // Pre-compute tool durations: map tool name → start timestamp for the most
  // recent unmatched execution_start. When we see execution_complete we look
  // up the start time and render the elapsed ms.
  const toolStartTimes = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of events) {
      if (e.eventType === "tool.execution_start") {
        const d = isRecord(e.data) ? e.data : {};
        const name = typeof d.toolName === "string" ? d.toolName : typeof d.name === "string" ? d.name : "tool";
        map[name] = new Date(e.createdAt).getTime();
      }
    }
    return map;
  }, [events]);

  // Filter out internal accounting noise — token counts are already in Stats tab
  const visible = React.useMemo(
    () => events.filter(e => e.eventType !== "assistant.usage"),
    [events],
  );

  if (!visible.length) {
    return <div className="p-3 text-xs text-zinc-600">No events yet.</div>;
  }

  return (
    <div className="space-y-0.5 p-2 font-mono text-[10px]">
      {visible.map(e => {
        const t = new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const d = isRecord(e.data) ? e.data : {};
        const toolName = typeof d.toolName === "string" ? d.toolName : typeof d.name === "string" ? d.name : null;
        const snippet = typeof d.content === "string" ? d.content.slice(0, 60) : (toolName ?? "");

        // Duration: only on execution_complete, only if we have a start time
        let duration: string | null = null;
        if (e.eventType === "tool.execution_complete" && toolName && toolStartTimes[toolName]) {
          const ms = new Date(e.createdAt).getTime() - toolStartTimes[toolName]!;
          duration = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        }

        const isToolComplete = e.eventType === "tool.execution_complete";
        const isToolStart = e.eventType === "tool.execution_start";

        return (
          <div key={e.seq} className="flex gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/40">
            <span className="shrink-0 text-zinc-700">{t}</span>
            <span className={cn(
              "shrink-0",
              isToolComplete ? "text-green-700" : isToolStart ? "text-yellow-700" : "text-zinc-500",
            )}>
              {e.eventType}
            </span>
            {snippet && <span className="truncate text-zinc-400">{snippet}</span>}
            {duration && <span className="ml-auto shrink-0 text-zinc-500">{duration}</span>}
          </div>
        );
      })}
    </div>
  );
}


function FilesTab({ sessionId, events }: { sessionId: string; events: CmsEvent[] }) {
  const artifactEvents = events.filter(e =>
    e.eventType === "artifact.written" ||
    e.eventType === "artifact.exported" ||
    (isRecord(e.data) && typeof (e.data as Record<string, unknown>).artifactId === "string")
  );

  return (
    <div className="p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2">Files</div>
      {artifactEvents.length ? (
        artifactEvents.map(e => {
          const d = isRecord(e.data) ? e.data : {};
          const name = typeof d.name === "string" ? d.name : typeof d.artifactId === "string" ? d.artifactId : "artifact";
          return (
            <div key={e.seq} className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs">
              <div className="font-mono text-zinc-300 truncate">{name}</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">{e.eventType}</div>
            </div>
          );
        })
      ) : (
        <div className="text-xs text-zinc-600">No files yet.</div>
      )}
      {sessionId && (
        <a
          href={`/api/sessions/${sessionId}/dump`}
          className="block mt-3 text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
        >
          ↓ Download full transcript
        </a>
      )}
    </div>
  );
}

// ─── Stats Tab ────────────────────────────────────────────────────────────────
//
// Displays a live breakdown of token usage per agent plus overall CPU usage.
// Data comes from /api/stats which aggregates assistant.usage events from the
// DB and fetches ECS CPU from CloudWatch. Refreshed every 5 seconds.

function StatsTab({ stats }: { stats: StatsData | null }) {
  if (!stats) {
    return <div className="p-3 text-xs text-zinc-600">Loading stats…</div>;
  }

  const activeAgents = stats.agents.filter(a => a.inputTokens + a.outputTokens > 0);

  return (
    <div className="space-y-4 p-3 font-mono text-xs">

      {/* ── Overall numbers ── */}
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-600">Overall</div>
        <div className="space-y-1">
          <div className="flex justify-between text-zinc-400">
            <span>tokens in</span>
            <span className="text-zinc-300">{fmtTokens(stats.totalInput)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>tokens out</span>
            <span className="text-zinc-300">{fmtTokens(stats.totalOutput)}</span>
          </div>
          <div className="flex justify-between border-t border-zinc-800 pt-1 text-zinc-400">
            <span>total</span>
            <span className="font-semibold text-zinc-100">{fmtTokens(stats.totalInput + stats.totalOutput)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>agents running</span>
            <span className={stats.runningCount > 0 ? "text-blue-400" : "text-zinc-400"}>
              {stats.runningCount}
            </span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>worker cpu</span>
            <span className="text-zinc-300">
              {stats.cpuPercent !== null ? `${stats.cpuPercent.toFixed(1)}%` : "n/a"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Per-agent breakdown ── */}
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-600">Per Agent</div>
        {activeAgents.length === 0 ? (
          <div className="text-[10px] text-zinc-600">No token usage recorded yet.</div>
        ) : (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-zinc-600">
                <th className="pb-1 text-left font-normal">agent</th>
                <th className="pb-1 text-right font-normal">in</th>
                <th className="pb-1 text-right font-normal">out</th>
              </tr>
            </thead>
            <tbody>
              {activeAgents.map(a => (
                <tr key={a.sessionId} className="border-t border-zinc-800/50">
                  <td className="max-w-[120px] truncate py-0.5 pr-2">
                    <span className={a.state === "running" ? "text-blue-400" : "text-zinc-400"}>
                      {a.title ?? a.sessionId.slice(0, 8)}
                      {a.isSystem ? " ◆" : ""}
                    </span>
                  </td>
                  <td className="py-0.5 text-right text-zinc-300">{fmtTokens(a.inputTokens)}</td>
                  <td className="py-0.5 text-right text-zinc-300">{fmtTokens(a.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

// ─── Main Shell ───────────────────────────────────────────────────────────────

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
  const [systemCollapsed, setSystemCollapsed] = React.useState(true);

  // Global model selector
  const [globalModel, setGlobalModel] = React.useState<string>("");
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);

  // Daily token tracking: sessionId → TokenCount
  const dailyTokensRef = React.useRef<Map<string, TokenCount>>(new Map());
  const [dailyTotal, setDailyTotal] = React.useState<TokenCount>({ input: 0, output: 0 });

  // Panel widths (resizable)
  const [sidebarWidth, setSidebarWidth] = React.useState(260);
  const [inspectorWidth, setInspectorWidth] = React.useState(300);

  // Right panel tab
  const [rightTab, setRightTab] = React.useState<RightTab>("activity");

  // Agent picker + slash commands
  const [showAgentPicker, setShowAgentPicker] = React.useState(false);
  const [showSlash, setShowSlash] = React.useState(false);

  // Live stats (tokens per agent + CPU) — polled every 5 seconds
  const [stats, setStats] = React.useState<StatsData | null>(null);

  const chatBottomRef = React.useRef<HTMLDivElement | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────

  const selected = React.useMemo(
    () => sessions.find(s => s.sessionId === selectedId) ?? null,
    [sessions, selectedId],
  );

  const chatEvents = React.useMemo(
    () => events.filter(e => e.eventType === "user.message" || e.eventType === "assistant.message"),
    [events],
  );

  const activityEvents = React.useMemo(
    () => events.filter(e => e.eventType !== "user.message" && e.eventType !== "assistant.message"),
    [events],
  );

  const userSessions = React.useMemo(() => sessions.filter(s => !s.isSystem), [sessions]);
  const systemSessions = React.useMemo(() => sessions.filter(s => s.isSystem), [sessions]);

  const userRootSessions = React.useMemo(() => {
    const userIds = new Set(userSessions.map(s => s.sessionId));
    return userSessions.filter(s => !s.parentSessionId || !userIds.has(s.parentSessionId));
  }, [userSessions]);

  const filteredUserRoots = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return userRootSessions;
    return userRootSessions.filter(s =>
      `${s.title ?? ""} ${s.sessionId}`.toLowerCase().includes(q),
    );
  }, [userRootSessions, filter]);

  // ── Effects ──────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (selectedId || filteredUserRoots.length === 0) return;
    router.replace(`/sessions?sid=${encodeURIComponent(filteredUserRoots[0]!.sessionId)}`);
  }, [filteredUserRoots, selectedId, router]);

  React.useEffect(() => {
    fetch("/api/models", { cache: "no-store" })
      .then(r => r.json())
      .then((json: unknown) => {
        if (!isRecord(json)) return;
        const list: string[] = [];
        if (Array.isArray(json.modelsByProvider)) {
          for (const g of json.modelsByProvider) {
            if (isRecord(g) && Array.isArray(g.models)) {
              for (const m of g.models) {
                if (isRecord(m) && typeof m.qualifiedName === "string") list.push(m.qualifiedName);
              }
            }
          }
        }
        setAvailableModels(list);
        if (typeof json.defaultModel === "string") setGlobalModel(json.defaultModel);
      })
      .catch(() => {});
  }, []);

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
        const evts = await loadEvents(selectedId);
        if (cancelled) return;
        setEvents(evts);
        lastSeqRef.current = evts.length ? evts[evts.length - 1]!.seq : 0;
        const t = extractTokens(todayEvents(evts));
        dailyTokensRef.current.set(selectedId, t);
        recomputeDailyTotal();
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load events");
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  React.useEffect(() => {
    if (!selectedId) return;
    const url = new URL(`/api/sessions/${selectedId}/stream`, window.location.origin);
    if (lastSeqRef.current) url.searchParams.set("afterSeq", String(lastSeqRef.current));
    const es = new EventSource(url.toString());

    es.addEventListener("init", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data)) {
          const s = data.status;
          if (isRecord(s) && isRecord(s.customStatus) && typeof s.customStatus.status === "string")
            setLiveStatus(s.customStatus.status);
          if (typeof data.lastSeq === "number") lastSeqRef.current = data.lastSeq;
        }
      } catch {}
    });

    es.addEventListener("status", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data) && isRecord(data.customStatus) && typeof data.customStatus.status === "string")
          setLiveStatus(data.customStatus.status);
      } catch {}
    });

    es.addEventListener("events", (evt) => {
      try {
        const data: unknown = JSON.parse((evt as MessageEvent).data);
        if (isRecord(data) && Array.isArray(data.events)) {
          const evts = data.events as CmsEvent[];
          if (evts.length > 0) {
            setEvents(prev => {
              const next = [...prev, ...evts];
              const t = extractTokens(todayEvents(next));
              dailyTokensRef.current.set(selectedId, t);
              recomputeDailyTotal();
              return next;
            });
            lastSeqRef.current = evts[evts.length - 1]!.seq;
          }
        }
      } catch {}
    });

    es.addEventListener("error", () => {});
    return () => es.close();
  }, [selectedId]);

  React.useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatEvents.length]);

  // Poll /api/stats every 5 seconds to keep token + CPU numbers fresh.
  // The endpoint is lightweight — it runs one DB aggregation query and one
  // CloudWatch call. 5 seconds gives a "live" feel without hammering Neon.
  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as StatsData;
        if (!cancelled) setStats(data);
      } catch {}
    };
    void poll();
    const id = setInterval(() => void poll(), 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function recomputeDailyTotal() {
    let input = 0, output = 0;
    for (const t of dailyTokensRef.current.values()) {
      input += t.input; output += t.output;
    }
    setDailyTotal({ input, output });
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
    url.searchParams.set("limit", "50");
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`events_http_${res.status}`);
    const json = (await res.json()) as { events: CmsEvent[] };
    return json.events ?? [];
  }

  async function createSession(model?: string) {
    setError(null);
    const m = model ?? globalModel;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(m ? { model: m } : {}),
    });
    if (!res.ok) throw new Error(`create_http_${res.status}`);
    const json = (await res.json()) as { sessionId: string };
    await refreshSessions();
    router.push(`/sessions?sid=${encodeURIComponent(json.sessionId)}`);
  }

  async function spawnAgent(task: string, model?: string) {
    setError(null);
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentSessionId: selectedId,
        ...(model ? { model } : globalModel ? { model: globalModel } : {}),
      }),
    });
    if (!res.ok) throw new Error(`spawn_http_${res.status}`);
    const json = (await res.json()) as { sessionId: string };
    await fetch(`/api/sessions/${json.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: task }),
    });
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
    if (!selectedId || !message.trim()) return;
    const trimmed = message.trim();

    // Handle slash commands
    if (trimmed === "/new") { setMessage(""); void createSession(); return; }
    if (trimmed === "/done") { setMessage(""); void cancelSession(selectedId); return; }
    if (trimmed === "/info") { setMessage(""); setRightTab("details"); return; }
    if (trimmed === "/spawn") { setMessage(""); return; } // opens spawn dialog — handled via button
    if (trimmed.startsWith("/model ")) {
      const m = trimmed.slice(7).trim();
      if (m) setGlobalModel(m);
      setMessage("");
      return;
    }
    if (trimmed === "/help") {
      setMessage(SLASH_COMMANDS.map(c => `${c.command} — ${c.description}`).join("\n"));
      return;
    }

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
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const currentStatus = liveStatus ?? selected?.status ?? "";

  const RIGHT_TABS: { key: RightTab; label: string }[] = [
    { key: "activity", label: "Activity" },
    { key: "logs", label: "Logs" },
    { key: "files", label: "Files" },
    { key: "details", label: "Details" },
    { key: "stats", label: "Stats" },
  ];

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">

      {/* ── Header ── */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-bold tracking-tight text-zinc-100">PilotSwarm</span>
          <span className="hidden text-xs text-zinc-600 sm:block">Durable AI Orchestration</span>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500" htmlFor="global-model">Model</label>
          <select
            id="global-model"
            className="h-7 rounded border border-zinc-700 bg-zinc-800 px-2 font-mono text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            value={globalModel}
            onChange={e => setGlobalModel(e.target.value)}
          >
            <option value="">(default)</option>
            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-xs">
          <span className="text-zinc-500">tokens today</span>
          <span className="text-zinc-300">
            ↑{fmtTokens(dailyTotal.input)} ↓{fmtTokens(dailyTotal.output)}
          </span>
          {dailyTotal.input + dailyTotal.output > 0 && (
            <span className="text-zinc-500">= {fmtTokens(dailyTotal.input + dailyTotal.output)}</span>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* ── Left: Sessions sidebar ── */}
        <aside
          style={{ width: sidebarWidth, minWidth: 180 }}
          className="flex flex-shrink-0 flex-col overflow-hidden border-r border-zinc-800"
        >
          <div className="shrink-0 border-b border-zinc-800 px-3 py-2">
            <input
              placeholder="Search sessions…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            />
          </div>

          <div className="flex-1 overflow-auto py-1 font-mono text-xs">
            {loading ? (
              <div className="px-4 py-3 text-zinc-600">Loading…</div>
            ) : (
              <>
                <SectionHeader label="My Chats" count={filteredUserRoots.length} collapsed={false} onToggle={() => {}} alwaysOpen />
                {filteredUserRoots.length === 0 ? (
                  <div className="px-4 py-2 text-zinc-600">No chats yet.</div>
                ) : (
                  filteredUserRoots.map(s => (
                    <SessionTreeNode
                      key={s.sessionId}
                      session={s}
                      depth={0}
                      allSessions={userSessions}
                      selectedId={selectedId}
                      onSelect={id => router.push(`/sessions?sid=${encodeURIComponent(id)}`)}
                      onDelete={deleteSession}
                    />
                  ))
                )}
                <div className="mt-2">
                  <SectionHeader
                    label="System"
                    count={systemSessions.length}
                    collapsed={systemCollapsed}
                    onToggle={() => setSystemCollapsed(v => !v)}
                  />
                  {!systemCollapsed && systemSessions.map(s => (
                    <SessionTreeNode
                      key={s.sessionId}
                      session={s}
                      depth={0}
                      allSessions={systemSessions}
                      selectedId={selectedId}
                      onSelect={id => router.push(`/sessions?sid=${encodeURIComponent(id)}`)}
                      onDelete={deleteSession}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-800 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setShowAgentPicker(true)}
              className="w-full rounded border border-zinc-700 bg-zinc-800/60 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-100"
            >
              + New Chat
            </button>
          </div>
        </aside>

        <PanelDivider onResize={delta => setSidebarWidth(w => Math.max(180, w + delta))} />

        {/* ── Center: Chat ── */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-zinc-800">
          <BoxPanel
            label={selectedId ? `Chat [${shortId(selectedId)}]` : "Chat"}
            className="flex-1 overflow-hidden border-0 border-b border-zinc-800 rounded-none"
            headerRight={
              selectedId ? (
                <div className="flex items-center gap-1.5">
                  <span className={cn("text-[10px]", statusDot(currentStatus))}>●</span>
                  <span className="text-[10px] text-zinc-400">{currentStatus || "idle"}</span>
                  <span className="mx-1 text-zinc-700">|</span>
                  <SpawnAgentButton
                    parentSessionId={selectedId}
                    onSpawn={spawnAgent}
                    availableModels={availableModels}
                    defaultModel={globalModel}
                  />
                  <RenameButton
                    disabled={!!selected?.isSystem}
                    initialTitle={selected?.title ?? ""}
                    onRename={t => renameSession(selectedId, t)}
                  />
                  <button
                    type="button"
                    onClick={() => void cancelSession(selectedId)}
                    disabled={!!selected?.isSystem}
                    className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                  >
                    cancel
                  </button>
                  <DeleteButton
                    disabled={!!selected?.isSystem}
                    onDelete={() => deleteSession(selectedId)}
                  />
                </div>
              ) : undefined
            }
          >
            <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
              {error && (
                <div className="rounded border border-red-900/50 bg-red-900/20 px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}
              {selectedId ? (
                chatEvents.length ? (
                  chatEvents.map(e => <ChatRow key={`${e.seq}`} evt={e} />)
                ) : (
                  <div className="text-xs text-zinc-600">No messages yet. Send one below.</div>
                )
              ) : (
                <div className="text-xs text-zinc-600">Select a chat or create a new one.</div>
              )}
              <div ref={chatBottomRef} />
            </div>
          </BoxPanel>

          {/* Input */}
          <div className="relative shrink-0 border-t border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            {showSlash && (
              <SlashCommandMenu
                onSelect={cmd => { setMessage(cmd + " "); setShowSlash(false); }}
                onDismiss={() => setShowSlash(false)}
              />
            )}
            <form
              className="flex gap-2"
              onSubmit={e => { e.preventDefault(); setShowSlash(false); void sendMessage(); }}
            >
              <textarea
                rows={1}
                placeholder={selectedId ? "Message PilotSwarm… (type / for commands)" : "Select a chat to send messages"}
                value={message}
                onChange={e => {
                  const v = e.target.value;
                  setMessage(v);
                  setShowSlash(v === "/");
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    setShowSlash(false);
                    void sendMessage();
                  }
                  if (e.key === "Escape") setShowSlash(false);
                }}
                disabled={!selectedId || sending}
                className="flex-1 resize-none rounded border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={!selectedId || sending || !message.trim()}
                className="rounded border border-zinc-600 bg-zinc-700 px-4 py-1.5 font-mono text-xs text-zinc-200 transition-colors hover:bg-zinc-600 disabled:opacity-30"
              >
                {sending ? "…" : "Send"}
              </button>
            </form>
          </div>
        </main>

        <PanelDivider onResize={delta => setInspectorWidth(w => Math.max(220, w - delta))} />

        {/* ── Right: Tabbed Inspector ── */}
        <div
          style={{ width: inspectorWidth, minWidth: 220 }}
          className="flex flex-shrink-0 flex-col overflow-hidden"
        >
          {/* Tab bar */}
          <div className="flex shrink-0 overflow-x-auto border-b border-zinc-800 bg-zinc-900/60 scrollbar-none" style={{scrollbarWidth:"none"}}>
            {RIGHT_TABS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setRightTab(t.key)}
                className={cn(
                  "px-2.5 py-2 text-[10px] font-mono transition-colors",
                  rightTab === t.key
                    ? "border-b border-zinc-300 text-zinc-200"
                    : "text-zinc-600 hover:text-zinc-400",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            {rightTab === "activity" && (
              activityEvents.length ? (
                <div className="space-y-1 p-2">
                  {activityEvents.map(e => <ActivityRow key={`${e.seq}`} evt={e} />)}
                </div>
              ) : (
                <div className="p-3 text-xs text-zinc-600">No activity yet.</div>
              )
            )}
            {rightTab === "logs" && <LogsTab events={events} />}
            {rightTab === "files" && <FilesTab sessionId={selectedId} events={events} />}
            {rightTab === "stats" && <StatsTab stats={stats} />}
            {rightTab === "details" && (
              <div className="p-3">
                {selected ? (
                  <dl className="space-y-1.5 font-mono text-xs">
                    <DetailRow label="id" value={shortId(selected.sessionId)} mono />
                    <DetailRow label="model" value={selected.model ?? (globalModel || "default")} />
                    <DetailRow
                      label="status"
                      value={
                        <span className={statusDot(liveStatus ?? selected.status)}>
                          {liveStatus ?? selected.status}
                        </span>
                      }
                    />
                    <DetailRow label="turns" value={String(selected.iterations ?? 0)} />
                    {selected.parentSessionId && (
                      <DetailRow
                        label="parent"
                        value={
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-zinc-200"
                            onClick={() => router.push(`/sessions?sid=${encodeURIComponent(selected.parentSessionId!)}`)}
                          >
                            {shortId(selected.parentSessionId)}
                          </button>
                        }
                      />
                    )}
                    {selected.waitReason && (
                      <div className="mt-2 rounded border border-zinc-700 bg-zinc-800/40 p-2">
                        <div className="mb-1 text-[10px] text-zinc-500">wait reason</div>
                        <div className="text-zinc-300">{selected.waitReason}</div>
                      </div>
                    )}
                    {selected.error && (
                      <div className="mt-2 rounded border border-red-900/50 bg-red-900/20 p-2">
                        <div className="mb-1 text-[10px] text-red-500">error</div>
                        <div className="text-red-400">{selected.error}</div>
                      </div>
                    )}
                  </dl>
                ) : (
                  <div className="text-xs text-zinc-600">Select a chat to see details.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Agent picker overlay */}
      {showAgentPicker && (
        <AgentPicker
          availableModels={availableModels}
          defaultModel={globalModel}
          onStart={model => { setShowAgentPicker(false); void createSession(model); }}
          onCancel={() => setShowAgentPicker(false)}
        />
      )}
    </div>
  );
}

// ─── Session Tree ──────────────────────────────────────────────────────────────

function SectionHeader({
  label, count, collapsed, onToggle, alwaysOpen,
}: {
  label: string; count: number; collapsed: boolean; onToggle: () => void; alwaysOpen?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={alwaysOpen ? undefined : onToggle}
      className={cn(
        "flex w-full items-center gap-1.5 px-3 py-1 text-left text-[10px] font-semibold uppercase tracking-widest",
        alwaysOpen ? "cursor-default text-zinc-500" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {!alwaysOpen && <span>{collapsed ? "▸" : "▾"}</span>}
      {label}
      <span className="text-zinc-700">({count})</span>
    </button>
  );
}

function SessionTreeNode({
  session, depth, allSessions, selectedId, onSelect, onDelete,
}: {
  session: SessionView; depth: number; allSessions: SessionView[];
  selectedId: string; onSelect: (id: string) => void; onDelete: (id: string) => Promise<void>;
}) {
  const children = allSessions.filter(s => s.parentSessionId === session.sessionId);
  const [expanded, setExpanded] = React.useState(true);
  const active = session.sessionId === selectedId;

  return (
    <>
      <div
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={cn(
          "group flex items-center gap-1 py-0.5 pr-1 transition-colors",
          active ? "bg-zinc-800/80" : "hover:bg-zinc-800/40",
        )}
      >
        <span className="w-3 shrink-0 text-center text-zinc-600">
          {children.length > 0 ? (
            <button type="button" onClick={() => setExpanded(v => !v)} className="hover:text-zinc-400">
              {expanded ? "▾" : "▸"}
            </button>
          ) : depth > 0 ? "└" : null}
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
          onClick={() => onSelect(session.sessionId)}
        >
          <span className={cn("shrink-0 text-[8px]", statusDot(session.status))}>●</span>
          <span className={cn("truncate", active ? "text-zinc-100" : "text-zinc-400 group-hover:text-zinc-200")}>
            {session.title || shortId(session.sessionId)}
          </span>
        </button>
        {!session.isSystem && (
          <button
            type="button"
            aria-label="Delete"
            onClick={() => void onDelete(session.sessionId)}
            className="shrink-0 rounded px-1 py-0.5 text-[10px] text-zinc-700 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
          >
            ✕
          </button>
        )}
      </div>
      {expanded && children.map(child => (
        <SessionTreeNode
          key={child.sessionId}
          session={child}
          depth={depth + 1}
          allSessions={allSessions}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// ─── Detail row ────────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-14 shrink-0 text-zinc-600">{label}</dt>
      <dd className={cn("min-w-0 break-all text-zinc-300", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

// ─── Chat rows ─────────────────────────────────────────────────────────────────

function ChatRow({ evt }: { evt: CmsEvent }) {
  const t = new Date(evt.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (evt.eventType === "user.message") {
    const raw = getContent(evt.data) ?? "";
    const content = raw.replace(/^\[SYSTEM: Running on host "[^"]*"\.\]\n\n/, "");
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[10px] text-zinc-500">
          <span className="font-semibold text-zinc-300">You</span> · {t}
        </div>
        <div className="rounded border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 text-sm text-zinc-200">
          {content}
        </div>
      </div>
    );
  }

  if (evt.eventType === "assistant.message") {
    const content = getContent(evt.data) ?? "";
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[10px] text-zinc-500">
          <span className="font-semibold text-blue-400">Assistant</span> · {t}
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: p => <a {...p} className="text-blue-400 underline underline-offset-2 hover:text-blue-300" target="_blank" rel="noreferrer" />,
              code: p => {
                const block = typeof p.className === "string" && p.className.includes("language-");
                return <code {...p} className={cn(block ? "font-mono text-xs" : "rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-zinc-300", p.className)} />;
              },
              pre: p => <pre {...p} className="mt-2 overflow-auto rounded border border-zinc-700 bg-zinc-800/60 p-3 font-mono text-xs" />,
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

// ─── Activity row ──────────────────────────────────────────────────────────────

function ActivityRow({ evt }: { evt: CmsEvent }) {
  const t = new Date(evt.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const d = isRecord(evt.data) ? evt.data : {};

  if (evt.eventType === "tool.execution_start" || evt.eventType === "tool.execution_complete") {
    const name = typeof d.toolName === "string" ? d.toolName : typeof d.name === "string" ? d.name : "tool";
    const done = evt.eventType === "tool.execution_complete";
    return (
      <div className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1">
        <span className="font-mono text-[11px] text-zinc-300">{name}</span>
        <span className={cn("text-[10px]", done ? "text-green-600" : "text-yellow-600")}>{done ? "✓" : "…"}</span>
        <span className="text-[10px] text-zinc-600">{t}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded border border-zinc-800/60 bg-zinc-900/20 px-2 py-1">
      <span className="font-mono text-[11px] text-zinc-500">{evt.eventType}</span>
      <span className="text-[10px] text-zinc-700">{t}</span>
    </div>
  );
}

// ─── Dialogs ───────────────────────────────────────────────────────────────────

function SpawnAgentButton({
  parentSessionId, onSpawn, availableModels, defaultModel,
}: {
  parentSessionId: string; onSpawn: (task: string, model?: string) => Promise<void>;
  availableModels: string[]; defaultModel: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [task, setTask] = React.useState("");
  const [model, setModel] = React.useState(defaultModel);
  const [spawning, setSpawning] = React.useState(false);

  React.useEffect(() => { if (open) setModel(defaultModel); }, [open, defaultModel]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200">
          spawn
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Spawn child agent</DialogTitle>
          <DialogDescription>
            Creates a new agent under <span className="font-mono text-xs">{shortId(parentSessionId)}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400" htmlFor="spawn-task">Task</label>
            <textarea
              id="spawn-task"
              rows={4}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-500"
              placeholder="Describe what this agent should do…"
              value={task}
              onChange={e => setTask(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400" htmlFor="spawn-model">Model</label>
            <select
              id="spawn-model"
              className="h-9 w-full rounded border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-200 focus:outline-none"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              <option value="">(default)</option>
              {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!task.trim() || spawning}
            onClick={async () => {
              setSpawning(true);
              try { await onSpawn(task.trim(), model || undefined); setOpen(false); setTask(""); }
              finally { setSpawning(false); }
            }}
          >
            {spawning ? "Spawning…" : "Spawn"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RenameButton({ initialTitle, onRename, disabled }: { initialTitle: string; onRename: (t: string) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(initialTitle);
  React.useEffect(() => setTitle(initialTitle), [initialTitle]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" disabled={disabled} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30">
          rename
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Rename session</DialogTitle></DialogHeader>
        <Input value={title} onChange={e => setTitle(e.target.value)} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!title.trim()} onClick={async () => { await onRename(title.trim()); setOpen(false); }}>Save</Button>
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
        <button type="button" disabled={disabled} className="rounded px-1.5 py-0.5 text-[10px] text-red-500/70 transition-colors hover:bg-red-900/20 hover:text-red-400 disabled:opacity-30">
          delete
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete session</DialogTitle>
          <DialogDescription>This cancels the session and removes it permanently.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { await onDelete(); setOpen(false); }}>Delete</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
