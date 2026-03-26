import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main id="main" className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-balance text-3xl font-semibold tracking-tight">
            PilotSwarm Web
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            An accessible, keyboard-first UI for managing durable PilotSwarm sessions
            backed by local PostgreSQL.
          </p>
        </header>

        <section className="grid gap-4 rounded-xl border border-border bg-muted/20 p-5">
          <h2 className="text-lg font-medium">Get started</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              Copy <code className="rounded bg-muted px-1.5 py-0.5">.env.local.example</code>{" "}
              to <code className="rounded bg-muted px-1.5 py-0.5">.env.local</code> and set{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">DATABASE_URL</code>.
            </li>
            <li>
              Start your PilotSwarm worker/client (or run the TUI) against the same database.
            </li>
            <li>Open the Sessions view.</li>
          </ol>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/sessions"
              className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
            >
              Open Sessions <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
