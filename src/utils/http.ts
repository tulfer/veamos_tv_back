import axios from 'axios';

export const httpClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/json,*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  },
  maxRedirects: 5,
});

export async function fetchHTML(url: string): Promise<string> {
  const response = await httpClient.get(url);
  return response.data;
}

export async function fetchHTMLWithReferer(url: string, referer: string): Promise<string> {
  const response = await httpClient.get(url, {
    headers: { Referer: referer },
  });
  return response.data;
}

export async function fetchJSON<T>(url: string): Promise<T> {
  const response = await httpClient.get(url, {
    headers: { Accept: 'application/json' },
  });
  return response.data;
}
