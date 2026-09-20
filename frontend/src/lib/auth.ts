import { useCallback, useEffect, useRef, useState } from 'react';
import { request, ApiError } from './api';
import { uploadImage, type ResizeOptions, type UploadResult } from './images';

/**
 * Session handling.
 *
 * The access token is held in memory only — never localStorage — so an XSS
 * bug cannot lift a long-lived credential. Reloads are covered by the
 * httpOnly refresh cookie, which is exchanged for a fresh access token on
 * mount and again shortly before the current one expires.
 */

export type SessionUser = {
  id: number;
  name?: string;
  email?: string;
  username?: string;
  role: 'admin' | 'receptionist' | 'doctor';
  specialty?: string;
};

type LoginResponse = {
  accessToken: string;
  user: SessionUser;
  /** When the signed-in device will need a password again. */
  sessionExpiresAt?: string;
};

// Access tokens live 15 minutes; refresh a little early so a request in flight
// never lands on an expired token.
const REFRESH_INTERVAL_MS = 12 * 60 * 1000;

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);

  const applySession = useCallback((payload: LoginResponse) => {
    setToken(payload.accessToken);
    setUser(payload.user);
    setSessionExpiresAt(payload.sessionExpiresAt ?? null);
    setError('');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await request<LoginResponse>('/api/auth/refresh', { method: 'POST' });
      applySession(payload);
      return true;
    } catch {
      setToken(null);
      setUser(null);
      setSessionExpiresAt(null);
      return false;
    }
  }, [applySession]);

  // Restore an existing session on mount.
  useEffect(() => {
    void refresh().finally(() => setRestoring(false));
  }, [refresh]);

  // Keep it alive while the tab is open.
  useEffect(() => {
    if (!token) return;
    timer.current = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [token, refresh]);

  /**
   * Re-check the session whenever the tab comes back to the foreground.
   *
   * This is what makes the panel feel "always open" for the doctors. A laptop
   * that slept through the night has a long-dead access token and a timer that
   * never fired, so without this the first click after opening the lid would
   * fail. Refreshing on focus means the panel is already signed in by the time
   * anyone touches it.
   */
  useEffect(() => {
    if (!token) return;

    const onWake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [token, refresh]);

  const login = useCallback(
    async (credentials: { email?: string; password: string; username?: string }, kind: 'staff' | 'doctor') => {
      setError('');
      try {
        const payload = await request<LoginResponse>(
          kind === 'doctor' ? '/api/auth/doctor-login' : '/api/auth/login',
          { method: 'POST', body: credentials },
        );
        applySession(payload);
        return true;
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Sign-in failed.');
        return false;
      }
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await request('/api/auth/logout', { method: 'POST', token });
    } catch {
      /* the local session is cleared either way */
    }
    setToken(null);
    setUser(null);
    setSessionExpiresAt(null);
  }, [token]);

  /** Wraps `request` so a 401 triggers one refresh-and-retry. */
  const authed = useCallback(
    async <T,>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
      try {
        return await request<T>(path, { ...options, token });
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          const payload = await request<LoginResponse>('/api/auth/refresh', { method: 'POST' });
          applySession(payload);
          return request<T>(path, { ...options, token: payload.accessToken });
        }
        throw caught;
      }
    },
    [token, applySession],
  );

  /**
   * Uploads an image with the current access token, refreshing once if it has
   * expired — the same contract as `authed`, but for multipart bodies.
   */
  const upload = useCallback(
    async (file: File, options?: ResizeOptions): Promise<UploadResult> => {
      try {
        return await uploadImage(file, token, options);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          const payload = await request<LoginResponse>('/api/auth/refresh', { method: 'POST' });
          applySession(payload);
          return uploadImage(file, payload.accessToken, options);
        }
        throw caught;
      }
    },
    [token, applySession],
  );

  return { user, token, sessionExpiresAt, restoring, error, login, logout, authed, upload, setError };
}
