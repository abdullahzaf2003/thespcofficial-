import { verifyAccessToken } from '../domain/tokens.js';

/**
 * Role-based guard. `subjectType` is 'staff' (admin/receptionist) or 'doctor';
 * `role` narrows staff further. Every protected route names the roles it
 * accepts, so adding an endpoint without a guard is a visible omission.
 */
export function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: 'Authentication required.' });

    try {
      const claims = verifyAccessToken(token);
      req.auth = {
        id: Number(claims.sub),
        subjectType: claims.typ,
        role: claims.role,
        name: claims.name,
      };

      if (roles.length && !roles.includes(claims.role)) {
        return res.status(403).json({ message: 'You do not have access to this resource.' });
      }
      return next();
    } catch {
      return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
    }
  };
}

/** Doctors may only ever touch their own records (Section 9). */
export function scopedToDoctor(req) {
  return req.auth?.role === 'doctor' ? req.auth.id : null;
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
