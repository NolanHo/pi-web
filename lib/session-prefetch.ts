/**
 * In-flight dedupe for the session context payload.
 *
 * The sidebar session list is the bottleneck that gates ChatWindow mount, so a
 * deep link (?session=ID) used to serialize: list → restore → context fetch.
 * AppShell now fires the context request at page load; when useAgentSession
 * later needs the same payload it reuses the in-flight request.
 *
 * Only the promise is cached (not the result): once the request settles the
 * map entry is dropped, so a later load always fetches fresh data. Callers
 * other than the first must not consume the Response body.
 */

const inFlight = new Map<string, Promise<Response>>();

export function fetchSessionData(sid: string): Promise<Response> {
  const existing = inFlight.get(sid);
  if (existing) return existing;
  const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
  const promise = fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`).finally(() => {
    inFlight.delete(sid);
  });
  inFlight.set(sid, promise);
  return promise;
}
