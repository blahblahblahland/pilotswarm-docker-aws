import { Suspense } from "react";
import { SessionsShell } from "./sessions-shell";

export default function SessionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading sessions…</div>}>
      <SessionsShell />
    </Suspense>
  );
}

