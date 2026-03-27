import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "./context.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerSessionTools } from "./tools/sessions.js";

export function createMcpServer(ctx: ServerContext): McpServer {
    const server = new McpServer({
        name: "pilotswarm",
        version: "0.1.0",
    });

    // Tool registration
    registerSessionTools(server, ctx);
    registerAgentTools(server, ctx);

    return server;
}
