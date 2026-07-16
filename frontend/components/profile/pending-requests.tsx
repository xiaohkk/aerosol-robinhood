"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, ArrowUpRight, Clock } from "lucide-react";
import { useRouter } from "next/navigation";

interface PendingTransaction {
  id: string;
  sender: string;
  recipient: string;
  recipientAddress: string;
  amount: number;
  status: string;
  expiresAt: string;
}

interface PendingRequestsProps {
  /** The logged-in user's Twitter/X handle (without @). */
  twitterUsername: string;
}

const formatExpiry = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours >= 1) return `expires in ${hours}h`;
  const mins = Math.max(1, Math.floor(ms / (1000 * 60)));
  return `expires in ${mins}m`;
};

export function PendingRequests({ twitterUsername }: PendingRequestsProps) {
  const router = useRouter();
  const [requests, setRequests] = useState<PendingTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    if (!twitterUsername) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/transactions?sender=${encodeURIComponent(
          twitterUsername
        )}&status=pending`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to load requests");
      setRequests(data.transactions || []);
    } catch (err) {
      console.error("Error fetching pending requests:", err);
      setError("Failed to load pending requests");
    } finally {
      setLoading(false);
    }
  }, [twitterUsername]);

  const handleCancel = useCallback(async (id: string) => {
    setCancellingId(id);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/transactions/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to cancel");
      // Drop it from the list immediately.
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error("Error cancelling request:", err);
    } finally {
      setCancellingId(null);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
    // Poll so a freshly-tweeted request appears without a manual refresh.
    const interval = setInterval(fetchRequests, 15000);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">Pending Requests</h3>
          {requests.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold h-5 min-w-5 px-1.5">
              {requests.length}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchRequests}
          disabled={loading}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && requests.length === 0 ? (
        <div className="flex justify-center items-center py-8 gap-2">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading requests...</span>
        </div>
      ) : error ? (
        <div className="text-center py-8 px-4">
          <p className="text-red-500 mb-4 text-sm sm:text-base">{error}</p>
          <Button variant="outline" onClick={fetchRequests} className="w-full sm:w-auto">
            Try Again
          </Button>
        </div>
      ) : requests.length === 0 ? (
        <div className="text-center py-8 px-4">
          <p className="text-muted-foreground text-sm sm:text-base">
            No pending requests. Tweet{" "}
            <span className="font-medium">@tryrobinpay send 0.01 to @someone</span> to create one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <div
              key={req.id}
              className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 sm:p-4 border rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-start sm:items-center space-x-3 flex-1 min-w-0">
                <div className="p-2 rounded-full bg-muted flex-shrink-0">
                  <ArrowUpRight className="w-4 h-4 text-red-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">
                    Send {req.amount} ETH to @{req.recipient}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                    <Clock className="w-3 h-3" />
                    {formatExpiry(req.expiresAt)}
                  </p>
                </div>
              </div>

              <div className="flex gap-2 w-full sm:w-auto">
                <Button
                  onClick={() => router.push(`/approve/${req.id}`)}
                  className="flex-1 sm:flex-none bg-indigo-600 hover:bg-indigo-700 text-white"
                  size="sm"
                  disabled={cancellingId === req.id}
                >
                  Approve &amp; Send
                </Button>
                <Button
                  onClick={() => handleCancel(req.id)}
                  variant="outline"
                  size="sm"
                  disabled={cancellingId === req.id}
                >
                  {cancellingId === req.id ? "Cancelling…" : "Cancel"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
