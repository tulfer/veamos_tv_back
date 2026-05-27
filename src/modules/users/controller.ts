import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as userService from './service';
import { logger } from '../../utils/logger';
import { UserProfile, FavoriteItem, ContinueWatchingItem } from '../../types';

const profileSchema = z.object({
  name: z.string().min(1).max(50),
  avatar: z.string().optional(),
  pin: z.string().optional(),
  isChild: z.boolean().default(false),
});

const favoriteSchema = z.object({
  id: z.string(),
  title: z.string(),
  poster: z.string().optional(),
  type: z.enum(['movie', 'series', 'live']),
});

const continueSchema = z.object({
  id: z.string(),
  title: z.string(),
  poster: z.string().optional(),
  type: z.enum(['movie', 'series', 'live']),
  progress: z.number().min(0),
  duration: z.number().min(0),
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
  episodeTitle: z.string().optional(),
});

export async function getOrCreateUserHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid, email } = (request as any).user;
  const user = await userService.getOrCreateUser(uid, email);
  return reply.send(user);
}

export async function getProfilesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const profiles = await userService.getProfiles(uid);
  return reply.send({ profiles });
}

export async function createProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const data = profileSchema.parse(request.body);
  const profile: UserProfile = {
    id: `profile_${Date.now()}`,
    name: data.name,
    avatar: data.avatar,
    pin: data.pin,
    isChild: data.isChild ?? false,
  };
  await userService.addProfile(uid, profile);
  return reply.status(201).send(profile);
}

export async function getFavoritesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const items = await userService.getFavorites(uid, profileId);
  return reply.send({ items });
}

export async function addFavoriteHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const data = favoriteSchema.parse(request.body);
  const item: FavoriteItem = {
    id: data.id,
    title: data.title,
    poster: data.poster,
    type: data.type,
    addedAt: Date.now(),
  };
  await userService.addFavorite(uid, profileId, item);
  return reply.status(201).send({ message: 'Favorite added' });
}

export async function removeFavoriteHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId, itemId } = request.params as any;
  await userService.removeFavorite(uid, profileId, itemId);
  return reply.send({ message: 'Favorite removed' });
}

export async function getContinueWatchingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const items = await userService.getContinueWatching(uid, profileId);
  return reply.send({ items });
}

export async function upsertContinueWatchingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const data = continueSchema.parse(request.body);
  const item: ContinueWatchingItem = {
    id: data.id,
    title: data.title,
    poster: data.poster,
    type: data.type,
    progress: data.progress,
    duration: data.duration,
    seasonNumber: data.seasonNumber,
    episodeNumber: data.episodeNumber,
    episodeTitle: data.episodeTitle,
    updatedAt: Date.now(),
  };
  await userService.upsertContinueWatching(uid, profileId, item);
  return reply.send({ message: 'Progress updated' });
}

export async function getHistoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const items = await userService.getHistory(uid, profileId);
  return reply.send({ items });
}

export async function getRecommendationsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { uid } = (request as any).user;
  const { profileId } = request.params as any;
  const items = await userService.getRecommendations(uid, profileId);
  return reply.send({ items });
}
