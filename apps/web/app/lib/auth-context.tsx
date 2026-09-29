"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { useRouter } from "next/navigation";

/**
 * Cached profile so a reload does not flash the login page while /me is in
 * flight. Not a credential: the session itself lives in an httpOnly cookie
 * that page scripts cannot read.
 */
const USER_KEY = "devcolab_user";
/** Where the token used to live; removed so upgraded browsers do not keep it. */
const LEGACY_TOKEN_KEY = "devcolab_token";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

/**
 * Thrown by `apiFetch` when the server rejects the session. The redirect to
 * /login has already been started by the time this surfaces, so callers should
 * let it fall through rather than rendering an error for it.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Session expired");
    this.name = "UnauthorizedError";
  }
}

interface AuthContextType {
  user: User | null;
  /** Record who signed in. The server has already set the session cookie. */
  login: (user: User) => void;
  /** Revoke the session on the server, then forget it here. */
  logout: () => Promise<void>;
  isLoading: boolean;
  /**
   * Fetch against the API (proxied on this origin, so the session cookie goes
   * with it). Signs the user out on a 401 instead of handing back a body the
   * caller will misread as data.
   */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function readCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearAuth = useCallback(() => {
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  useEffect(() => {
    localStorage.removeItem(LEGACY_TOKEN_KEY);

    // Restore optimistically so a reload does not flash the login page...
    const cached = readCachedUser();
    if (cached) setUser(cached);

    // ...then ask the server whether the cookie is still good. Always ask,
    // cached profile or not: only the server can see the cookie.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (cancelled) return;

        if (res.ok) {
          const fresh = (await res.json()) as User;
          setUser(fresh);
          localStorage.setItem(USER_KEY, JSON.stringify(fresh));
        } else if (res.status === 401) {
          clearAuth();
        }
        // Any other status is the server having a bad day, not a bad session.
        // Keep the restored user rather than signing everyone out on a blip.
      } catch {
        // Network error — same reasoning: do not sign the user out.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const login = useCallback((newUser: User) => {
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setUser(newUser);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Still forget the user locally; the cookie expires on its own.
    }
    clearAuth();
    router.push("/login");
  }, [clearAuth, router]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, init);

      if (res.status === 401) {
        clearAuth();
        router.push("/login");
        throw new UnauthorizedError();
      }

      return res;
    },
    [clearAuth, router]
  );

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoading, apiFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
