// Minimal stand-in for the Supabase client, for API tests that don't need a real database.
export function fakeDb({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  return {
    calls,
    // storage ops: upload/remove resolve ok; override by replacing db.storage in a test.
    storage: {
      from: (bucket) => ({
        upload: (path, body, opts) => {
          calls.push({ storage: bucket, op: 'upload', path, size: body?.length, contentType: opts?.contentType });
          return Promise.resolve({ data: { path }, error: null });
        },
        download: (path) => {
          calls.push({ storage: bucket, op: 'download', path });
          return Promise.resolve({ data: new Blob([]), error: null });
        },
        list: (prefix, opts) => {
          calls.push({ storage: bucket, op: 'list', prefix, opts });
          return Promise.resolve({ data: [], error: null });
        },
        remove: (paths) => {
          calls.push({ storage: bucket, op: 'remove', paths });
          return Promise.resolve({ data: [], error: null });
        },
      }),
    },
    rpc(fn, args) {
      calls.push({ fn, args });
      const handler = rpc[fn];
      return Promise.resolve(handler ? handler(args) : { data: null, error: null });
    },
    from(table) {
      calls.push({ table });
      const result = tables[table] ?? { data: [], error: null };
      const request = {
        select: () => request,
        eq: () => request,
        not: () => request,
        order: () => request,
        in: () => request,
        then: (resolve, reject) =>
          Promise.resolve(typeof result === 'function' ? result() : result).then(resolve, reject),
      };
      return request;
    },
  };
}

export const testConfig = {
  supabaseUrl: 'http://fake.local',
  supabaseSecretKey: 'fake',
  adminPassword: 'correct horse battery staple',
  sessionSecret: 's'.repeat(32),
  eventTitle: 'Test Event',
  isProduction: false,
};
