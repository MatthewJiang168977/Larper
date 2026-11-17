/** An address from the API that's safe to put in an href: http(s) only, else null. */
export function webUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** A tel: link for a phone number, or null when it has no digits. */
export function telUrl(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const dialled = phone.replace(/[^\d+]/g, "");
  return /\d/.test(dialled) ? `tel:${dialled}` : null;
}
