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

// fetch() against the API with the Clerk session token attached. Clerk tokens are
// short-lived (60s); getToken() returns a cached one or refreshes it.
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      const res = await fetch(`/api${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
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

export interface Today {
  quest: QuestView | null;
  deck: DeckItem[];
  cache: "hit" | "miss";
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
