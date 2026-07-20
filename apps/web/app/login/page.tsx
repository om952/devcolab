"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:4000";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("reviewer");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const body = isRegister ? { email, password, name, role } : { email, password };

      const res = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");

      login(data.token, data.user);
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-emerald-400">
            DevColab
          </p>
          <h1 className="text-2xl font-bold">{isRegister ? "Create Account" : "Welcome Back"}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <>
              <input
                type="text"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg bg-slate-800 px-4 py-3 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
                required
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-lg bg-slate-800 px-4 py-3 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
              >
                <option value="reviewer">Reviewer</option>
                <option value="author">Author</option>
                <option value="ai_reviewer">AI Reviewer</option>
              </select>
            </>
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg bg-slate-800 px-4 py-3 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-slate-800 px-4 py-3 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
            required
          />

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-emerald-500 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {loading ? "Loading..." : isRegister ? "Sign Up" : "Sign In"}
          </button>
        </form>

        <p className="text-center text-sm text-slate-400">
          {isRegister ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-emerald-400 hover:underline"
          >
            {isRegister ? "Sign In" : "Sign Up"}
          </button>
        </p>
      </div>
    </div>
  );
}
