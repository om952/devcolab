import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./lib/auth-context";

export const metadata: Metadata = {
  title: "DevColab",
  description: "AI-Powered Real-Time Code Review Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
