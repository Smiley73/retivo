// RS256 signing-key registry: private and public maps share one `kid` set; the current kid signs, verify accepts any, and the public map is
// served at `/auth/.well-known/jwks.json`. Rotate by adding a pair, switching current, waiting out the access-token TTL, removing the old.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey } from 'node:crypto';
import type { EnvConfig } from '../common/env.config.js';

/** RFC 7517 JWK of one public key, from `KeyObject.export({ format: jwk })` with `kid`, `use` and `alg` added. */
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
      // env.config.ts already verified `explicit` is in the private map and the kid sets match.
      this.currentKid = explicit;
      return;
    }
    const first = Object.keys(this.privateKeys)[0];
    if (!first) {
      throw new Error('AUTH_JWT_PRIVATE_KEYS contains no keys');
    }
    this.currentKid = first;
  }

  /** Kid and private PEM for signing a new access token. */
  current(): { kid: string; privateKey: string } {
    return { kid: this.currentKid, privateKey: this.privateKeys[this.currentKid] };
  }

  /** Public PEM by kid for verification; null on an unknown kid. */
  publicFor(kid: string): string | null {
    return this.publicKeys[kid] ?? null;
  }

  /** Renders every active public key as a JWK for the JWKS endpoint. */
  jwks(): JwksKey[] {
    return Object.entries(this.publicKeys).map(([kid, pem]) => {
      const jwk = createPublicKey(pem).export({ format: 'jwk' });
      return { ...jwk, kid, use: 'sig' as const, alg: 'RS256' as const };
    });
  }
}
