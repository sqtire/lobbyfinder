/**
 * Fetches a link-viewable Google Sheet as XLSX via the export endpoint —
 * the same thing File → Download does, so no Google API or keys are involved.
 * XLSX (unlike CSV) preserves hyperlinks, which carry the osu! profile URLs
 * the roster parser anchors on.
 */

const MAX_BYTES = 20 * 1024 * 1024;

export function parseSheetUrl(input: string): { id: string; gid: string | null } | null {
  const m = input.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = input.match(/[?#&]gid=(\d+)/);
  return { id: m[1]!, gid: gid ? gid[1]! : null };
}

export async function fetchSheetXlsx(sheetUrl: string): Promise<Buffer> {
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) throw new Error("That doesn't look like a Google Sheets URL.");
  const exportUrl =
    `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=xlsx` +
    (parsed.gid ? `&gid=${parsed.gid}` : "");

  let res: Response;
  try {
    res = await fetch(exportUrl, { redirect: "follow", cache: "no-store" });
  } catch (e) {
    throw new Error(`Could not reach Google Sheets: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "Sheet not found — check the URL."
        : `Google returned ${res.status} — the sheet may not be link-viewable.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error("Sheet export is larger than 20MB — that's not a roster tab.");
  // A private sheet returns an HTML login page instead of an xlsx (xlsx = zip, starts "PK")
  if (buf.byteLength < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('Got a webpage instead of a spreadsheet — set the sheet to "anyone with the link can view".');
  }
  return buf;
}
