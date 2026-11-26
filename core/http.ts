// The few shapes of answer the hub's own pages get, and how their requests are read.

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const go = (to: string) => new Response(null, { status: 302, headers: { location: to } });
export const refuse = (status: number, message: string) =>
  json({ ok: false, code: "refused", message }, status);
/** The answer to something that either worked or did not, as the accounts and devices code reports it. */
export const outcome = (r: { ok: boolean }, headers: Record<string, string> = {}) =>
  json(r, r.ok ? 200 : 400, headers);

/** An error as a sentence a person can be shown. */
export const sentence = (err: unknown) => {
  const text = String((err as Error).message ?? err);
  return text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith(".") ? "" : ".");
};

const COOKIE = "sk_session";
export const cookieOf = (req: Request) =>
  (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(
    COOKIE.length + 1,
  );
export const setCookie = (token: string, secure: boolean, clear = false) => ({
  "set-cookie": `${COOKIE}=${clear ? "" : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
    clear ? 0 : 31536000
  }${secure ? "; Secure" : ""}`,
});

/** Turn away a request a browser sent from any page but the hub's own. */
export function notOurPage(req: Request, origin: string): Response | null {
  const from = req.headers.get("origin");
  return from !== null && from !== origin
    ? refuse(403, "That request did not come from this hub's own pages.")
    : null;
}

/** Read a JSON request made by one of the hub's own pages. Anything else is turned away. */
export async function readJson(req: Request, origin: string): Promise<Record<string, unknown> | Response> {
  const no = notOurPage(req, origin);
  if (no) return no;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return refuse(415, "Expected JSON.");
  }
  const text = await req.text();
  if (text.length > 20_000) return refuse(413, "Too large.");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : refuse(400, "Expected an object.");
  } catch {
    return refuse(400, "That was not JSON.");
  }
}

/** Read a file sent by one of the hub's own pages, stopping at a size limit however large it claims to be. */
export async function readFile(req: Request, max: number): Promise<Uint8Array | Response> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body ?? []) {
    total += chunk.length;
    if (total > max) return refuse(413, "That file is larger than this hub accepts.");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}
