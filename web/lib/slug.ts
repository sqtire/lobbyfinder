/** Client-safe slug helpers (no Redis import). */
const RESERVED = new Set(["api", "t", "owner", "login", "logout", "auth", "me", "new", "admin", "static", "_next"]);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) && !RESERVED.has(slug);
}
