import "server-only";

function mustGet(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getDatabaseUrl(): string {
  return mustGet("DATABASE_URL");
}

export function getDefaultModel(): string | undefined {
  return process.env.PILOTSWARM_DEFAULT_MODEL;
}

