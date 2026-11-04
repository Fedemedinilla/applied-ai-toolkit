// Which install instructions to show, from what the browser reports about itself.

export type Os = 'ios' | 'android' | 'other';

export interface PlatformInput {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** matchMedia('(display-mode: standalone)').matches */
  readonly displayStandalone: boolean;
  /** navigator.standalone, which only iOS Safari has. */
  readonly navigatorStandalone: boolean | undefined;
}

export interface Platform {
  readonly os: Os;
  /** Opened from the home screen or as an installed app. */
  readonly installed: boolean;
  /**
   * On iPhone and iPad, web push exists only inside a web app added to the home screen. In a
   * Safari tab there is no PushManager and no permission to ask for, so the page explains the
   * install step instead of offering a button that cannot work.
   */
  readonly pushNeedsInstall: boolean;
}

export function detectPlatform(input: PlatformInput): Platform {
  const ua = input.userAgent;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const ios = /iPhone|iPad|iPod/u.test(ua) || (/Macintosh/u.test(ua) && input.maxTouchPoints > 1);
  const os: Os = ios ? 'ios' : /Android/u.test(ua) ? 'android' : 'other';
  const installed = input.displayStandalone || input.navigatorStandalone === true;
  return { os, installed, pushNeedsInstall: os === 'ios' && !installed };
}
