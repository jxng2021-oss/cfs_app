import { Router } from 'express';
import { z } from 'zod';
import { record } from './activity.js';
import { requireRole, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import { data, invalid, read } from './http.js';

const logo = z.string().max(280_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Upload a PNG, JPEG or WebP image');

/** Every setting here changes behaviour somewhere in the application; the comment says where. */
const settingsSchema = z.object({
  // Sidebar brand, sign-in page and page titles.
  institutionName: z.string().trim().min(1).max(120),
  // Replaces the default brand mark in the sidebar and sign-in page.
  institutionLogo: logo.nullable(),
  // Default academic year filter on Analytics and Admission intakes, and the prefill for new intakes.
  defaultAcademicYear: z.string().regex(/^[0-9]{4}\/[0-9]{4}$/, 'Use the format 2026/2027'),
  // Offer response deadline = offer date + this many days, unless the officer picks a date.
  offerResponseDays: z.number().int().min(1).max(120),
  // When true, rejecting an application requires a written reason.
  requireRejectionReason: z.boolean(),
  // Applications older than this many days in Submitted are flagged on the dashboard.
  reviewTargetDays: z.number().int().min(1).max(90),
  // Application reference numbers: PREFIX-YEAR-000123 or PREFIX-000123. Existing references never change.
  referencePrefix: z.string().regex(/^[A-Z]{2,6}$/, 'Use 2–6 capital letters'),
  referenceIncludeYear: z.boolean(),
  // How dates are shown throughout the interface.
  dateFormat: z.enum(['DAY_MONTH_YEAR', 'ISO']),
  // Shown in the sidebar footer and on Infrastructure Status to identify the deployment owner.
  adminNumber: z.string().trim().max(20).regex(/^[A-Za-z0-9-]*$/, 'Letters, digits and hyphens only'),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingKeys = Object.keys(settingsSchema.shape) as (keyof Settings)[];

export const defaultSettings = (): Settings => ({
  institutionName: 'CFS University',
  institutionLogo: null,
  defaultAcademicYear: '2026/2027',
  offerResponseDays: 14,
  requireRejectionReason: true,
  reviewTargetDays: 7,
  referencePrefix: 'ADM',
  referenceIncludeYear: true,
  dateFormat: 'DAY_MONTH_YEAR',
  adminNumber: (process.env.STUDENT_ADMIN_NUMBER ?? '').trim().slice(0, 20),
});

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: keyof Settings; value: unknown }>('SELECT key, value FROM system_settings');
  const stored = Object.fromEntries(rows.filter(row => settingKeys.includes(row.key)).map(row => [row.key, row.value]));
  const merged = { ...defaultSettings(), ...stored };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultSettings();
}

const publicKeys = ['institutionName', 'institutionLogo', 'dateFormat', 'adminNumber', 'defaultAcademicYear'] as const;

export function settingsRoutes({ pool }: Services) {
  const router = Router();

  router.get('/settings', async (_req, res) => data(res, await loadSettings(pool)));

  router.patch('/settings', requireRole('ADMIN'), async (req, res) => {
    const input = read(settingsSchema.partial().strict(), req.body);
    const keys = Object.keys(input) as (keyof Settings)[];
    if (!keys.length) invalid('Provide at least one setting.');
    const actor = viewer(res).user.id;
    data(res, await transaction(pool, async db => {
      const before = await loadSettings(db);
      const changed = keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(input[key]));
      for (const key of changed) {
        await db.query(
          `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = clock_timestamp()`,
          [key, JSON.stringify(input[key]), actor],
        );
      }
      if (changed.length) {
        // Record what changed without copying the logo image into the log.
        const metadata = Object.fromEntries(changed.map(key => [key, key === 'institutionLogo' ? (input[key] ? 'updated' : 'removed') : String(input[key])]));
        await record(db, actor, 'SETTINGS_UPDATED', 'SETTING', null, 'Updated ' + changed.length + ' system setting' + (changed.length === 1 ? '' : 's'), metadata);
      }
      return loadSettings(db);
    }));
  });

  return router;
}

/** Branding needed before sign-in. */
export function publicSettingsRoute({ pool }: Services) {
  const router = Router();
  router.get('/settings/public', async (_req, res) => {
    const settings = await loadSettings(pool);
    res.set('Cache-Control', 'no-cache');
    data(res, Object.fromEntries(publicKeys.map(key => [key, settings[key]])));
  });
  return router;
}
