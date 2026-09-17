// Minimal stand-in for the Supabase client, for API tests that don't need a real database.
export function fakeDb({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  return {
    calls,
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
        order: () => request,
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
