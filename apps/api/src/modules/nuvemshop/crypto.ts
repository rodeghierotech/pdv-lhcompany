import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Cifragem das credenciais em repouso: AES-256-GCM, formato v1.<iv>.<tag>.<dados> (base64url). */
export function createCredentialCipher(jwtSecret: string, explicitKey?: string) {
  const key = Buffer.from(
    hkdfSync('sha256', explicitKey ?? jwtSecret, 'pdv-integration-credentials', 'v1', 32),
  );
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    decrypt(token: string): string {
      const [v, iv, tag, data] = token.split('.');
      if (v !== 'v1' || !iv || !tag || !data) throw new Error('credencial em formato inválido');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
export type CredentialCipher = ReturnType<typeof createCredentialCipher>;
