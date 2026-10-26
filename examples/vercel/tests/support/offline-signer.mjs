import { generateKeyPairSync, sign } from 'node:crypto';
import nock from 'nock';
import { DESTINATION_PATH } from '../../src/config.mjs';

export const receiverIdentity = {
  path: DESTINATION_PATH,
  projectId: 'prj_synthetic',
  environment: 'production',
  ownerId: 'team_synthetic',
  issuer: 'https://oidc.vercel.com',
  audience: 'https://vercel.com/synthetic-team',
};

// Test-only JWT/JWKS fixtures follow the pinned SDK's verifier source. There is
// deliberately no production switch for replacing Vercel's signing keys.
export function offlineSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'ephemeral-offline-test-key';
  nock.disableNetConnect();
  const scope = nock('https://oidc.vercel.com')
    .persist().get('/.well-known/jwks')
    .reply(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
  return {
    token(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: receiverIdentity.issuer, aud: receiverIdentity.audience,
        iat: now, exp: now + 120,
        owner_id: receiverIdentity.ownerId, project_id: receiverIdentity.projectId,
        environment: receiverIdentity.environment,
        connect: { purpose: 'mcp_event_delivery', version: 1, destinationPath: DESTINATION_PATH },
        ...overrides,
      };
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(claims)}`;
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
    },
    request(delivery, { token, ...options } = {}) {
      return new Request(`https://receiver.invalid${DESTINATION_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(delivery),
        ...options,
      });
    },
    close() {
      const used = scope.isDone();
      nock.cleanAll();
      nock.enableNetConnect();
      return used;
    },
  };
}
