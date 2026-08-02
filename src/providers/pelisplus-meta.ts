import * as cheerio from 'cheerio';
import { CastMember } from '../types';

/**
 * Extractores para el tema actual de pelisplushd.la.
 * Estructura verificada del detalle:
 * - Sinopsis: primer <div class="text-large"> dentro de .page-container
 * - Póster:   primer <img src="/poster/...">
 * - Géneros:  <a href="/generos/..."> dentro de .page-container (el menú lateral usa la misma ruta, por eso el scope)
 * - Cast:     <a href="/actor/...">
 * - Rating:   <span class="... ion-md-star"> 8.0/10
 * - Año:      <a href="/year/NNNN"><span class="font-size-18"> NNNN </span></a> o "Fecha de estreno: NNNN" o (NNNN) del <title>
 */

export interface DetailMeta {
  description: string;
  genres: string[];
  cast: CastMember[];
  rating: number;
  year: number;
  poster: string;
}

export function extractDetailMeta($: cheerio.CheerioAPI): DetailMeta {
  const description =
    $('.page-container .text-large').first().text().trim() || 'Description not available';

  const poster = $('img[src^="/poster/"]').first().attr('src') || '';

  const genres: string[] = [];
  $('.page-container a[href^="/generos/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length < 30 && !g.toLowerCase().includes('ver')) genres.push(g);
  });

  const cast: CastMember[] = [];
  $('.page-container a[href^="/actor/"]').each((_, el) => {
    const name = $(el).text().trim();
    if (name && name.length < 50) cast.push({ name });
  });

  const ratingText = $('.page-container [class*="ion-md-star"]').first().text().trim();
  const ratingMatch = ratingText.match(/([\d.]+)\/10/);

  const yearLink = parseInt($('.page-container a[href^="/year/"] .font-size-18').first().text().trim() || '') || 0;
  const yearSectionText = $('.sectionDetail:contains("Fecha de estreno")').text();
  const yearSectionMatch = yearSectionText.match(/\b(19|20)\d{2}\b/);
  const yearSection = yearSectionMatch ? parseInt(yearSectionMatch[0]) : 0;
  const titleMatch = $('title').text().match(/\((\d{4})\)/);
  const yearTitle = titleMatch ? parseInt(titleMatch[1]) : 0;

  return {
    description,
    genres: [...new Set(genres)],
    cast,
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : 0,
    year: yearLink || yearSection || yearTitle || 0,
    poster,
  };
}
