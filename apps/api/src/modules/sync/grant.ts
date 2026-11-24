import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { OFFLINE_GRANT_MAX_AGE_MS } from '@pdv/shared';
import type { OfflineGrantClaims, Role } from '@pdv/shared';
import { errors } from '../../shared/errors.js';

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

/**
 * Autorização offline assinada (HMAC-SHA256, chave derivada do segredo do servidor via HKDF).
 * Só o servidor emite e verifica; o cliente a trata como opaca (só lê as datas para a interface).
 * Não pode ser renovada sem o servidor e vale no máximo 8 h.
 */
export function createGrantSigner(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'pdv-offline-grant', 'v1', 32));
  const mac = (data: string): Buffer => createHmac('sha256', key).update(data).digest();

  return {
    issue(user: { id: string; role: Role }, deviceId: string, now = Date.now()) {
      const claims: OfflineGrantClaims = {
        v: 1,
        sub: user.id,
        role: user.role,
        did: deviceId,
        iat: now,
        exp: now + OFFLINE_GRANT_MAX_AGE_MS,
        jti: randomUUID(),
      };
      const body = b64u(JSON.stringify(claims));
      return { grant: `${body}.${b64u(mac(body))}`, claims };
    },

    /** Verifica assinatura e estrutura. A expiração é avaliada por operação, não aqui. */
    verify(token: string): OfflineGrantClaims {
      const [body, sig, extra] = token.split('.');
      if (!body || !sig || extra !== undefined)
        throw errors.unauthorized('Autorização offline inválida');
      const expected = mac(body);
      const given = Buffer.from(sig, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw errors.unauthorized('Autorização offline inválida');
      }
      try {
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as OfflineGrantClaims;
        if (claims.v !== 1 || !claims.sub || !claims.did || !(claims.exp > claims.iat))
          throw new Error();
        if (claims.exp - claims.iat > OFFLINE_GRANT_MAX_AGE_MS) throw new Error();
        return claims;
      } catch {
        throw errors.unauthorized('Autorização offline inválida');
      }
    },
  };
}
export type GrantSigner = ReturnType<typeof createGrantSigner>;
