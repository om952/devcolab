import { test, expect, type Page } from "@playwright/test";

/** Unique per run so repeated runs never collide on the email unique index. */
function newUser() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  return { email: `e2e-${stamp}@example.com`, name: "E2E Tester", password: "password123" };
}

async function register(page: Page, role: "author" | "reviewer" = "author") {
  const user = newUser();
  await page.goto("/login");
  await page.getByRole("button", { name: /sign up/i }).click();

  await page.getByPlaceholder("Name").fill(user.name);
  await page.getByRole("combobox").selectOption(role);
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
    // Auth restores from localStorage asynchronously; a hard load must wait
    // for that rather than redirecting to login.
    await register(page);
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
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
    await register(page, "author");
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
    await register(page, "author");
    const { row } = await createSession(page, "E2E AI Review");

    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    await addFile(
      page,
      "vuln.ts",
      'const apiKey = "sk_live_abcdef123456";\ntry { risky(); } catch (e) {}\n// TODO: fix\n'
    );
    await expect(page.getByText("vuln.ts").first()).toBeVisible();

    await page.getByRole("button", { name: /^ai review$/i }).click();

    // The AI service is intentionally unreachable here, so the run must
    // complete via the heuristic engine AND say so rather than pass it off
    // as AI output.
    await expect(page.getByText(/heuristic scan only/i)).toBeVisible({ timeout: 45_000 });

    // Findings land as comments in the sidebar.
    await expect(page.getByText(/hardcoded secret/i).first()).toBeVisible();
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
  test("a reviewer is not offered the upload control, and is told why", async ({ page }) => {
    await register(page, "reviewer");
    const { row } = await createSession(page, "RBAC Session");
    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    // Defence in depth: the server rejects non-authors regardless, but the UI
    // must not offer a control that is guaranteed to 403. The disabled state
    // renders as a span, so no button with this name should exist at all.
    await expect(page.getByText("No files yet")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upload or paste code|\+ add/i })
    ).toHaveCount(0);

    // A disabled control with no explanation is just a dead end.
    await expect(page.getByText(/only the author can add files/i)).toBeVisible();
  });

  test("an author is offered the control and the upload succeeds", async ({ page }) => {
    await register(page, "author");
    const { row } = await createSession(page, "RBAC Session Author");
    await row.click();
    await expect(page).toHaveURL(/\/session\//);

    await expect(
      page.getByRole("button", { name: /upload or paste code|\+ add/i }).first()
    ).toBeVisible();

    await addFile(page, "allowed.ts", "const a = 1;\n");
    await expect(page.getByText("allowed.ts").first()).toBeVisible();
  });
});
