/**
 * Hub de eventos en tiempo real para el panel /mipanel.
 *
 * Los servicios que escriben en la base (device-codes, app-versions) emiten
 * eventos al guardar; el endpoint GET /devices/events los reenvía como
 * Server-Sent Events a los clientes conectados. Así el panel se actualiza
 * cuando hay un cambio real (ej: un código es tomado por un dispositivo) sin
 * necesidad de polling.
 *
 * Nota: el hub es en memoria (una instancia del proceso). Los clientes SSE se
 * reconectan solos, así que ante un reinicio del servidor se re-sincronizan al
 * volver a conectarse (el panel hace un load inicial al abrir la conexión).
 */

type RealtimeListener = (frame: string) => void;

const listeners = new Set<RealtimeListener>();

export function subscribeRealtime(listener: RealtimeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Envía un evento SSE a todos los suscriptores (ej: 'codes', 'versions'). */
export function broadcastRealtime(channel: string, payload: unknown = {}): void {
  const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch {
      /* un suscriptor fallido no debe romper el broadcast */
    }
  }
}