/*
 * Client-side helpers for the bookmark feature.
 *
 * Bookmarks are scoped per browser via a random clientId kept in
 * localStorage (the app has no auth). All calls hit /api/bookmarks.
 */

export type Bookmark = {
  id: string;
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
  createdAt?: string;
};

const CLIENT_ID_KEY = "translator_client_id";

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// Stable identity for a bookmark independent of its DB id, so the UI can tell
// which words are already saved.
export function bookmarkKey(b: {
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
}): string {
  return [b.source, b.target, b.sourceLang, b.targetLang].join("|");
}

export async function fetchBookmarks(
  clientId: string
): Promise<Bookmark[]> {
  const res = await fetch(
    `/api/bookmarks?clientId=${encodeURIComponent(clientId)}`
  );
  if (!res.ok) {
    throw new Error("Failed to load bookmarks.");
  }
  const data = await res.json();
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

export async function addBookmark(
  clientId: string,
  entry: Omit<Bookmark, "id" | "createdAt">
): Promise<Bookmark> {
  const res = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, ...entry }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Failed to save bookmark.");
  }
  return data.bookmark as Bookmark;
}

export async function removeBookmark(
  clientId: string,
  id: string
): Promise<void> {
  const res = await fetch(
    `/api/bookmarks?id=${encodeURIComponent(id)}&clientId=${encodeURIComponent(
      clientId
    )}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Failed to remove bookmark.");
  }
}
