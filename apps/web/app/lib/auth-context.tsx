"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:4000";

const TOKEN_KEY = "devcolab_token";
const USER_KEY = "devcolab_user";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

/**
 * Thrown by `apiFetch` when the server rejects the token. The redirect to
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
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
  /**
   * Authenticated fetch. Takes a path (`/api/sessions`), attaches the bearer
   * token, and signs the user out on a 401 instead of handing back a body the
   * caller will misread as data.
   */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // apiFetch is used inside effects; reading the token from a ref keeps its
  // identity stable so it never re-triggers the effects that depend on it.
  const tokenRef = useRef<string | null>(null);

  const clearAuth = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    tokenRef.current = null;
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedUser = localStorage.getItem(USER_KEY);

    if (!storedToken || !storedUser) {
      setIsLoading(false);
      return;
    }

    // Restore optimistically so a reload does not flash the login page...
    try {
      setUser(JSON.parse(storedUser) as User);
    } catch {
      clearAuth();
      setIsLoading(false);
      return;
    }
    tokenRef.current = storedToken;
    setToken(storedToken);

    // ...then ask the server whether the token is actually still good.
    // localStorage cannot answer that: an expired or revoked token looks
    // exactly like a valid one, and the user only found out when a request
    // quietly returned an error body that the page rendered as empty data.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        });

        if (cancelled) return;

        if (res.ok) {
          const fresh = (await res.json()) as User;
          setUser(fresh);
          localStorage.setItem(USER_KEY, JSON.stringify(fresh));
        } else if (res.status === 401) {
          clearAuth();
        }
        // Any other status is the server having a bad day, not a bad token.
        // Keep the restored session rather than signing everyone out on a blip.
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

  const login = useCallback((newToken: string, newUser: User) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    tokenRef.current = newToken;
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
  }, [clearAuth]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const bearer = tokenRef.current ?? localStorage.getItem(TOKEN_KEY);

      const headers = new Headers(init.headers);
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

      const url = path.startsWith("http") ? path : `${API_URL}${path}`;
      const res = await fetch(url, { ...init, headers });

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
    <AuthContext.Provider value={{ user, token, login, logout, isLoading, apiFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
