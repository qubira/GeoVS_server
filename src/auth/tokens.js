import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  // Sin esto cualquiera podria falsificar tokens de sesion: se prefiere que
  // el proceso no arranque a arrancar inseguro.
  throw new Error('Falta JWT_SECRET en las variables de entorno.');
}

const EXPIRES_IN = '30d';

export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, SECRET, {
    expiresIn: EXPIRES_IN,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
