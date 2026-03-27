import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerAgentTools(server: McpServer, ctx: ServerContext) {
    // 1. spawn_agent — Spawn a sub-agent within a session
    server.registerTool(
        "spawn_agent",
        {
            description: "Spawn a sub-agent within a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to spawn the agent in"),
                task: z.string().describe("The task description for the new agent"),
                agent_name: z.string().optional().describe("Optional name for the agent"),
                model: z.string().optional().describe("Optional model override"),
            },
        },
        async ({ session_id, task, agent_name, model }) => {
            try {
                await ctx.mgmt.sendCommand(session_id, {
                    cmd: "spawn_agent",
                    id: `spawn-${Date.now()}`,
                    args: {
                        task,
                        ...(agent_name !== undefined && { agentName: agent_name }),
                        ...(model !== undefined && { model }),
                    },
                });
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ sent: true, command: "spawn_agent" }) },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // 2. message_agent — Send a message to a running sub-agent
    server.registerTool(
        "message_agent",
        {
            description: "Send a message to a running sub-agent in a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session the agent belongs to"),
                agent_id: z.string().describe("The ID of the agent to message"),
                message: z.string().describe("The message to send to the agent"),
            },
        },
        async ({ session_id, agent_id, message }) => {
            try {
                await ctx.mgmt.sendCommand(session_id, {
                    cmd: "message_agent",
                    id: `msg-${Date.now()}`,
                    args: { agentId: agent_id, message },
                });
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ sent: true }) },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 3. cancel_agent — Cancel a running sub-agent
    server.registerTool(
        "cancel_agent",
        {
            description: "Cancel a running sub-agent in a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session the agent belongs to"),
                agent_id: z.string().describe("The ID of the agent to cancel"),
                reason: z.string().optional().describe("Optional reason for cancellation"),
            },
        },
        async ({ session_id, agent_id, reason }) => {
            try {
                await ctx.mgmt.sendCommand(session_id, {
                    cmd: "cancel_agent",
                    id: `cancel-${Date.now()}`,
                    args: {
                        agentId: agent_id,
                        ...(reason !== undefined && { reason }),
                    },
                });
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ cancelled: true }) },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );
}
