import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('hashes and verifies credentials in the actual workerd Web Crypto runtime', async () => {
  const code = ts
    .transpileModule(readFileSync('worker/credential.ts', 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/export /g, '');
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-09-19',
      script: `${code}
    export default { async fetch() {
      const password = 'test-only-workerd-credential-827139';
      const verifier = await createVerifier(password);
      return Response.json({ valid: await verifyCredential(password, verifier), wrong: await verifyCredential('wrong', verifier), format: validVerifier(verifier), plaintext: verifier.includes(password) });
    }};`,
    }),
  );
  try {
    const response = await runtime.dispatchFetch('https://test.local/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      valid: true,
      wrong: false,
      format: true,
      plaintext: false,
    });
  } finally {
    await runtime.dispose();
  }
});
