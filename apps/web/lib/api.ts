"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";

export interface Me {
  id: string;
  onboarded: boolean;
  topTags: string[];
}

export interface VibeCard {
  id: string;
  title: string;
  blurb: string;
}

// A request is abandoned after this long. A cache miss answers in well under a second
// (ingest is asynchronous: the API returns `surveying` instead of waiting), so this
// only fires when the API or the network is stuck.
export const REQUEST_TIMEOUT_MS = 15_000;

/** A failed API call. `status` is 0 when no response arrived (offline, timeout). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "http" | "network" | "timeout" = "http",
    /** The API's machine-readable reason, when it gives one (e.g. "too_rough" on a check-in). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** What to tell the user about a failed call: the API's own words for 4xx, plain copy otherwise. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.kind === "timeout") return "The server is taking too long to answer.";
    if (e.kind === "network") return "Can't reach the server. Check your connection.";
    if (e.status >= 500) return "Something went wrong on our end.";
    return e.message;
  }
  return "Something went wrong.";
}

// fetch() against the API with the Clerk session token attached. Clerk tokens are
// short-lived (60s); getToken() returns a cached one or refreshes it.
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`/api${path}`, {
          ...init,
          signal: timeout,
          headers: {
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
          },
        });
      } catch (e) {
        if (timeout.aborted) throw new ApiError("timed out", 0, "timeout");
        throw new ApiError((e as Error).message, 0, "network");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Nest's validation errors carry a list of messages.
        const message = Array.isArray(body.message) ? body.message.join("; ") : body.message;
        throw new ApiError(message ?? `${res.status} ${res.statusText}`, res.status, "http", body.code);
      }
      return res.json() as Promise<T>;
    },
    [getToken],
  );
}

// --- quests (shapes mirror apps/api/src/quests/quests.service.ts) -----------

export interface PlaceView {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  tags: string[];
  distanceM: number;
  website: string | null;
  instagram: string | null;
  phone: string | null;
}

export interface Reasons {
  liked: string[];
  rarest: { tag: string; nearby: number } | null;
  indie: boolean;
}

export type QuestStatus = "offered" | "accepted" | "completed" | "skipped" | "expired";

export interface QuestView {
  id: string;
  status: QuestStatus;
  score: number;
  reasons: Reasons;
  createdAt: string;
  place: PlaceView;
}

export interface DeckItem {
  score: number;
  reasons: Reasons;
  place: PlaceView;
}

export interface Survey {
  /** geohash5 areas whose places are being loaded right now. */
  pending: string[];
  /** Areas whose load failed recently. */
  failed: string[];
}

export interface Today {
  quest: QuestView | null;
  deck: DeckItem[];
  cache: "hit" | "miss";
  /** Set while nearby areas are being ingested (or failed to be). */
  surveying: Survey | null;
}

export interface JournalEntry {
  id: string;
  status: QuestStatus;
  createdAt: string;
  updatedAt: string;
  name: string;
  category: string;
  reasons: Reasons;
}
