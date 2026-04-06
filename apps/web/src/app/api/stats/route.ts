import { NextResponse } from "next/server";
import { Pool } from "pg";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

export const runtime = "nodejs";

// ── DB pool (reused across requests in the same process) ──────────────────────
//
// We use raw `pg` here instead of the pilotswarm management client because we
// need a custom aggregation query — the management client only exposes
// higher-level methods like listSessions().

let pool: Pool | undefined;
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentStat = {
  sessionId: string;
  title: string | null;
  isSystem: boolean;
  state: string;
  inputTokens: number;
  outputTokens: number;
};

export type StatsResponse = {
  agents: AgentStat[];
  totalInput: number;
  totalOutput: number;
  runningCount: number;
  cpuPercent: number | null; // null = CloudWatch not configured or no data yet
};

// ── GET /api/stats ────────────────────────────────────────────────────────────

export async function GET() {
  // ── Token stats from Neon ──────────────────────────────────────────────────
  //
  // For every non-deleted session, we sum the token counts stored in
  // `assistant.usage` events. The worker can write tokens in two formats:
  //   { usage: { inputTokens, outputTokens } }   ← GitHub Copilot SDK style
  //   { usage: { input_tokens, output_tokens } }  ← OpenAI/Anthropic style
  //
  // We handle both using COALESCE in SQL so neither format is missed.

  const db = getPool();
  const { rows } = await db.query<{
    session_id: string;
    title: string | null;
    is_system: boolean;
    state: string;
    input_tokens: string;
    output_tokens: string;
  }>(`
    SELECT
      s.session_id,
      s.title,
      s.is_system,
      s.state,
      COALESCE(SUM(
        COALESCE((e.data->'usage'->>'inputTokens')::bigint, 0) +
        COALESCE((e.data->'usage'->>'input_tokens')::bigint, 0) +
        COALESCE((e.data->>'inputTokens')::bigint, 0) +
        COALESCE((e.data->>'input_tokens')::bigint, 0) +
        COALESCE((e.data->>'prompt_tokens')::bigint, 0)
      ), 0) AS input_tokens,
      COALESCE(SUM(
        COALESCE((e.data->'usage'->>'outputTokens')::bigint, 0) +
        COALESCE((e.data->'usage'->>'output_tokens')::bigint, 0) +
        COALESCE((e.data->>'outputTokens')::bigint, 0) +
        COALESCE((e.data->>'output_tokens')::bigint, 0) +
        COALESCE((e.data->>'completion_tokens')::bigint, 0)
      ), 0) AS output_tokens
    FROM copilot_sessions.sessions s
    LEFT JOIN copilot_sessions.session_events e
      ON s.session_id = e.session_id
      AND e.event_type = 'assistant.usage'
    WHERE s.deleted_at IS NULL
    GROUP BY s.session_id, s.title, s.is_system, s.state
    ORDER BY (
      COALESCE((e.data->'usage'->>'inputTokens')::bigint, 0)
    ) DESC
  `);

  // Re-sort in JS after aggregation (ORDER BY on aggregated alias isn't valid)
  const agents: AgentStat[] = rows
    .map(r => ({
      sessionId: r.session_id,
      title: r.title,
      isSystem: r.is_system,
      state: r.state,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

  const totalInput = agents.reduce((s, a) => s + a.inputTokens, 0);
  const totalOutput = agents.reduce((s, a) => s + a.outputTokens, 0);
  const runningCount = agents.filter(a => a.state === "running").length;

  // ── CPU from CloudWatch ────────────────────────────────────────────────────
  //
  // CloudWatch stores ECS task CPU metrics in the AWS/ECS namespace.
  // We ask for the last 3 minutes at 1-minute granularity and take the most
  // recent datapoint. CloudWatch metrics are typically 1–2 minutes delayed.
  //
  // This requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION
  // to be set in the environment (Vercel env vars or local .env).
  // If they're missing or the call fails, cpuPercent is returned as null
  // and the UI shows "n/a" — it never breaks the rest of the stats.

  let cpuPercent: number | null = null;
  const awsKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecret = process.env.AWS_SECRET_ACCESS_KEY;

  if (awsKeyId && awsSecret) {
    try {
      const cw = new CloudWatchClient({
        region: process.env.AWS_REGION ?? "us-east-1",
        credentials: { accessKeyId: awsKeyId, secretAccessKey: awsSecret },
      });

      const now = new Date();
      const start = new Date(now.getTime() - 3 * 60 * 1000);

      const result = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/ECS",
          MetricName: "CPUUtilization",
          Dimensions: [
            { Name: "ClusterName", Value: "pilotswarm" },
            { Name: "ServiceName", Value: "pilotswarm-worker" },
          ],
          StartTime: start,
          EndTime: now,
          Period: 60,
          Statistics: ["Average"],
        }),
      );

      if (result.Datapoints && result.Datapoints.length > 0) {
        // Sort descending by timestamp, take the freshest datapoint
        const sorted = [...result.Datapoints].sort(
          (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
        );
        cpuPercent = sorted[0]?.Average ?? null;
      }
    } catch {
      // CloudWatch unavailable, wrong creds, or no data — silently skip
    }
  }

  return NextResponse.json<StatsResponse>({
    agents,
    totalInput,
    totalOutput,
    runningCount,
    cpuPercent,
  });
}
