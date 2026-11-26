import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'synthetic browser fixture';

async function signIn(page: Page, who: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who + '@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function confirm(page: Page, label: string, reason?: string) {
  const dialog = page.getByRole('alertdialog');
  if (reason) await dialog.getByRole('textbox').fill(reason);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('an officer creates an applicant and takes an application from submission to enrolment', async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 6);
  await signIn(page, 'officer-a');
  await expect(page.getByRole('heading', { name: 'Admissions overview' })).toBeVisible();
  await expect(page.getByText('Total applications')).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Applicants' }).click();
  await page.getByRole('link', { name: 'New applicant' }).click();
  await page.getByLabel('First name').fill('Browser');
  await page.getByLabel('Last name').fill('Tester ' + suffix);
  await page.getByLabel('Date of birth').fill('2006-03-14');
  await page.getByLabel('Nationality').fill('Singaporean');
  await page.getByLabel('Email address').fill(`browser.${suffix}@example.test`);
  await page.getByLabel('Phone number').fill('+65 9876 5432');
  await page.getByLabel('Address', { exact: true }).fill('1 Synthetic Street, Singapore 000001');
  await page.getByLabel('Previous institution').fill('Harbourview Junior College');
  await page.getByLabel('GPA (0.00–4.00, optional)').fill('3.75');
  await page.getByRole('button', { name: 'Create applicant' }).click();
  await expect(page.getByRole('heading', { name: 'Browser Tester ' + suffix })).toBeVisible();

  await page.getByRole('main').getByRole('link', { name: 'New application' }).first().click();
  await page.getByRole('combobox', { name: 'Programme', exact: true }).selectOption({ label: 'BCS · Bachelor of Computer Science' });
  const intake = page.getByRole('combobox', { name: 'Admission intake' });
  await intake.selectOption({ index: (await intake.locator('option').allTextContents()).findIndex(text => text.includes('Open')) });
  await page.getByRole('button', { name: 'Create and submit' }).click();
  await expect(page.getByRole('heading', { name: /^ADM-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText('Requirements met')).toBeVisible();

  // Actions offered depend on the current status.
  const actions = page.locator('.action-panel');
  await expect(actions.getByRole('button', { name: 'Issue offer' })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Begin review' }).click();
  await confirm(page, 'Begin review');
  await actions.getByRole('button', { name: 'Issue offer' }).click();
  await confirm(page, 'Issue offer');
  await actions.getByRole('button', { name: 'Record offer acceptance' }).click();
  await confirm(page, 'Record offer acceptance');
  await actions.getByRole('button', { name: 'Confirm enrolment' }).click();
  await confirm(page, 'Confirm enrolment');
  await expect(page.getByText('No further actions are available')).toBeVisible();
  const history = page.locator('.timeline-v');
  for (const status of ['Draft', 'Submitted', 'Under review', 'Offer issued', 'Offer accepted', 'Enrolled']) await expect(history.getByText(status, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Browser Tester ' + suffix }).click();
  await expect(page.getByRole('main').getByText('Enrolled', { exact: true }).first()).toBeVisible();
});

test('rejecting requires a reason and the decision appears in the history', async ({ page }) => {
  await signIn(page, 'officer-b');
  await page.goto('/applications?status=UNDER_REVIEW');
  await page.locator('a.row-link').first().click();
  await page.locator('.action-panel').getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await confirm(page, 'Reject', 'Prerequisite subjects not completed.');
  await expect(page.getByText('Prerequisite subjects not completed.')).toBeVisible();
  await expect(page.locator('.page-heading').getByText('Rejected')).toBeVisible();
});

test('read-only viewers see records without editing controls', async ({ page }) => {
  await signIn(page, 'viewer');
  await expect(page.getByRole('link', { name: 'Create applicant' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Activity Logs' })).toHaveCount(0);
  await page.goto('/applications');
  await expect(page.getByRole('link', { name: 'New application' })).toHaveCount(0);
  await page.locator('a.row-link').first().click();
  await expect(page.getByText('Read-only access')).toBeVisible();
});

test('administrators manage programme status and see the infrastructure page', async ({ page }) => {
  await signIn(page, 'admin');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Infrastructure Status' }).click();
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible();
  await expect(page.getByText('Local development').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sample 10 requests' }).click();
  await expect(page.getByText(/distinct instance/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Activity Logs' }).click();
  await expect(page.getByRole('heading', { name: 'Activity Logs' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('mobile navigation expands on request and closes after choosing a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, 'officer-a');
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Programmes' }).click();
  await expect(page.getByRole('heading', { name: 'Programmes' })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});
