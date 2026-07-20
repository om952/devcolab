export type UserRole = "author" | "reviewer" | "ai-reviewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = "active" | "completed" | "archived";

export interface Session {
  id: string;
  title: string;
  repositoryUrl?: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type CommentAuthorType = "human" | "ai";
export type CommentCategory =
  | "bug"
  | "security"
  | "anti-pattern"
  | "test"
  | "general";

export interface Comment {
  id: string;
  sessionId: string;
  authorId: string;
  authorType: CommentAuthorType;
  category: CommentCategory;
  content: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}
