import { describe, expect, it } from 'vitest';
import { pickChineseVoice } from '../src/audio/speech.ts';

function voice(name: string, lang: string, localService = true): SpeechSynthesisVoice {
  return { name, lang, localService, voiceURI: name, default: false } as SpeechSynthesisVoice;
}

const pick = (voices: SpeechSynthesisVoice[]): string | null => pickChineseVoice(voices)?.name ?? null;

describe('pickChineseVoice', () => {
  it('prefers Tingting over the Eloquence voices macOS lists first', () => {
    // The order Chrome on macOS actually reports.
    const mac = [
      voice('Samantha', 'en-US'),
      voice('Eddy (Chinese (China mainland))', 'zh-CN'),
      voice('Eddy (Chinese (Taiwan))', 'zh-TW'),
      voice('Flo (Chinese (China mainland))', 'zh-CN'),
      voice('Grandma (Chinese (China mainland))', 'zh-CN'),
      voice('Meijia', 'zh-TW'),
      voice('Reed (Chinese (China mainland))', 'zh-CN'),
      voice('Shelley (Chinese (China mainland))', 'zh-CN'),
      voice('Tingting', 'zh-CN'),
    ];
    expect(pick(mac)).toBe('Tingting');
  });

  it('still uses an Eloquence voice when it is the only simplified one', () => {
    expect(pick([voice('Meijia', 'zh-TW'), voice('Eddy (Chinese (China mainland))', 'zh-CN')])).toBe(
      'Eddy (Chinese (China mainland))',
    );
  });

  it('prefers a natural voice on Windows', () => {
    const windows = [
      voice('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'),
      voice('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', 'zh-CN', false),
    ];
    expect(pick(windows)).toBe('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)');
  });

  it('accepts the cmn-Hans-CN form and falls back to any Chinese', () => {
    expect(pick([voice('Chinese', 'cmn-Hans-CN')])).toBe('Chinese');
    expect(pick([voice('粵語', 'zh-HK')])).toBe('粵語');
  });

  it('returns null without a Chinese voice', () => {
    expect(pick([voice('Samantha', 'en-US')])).toBeNull();
  });
});
