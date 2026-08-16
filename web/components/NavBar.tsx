"use client";

import { useEffect, useState } from "react";
import type { MeResponse } from "@/lib/types";

/** Session-aware top bar: brand, owner link, sign in / avatar + sign out. */
export default function NavBar({ me: initial }: { me?: MeResponse | null }) {
  const [me, setMe] = useState<MeResponse | null>(initial ?? null);
  const [here, setHere] = useState("/");
  useEffect(() => {
    setHere(window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setMe(d as MeResponse))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [initial]);

  const user = me?.user ?? null;

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  return (
    <nav className="nav">
      <a className="nav-brand" href="/">
        MP <span className="accent">Pool</span> Scanner
      </a>
      <div className="nav-right">
        {user?.is_site_owner && (
          <a className="nav-link" href="/owner">
            Owner panel
          </a>
        )}
        {user ? (
          <span className="nav-user">
            {user.avatar_url ? <img className="avatar" src={user.avatar_url} alt="" /> : null}
            <a href={`https://osu.ppy.sh/users/${user.osu_id}`} target="_blank" rel="noreferrer">
              {user.username}
            </a>
            <button className="linkbtn" onClick={signOut}>
              sign out
            </button>
          </span>
        ) : (
          <a className="btn btn-osu" href={`/api/auth/login?next=${encodeURIComponent(here)}`}>
            Sign in with osu!
          </a>
        )}
      </div>
    </nav>
  );
}
