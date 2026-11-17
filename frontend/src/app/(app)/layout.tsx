import { AppShell } from "@/components/nav/app-shell";

/**
 * Signed-in pages: everything except /, /login and /change-password.
 * "/" lives in src/app/page.tsx because signed-out visitors see it too.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
