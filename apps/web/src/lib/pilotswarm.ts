import "server-only";

import { PilotSwarmClient, PilotSwarmManagementClient } from "pilotswarm";
import type { PilotSwarmManagementClient as MgmtClientType } from "pilotswarm";
import { getDatabaseUrl } from "./env";

declare global {
  var __pilotswarm_mgmt: MgmtClientType | undefined;
  var __pilotswarm_client: PilotSwarmClient | undefined;
}

export async function getMgmt(): Promise<PilotSwarmManagementClient> {
  if (!globalThis.__pilotswarm_mgmt) {
    globalThis.__pilotswarm_mgmt = new PilotSwarmManagementClient({
      store: getDatabaseUrl(),
    });
  }
  const mgmt = globalThis.__pilotswarm_mgmt as PilotSwarmManagementClient;
  await mgmt.start();
  return mgmt;
}

export async function getClient(): Promise<PilotSwarmClient> {
  if (!globalThis.__pilotswarm_client) {
    globalThis.__pilotswarm_client = new PilotSwarmClient({
      store: getDatabaseUrl(),
      blobEnabled: true,
    });
  }
  const client = globalThis.__pilotswarm_client;
  await client.start();
  return client;
}

