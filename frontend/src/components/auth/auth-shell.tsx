import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Centered wordmark + card used by the signed-out / account pages. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-7 bg-muted/50 px-4 py-12">
      <p className="text-2xl font-semibold tracking-tight">Flabsheet</p>
      <Card className="w-full max-w-[25rem] gap-6 ring-foreground/10 [--card-spacing:--spacing(8)]">
        <CardHeader className="gap-1.5">
          <CardTitle className="text-xl font-semibold">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

/** Taller inputs / buttons for the auth forms. */
export const AUTH_INPUT_CLASS = "h-11 px-3 border-ring";
export const AUTH_BUTTON_CLASS = "h-11 font-semibold";
