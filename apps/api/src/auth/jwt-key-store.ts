/**
 * JWT signing-key registry for RS256.
 *
 * Holds two maps keyed by the same `kid` set:
 *   AUTH_JWT_PRIVATE_KEYS: { kid → PKCS#8 PEM private key }  // sign
 *   AUTH_JWT_PUBLIC_KEYS:  { kid → SPKI PEM public key }     // verify + JWKS
 *
 * The "current" kid signs new access tokens; verify accepts any kid in
 * the public map; the public map is also surfaced verbatim by
 * `GET /auth/.well-known/jwks.json`. Rotation = add a new kid pair to
 * both SSM parameters, switch the current pointer, wait ≥ access-token
 * TTL, remove the old. The cross-validation in env.config.ts ensures
 * the two maps stay in sync.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey } from 'node:crypto';
import type { EnvConfig } from '../common/env.config.js';

/**
 * RFC 7517 JWK rendering of one public key. We don't enumerate every
 * possible JWK field — the shape comes straight from
 * `KeyObject.export({ format: 'jwk' })` and just gets `kid`/`use`/`alg`
 * stamped on top.
 */
export type JwksKey = {
  kid: string;
  use: 'sig';
  alg: 'RS256';
} & Record<string, unknown>;

@Injectable()
export class JwtKeyStore implements OnModuleInit {
  private privateKeys: Record<string, string> = {};
  private publicKeys: Record<string, string> = {};
  private currentKid: string = '';

  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  onModuleInit(): void {
    this.privateKeys = { ...this.config.get('AUTH_JWT_PRIVATE_KEYS', { infer: true }) };
    this.publicKeys = { ...this.config.get('AUTH_JWT_PUBLIC_KEYS', { infer: true }) };
    const explicit = this.config.get('AUTH_JWT_CURRENT_KID', { infer: true });
    if (explicit) {
      // env.config.ts already verified `explicit` is in the private map
      // (and that the maps' kid sets match).
      this.currentKid = explicit;
      return;
    }
    const first = Object.keys(this.privateKeys)[0];
    if (!first) {
      throw new Error('AUTH_JWT_PRIVATE_KEYS contains no keys');
    }
    this.currentKid = first;
  }

  /** Kid + private PEM for signing a freshly issued access token. */
  current(): { kid: string; privateKey: string } {
    return { kid: this.currentKid, privateKey: this.privateKeys[this.currentKid] };
  }

  /** Look up a public PEM by kid for verification. Returns null on unknown kid. */
  publicFor(kid: string): string | null {
    return this.publicKeys[kid] ?? null;
  }

  /**
   * Render every active public key as a JWK (RFC 7517) for the
   * `/auth/.well-known/jwks.json` endpoint. Node's `createPublicKey`
   * handles the SPKI → JWK conversion natively, so we just attach the
   * `kid`, `use`, and `alg` metadata.
   */
  jwks(): JwksKey[] {
    return Object.entries(this.publicKeys).map(([kid, pem]) => {
      const jwk = createPublicKey(pem).export({ format: 'jwk' });
      return { ...jwk, kid, use: 'sig' as const, alg: 'RS256' as const };
    });
  }
}
