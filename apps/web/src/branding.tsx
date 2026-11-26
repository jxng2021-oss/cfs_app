import { createContext, useContext } from 'react';
import type { PublicSettings } from './api.js';

/** Institution branding and display settings, loaded before sign-in and refreshed after Settings changes. */
export const defaultBranding: PublicSettings = { institutionName: 'CFS University', institutionLogo: null, dateFormat: 'DAY_MONTH_YEAR', adminNumber: '', defaultAcademicYear: '2026/2027' };
export const BrandingContext = createContext<{ settings: PublicSettings; refresh: () => void }>({ settings: defaultBranding, refresh: () => undefined });
export const useBranding = () => useContext(BrandingContext);
