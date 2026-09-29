// The session itself is an HttpOnly cookie. JavaScript never reads or stores it.
export async function privateFetch(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (body.code === 'auth_required' && typeof window !== 'undefined')
      window.dispatchEvent(new Event('household-unauthorized'));
  }
  return response;
}
export async function accessRequest(
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const response = await privateFetch(`/api/auth/${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || 'Household access is unavailable. Please retry.');
  return result;
}
