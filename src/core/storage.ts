/**
 * Ask the browser to keep this app's storage instead of evicting it.
 *
 * Safari deletes script-written storage (IndexedDB included) for sites not
 * opened in 7 days, and every browser may evict under disk pressure. Installed
 * home-screen apps are exempt from Safari's 7-day rule, but asking costs
 * nothing and protects the plain-tab case too.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean | null> {
  try {
    return navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  } catch {
    return null;
  }
}
