import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerSessionTools(server: McpServer, ctx: ServerContext) {
    // 1. create_session — Create a new PilotSwarm session
    server.registerTool(
        "create_session",
        {
            title: "Create Session",
            description: "Create a new PilotSwarm session, optionally bound to a named agent",
            inputSchema: {
                model: z.string().optional().describe("Model to use for the session"),
                agent: z.string().optional().describe("Agent name to bind the session to"),
                system_message: z.string().optional().describe("Custom system message for the session"),
                title: z.string().optional().describe("Title for the session"),
            },
        },
        async ({ model, agent, system_message, title }) => {
            try {
                const config: Record<string, unknown> = {};
                if (model !== undefined) config.model = model;
                if (system_message !== undefined) config.systemMessage = system_message;
                if (title !== undefined) config.title = title;

                let session;
                if (agent) {
                    session = await ctx.client.createSessionForAgent(agent, {
                        model,
                        title,
                    });
                } else {
                    session = await ctx.client.createSession({
                        model,
                        systemMessage: system_message,
                    });
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                session_id: session.sessionId,
                                status: "created",
                                model: model ?? "default",
                                title: title ?? null,
                            }),
                        },
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

    // 2. send_message — Fire-and-forget message to a session
    server.registerTool(
        "send_message",
        {
            title: "Send Message",
            description: "Send a fire-and-forget message to a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
            },
        },
        async ({ session_id, message }) => {
            try {
                await ctx.mgmt.sendMessage(session_id, message);
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

    // 3. send_and_wait — Send message and wait for response
    server.registerTool(
        "send_and_wait",
        {
            title: "Send and Wait",
            description: "Send a message to a PilotSwarm session and wait for the response",
            inputSchema: {
                session_id: z.string().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
                timeout_ms: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
            },
        },
        async ({ session_id, message, timeout_ms }) => {
            try {
                const timeout = timeout_ms ?? 120_000;
                const session = await ctx.client.resumeSession(session_id);
                const response = await session.sendAndWait(message, timeout);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                response: response ?? null,
                                status: response !== undefined ? "completed" : "timeout",
                            }),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.toLowerCase().includes("timeout")) {
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ error: "timeout" }) },
                        ],
                    };
                }
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 4. send_answer — Answer a pending input_required question
    server.registerTool(
        "send_answer",
        {
            title: "Send Answer",
            description: "Answer a pending input_required question in a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session awaiting an answer"),
                answer: z.string().describe("The answer to provide"),
            },
        },
        async ({ session_id, answer }) => {
            try {
                await ctx.mgmt.sendAnswer(session_id, answer);
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

    // 5. abort_session — Cancel a running session
    server.registerTool(
        "abort_session",
        {
            title: "Abort Session",
            description: "Cancel a running PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to abort"),
                reason: z.string().optional().describe("Optional reason for cancellation"),
            },
        },
        async ({ session_id, reason }) => {
            try {
                await ctx.mgmt.cancelSession(session_id, reason);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ aborted: true }) },
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

    // 6. rename_session — Rename a session
    server.registerTool(
        "rename_session",
        {
            title: "Rename Session",
            description: "Rename a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to rename"),
                title: z.string().describe("The new title for the session"),
            },
        },
        async ({ session_id, title }) => {
            try {
                await ctx.mgmt.renameSession(session_id, title);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ renamed: true }) },
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

    // 7. delete_session — Delete a session
    server.registerTool(
        "delete_session",
        {
            title: "Delete Session",
            description: "Delete a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to delete"),
            },
        },
        async ({ session_id }) => {
            try {
                await ctx.mgmt.deleteSession(session_id);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ deleted: true }) },
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
