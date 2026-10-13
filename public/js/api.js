// fetch wrapper: returns parsed JSON, or throws an Error carrying the API's { error, message }.
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Network error. Check your connection and try again.'), { code: 'NETWORK', status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || 'Something went wrong, please try again.'), {
      code: data.error || 'INTERNAL',
      status: res.status,
      data,
    });
  }
  return data;
}
