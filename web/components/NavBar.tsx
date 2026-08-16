"use client";

import { useEffect, useRef, useState } from "react";
import type { MeResponse } from "@/lib/types";

type Theme = "dark" | "light";
const THEME_KEY = "lf:theme";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    window.localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

/**
 * Session-aware top bar, identical on every page: a big home link, and either
 * "Sign in with osu!" or the user's avatar with a dropdown (home, owner panel,
 * theme, sign out). Always resolves the session itself so it can never
 * disagree with the page below it.
 */
export default function NavBar() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const [here, setHere] = useState("/");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHere(window.location.pathname + window.location.search);
    setTheme(readTheme());
    let live = true;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setMe(d as MeResponse))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  const user = me?.user ?? null;
  const themeLabel = theme === "dark" ? "☀ Light mode" : "☾ Dark mode";

  return (
    <nav className="nav">
      <a className="nav-brand" href="/" title="Home">
        MP <span className="accent">Pool</span> Scanner
      </a>
      <div className="nav-right">
        {user ? (
          <div className="menu" ref={menuRef}>
            <button
              className={`avatar-btn ${open ? "open" : ""}`}
              onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={open}
              title={user.username}
            >
              {user.avatar_url ? <img className="avatar lg" src={user.avatar_url} alt="" /> : <span className="avatar lg initials">{user.username.slice(0, 2)}</span>}
            </button>
            {open && (
              <div className="menu-pop" role="menu">
                <div className="menu-head">
                  <span className="menu-name">{user.username}</span>
                  <a className="menu-sub" href={`https://osu.ppy.sh/users/${user.osu_id}`} target="_blank" rel="noreferrer">
                    osu! profile ↗
                  </a>
                </div>
                <a className="menu-item" role="menuitem" href="/">
                  <span className="menu-ico">⌂</span> Home
                </a>
                {user.is_site_owner && (
                  <a className="menu-item" role="menuitem" href="/owner">
                    <span className="menu-ico">⚙</span> Owner panel
                  </a>
                )}
                <button className="menu-item" role="menuitem" onClick={toggleTheme}>
                  <span className="menu-ico">{theme === "dark" ? "☀" : "☾"}</span> {theme === "dark" ? "Light mode" : "Dark mode"}
                </button>
                <button className="menu-item" role="menuitem" onClick={signOut}>
                  <span className="menu-ico">→</span> Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <button className="theme-btn" onClick={toggleTheme} title={themeLabel} aria-label={themeLabel}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <a className="btn btn-osu" href={`/api/auth/login?next=${encodeURIComponent(here)}`}>
              Sign in with osu!
            </a>
          </>
        )}
      </div>
    </nav>
  );
}
