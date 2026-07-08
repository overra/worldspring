// /logout (doc 01 M4). Clears the identity-only ws_session cookie and goes
// home. Safe in disabled mode too (deleting a cookie that isn't there is a
// no-op). GET is acceptable here: the session carries zero capability, so a
// forced logout is the worst a cross-site GET can do.
import type { APIRoute } from "astro";
import { SESSION_COOKIE } from "../lib/auth";

export const prerender = false;

export const GET: APIRoute = ({ cookies, redirect }) => {
  cookies.delete(SESSION_COOKIE, { path: "/" });
  return redirect("/", 302);
};
