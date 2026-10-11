/**
 * Marks a handler (or controller) as publicly reachable - both the global
 * JwtAuthGuard and RolesGuard bypass it. Use sparingly; every non-public
 * route must be protected by default.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
