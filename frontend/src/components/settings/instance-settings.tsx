"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { getInstanceSettings, type InstanceSettings } from "@/lib/api";

const REFRESH_MS = 30_000;

type SettingsContext = {
  /** null until the first answer; treat that as "submissions open". */
  settings: InstanceSettings | null;
  /** Re-read the settings now, e.g. after a `submissions_closed` error. */
  refresh: () => void;
};

const Context = createContext<SettingsContext>({
  settings: null,
  refresh: () => {},
});

/**
 * Keeps the instance settings (submission killswitch, leaderboard mode) for
 * every signed-in page and re-reads them every 30 s (FR-ADM-05). Pages that
 * need them sooner call `refresh` on a timer of their own.
 */
export function InstanceSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);

  const refresh = useCallback(() => {
    getInstanceSettings()
      .then(setSettings)
      .catch(() => {
        // Keep the last known settings; the backend still refuses a
        // submission while the killswitch is on
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const value = useMemo(() => ({ settings, refresh }), [settings, refresh]);
  return <Context value={value}>{children}</Context>;
}

export function useInstanceSettings(): SettingsContext {
  return useContext(Context);
}

/** Shown on every signed-in page while submissions are closed. */
export function KillswitchBanner() {
  const { settings } = useInstanceSettings();
  if (!settings || settings.submissions_open) return null;
  return (
    <p
      role="status"
      className="border-b bg-warning px-4 py-2.5 text-sm text-warning-foreground sm:px-6"
    >
      <span className="font-medium">Submissions are closed.</span>{" "}
      {settings.submissions_message}
    </p>
  );
}
