import type { DesktopApi } from '../desktop'

export function desktop(): DesktopApi {
  if (typeof window === 'undefined' || !window.pgdevDesktop) {
    throw new Error('pgDEV must be opened in the desktop application')
  }
  return window.pgdevDesktop
}

export function confirmAction(message: string): Promise<boolean> {
  return desktop().confirm(message)
}
