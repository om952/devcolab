import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/** Correctly shaped, wrongly signed. */
const FORGED_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJ1c2VySWQiOiJnb25lIiwicm9sZSI6InJldmlld2VyIn0.not-a-real-signature";

/** The httpOnly session cookie, read from the browser context (scripts cannot). */
async function sessionCookie(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === "devcolab_session");
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

/**
 * Add an LLM key through the session page. The e2e collab-server runs with
 * LLM_KEY_CHECK=skip, so no provider is called.
 */
async function addLlmKey(page: Page, key = "gsk_e2e_test_key_123") {
  await page.getByRole("button", { name: /add ai key/i }).click();
  await page.getByRole("button", { name: /^groq$/i }).click();
  await page.getByPlaceholder(/groq api key/i).fill(key);
  await page.getByRole("button", { name: /save key/i }).click();
  await expect(page.getByRole("button", { name: /using your groq key/i })).toBeVisible();
}

/** Unique per run so repeated runs never collide on the email unique index. */
function newUser() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  return { email: `e2e-${stamp}@example.com`, name: "E2E Tester", password: "password123" };
}

/** Everyone registers as a reviewer; what you may do comes from owning a session. */
async function register(page: Page) {
  const user = newUser();
  await page.goto("/login");
  await page.getByRole("button", { name: /sign up/i }).click();

  await page.getByPlaceholder("Name").fill(user.name);
  await page.getByPlaceholder("Email").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  await page.getByRole("button", { name: /sign up/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  return user;
}

/**
 * Creates a session with a title unique to this run and opens it.
 *
 * The dashboard lists every session, including ones left by earlier runs, so a
 * fixed title would match several rows.
 */
async function createSession(page: Page, label: string) {
  const title = `${label} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

  await page.getByRole("button", { name: /new session/i }).click();
  await page.getByPlaceholder("Session title").fill(title);
  await page.getByRole("button", { name: /^create$/i }).click();

  const row = page.getByText(title, { exact: true });
  await expect(row).toBeVisible();
  return { title, row };
}

async function addFile(page: Page, fileName: string, content: string) {
  await page.getByRole("button", { name: /upload or paste code|\+ add/i }).first().click();
  await page.getByPlaceholder("filename.js").fill(fileName);
  await page.getByPlaceholder("Paste your code here...").fill(content);
  await page.getByRole("button", { name: /save file/i }).click();
}

test.describe("landing page", () => {
  test("renders the marketing page instead of redirecting", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /code review that keeps up/i })).toBeVisible();
    // The CTA appears in both the hero and the closing section.
    await expect(page.getByRole("link", { name: /start reviewing free/i }).first()).toBeVisible();

    // The animated preview should resolve all four agents.
    for (const agent of ["Bugs", "Security", "Anti-patterns", "Tests"]) {
      await expect(page.getByText(agent, { exact: false }).first()).toBeVisible();
    }
  });

  test("anchor navigation reaches the sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /see how it works/i }).click();
    await expect(page.getByRole("heading", { name: /from paste to reviewed/i })).toBeInViewport();
  });

  test("sends a signed-out visitor to login from the CTA", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /start reviewing free/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("auth", () => {
  test("registers and lands on the dashboard", async ({ page }) => {
    await register(page);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });

  test("rejects bad credentials without leaking whether the account exists", async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("Email").fill("nobody@example.com");
    await page.getByPlaceholder("Password").fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/invalid credentials/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("signing out clears the session", async ({ page }) => {
    await register(page);
    await page.getByRole("button", { name: /logout/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("stays signed in when the dashboard is loaded directly", async ({ page }) => {
    // Auth is confirmed with the server asynchronously; a hard load must wait
    // for that rather than redirecting to login.
    await register(page);
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });

  test("a stale session is bounced to login, not shown an empty dashboard", async ({ page, context }) => {
    await register(page);
    await expect(page).toHaveURL(/\/dashboard/);

    // Correctly shaped, wrongly signed — indistinguishable from a good token
    // until the server is asked, which is exactly the point of /api/auth/me.
    await context.addCookies([{ ...(await sessionCookie(context)), value: FORGED_TOKEN }]);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    // The server clears the dead cookie rather than letting it be resent.
    expect(await sessionCookie(context).catch(() => null)).toBeNull();
  });

  test("a stale session on a session link goes to login, not an empty session", async ({ page, context }) => {
    await register(page);
    const { row } = await createSession(page, "Stale Token");
    await row.click();
    await expect(page).toHaveURL(/\/session\//);
    const sessionUrl = page.url();

    await context.addCookies([{ ...(await sessionCookie(context)), value: FORGED_TOKEN }]);

    // This previously rendered a session that looked real but had no files and
    // no comments, with nothing telling the user to sign in again.
    await page.goto(sessionUrl);
    await expect(page).toHaveURL(/\/login/);
  });

  test("the token is never readable by page scripts", async ({ page, context }) => {
    await register(page);
    expect((await sessionCookie(context)).httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("devcolab_session");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/eyJ/);
  });

  test("signing out revokes the session on the server, not just in this tab", async ({ page, context }) => {
    await register(page);
    const stolen = await sessionCookie(context);

    await page.getByRole("button", { name: /logout/i }).click();
    await expect(page).toHaveURL(/\/login/);

    // Replaying the old cookie must not get back in.
    await context.addCookies([stolen]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("survives a page reload on the dashboard", async ({ page }) => {
    await register(page);
    await page.reload();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });
});

test.describe("review session", () => {
  test("creates a session, adds a file, and comments on a line", async ({ page }) => {
    await register(page);
    const { row } = await createSession(page, "E2E Review Session");

    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    await addFile(page, "example.ts", 'const password = "hunter2";\nconsole.log(password);\n');
    await expect(page.getByText("example.ts").first()).toBeVisible();

    // Comment on a line — exercises the authenticated Socket.IO round trip.
    await page.locator("text=const password").first().click();
    const box = page.getByPlaceholder("Add a comment...");
    await expect(box).toBeVisible();
    await box.fill("This secret should not be committed.");
    await page.getByRole("button", { name: /^post$/i }).click();

    // Round-trips through the server and comes back over the socket.
    await expect(page.getByText("This secret should not be committed.").first()).toBeVisible();
  });

  test("AI review streams per-agent progress to completion", async ({ page }) => {
    await register(page);
    const { row } = await createSession(page, "E2E AI Review");

    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    await addFile(
      page,
      "vuln.ts",
      'const apiKey = "sk_live_abcdef123456";\ntry { risky(); } catch (e) {}\n// TODO: fix\n'
    );
    await expect(page.getByText("vuln.ts").first()).toBeVisible();

    await addLlmKey(page);
    await page.getByRole("button", { name: /^ai review$/i }).click();

    // The AI service is intentionally unreachable here, so the run must
    // complete via the heuristic engine AND say so rather than pass it off
    // as AI output.
    await expect(page.getByText(/heuristic scan only/i)).toBeVisible({ timeout: 45_000 });

    // Findings land as comments in the sidebar.
    await expect(page.getByText(/hardcoded secret/i).first()).toBeVisible();
  });
});

test.describe("bring your own LLM key", () => {
  test("a review without a key asks for one instead of failing", async ({ page }) => {
    await register(page);
    const { row } = await createSession(page, "No Key");
    await row.click();
    await addFile(page, "a.ts", "const a = 1;\n");

    await expect(page.getByRole("button", { name: /add ai key/i })).toBeVisible();
    await page.getByRole("button", { name: /^ai review$/i }).click();

    await expect(page.getByRole("dialog", { name: /your ai key/i })).toBeVisible();
    await expect(page.getByText(/add your gemini or groq api key/i)).toBeVisible();
  });

  test("a saved key is never shown back, and logout forgets it", async ({ page }) => {
    const user = await register(page);
    const { row } = await createSession(page, "Key Privacy");
    await row.click();
    await expect(page).toHaveURL(/\/session\//);
    const sessionUrl = page.url();

    await addLlmKey(page, "gsk_e2e_secret_value_42");
    await expect(page.getByRole("button", { name: /using your groq key/i })).toBeVisible();
    expect(await page.content()).not.toContain("gsk_e2e_secret_value_42");

    // Survives a reload: it lives on the server, not in the page.
    await page.reload();
    await expect(page.getByRole("button", { name: /using your groq key/i })).toBeVisible();

    await page.goto("/dashboard");
    await page.getByRole("button", { name: /logout/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByPlaceholder("Email").fill(user.email);
    await page.getByPlaceholder("Password").fill(user.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto(sessionUrl);
    await expect(page.getByRole("button", { name: /add ai key/i })).toBeVisible();
  });
});

test.describe("session visibility", () => {
  test("one user's dashboard does not show another user's session", async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const strangerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const strangerPage = await strangerCtx.newPage();

    await register(ownerPage);
    const { title } = await createSession(ownerPage, "Private Session");
    const sessionUrl = ownerPage.url();

    // A different account sees an empty dashboard.
    await register(strangerPage);
    await expect(strangerPage.getByText(title)).toHaveCount(0);
    await expect(strangerPage.getByText(/no sessions yet/i)).toBeVisible();

    await ownerCtx.close();
    await strangerCtx.close();
    expect(sessionUrl).toBeTruthy();
  });

  test("a session opened by link then appears on that user's dashboard", async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const guestPage = await guestCtx.newPage();

    await register(ownerPage);
    const { title, row } = await createSession(ownerPage, "Link Shared");
    await row.click();
    await expect(ownerPage).toHaveURL(/\/session\//);
    const sessionUrl = ownerPage.url();

    // The guest follows the shared link, which enrols them.
    await register(guestPage);
    await expect(guestPage.getByText(title)).toHaveCount(0);
    await guestPage.goto(sessionUrl);
    await expect(guestPage).toHaveURL(/\/session\//);
    // Enrolment happens when the page loads the session, so wait for that
    // request to finish before checking the dashboard.
    await expect(guestPage.getByText(/no files yet/i)).toBeVisible();

    await guestPage.goto("/dashboard");
    await expect(guestPage.getByText(title)).toBeVisible();

    await ownerCtx.close();
    await guestCtx.close();
  });
});

test.describe("access control", () => {
  test("the session creator is offered the control and the upload succeeds", async ({ page }) => {
    await register(page);
    const { row } = await createSession(page, "Owned Session");
    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    // Everyone registers with the same account role; "Author" must come from
    // having created this session.
    await expect(page.getByText(/You:\s*Author/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upload or paste code|\+ add/i }).first()
    ).toBeVisible();

    await addFile(page, "allowed.ts", "const a = 1;\n");
    await expect(page.getByText("allowed.ts").first()).toBeVisible();
  });

  test("someone who joins by link is not offered the control, and is told why", async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const guestPage = await guestCtx.newPage();

    await register(ownerPage);
    const { row } = await createSession(ownerPage, "Link Guarded");
    await row.click();
    await expect(ownerPage).toHaveURL(/\/session\//);
    const sessionUrl = ownerPage.url();

    // The guest holds the link and is a full participant, but does not own the
    // session. Defence in depth: the server 403s regardless, but the UI must
    // not offer a control guaranteed to fail. The disabled state renders as a
    // span, so no button with this name should exist for them at all.
    await register(guestPage);
    await guestPage.goto(sessionUrl);
    await expect(guestPage.getByText("No files yet")).toBeVisible();
    await expect(guestPage.getByText(/You:\s*Reviewer/)).toBeVisible();
    await expect(
      guestPage.getByRole("button", { name: /upload or paste code|\+ add/i })
    ).toHaveCount(0);

    // A disabled control with no explanation is just a dead end.
    await expect(guestPage.getByText(/only the person who created this session/i)).toBeVisible();

    await ownerCtx.close();
    await guestCtx.close();
  });
});
