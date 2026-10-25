// Marks a handler or controller as publicly reachable (bypassing JwtAuthGuard); use sparingly, since every route is protected by default.
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
