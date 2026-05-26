import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { getFirebaseAuth } from '../../config/firebase';
import { logger } from '../../utils/logger';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface AuthUser {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
}

export function generateTokens(uid: string, email: string): TokenPair {
  const accessToken = jwt.sign(
    { uid, email },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as any },
  );

  const refreshToken = jwt.sign(
    { uid, email, type: 'refresh' },
    env.JWT_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any },
  );

  const expiresIn = parseTimeToSeconds(env.JWT_EXPIRES_IN);

  return { accessToken, refreshToken, expiresIn };
}

export function verifyToken(token: string): { uid: string; email: string } {
  return jwt.verify(token, env.JWT_SECRET) as { uid: string; email: string };
}

export function refreshTokens(refreshToken: string): TokenPair | null {
  try {
    const decoded = jwt.verify(refreshToken, env.JWT_SECRET) as any;
    if (decoded.type !== 'refresh') return null;
    return generateTokens(decoded.uid, decoded.email);
  } catch {
    return null;
  }
}

export async function verifyFirebaseToken(idToken: string): Promise<AuthUser | null> {
  try {
    const decoded = await getFirebaseAuth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email || '',
      displayName: decoded.name,
      photoURL: decoded.picture,
    };
  } catch (error) {
    logger.error({ error }, 'Firebase token verification failed');
    return null;
  }
}

function parseTimeToSeconds(time: string): number {
  const match = time.match(/^(\d+)([dhms])$/);
  if (!match) return 604800;
  const value = parseInt(match[1]);
  switch (match[2]) {
    case 'd': return value * 86400;
    case 'h': return value * 3600;
    case 'm': return value * 60;
    case 's': return value;
    default: return 604800;
  }
}
