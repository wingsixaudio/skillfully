// The hub's own pages: setting up, signing in, your account, managing people and devices,
// and the frame a screen is shown in. These are the only pages that ever see
// a PIN or password, and the only ones that talk to the hub directly.
//
// They are ordinary files in core/web. A page is read each time it is asked for, so a change to one
// shows on the next reload. The few places a page differs from one request to the next are written
// {{like this}} and filled in here, as text.

import { TYPES } from "./http.ts";
import { here } from "./paths.ts";

const WEB = here("./web", import.meta.url).replace(/[\\/]$/, "") + "/";
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const text = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Read a page and fill it in. Everything is filled in as text, except what is named as the hub's own HTML. */
async function page(file: string, values: Record<string, string> = {}, html: string[] = []): Promise<string> {
  const raw = await Deno.readTextFile(WEB + file);
  return raw.replace(
    /\{\{\s*([a-z]+)\s*\}\}/g,
    (_, k) => (html.includes(k) ? values[k] ?? "" : text(values[k] ?? "")),
  );
}

const TITLES = {
  setup: "Set up this hub",
  signin: "Sign in",
  join: "Join the team",
  account: "Your account",
};

/** Setting up a new hub, signing in, using an invitation, and your own account. One page, four forms. */
export const authPage = (mode: keyof typeof TITLES) => page("auth.html", { title: TITLES[mode], mode });

/** People, roles, screens, devices and sign-in rules. Superusers only. */
export const adminPage = () => page("admin.html");

/** A plain page with one message, for dead ends. The message is the hub's own words and may hold a link. */
export const notePage = (title: string, message: string) =>
  page("note.html", { title, message }, ["message"]);

/** The frame a screen is shown in. */
export const shellPage = (screen: { id: string; name: string; entry: string }) =>
  page("shell.html", { id: screen.id, name: screen.name, entry: screen.entry });

/**
 * What one of the hub's own pages may load: its scripts and styles from the hub's own folder of them and
 * nowhere else, not even a script written into the page. A page may talk to the hub and to nothing else.
 */
export const pagePolicy = (origin: string, more = "connect-src 'self'") =>
  `default-src 'none'; script-src ${origin}/_hub/; style-src 'unsafe-inline' ${origin}/_hub/; ${more}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** One of the scripts or styles the hub's own pages load. Code, not secrets. */
export async function pageFile(name: string): Promise<Response | undefined> {
  const ext = /^[a-z][a-z0-9-]*(\.js|\.css)$/.exec(name)?.[1];
  if (!ext) return undefined;
  try {
    return new Response(await Deno.readFile(WEB + name), {
      headers: {
        "content-type": TYPES[ext],
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return undefined;
  }
}
