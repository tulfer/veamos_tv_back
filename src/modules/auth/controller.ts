import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { generateTokens, refreshTokens, verifyFirebaseToken } from './service';
import { logger } from '../../utils/logger';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const firebaseLoginSchema = z.object({
  idToken: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const { email } = loginSchema.parse(request.body);
  const uid = `user_${Buffer.from(email).toString('base64url').substring(0, 10)}`;

  const tokens = generateTokens(uid, email);

  return reply.send({
    user: { uid, email },
    ...tokens,
  });
}

export async function firebaseLoginHandler(request: FastifyRequest, reply: FastifyReply) {
  const { idToken } = firebaseLoginSchema.parse(request.body);

  const user = await verifyFirebaseToken(idToken);
  if (!user) {
    return reply.status(401).send({ error: 'Invalid Firebase token' });
  }

  const tokens = generateTokens(user.uid, user.email);

  return reply.send({
    user,
    ...tokens,
  });
}

export async function refreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const { refreshToken } = refreshSchema.parse(request.body);

  const tokens = refreshTokens(refreshToken);
  if (!tokens) {
    return reply.status(401).send({ error: 'Invalid or expired refresh token' });
  }

  return reply.send(tokens);
}

export async function meHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = (request as any).user;
  return reply.send({ user });
}
