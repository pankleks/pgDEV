export interface DesktopSettings {
  editorFontSize: number
  statementTimeout: number
  maxRows: number
}

export const SETTING_LIMITS = {
  editorFontSize: { min: 8, max: 32, fallback: 14 },
  statementTimeout: { min: 1, max: 600, fallback: 30 },
  maxRows: { min: 1, max: 10_000, fallback: 500 },
} as const

function clamp(value: unknown, limits: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.fallback
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

/** Same font/timeout defaults and clamping rules as the original Vue settings. */
export function sanitizeSettings(value: unknown): DesktopSettings {
  const record = value && typeof value === 'object' ? value as Partial<DesktopSettings> : {}
  return {
    editorFontSize: clamp(record.editorFontSize, SETTING_LIMITS.editorFontSize),
    statementTimeout: clamp(record.statementTimeout, SETTING_LIMITS.statementTimeout),
    maxRows: clamp(record.maxRows, SETTING_LIMITS.maxRows),
  }
}

export interface SettingsRecord { version: 1; settings: DesktopSettings }
export function settingsRecord(settings: DesktopSettings): SettingsRecord {
  return { version: 1, settings: sanitizeSettings(settings) }
}
export function parseSettingsRecord(value: unknown): SettingsRecord {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('settings' in value) || !value.settings || typeof value.settings !== 'object') {
    throw new Error('Invalid or unsupported saved settings')
  }
  return settingsRecord(sanitizeSettings(value.settings))
}
