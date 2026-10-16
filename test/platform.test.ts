import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIOS, isMac, isSafari } from '../src/core/platform.ts';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ pretends to be a Mac.
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
};

function as(userAgent: string, maxTouchPoints = 0): void {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
}

afterEach(() => vi.unstubAllGlobals());

describe('platform detection', () => {
  it('detects iPhone Safari', () => {
    as(UA.iphoneSafari, 5);
    expect(isIOS()).toBe(true);
    expect(isSafari()).toBe(true);
    expect(isMac()).toBe(false);
  });

  it('treats Chrome on iPhone as iOS but not as Safari', () => {
    as(UA.iphoneChrome, 5);
    expect(isIOS()).toBe(true);
    expect(isSafari()).toBe(false);
  });

  it('recognises an iPad masquerading as a Mac by its touch points', () => {
    as(UA.ipadDesktopMode, 5);
    expect(isIOS()).toBe(true);
    expect(isMac()).toBe(false);
  });

  it('detects a real Mac with Safari', () => {
    as(UA.macSafari, 0);
    expect(isMac()).toBe(true);
    expect(isIOS()).toBe(false);
    expect(isSafari()).toBe(true);
  });

  it('does not mistake Chrome or Edge for Safari', () => {
    as(UA.macChrome, 0);
    expect(isSafari()).toBe(false);
    as(UA.windowsEdge, 0);
    expect(isSafari()).toBe(false);
    expect(isIOS()).toBe(false);
    expect(isMac()).toBe(false);
  });
});
