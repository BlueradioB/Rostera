import { expect, test } from "@playwright/test";

test("a new owner creates teams, people, and assigned work", async ({ page }) => {
  const email = `owner-${Date.now()}@example.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "New to Rostera? Create an account" }).click();
  await page.getByLabel("Your name").fill("Taylor Brooks");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("strong-e2e-password");
  await page.getByLabel("Workspace name").fill("E2E Garden");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.locator("#app-shell")).toBeVisible();
  await expect(page.locator("#profile-name")).toHaveText("Taylor Brooks");
  await expect(page.locator("#workspace-select option")).toHaveCount(1);

  await page.getByRole("button", { name: "Add team +" }).click();
  await page.locator("#team-form input[name='name']").fill("Research");
  await page.locator("#team-form input[name='fantasyName']").fill("The Scribes");
  await page.locator("#team-form input[name='requiredSkills']").fill("Synthesis, Analytics");
  await page.locator("#team-form").getByRole("button", { name: "Save team" }).click();
  await expect(page.locator("#team-list")).toContainText("Research");

  await page.getByRole("button", { name: "Add a person" }).click();
  await page.locator("#person-form input[name='name']").fill("Casey Morgan");
  await page.locator("#person-form input[name='role']").fill("Researcher");
  await page.locator("#person-form select[name='team']").selectOption({ label: "Research" });
  await page.locator("#person-form input[name='skills']").fill("Synthesis");
  await page.locator("#person-form input[name='aspirations']").fill("Analytics");
  await page.locator("#person-form").getByRole("button", { name: "Add to roster" }).click();
  await expect(page.locator("#member-grid")).toContainText("Casey Morgan");

  await page.getByRole("button", { name: "Add work +" }).click();
  await page.locator("#work-form input[name='title']").fill("Synthesize customer themes");
  await page.locator("#work-form select[name='teamId']").selectOption({ label: "Research" });
  await page.locator("#work-form input[name='requiredSkill']").fill("Synthesis");
  await page.locator("#work-form select[name='assignedPersonId']").selectOption({ label: "Casey Morgan" });
  await page.locator("#work-form").getByRole("button", { name: "Save work" }).click();
  const workCard = page.locator("#assignment-list article").filter({ hasText: "Synthesize customer themes" });
  await expect(workCard).toContainText("Casey Morgan");
  await workCard.getByRole("button", { name: "Mark complete" }).click();
  await expect(workCard).toContainText("Completed");
  await workCard.getByRole("button", { name: "Reopen" }).click();
  await expect(workCard).toContainText("Assigned");

  await page.locator("#theme-toggle").click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "fantasy");
  await page.reload();
  await expect(page.locator("#app-shell")).toBeVisible();
  await expect(page.locator("#member-grid")).toContainText("Casey Morgan");
  await expect(page.locator("#assignment-list")).toContainText("Synthesize customer themes");
});

test("workspace members can read but cannot modify roster data", async ({ page, context }) => {
  const ownerEmail = `owner-${Date.now()}@example.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "New to Rostera? Create an account" }).click();
  await page.getByLabel("Your name").fill("Workspace Owner");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill("strong-e2e-password");
  await page.getByLabel("Workspace name").fill("Read Only Garden");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("#app-shell")).toBeVisible();

  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invitationUrl = await page.locator("#invite-url").inputValue();
  const memberPage = await context.newPage();
  await memberPage.goto(invitationUrl);
  await memberPage.getByRole("button", { name: "New to Rostera? Create an account" }).click();
  await memberPage.getByLabel("Your name").fill("Workspace Member");
  await memberPage.getByLabel("Email").fill(`member-${Date.now()}@example.test`);
  await memberPage.getByLabel("Password").fill("strong-member-password");
  await memberPage.getByRole("button", { name: "Create account" }).click();
  await expect(memberPage.locator("#app-shell")).toBeVisible();
  await expect(memberPage.locator("#profile-role")).toHaveText("Workspace member · read only");

  const createResult = await memberPage.evaluate(async () => {
    const response = await fetch("/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Forbidden", fantasyName: "Forbidden" })
    });
    return { status: response.status, body: await response.json() };
  });
  expect(createResult.status).toBe(403);
  expect(createResult.body.error).toContain("Only workspace owners");
});
