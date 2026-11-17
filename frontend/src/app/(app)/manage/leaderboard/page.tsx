import type { Metadata } from "next";

import { LeaderboardControl } from "@/components/leaderboard/leaderboard-control";

export const metadata: Metadata = { title: "Leaderboard control" };

export default function ManageLeaderboardPage() {
  return <LeaderboardControl />;
}
