export async function readSessionValue<T>(key: string, fallback: T): Promise<T> {
  const data = await chrome.storage.session.get(key);
  return (data[key] as T | undefined) ?? fallback;
}

export async function writeSessionValue<T>(key: string, value: T): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function removeSessionValue(key: string): Promise<void> {
  await chrome.storage.session.remove(key);
}
