import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'synthetic browser fixture';
async function role(page: Page, email: string) {
  if (await page.getByRole('button', { name: 'Sign out' }).isVisible()) {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  }
  await page.goto('/login');
  await page.getByLabel('Email').fill(email + '@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function confirm(page: Page, name: string) {
  await page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click();
}
async function issueTopic(page: Page, title: string, lock = false) {
  await page
    .getByRole('navigation', { name: 'Module navigation' })
    .getByRole('link', { name: 'Content', exact: true })
    .click();
  await page.getByRole('button', { name: 'New topic' }).click();
  await page.getByLabel('Topic title').fill(title);
  await page.getByRole('button', { name: 'Create topic' }).click();
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.getByRole('button', { name: 'New material' }).click();
  await page.getByLabel('Material title').fill(title + ' reading');
  await page.getByLabel('Text', { exact: true }).fill('Synthetic browser reading.');
  await page.getByRole('button', { name: 'Create material' }).click();
  await page.getByRole('link', { name: title + ' reading' }).click();
  await page.getByRole('button', { name: 'Publish material' }).click();
  await expect(page.getByRole('button', { name: 'Revert to draft' })).toBeVisible();
  await page.getByRole('link', { name: title, exact: true }).click();
  if (lock) {
    await page.getByRole('button', { name: 'Release conditions', exact: true }).click();
    await page.getByLabel('Complete earlier topic').selectOption({ label: 'Week 1' });
    await page.getByLabel('Quiz result').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Save conditions' }).click();
    await expect(page.getByRole('button', { name: 'Save conditions' })).toBeHidden();
  }
  await page.getByRole('button', { name: 'Publish topic', exact: true }).click();
  await confirm(page, 'Publish topic');
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
}

test('full LMS journey from enrolment through a gated quiz, assignment and released grade', async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const code = 'J' + suffix;
  await role(page, 'admin');
  await page.getByRole('button', { name: 'New module' }).click();
  await page.getByLabel('Module code').fill(code);
  await page.getByLabel('Term', { exact: true }).fill('Browser test');
  await page.getByLabel('Module name').fill('Academic journey ' + suffix);
  await page
    .getByRole('combobox', { name: 'Assigned lecturer' })
    .selectOption({ label: 'Casey Tan · lecturer-a@example.test' });
  await page.getByRole('button', { name: 'Create module' }).click();
  await page.getByLabel('Search modules').fill(code);
  const row = page.getByRole('row', { name: new RegExp(code) });
  await row.getByRole('link', { name: /Enrolments/ }).click();
  await page.getByLabel('Search student accounts').fill('student-a@example.test');
  await page
    .getByRole('combobox', { name: 'Student', exact: true })
    .selectOption({ label: 'Avery Lee · student-a@example.test' });
  await page.getByRole('button', { name: 'Enrol student' }).click();
  await expect(page.getByRole('row', { name: /Avery Lee/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Modules', exact: true })
    .click();
  await page.getByLabel('Search modules').fill(code);
  await row.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();

  await role(page, 'lecturer-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await issueTopic(page, 'Week 1');
  const nav = page.getByRole('navigation', { name: 'Module navigation' });
  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'New assessment' }).click();
  await page.getByLabel('Assessment type').selectOption('QUIZ');
  await page.getByLabel('Assessment title').fill('Introduction quiz');
  await page.getByLabel('Weight percent (0 for practice)').fill('20');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('How many points are available?');
  await page.getByLabel('Option 1', { exact: true }).fill('One point');
  await page.getByLabel('Option 2', { exact: true }).fill('Ten points');
  await page.getByRole('radio', { name: 'Correct' }).first().check();
  await page.getByRole('button', { name: 'Save questions' }).click();
  await expect(page.getByText('1 points total')).toBeVisible();
  await page.getByRole('button', { name: 'Publish assessment', exact: true }).click();
  await confirm(page, 'Publish assessment');
  await expect(page.getByRole('link', { name: 'Marking and results' })).toBeVisible();
  await issueTopic(page, 'Week 2', true);

  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'New assessment' }).click();
  await page.getByLabel('Assessment title').fill('Written brief');
  await page.getByLabel('Weight percent (0 for practice)').fill('30');
  await page.getByLabel('Instructions', { exact: true }).fill('Upload a short text file.');
  await page.getByRole('checkbox', { name: 'TXT', exact: true }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Publish assessment', exact: true }).click();
  await confirm(page, 'Publish assessment');
  await expect(page.getByRole('link', { name: 'Marking and results' })).toBeVisible();

  await role(page, 'student-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await nav.getByRole('link', { name: 'Content', exact: true }).click();
  await page.getByRole('link', { name: 'Week 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Topic locked' })).toBeVisible();
  await page.getByRole('link', { name: 'Week 1', exact: true }).click();
  await page.getByRole('link', { name: 'Week 1 reading', exact: true }).click();
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByRole('status')).toHaveText('Completed');

  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'Introduction quiz', exact: true }).click();
  await page.getByRole('button', { name: 'Start quiz', exact: true }).click();
  await confirm(page, 'Start quiz');
  await page.getByRole('radio', { name: 'One point' }).check();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'One point' })).toBeChecked();
  await page.getByRole('button', { name: 'Submit quiz', exact: true }).click();
  await confirm(page, 'Submit quiz');
  await expect(page.getByRole('heading', { name: 'Attempt submitted' })).toBeVisible();
  await nav.getByRole('link', { name: 'Content', exact: true }).click();
  await page.getByRole('link', { name: 'Week 2', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Week 2 reading' })).toBeVisible();

  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'Written brief', exact: true }).click();
  await page
    .getByLabel('Assignment file')
    .setInputFiles({
      name: 'brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Synthetic student submission'),
    });
  await page.getByRole('button', { name: 'Stage file' }).click();
  await page.getByRole('button', { name: 'Submit assignment', exact: true }).click();
  await confirm(page, 'Submit assignment');
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();

  await role(page, 'lecturer-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'Written brief', exact: true }).click();
  await page.getByRole('link', { name: 'Marking and results' }).click();
  await page
    .getByRole('row', { name: /Avery Lee/ })
    .getByRole('button', { name: 'View submission' })
    .click();
  await page.getByLabel('Points out of 100.00').fill('80');
  await page.getByLabel('Feedback', { exact: true }).fill('Good use of acceptance criteria.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await confirm(page, 'Save draft');
  await expect(page.getByRole('button', { name: 'Publish result', exact: true })).toBeVisible();

  await role(page, 'student-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await nav.getByRole('link', { name: 'Gradebook', exact: true }).click();
  await expect(page.getByText('Good use of acceptance criteria.')).toHaveCount(0);
  await expect(
    page.getByRole('row', { name: /Written brief/ }).getByText('Result pending', { exact: true }),
  ).toBeVisible();

  await role(page, 'lecturer-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await nav.getByRole('link', { name: 'Assessments', exact: true }).click();
  await page.getByRole('link', { name: 'Written brief', exact: true }).click();
  await page.getByRole('link', { name: 'Marking and results' }).click();
  await page
    .getByRole('row', { name: /Avery Lee/ })
    .getByRole('button', { name: 'View grade' })
    .click();
  await page.getByRole('button', { name: 'Publish result', exact: true }).click();
  await confirm(page, 'Publish result');
  await expect(page.getByText('Revision 1', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Analytics', exact: true }).click();
  await expect(page.getByRole('row', { name: /Avery Lee/ }).getByRole('cell', { name: /100\.00%.*1 sample/ })).toBeVisible();

  await role(page, 'student-a');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await nav.getByRole('link', { name: 'Gradebook', exact: true }).click();
  await expect(page.getByText('Good use of acceptance criteria.')).toBeVisible();
  await expect(page.getByText('88.00%', { exact: true })).toBeVisible();
});
