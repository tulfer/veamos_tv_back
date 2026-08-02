import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { generateTokens, refreshTokens, verifyExternalToken } from './service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const externalTokenSchema = z.object({
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

export async function externalTokenLoginHandler(request: FastifyRequest, reply: FastifyReply) {
  const { idToken } = externalTokenSchema.parse(request.body);

  const user = await verifyExternalToken(idToken);
  if (!user) {
    return reply.status(401).send({ error: 'Invalid token' });
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
