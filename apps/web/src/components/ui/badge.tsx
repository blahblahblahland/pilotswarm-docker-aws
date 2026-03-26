import * as React from "react";
import { cn } from "@/lib/cn";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "green" | "yellow" | "red" | "blue";
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  const tones: Record<NonNullable<BadgeProps["tone"]>, string> = {
    neutral: "bg-muted text-foreground border-border",
    green: "bg-green-600/10 text-green-700 dark:text-green-300 border-green-600/30",
    yellow: "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300 border-yellow-500/30",
    red: "bg-red-600/10 text-red-700 dark:text-red-300 border-red-600/30",
    blue: "bg-blue-600/10 text-blue-700 dark:text-blue-300 border-blue-600/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

