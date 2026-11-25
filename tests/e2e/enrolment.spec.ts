import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const demoPassword = 'synthetic browser fixture';

async function signIn(page: Page, email: string, password = demoPassword) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('administrator enrols, lecturer publishes, and student completes learning after changing password', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = 'browser-' + suffix + '@example.test';
  const student = 'Browser Learner ' + suffix;
  const code = 'B' + suffix.toUpperCase();
  await signIn(page, 'admin@example.test');
  await expect(page.getByRole('heading', { name: 'Modules' })).toBeVisible();
  await page.getByRole('link', { name: 'User accounts' }).click();
  await page.getByRole('button', { name: 'New user' }).click();
  await page.getByLabel('Display name').fill(student);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Create user' }).click();
  const modal = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(modal).toBeVisible();
  const temporaryPassword = await modal.locator('code').innerText();
  await modal.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('link', { name: 'Modules', exact: true }).click();
  await page.getByRole('button', { name: 'New module' }).click();
  await page.getByLabel('Module code').fill(code);
  await page.getByLabel('Term', { exact: true }).fill('Fixture term');
  await page.getByLabel('Module name').fill('Browser module ' + suffix);
  await page.getByRole('combobox', { name: 'Assigned lecturer' }).selectOption({ label: 'Casey Tan · lecturer-a@example.test' });
  await page.getByRole('button', { name: 'Create module' }).click();
  await page.getByLabel('Search modules').fill(code);
  const moduleRow = page.getByRole('row', { name: new RegExp(code) });
  await moduleRow.getByRole('link', { name: /Enrolments/ }).click();
  await page.getByLabel('Search student accounts').fill(email);
  await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption({ label: student + ' · ' + email });
  await page.getByRole('button', { name: 'Enrol student' }).click();
  await expect(page.getByRole('row', { name: new RegExp(student) })).toBeVisible();
  await page.getByRole('link', { name: 'Modules', exact: true }).first().click();
  await page.getByLabel('Search modules').fill(code);
  const adminModule = await moduleRow.getByRole('link', { name: /Enrolments/ }).getAttribute('href');
  const moduleId = adminModule?.split('/')[3];
  await moduleRow.getByRole('button', { name: 'Activate' }).click();
  await expect(moduleRow.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await signIn(page, 'lecturer-a@example.test');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await page.getByRole('link', { name: 'Learning content' }).click();
  await page.getByRole('button', { name: 'New topic' }).click();
  await page.getByLabel('Topic title').fill('Week 1');
  await page.getByRole('button', { name: 'Create topic' }).click();
  await page.getByRole('link', { name: 'Week 1' }).click();
  await page.getByRole('button', { name: 'New material' }).click();
  await page.getByLabel('Material title').fill('Required reading');
  await page.getByLabel('Text', { exact: true }).fill('<script>Learning content</script>');
  await page.getByRole('button', { name: 'Create material' }).click();
  await page.getByRole('link', { name: 'Required reading' }).click();
  await page.getByRole('button', { name: 'Publish material' }).click();
  await expect(page.getByRole('button', { name: 'Revert to draft' })).toBeVisible();
  await page.getByRole('link', { name: /Week 1/ }).click();
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Publish topic' }).click();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, email, temporaryPassword);
  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await page.getByLabel('Current password').fill(temporaryPassword);
  await page.getByLabel('New password').fill('another synthetic browser fixture');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await expect(page.getByRole('heading', { name: 'Browser module ' + suffix })).toBeVisible();
  await page.getByRole('link', { name: 'Learning content' }).click();
  await page.getByRole('link', { name: 'Week 1' }).click();
  await page.getByRole('link', { name: 'Required reading' }).click();
  await expect(page.getByText('<script>Learning content</script>', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByRole('status')).toHaveText('Completed');
  await page.getByRole('link', { name: /Week 1/ }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'lecturer-b@example.test');
  await expect(page.getByRole('heading', { name: 'My modules' })).toBeVisible();
  await page.goto('/modules/' + moduleId);
  await expect(page.getByRole('alert')).toContainText('This resource could not be found.');
});

test('mobile navigation expands on request and closes after choosing a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'admin@example.test');
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'User accounts' })).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('link', { name: 'User accounts' }).click();
  await expect(page.getByRole('heading', { name: 'User accounts' })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});
