// FIXTURE — intentionally contains forbidden brand tokens.
// This file is never shipped (tests/ is excluded from the brand-gate scan and
// from `npm pack`); it only proves that the gate actually catches violations.
export const LEGACY_COOKIE = 'initech_auth';
export const LEGACY_CLASS = '.initech-sidebar';
export const LEGACY_HOST = 'https://initech.local';
