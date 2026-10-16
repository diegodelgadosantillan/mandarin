import { isIOS } from '../core/platform.ts';

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Hand a generated file to the user.
 *
 * On iOS, `<a download>` is unreliable — inside a home-screen app it can do
 * nothing at all — so the system share sheet is used instead, which offers
 * "Guardar en Archivos", iCloud Drive and AirDrop. Everywhere else a plain
 * download is what people expect.
 */
export async function saveFile(blob: Blob, fileName: string): Promise<SaveOutcome> {
  if (isIOS() && typeof navigator.share === 'function') {
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fileName });
        return 'shared';
      } catch (error) {
        // Closing the share sheet is not an error worth reporting.
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
        // Anything else: fall through to the download path.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
