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
