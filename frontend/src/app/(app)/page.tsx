import { AccountPanel } from "@/components/auth/account-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Flabsheet</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountPanel />
        </CardContent>
      </Card>
    </main>
  );
}
