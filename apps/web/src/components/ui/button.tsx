import * as React from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-opacity disabled:opacity-50 disabled:pointer-events-none";
  const sizes: Record<Size, string> = {
    sm: "h-9 px-3 text-sm",
    md: "h-10 px-4 text-sm",
  };
  const variants: Record<Variant, string> = {
    primary: "bg-foreground text-background hover:opacity-90",
    secondary: "bg-muted text-foreground border border-border hover:opacity-90",
    ghost: "hover:bg-muted/60 text-foreground",
    danger: "bg-red-600 text-white hover:opacity-90",
  };
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      {...props}
    />
  );
}

